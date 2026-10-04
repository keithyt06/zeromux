import { useState, useEffect, useRef, useCallback } from 'react'
import { wsUrl } from '../lib/api'
import type { WsStatus } from '../lib/wsStatus'
import { buildPromptWithAttachments } from '../lib/attachments'
import type { WireEvent } from '../lib/transcript'
import { shouldSeedTurnClock } from '../lib/stuck'
import { shouldClearQueuedHint, busyAfterReplay, replaySilenceBaseline } from '../lib/collectHint'

// WS lifecycle of one agent session (/ws/acp/{id}), moved verbatim out of
// AcpChatView. Scroll state stays in the view; the hook reaches it only through
// the onAppend / onOpen / onReplayDone callbacks.

export const newId = () =>
  (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36)

// 系统/错误/退出提示:不属于 turn transcript(无 turn_id),单独按到达顺序保留
// 渲染在 groups 之后。它们只驱动 busy 状态与可见诊断,不进 foldTranscript。
export interface Notice { id: string; kind: 'system' | 'error'; text: string }

// ── Server events ──

interface ServerEvent {
  type: string
  subtype?: string
  session_id?: string
  block_type?: string
  text?: string
  name?: string
  input?: any
  cost_usd?: number
  message?: string
  code?: number
  streaming?: boolean
  summary?: string
  count?: number
  turn_id?: number
  client_id?: string
  running?: boolean
  last_activity_ms?: number
  queue_mode?: string
  // Crew: approval 请求 / 上下文用量。后端加变体与前端加 case 必须同一 commit ——
  // handleEvent 的 switch 没有 default 分支，未知 type 是**静默丢弃**。
  approval_id?: string
  // backend's Approval variant serializes its id as `id` (process.rs)
  id?: string
  tool?: string
  tool_purpose?: string
  tool_input?: string
  used?: number
  total?: number
  from_name?: string
  level?: string
}

export interface AcpSocketOptions {
  sessionId: string
  onQueueModeChange?: (sid: string, mode: string) => void
  /** Called right after events are appended; AcpChatView scrolls here. force = user's own send. */
  onAppend?: (force: boolean) => void
  /** onopen: AcpChatView arms its replay-scroll window here. NB a brand-new session
   *  never gets replay_done (ws_handler.rs:120), so the window stays armed — existing
   *  behaviour, preserved as-is. */
  onOpen?: () => void
  /** replay_done: AcpChatView runs its bottom-stick + follow here. */
  onReplayDone?: () => void
  /** Pending attachments are owned by the view; the hook reads them at send time. */
  getPending: () => string[]
  clearPending: () => void
}

export function useAcpSocket(o: AcpSocketOptions) {
  const { sessionId, onQueueModeChange } = o
  // The view's callbacks are held in refs synced every render (same idiom as
  // onQueueModeChangeRef below), so the WS effect keeps its [sessionId]-only deps
  // and handleEvent keeps its useCallback capture semantics.
  const onAppendRef = useRef(o.onAppend)
  useEffect(() => { onAppendRef.current = o.onAppend }, [o.onAppend])
  const onOpenRef = useRef(o.onOpen)
  useEffect(() => { onOpenRef.current = o.onOpen }, [o.onOpen])
  const onReplayDoneRef = useRef(o.onReplayDone)
  useEffect(() => { onReplayDoneRef.current = o.onReplayDone }, [o.onReplayDone])
  const getPendingRef = useRef(o.getPending)
  useEffect(() => { getPendingRef.current = o.getPending }, [o.getPending])
  const clearPendingRef = useRef(o.clearPending)
  useEffect(() => { clearPendingRef.current = o.clearPending }, [o.clearPending])

  // Raw wire-event log; the rendered transcript is DERIVED from it by grouping
  // on turn_id (T1). This is what fixes "send while streaming" misalignment:
  // a new prompt carries the NEXT turn_id, so it folds into its own group
  // instead of splicing into the still-streaming prior turn's blocks.
  const [events, setEvents] = useState<WireEvent[]>([])
  // seenClientIds is NOT passed to foldTranscript (that would double-dedupe and
  // hide the local optimistic bubble). It's used only by the WS handler to
  // decide append-vs-replace for the server echo of a prompt we inserted.
  const seenClientIds = useRef<Set<string>>(new Set())
  const [notices, setNotices] = useState<Notice[]>([])
  // approval id → 本端已作出的决定。Gateway 不广播「已解决」帧，所以按钮是否
  // 收起只能由本端记账；replay 后一个已解决的 approval 会重新出现按钮，点第二次
  // 得到 404（后端忽略），这是可接受的降级 —— 好过永久卡住一个无法回答的卡片。
  const [resolvedApprovals, setResolvedApprovals] = useState<Record<string, 'approve' | 'reject'>>({})
  // 上下文用量（Crew 白拿的新能力：zeromux 自己没有）。
  const [ctxUsage, setCtxUsage] = useState<{ used: number; total: number } | null>(null)
  const [busy, setBusy] = useState(false)
  // WS connection state for the ConnectionBar (B8). Mirrors onopen/onclose only;
  // backoff/attempt logic is untouched (I-4).
  const [wsStatus, setWsStatus] = useState<{ status: WsStatus; since: number }>(() => ({ status: 'connecting', since: Date.now() }))
  // collect:本轮进行中追加排队的条数(后端 ephemeral System{subtype:"queued"})。
  // 合并 turn 发出(下一个 Running)或 turn 结束时清零。
  const [queuedCount, setQueuedCount] = useState(0)
  const [turnStartedMs, setTurnStartedMs] = useState<number | null>(null)
  // Latest turn_id observed on a user_prompt / content_block, so a terminal
  // `error`/`exit` (which carry NO turn_id on the wire) can settle THAT turn's
  // group to complete. Without it the last turn of an errored/exited run stays
  // `complete:false` forever → streaming-markdown sanitizer appends a phantom
  // closing fence and `thinking` blocks stay force-expanded. (review 2026-08-03, F4)
  const activeTurnIdRef = useRef<number | null>(null)
  // Timestamp of the last streamed agent output. "Stuck" is silence-based:
  // a turn is stuck only when running AND no output has arrived for a while,
  // not merely when the turn has run long. Stamped on content_block.
  const [lastEventMs, setLastEventMs] = useState<number | null>(null)
  const [nowMs, setNowMs] = useState(() => Date.now())
  // Bumped (debounced) on each turn boundary so the inline RunMetricsPanel
  // re-GETs runs once the backend has flushed the just-finished run record.
  const [metricsRefresh, setMetricsRefresh] = useState(0)
  const metricsDebounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const bumpMetrics = useCallback(() => {
    if (metricsDebounce.current) clearTimeout(metricsDebounce.current)
    metricsDebounce.current = setTimeout(() => setMetricsRefresh(n => n + 1), 300)
  }, [])
  const wsRef = useRef<WebSocket | null>(null)
  // Mirror of `busy` readable from callbacks whose deps don't include busy
  // (sendPrompt). Used to avoid re-seeding the turn/silence clocks when a send is
  // merely collect-queued onto an already-running turn — see sendPrompt.
  const busyRef = useRef(false)
  // Current effective queue mode, mirrored from setQueueMode. sendPrompt reads it
  // to decide whether a busy send is collect-queued (skip reseed) or starts a fresh
  // turn (Interrupt → must reseed the clocks; see shouldSeedTurnClock / F-FE-1).
  const queueModeRef = useRef('collect')
  // Stable ref to the (optional) up-report so handleEvent's deps needn't include a
  // prop that could churn the WS effect. adoptQueueMode is the ONE place that sets
  // queueModeRef to a backend-authoritative value AND mirrors it to App so the
  // sibling SessionInfoBar dropdown reflects the real mode (review 2026-07-28).
  const onQueueModeChangeRef = useRef(onQueueModeChange)
  useEffect(() => { onQueueModeChangeRef.current = onQueueModeChange }, [onQueueModeChange])
  const adoptQueueMode = useCallback((mode: string) => {
    queueModeRef.current = mode
    onQueueModeChangeRef.current?.(sessionId, mode)
  }, [sessionId])
  const pushNotice = useCallback((notice: Notice) => {
    setNotices(prev => [...prev, notice])
    onAppendRef.current?.(false)
  }, [])
  const appendEvent = useCallback((evt: WireEvent, force = false) => {
    setEvents(prev => [...prev, evt])
    onAppendRef.current?.(force)
  }, [])

  // 审批上行。照 interrupt 的形状（同一条 /ws/acp socket，后端 fan-out 代理
  // POST /api/approvals/{id}/{action}）—— 不新开连接、不新增轮询。
  // resolve 后本地把该块标 resolved，按钮消失（不等服务端回帧，Gateway 不回执）。
  // socket 未 OPEN → 返回 false、不标 resolved（否则按钮消失但决定从未送达）。
  const resolveApproval = useCallback((approvalId: string, action: 'approve' | 'reject'): boolean => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return false
    wsRef.current.send(JSON.stringify({ type: 'approval', approval_id: approvalId, action }))
    setResolvedApprovals(prev => (prev[approvalId] ? prev : { ...prev, [approvalId]: action }))
    return true
  }, [])

  // Mark the in-flight turn's group complete when a turn ends via error/exit rather
  // than a clean `result`. Injects an empty synthetic `result` for the last observed
  // turn_id (empty text → foldTranscript sets complete without appending). No-op if no
  // turn is active or one already settled. (review 2026-08-03, F4)
  const settleActiveTurn = useCallback((isError = false) => {
    const tid = activeTurnIdRef.current
    if (tid == null) return
    activeTurnIdRef.current = null
    setEvents(prev => [...prev, { type: 'result', turn_id: tid, text: '', ...(isError ? { is_error: true } : {}) }])
  }, [])

  useEffect(() => {
    let disposed = false
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let stableTimer: ReturnType<typeof setTimeout> | undefined
    let attempt = 0

    const connect = () => {
      if (disposed) return
      const ws = new WebSocket(wsUrl(`/ws/acp/${sessionId}`))
      wsRef.current = ws

      ws.onopen = () => {
        setWsStatus({ status: 'open', since: Date.now() })
        // Reset backoff only after the connection proves STABLE (~3s), not on the
        // instant it opens. Otherwise an accept-then-immediately-close loop (app-level
        // close after upgrade, a deleted/unavailable session, or a proxy that 1006s
        // right after the handshake) resets attempt→0 every open, so `delay` is always
        // 1000*2^0 = 1s and the 10s cap is never reached — a permanent ~1s reconnect
        // hammer that drains battery/CPU and hammers the server. A genuinely healthy
        // socket outlives the timer and correctly resets. (review 2026-08-05)
        clearTimeout(stableTimer)
        stableTimer = setTimeout(() => { attempt = 0 }, 3000)
        // The server replays full scrollback on (re)connect, so start clean to
        // avoid duplicating already-rendered messages. Matches page-reload behavior.
        setEvents([])
        seenClientIds.current.clear()
        activeTurnIdRef.current = null
        setNotices([])
        setBusy(false)
        setTurnStartedMs(null)
        // Pre-replay default: assume Collect until replay_done delivers the backend's
        // AUTHORITATIVE queue_mode. We must NOT hard-assume Collect here (68ab4f5
        // regression, review 2026-07-26): the fan-out is spawned once per session and
        // keeps its mode across a transient reconnect (ensure_running → AlreadyRunning,
        // no respawn), so the backend may still be Interrupt. A busy send in the gap
        // before replay_done is not realistic (replay is near-instant), and replay_done
        // corrects the ref either way — this is only a conservative floor.
        queueModeRef.current = 'collect'
        // Arm the replay window: auto bottom-stick is allowed until replay_done,
        // and only while the user hasn't scrolled up to read history.
        onOpenRef.current?.()
      }

      ws.onmessage = (evt) => {
        try {
          const msg: ServerEvent = JSON.parse(evt.data)
          handleEvent(msg)
        } catch { /* ignore */ }
      }

      ws.onclose = () => {
        wsRef.current = null
        // Keep the ORIGINAL drop time across failed retries: a retry that never
        // opens closes again while already 'reconnecting' — resetting `since`
        // there would hide the bar for another delay window every backoff cycle.
        if (!disposed) setWsStatus(prev => prev.status === 'reconnecting' ? prev : { status: 'reconnecting', since: Date.now() })
        // A close before the stability timer fires means this open did NOT prove
        // stable — cancel the pending reset so `attempt` keeps escalating.
        clearTimeout(stableTimer)
        // Transcript completeness is derived from `result` events in
        // foldTranscript; a dropped socket simply ends the busy state. On
        // reconnect the server replays full scrollback (incl. the result).
        setBusy(false)
        setTurnStartedMs(null)
        // Auto-reconnect: an idle-timeout proxy or transient drop must not leave
        // the session permanently unable to send. Reconnect re-runs ensure_running
        // server-side and replays scrollback. Exponential backoff, capped at 10s.
        if (!disposed) {
          const delay = Math.min(1000 * 2 ** attempt, 10000)
          attempt += 1
          retryTimer = setTimeout(connect, delay)
        }
      }
      ws.onerror = () => { ws.close() }
    }

    connect()

    return () => {
      disposed = true
      if (retryTimer) clearTimeout(retryTimer)
      if (stableTimer) clearTimeout(stableTimer)
      wsRef.current?.close()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  const handleEvent = useCallback((evt: ServerEvent) => {
    switch (evt.type) {
      case 'queue_mode': {
        // Live, backend-authoritative queue-mode change (review 2026-07-27,
        // F-OBS-LIVE). Another tab (or SessionInfoBar) flipped the mode; the backend
        // broadcasts it so THIS already-connected tab adopts it without a reconnect.
        // Without this, an observer tab keeps a stale queueModeRef and a busy send
        // mis-seeds the turn clock (inflated 已运行 + false 可能卡住). replay_done
        // still carries the same value for the connect-time path. adoptQueueMode
        // also mirrors it to App so the SessionInfoBar dropdown reflects it (2026-07-28).
        if (typeof evt.queue_mode === 'string') {
          adoptQueueMode(evt.queue_mode)
        }
        break
      }

      case 'approval': {
        // **必须有这个 case** —— handleEvent 的 switch 没有 default 分支，未知顶层
        // type 是静默忽略：后端发了、前端没接 = 「什么都没发生」。
        const aid = evt.approval_id ?? evt.id
        if (!aid) break
        // 作为一个 content_block 折进它所属的 turn，与那次 tool_use 相邻渲染。
        appendEvent({
          type: 'content_block',
          block_type: 'approval',
          turn_id: evt.turn_id ?? activeTurnIdRef.current ?? 0,
          approval_id: aid,
          name: evt.tool,
          summary: evt.tool_purpose,
          text: evt.tool_input,
        })
        // 审批请求是**真实的前进信号**（agent 在等人），刷新静默基线。
        // stuck 是静默判定（:585 的 STUCK_SILENCE_MS）：approval 弹出后 agent 就不再
        // 产出任何输出，不刷基线的话 60s 后 UI 显示「可能卡住」+ 中断按钮，用户点
        // 中断会白白杀掉一个只需点「批准」的轮次。与 chat_status（纯噪音）方向相反。
        setLastEventMs(Date.now())
        break
      }

      case 'context_usage': {
        // Crew 独有的能力，zeromux 自己没有 —— 纯白拿。
        if (typeof evt.used === 'number' && typeof evt.total === 'number' && evt.total > 0) {
          setCtxUsage({ used: evt.used, total: evt.total })
        }
        break
      }

      case 'system': {
        // collect:排队提示是 ephemeral 状态行,不进消息气泡列表。
        if (evt.subtype === 'queued') {
          setQueuedCount(evt.count ?? 0)
          break
        }
        // 生命周期噪音(session ready / task_started / task_progress /
        // task_notification / task_completed 等,以及 agent 透传的其它状态行)
        // 不进消息气泡。只有真正需要用户知道的 subtype 才弹 notice。
        const labelMap: Record<string, string> = {
          resume_failed: '⚠ 上下文恢复失败，已重置为新会话',
          crew_ack: 'Crew 已接收',
        }
        const label = labelMap[evt.subtype || '']
        if (!label) break
        pushNotice({ id: newId(), kind: 'system', text: label })
        break
      }

      case 'peer_message': {
        // Another Claude session's message (spec 2026-09-26). The backend has
        // already counted the turn; mirror content_block's observer-tab seeding
        // so busy + the turn clock light up even without a local sendPrompt.
        if (typeof evt.turn_id === 'number') activeTurnIdRef.current = evt.turn_id
        appendEvent(evt as unknown as WireEvent)
        setBusy(true)
        const pmNow = Date.now()
        setTurnStartedMs(prev => prev ?? pmNow)
        setNowMs(pmNow)
        setLastEventMs(pmNow)
        break
      }

      case 'notice': {
        // CLI informational line (e.g. our cross-session message was held/refused).
        if (evt.text) pushNotice({ id: newId(), kind: 'system', text: evt.text })
        break
      }

      case 'user_prompt': {
        // Track the authoritative turn_id so an IMMEDIATE error/exit (before any
        // content_block streams) can still settle this turn's group. (F4)
        if (typeof evt.turn_id === 'number' && evt.turn_id !== Number.MAX_SAFE_INTEGER) {
          activeTurnIdRef.current = evt.turn_id
        }
        // 服务器回显。若 client_id 已是本端乐观插入(seen),不重复 append;改为把
        // 那条乐观事件的 turn_id 替换为权威值(乐观插入用 MAX_SAFE_INTEGER 让其
        // 暂排在最后,真实 turn_id 到达后归位,与对应助手 turn 对齐)。
        if (evt.client_id && seenClientIds.current.has(evt.client_id)) {
          const cid = evt.client_id
          const tid = evt.turn_id
          setEvents(prev => prev.map(e =>
            (e.type === 'user_prompt' && e.client_id === cid)
              ? { ...e, turn_id: tid }
              : e
          ))
          break
        }
        appendEvent(evt as unknown as WireEvent)
        break
      }

      case 'content_block': {
        if (typeof evt.turn_id === 'number') activeTurnIdRef.current = evt.turn_id
        appendEvent(evt as unknown as WireEvent)
        // NB: do NOT clear the collect hint here — content_block belongs to the
        // still-running turn (its own output), and the merged turn can only start
        // AFTER this turn's result/error/exit (which clear it). See shouldClearQueuedHint.
        setBusy(true)
        // Stamp turn start if not already running (e.g. a turn observed from
        // another tab via replay, where this client didn't call sendPrompt).
        const cbNow = Date.now()
        setTurnStartedMs(prev => prev ?? cbNow)
        // Seed the display clock too. On an OBSERVER tab (this client didn't
        // sendPrompt and busy was false), the busy-ticker — which has no leading
        // tick — hasn't run, so nowMs is frozen at a stale value. Without this the
        // first render computes elapsed = (staleNow - freshStart) < 0 and paints
        // "已运行 -Ns…" for up to a second. 95a7d1f seeded sendPrompt + replay_done
        // but not this path; a turn first seen via a live content_block (no replay,
        // e.g. a second tab opened mid-turn) hit the same negative-elapsed gap.
        setNowMs(cbNow)
        // Streamed output is the freshest evidence of liveness — drives the
        // silence-based stuck heuristic below.
        setLastEventMs(cbNow)
        break
      }

      case 'result': {
        activeTurnIdRef.current = null
        appendEvent(evt as unknown as WireEvent)
        setBusy(false)
        setTurnStartedMs(null)
        // Turn ended — clear any collect hint (the merged turn, if any, already
        // fired or was dropped; see shouldClearQueuedHint).
        if (shouldClearQueuedHint(evt.type)) setQueuedCount(0)
        bumpMetrics()
        break
      }

      case 'error': {
        // Settle the in-flight turn's group to complete: a terminal error carries no
        // turn_id, so synthesize an empty `result` for the last observed turn. Empty
        // text means foldTranscript sets complete=true WITHOUT appending any block
        // (its `if (finalText)` guard), so the group's markdown stops streaming-
        // sanitizing (no phantom fence) and thinking blocks collapse. (review 2026-08-03, F4)
        settleActiveTurn(true)
        pushNotice({ id: newId(), kind: 'error', text: evt.message || 'Unknown error' })
        setBusy(false)
        setTurnStartedMs(null)
        // Error ends the turn AND the backend drops the collect queue, so the
        // merged turn never fires — clear the hint or it sticks forever.
        if (shouldClearQueuedHint(evt.type)) setQueuedCount(0)
        bumpMetrics()
        break
      }

      case 'exit': {
        // Same as error: settle the in-flight turn before the process-exit notice.
        settleActiveTurn(true)
        pushNotice({ id: newId(), kind: 'system', text: `Process exited (code: ${evt.code || 0})` })
        setBusy(false)
        setTurnStartedMs(null)
        // Same as error: process death drops the queue; clear the stale hint.
        if (shouldClearQueuedHint(evt.type)) setQueuedCount(0)
        bumpMetrics()
        break
      }

      case 'replay_done': {
        // Adopt the backend's AUTHORITATIVE queue mode (review 2026-07-26). The
        // fan-out keeps its mode across a transient reconnect (no respawn) and a
        // second observer tab never learned it, so onopen's provisional 'collect'
        // may be wrong — a busy Interrupt send would then skip the clock reseed and
        // paint an inflated elapsed + false 可能卡住 on the fresh interrupt turn
        // (the F-FE-1 regression). Only adopt a delivered value; a missing field
        // (old backend / session with no live process) leaves the provisional mode.
        if (typeof evt.queue_mode === 'string') {
          adoptQueueMode(evt.queue_mode)
        }
        // Honor the backend's authoritative live turn state. On a mid-turn
        // reconnect (idle-proxy drop during an output-silent tool call) the turn
        // is still Running server-side; forcing busy=false here would hide the
        // running indicator AND the interrupt button until the next live event —
        // which for a hung turn never comes. When running, re-arm the elapsed +
        // silence clocks from now (the original start isn't replayed, but the
        // affordances must be live). When not running, reset as before.
        const stillRunning = busyAfterReplay(evt.running)
        setBusy(stillRunning)
        if (stillRunning) {
          const t = Date.now()
          // Refresh the display clock: nowMs may be frozen at a pre-reconnect value
          // (busy-ticker only runs while busy), which would make `elapsed` negative
          // and evaluate `stuck` against a stale clock right after reconnect.
          setNowMs(t)
          // Elapsed: keep a fresh content_block stamp from this replay if present
          // (onopen reset it to null, so `?? t` only fills the no-output case).
          setTurnStartedMs(prev => prev ?? t)
          // Silence baseline: seed from the backend's authoritative
          // last_activity_ms (same clock as Date.now()) so `stuck` — and thus the
          // stuck styling of the 中断 button (shown whenever busy) — reflects the REAL accumulated agent
          // silence, not a fresh clock restarted on every reconnect. A hung turn
          // is then interruptible immediately after reconnect. Missing value →
          // now (old-backend / unknown session); future stamp → clamped to now.
          setLastEventMs(replaySilenceBaseline(evt.last_activity_ms, t))
        } else {
          setTurnStartedMs(null)
        }
        // Reconnect replay finished — clear any stale queued hint (backend also
        // makes the queued event ephemeral; this is the frontend safety net).
        setQueuedCount(0)
        onReplayDoneRef.current?.()
        break
      }
    }
  }, [pushNotice, appendEvent, bumpMetrics, adoptQueueMode, settleActiveTurn])

  const sendPrompt = useCallback((text: string, opts?: { withAttachments?: boolean }): boolean => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return false
    const withAttachments = opts?.withAttachments ?? true
    const full = withAttachments ? buildPromptWithAttachments(text, getPendingRef.current()) : text
    // Optimistic bubble: insert immediately with MAX_SAFE_INTEGER turn_id so it
    // sorts last (newest) until the server echo arrives with the true turn_id,
    // at which point we rewrite this entry's turn_id (deduped by client_id).
    const cid = newId()
    seenClientIds.current.add(cid)
    // force: the user just hit send — always show their bubble and the reply,
    // even if they had scrolled up to read history a moment before.
    appendEvent({ type: 'user_prompt', text: full, turn_id: Number.MAX_SAFE_INTEGER, client_id: cid }, true)
    wsRef.current.send(JSON.stringify({ type: 'prompt', text: full, client_id: cid }))
    if (withAttachments) clearPendingRef.current()
    // If a turn is already in flight, a send in the default Collect queue mode is
    // merely enqueued server-side (no interrupt, no new turn) — re-seeding the clocks
    // here would reset the silence baseline of the RUNNING turn, resetting `stuck` and
    // HIDING the interrupt button on a turn that may be wedged (the one time the user
    // most needs it). But in Interrupt mode a busy send is NOT enqueued: the backend
    // interrupts and starts a genuinely fresh turn, which MUST reseed the clocks or it
    // inherits the old turn's baseline (F-FE-1). shouldSeedTurnClock decides from both.
    // setBusy is idempotent and always safe. (Refs, not state: this callback's deps
    // omit busy/queueMode.)
    const wasBusy = busyRef.current
    setBusy(true)
    if (shouldSeedTurnClock(wasBusy, queueModeRef.current)) {
      const sentAt = Date.now()
      setTurnStartedMs(sentAt)
      // Seed the display clock to send time too. nowMs is otherwise only advanced by
      // the 1s busy-ticker (no leading tick), so it stays frozen at its last value
      // between turns; without this, `elapsed = (staleNow - sentAt)/1000` paints
      // NEGATIVE ("已运行 -Ns…") until the first tick ~1s later.
      setNowMs(sentAt)
      // Seed silence baseline from send time so a turn that never emits output is
      // still measured (otherwise lastEventMs stays null → never stuck).
      setLastEventMs(sentAt)
    }
    return true
  }, [appendEvent])

  // Keep busyRef in sync so sendPrompt (whose deps omit busy) can tell whether a
  // send starts a fresh turn or is collect-queued onto a running one.
  useEffect(() => { busyRef.current = busy }, [busy])

  // Stuck-turn timer: tick a 1s clock while busy so the elapsed display
  // updates. turnStartedMs is stamped in the event handlers (turn start) and
  // cleared at turn end — set-state lives in handlers, not in this effect.
  useEffect(() => {
    if (!busy) return
    const t = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(t)
  }, [busy])

  // false = socket not OPEN: nothing sent, so the queued hint must stay (the
  // backend never saw the interrupt and still holds the collect queue).
  const interrupt = useCallback((): boolean => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return false
    wsRef.current.send(JSON.stringify({ type: 'interrupt' }))
    // Backend clears the pending collect queue on interrupt (E5); mirror locally.
    setQueuedCount(0)
    return true
  }, [])

  const setQueueMode = useCallback((mode: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'set_queue_mode', mode }))
      // Mirror locally ONLY on a delivered change so sendPrompt can tell a
      // collect-queued send (skip clock reseed) from an Interrupt send that starts
      // a fresh turn (must reseed). Updating the ref even when the socket is closed
      // would diverge it from the backend's real mode (the message was dropped) —
      // then a send could reseed a collect-queued turn (the 68ab4f5 bug) or skip a
      // real Interrupt turn. Keeping the ref == last-delivered mode avoids that.
      // adoptQueueMode also mirrors it to App so the dropdown that TRIGGERED this
      // stays in sync (and every other tab learns it via the backend broadcast).
      adoptQueueMode(mode)
    }
  }, [adoptQueueMode])
  // Clear the pending metrics-refresh timer on unmount.
  useEffect(() => () => { if (metricsDebounce.current) clearTimeout(metricsDebounce.current) }, [])

  return {
    events, notices, pushNotice,
    busy, turnStartedMs, lastEventMs, nowMs,
    queuedCount, wsStatus, ctxUsage, resolvedApprovals, metricsRefresh,
    sendPrompt, setQueueMode, interrupt, resolveApproval,
  }
}
