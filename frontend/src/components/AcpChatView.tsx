import { useState, useEffect, useRef, useCallback, useMemo, memo, createElement } from 'react'
import { wsUrl, uploadSessionFile, getSessionRuns } from '../lib/api'
import { ChevronDown, Wrench, Brain, AlertCircle, FileText, Terminal, Search, Bot, Paperclip, ListPlus, X, type LucideIcon } from 'lucide-react'
import MarkdownContent from './markdown/MarkdownContent'
import Composer from './Composer'
import PromptManager from './PromptManager'
import { usePromptPresets } from '../lib/usePromptPresets'
import { applyPreset } from '../lib/applyPreset'
import { buildPromptWithAttachments } from '../lib/attachments'
import { RunMetricsPanel } from './RunMetricsPanel'
import { SessionLifetimeBadge } from './SessionLifetimeBadge'
import { foldTranscript, stabilizeGroups, type WireEvent, type Block, type TurnGroup } from '../lib/transcript'
import { partitionBlocks, type Density } from '../lib/density'
import { STUCK_SILENCE_MS, shouldSeedTurnClock } from '../lib/stuck'
import { shouldStickToBottom, shouldAutoScrollOnAppend, shouldTrackScrollUp } from '../lib/scrollReplay'
import { shouldClearQueuedHint, busyAfterReplay, replaySilenceBaseline } from '../lib/collectHint'

// ── Message types ──

const newId = () =>
  (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36)

// 系统/错误/退出提示:不属于 turn transcript(无 turn_id),单独按到达顺序保留
// 渲染在 groups 之后。它们只驱动 busy 状态与可见诊断,不进 foldTranscript。
interface Notice { id: string; kind: 'system' | 'error'; text: string }

type ContentBlock = Block

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
}

interface Props {
  sessionId: string
  active: boolean
  agentType?: 'claude' | 'kiro' | 'codex'
  // Lets the parent (App→SessionInfoBar) drive WS-only controls that live in
  // this component. Registered on mount, cleared on unmount. (G2b queue mode.)
  onRegisterControls?: (sessionId: string, api: { setQueueMode: (mode: string) => void; sendPrompt: (text: string) => void } | null) => void
  // Report the backend-authoritative queue mode UP to App so the sibling
  // SessionInfoBar dropdown reflects the real mode (review 2026-07-28). The
  // functional path uses queueModeRef; this only mirrors the same value into
  // App state so the visible control can't lie (observer tab / reconnect showing
  // 'Collect' while the backend is 'Interrupt' → an unintended interrupt on send).
  onQueueModeChange?: (sessionId: string, mode: string) => void
  // Inline run-metrics panel visibility, owned by App (toggled from SessionInfoBar).
  showMetrics?: boolean
}

// `active` is accepted (App passes it for all session views) but no longer used:
// the Composer owns its own textarea and we intentionally don't auto-focus it,
// so switching to a chat session doesn't pop the mobile keyboard.
export default function AcpChatView({ sessionId, agentType = 'claude', onRegisterControls, onQueueModeChange, showMetrics }: Props) {
  // Raw wire-event log; the rendered transcript is DERIVED from it by grouping
  // on turn_id (T1). This is what fixes "send while streaming" misalignment:
  // a new prompt carries the NEXT turn_id, so it folds into its own group
  // instead of splicing into the still-streaming prior turn's blocks.
  const [events, setEvents] = useState<WireEvent[]>([])
  // seenClientIds is NOT passed to foldTranscript (that would double-dedupe and
  // hide the local optimistic bubble). It's used only by the WS handler to
  // decide append-vs-replace for the server echo of a prompt we inserted.
  const seenClientIds = useRef<Set<string>>(new Set())
  // Fold events → turn groups, then reconcile object identity against the previously
  // rendered list so already-finished turns keep their identity and the TurnGroupView
  // React.memo actually skips them. Without this, foldTranscript allocates fresh group
  // objects every call, so every prior turn re-parsed its markdown on each streamed
  // delta of the current turn — O(N²), visible lag on a long session. Reading + writing
  // a ref inside this useMemo is React's documented memoization-cache exception ("it's
  // fine to read or write a ref during render if you're implementing memoization"); the
  // write is idempotent per distinct `events`. (review 2026-08-03, F-perf)
  const prevGroupsRef = useRef<TurnGroup[]>([])
  const groups = useMemo(() => {
    // eslint-disable-next-line react-hooks/refs -- memoization cache (see note above)
    const stable = stabilizeGroups(prevGroupsRef.current, foldTranscript(events))
    // eslint-disable-next-line react-hooks/refs -- memoization cache (see note above)
    prevGroupsRef.current = stable
    return stable
  }, [events])
  const [notices, setNotices] = useState<Notice[]>([])
  const [input, setInput] = useState('')
  const presetStore = usePromptPresets()
  const [presetOpen, setPresetOpen] = useState(false)
  const [presetManaging, setPresetManaging] = useState(false)
  const closePreset = useCallback(() => { setPresetOpen(false); setPresetManaging(false) }, [])
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<string[]>([])   // 已上传待发的实际路径
  const [uploading, setUploading] = useState(0)           // 上传中计数
  const fileInputRef = useRef<HTMLInputElement>(null)
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
  // Session lifetime (cumulative turns/duration/cost) — fetched from /runs
  // independently of showMetrics so the header badge is always available.
  const [lifetime, setLifetime] = useState({ turns: 0, duration_ms: 0, cost_usd: 0 })
  useEffect(() => {
    // Guard against out-of-order resolves: metricsRefresh bumps this on every turn
    // boundary and getSessionRuns can be slow on JuiceFS, so a stale earlier fetch
    // could revert the cumulative badge to a smaller value. (review 2026-08-12)
    let ignore = false
    getSessionRuns(sessionId, { limit: 0 })
      .then(data => { if (!ignore && data.lifetime) setLifetime(data.lifetime) })
      .catch(() => { /* ignore — lifetime badge is non-critical */ })
    return () => { ignore = true }
  }, [sessionId, metricsRefresh])
  // 输出密度(G2b/P2):concise(默认)折叠思考+原始工具输入;full 全显。
  const [density, setDensity] = useState<Density>('concise')
  // 首次精简提示:一次性、可关。localStorage 跨会话只显示一次。
  const [showDensityHint, setShowDensityHint] = useState(
    () => typeof localStorage !== 'undefined' && localStorage.getItem('zeromux:density-hint') == null
  )
  const dismissDensityHint = useCallback(() => {
    setShowDensityHint(false)
    try { localStorage.setItem('zeromux:density-hint', '1') } catch { /* ignore */ }
  }, [])
  const expandDensity = useCallback(() => setDensity('full'), [])
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
  const scrollRef = useRef<HTMLDivElement>(null)
  const replayingRef = useRef(false)
  // True only while the post-replay_done follow ResizeObserver is armed (~2s).
  // Auto-stick spans replay AND this follow window, so the scroll-up detector
  // must stay armed across both (see shouldTrackScrollUp).
  const followingRef = useRef(false)
  const userScrolledUpRef = useRef(false)
  const roRef = useRef<ResizeObserver | null>(null)
  const roTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // Auto-scroll on a new event only if the user was already near the bottom
  // (or force, for their own just-sent prompt). Measure distance-from-bottom
  // SYNCHRONOUSLY here — this runs from the WS onmessage handler right after
  // setEvents/setNotices, which is outside React's batch, so the DOM still holds
  // the pre-append layout; the rAF then scrolls against the grown height. Keeping
  // the measurement out of the rAF is what makes the gate meaningful (post-append
  // height would always read as near-bottom and silently reintroduce the yank).
  const scrollBottom = useCallback((force = false) => {
    const el = scrollRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    if (!shouldAutoScrollOnAppend({ force, distanceFromBottom })) return
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
    })
  }, [])

  const pushNotice = useCallback((notice: Notice) => {
    setNotices(prev => [...prev, notice])
    scrollBottom()
  }, [scrollBottom])

  const appendEvent = useCallback((evt: WireEvent, force = false) => {
    setEvents(prev => [...prev, evt])
    scrollBottom(force)
  }, [scrollBottom])

  // Mark the in-flight turn's group complete when a turn ends via error/exit rather
  // than a clean `result`. Injects an empty synthetic `result` for the last observed
  // turn_id (empty text → foldTranscript sets complete without appending). No-op if no
  // turn is active or one already settled. (review 2026-08-03, F4)
  const settleActiveTurn = useCallback(() => {
    const tid = activeTurnIdRef.current
    if (tid == null) return
    activeTurnIdRef.current = null
    setEvents(prev => [...prev, { type: 'result', turn_id: tid, text: '' }])
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
        replayingRef.current = true
        userScrolledUpRef.current = false
      }

      ws.onmessage = (evt) => {
        try {
          const msg: ServerEvent = JSON.parse(evt.data)
          handleEvent(msg)
        } catch { /* ignore */ }
      }

      ws.onclose = () => {
        wsRef.current = null
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
        }
        const label = labelMap[evt.subtype || '']
        if (!label) break
        pushNotice({ id: newId(), kind: 'system', text: label })
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
        settleActiveTurn()
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
        settleActiveTurn()
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
          // `stuck`-gated 中断 button — reflects the REAL accumulated agent
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
        // Stable bottom-stick: only inside the replay window and only if the user
        // hasn't scrolled up (passive reconnect must not yank a reader to the end).
        const el = scrollRef.current
        if (el && shouldStickToBottom({ replaying: replayingRef.current, userScrolledUp: userScrolledUpRef.current })) {
          el.scrollTop = el.scrollHeight
          // Async content (markdown/mermaid/katex/images) grows height after this
          // tick; follow those growths for a short window via ResizeObserver.
          // followingRef keeps onScroll's scroll-up detector armed for the whole
          // follow window (replaying is about to flip false below), so a reader
          // who scrolls up mid-follow flips userScrolledUpRef and the guard here
          // actually fires — otherwise it would yank them back to the bottom.
          roRef.current?.disconnect()
          followingRef.current = true
          const ro = new ResizeObserver(() => {
            if (userScrolledUpRef.current) { ro.disconnect(); roRef.current = null; followingRef.current = false; return }
            el.scrollTop = el.scrollHeight
          })
          ro.observe(el)
          roRef.current = ro
          if (roTimerRef.current) clearTimeout(roTimerRef.current)
          roTimerRef.current = setTimeout(() => { ro.disconnect(); roRef.current = null; followingRef.current = false }, 2000)
        }
        // Replay window closes here — live output no longer auto-sticks.
        replayingRef.current = false
        break
      }
    }
  }, [pushNotice, appendEvent, bumpMetrics, adoptQueueMode, settleActiveTurn])

  // Composer 已 trim 且非空才回调；后端 fan-out 会在重发前自动打断在途轮次，
  // 前端只需发 prompt。
  // 串行上传(手机内存),每个成功 push 实际路径到 pending。
  const handleFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return
    const list = Array.from(files)
    setUploading(u => u + list.length)
    for (const file of list) {
      try {
        const dataUrl: string = await new Promise((resolve, reject) => {
          const r = new FileReader()
          r.onload = () => resolve(r.result as string)
          r.onerror = () => reject(r.error)
          r.readAsDataURL(file)
        })
        const base64 = dataUrl.split(',')[1] ?? ''
        const actual = await uploadSessionFile(sessionId, file.name, base64)
        setPending(p => [...p, actual])
      } catch (e) {
        alert(`上传失败 ${file.name}: ${e instanceof Error ? e.message : String(e)}`)
      } finally {
        setUploading(u => u - 1)
      }
    }
  }, [sessionId])

  const removePending = useCallback((path: string) => {
    setPending(p => p.filter(x => x !== path))
  }, [])

  const sendPrompt = useCallback((text: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return
    const full = buildPromptWithAttachments(text, pending)
    // Optimistic bubble: insert immediately with MAX_SAFE_INTEGER turn_id so it
    // sorts last (newest) until the server echo arrives with the true turn_id,
    // at which point we rewrite this entry's turn_id (deduped by client_id).
    const cid = newId()
    seenClientIds.current.add(cid)
    // force: the user just hit send — always show their bubble and the reply,
    // even if they had scrolled up to read history a moment before.
    appendEvent({ type: 'user_prompt', text: full, turn_id: Number.MAX_SAFE_INTEGER, client_id: cid }, true)
    wsRef.current.send(JSON.stringify({ type: 'prompt', text: full, client_id: cid }))
    setInput('')
    setPending([])
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
  }, [appendEvent, pending])

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

  const elapsed = turnStartedMs ? Math.floor((nowMs - turnStartedMs) / 1000) : 0
  // Silence-based, not turn-total-duration: a long but actively-streaming turn
  // is not stuck. Mirrors the sidebar amber dot / backend STUCK_SILENCE_MS.
  const stuck = busy && lastEventMs != null && (nowMs - lastEventMs) > STUCK_SILENCE_MS
  const silenceSecs = lastEventMs != null ? Math.floor((nowMs - lastEventMs) / 1000) : 0

  const interrupt = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'interrupt' }))
    }
    // Backend clears the pending collect queue on interrupt (E5); mirror locally.
    setQueuedCount(0)
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

  // Register WS-only controls so SessionInfoBar (rendered by App, a sibling)
  // can drive them for the active session. Clear on unmount.
  useEffect(() => {
    onRegisterControls?.(sessionId, { setQueueMode, sendPrompt })
    return () => onRegisterControls?.(sessionId, null)
  }, [sessionId, setQueueMode, sendPrompt, onRegisterControls])

  // Esc closes the preset popover (parity with the Sidebar pick-prompt step).
  useEffect(() => {
    if (!presetOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closePreset() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [presetOpen, closePreset])

  // Clear the pending metrics-refresh timer on unmount.
  useEffect(() => () => { if (metricsDebounce.current) clearTimeout(metricsDebounce.current) }, [])

  // Disconnect the replay-follow ResizeObserver and its disarm timer on unmount.
  useEffect(() => () => {
    roRef.current?.disconnect()
    followingRef.current = false
    if (roTimerRef.current) clearTimeout(roTimerRef.current)
  }, [])

  return (
    <div className="flex flex-col h-full">
      {lifetime.turns > 0 && (
        <div className="px-5 pt-2 pb-0 flex justify-end">
          <SessionLifetimeBadge agentType={agentType} lifetime={lifetime} />
        </div>
      )}
      {showMetrics && (
        <RunMetricsPanel
          sessionId={sessionId}
          turnStartedMs={turnStartedMs}
          running={busy}
          refreshKey={metricsRefresh}
        />
      )}
      <div
        ref={scrollRef}
        onScroll={() => {
          const el = scrollRef.current
          // Armed across BOTH the replay window and the post-replay_done follow
          // window — auto-stick can fire in either, so a scroll-up in either must
          // be detected. (Steady-state live output uses the near-bottom gate in
          // scrollBottom instead, which re-measures per append and needs no flag.)
          if (!el || !shouldTrackScrollUp({ replaying: replayingRef.current, following: followingRef.current })) return
          // `< 4` is a bottom-stick tolerance (scrollbar pixel jitter), not a
          // "N px from bottom" heuristic: any departure from the bottom during
          // replay means the user is reading history, so stop auto-sticking.
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 4
          if (!atBottom) userScrolledUpRef.current = true
        }}
        className="flex-1 overflow-y-auto px-5 py-4 space-y-4"
      >
        {showDensityHint && (
          <div className="flex items-center gap-2 text-[11px] text-[var(--text-muted)] bg-[var(--bg-secondary)] border border-[var(--border)] rounded px-2 py-1">
            <span className="flex-1">已为你精简显示，可切完整</span>
            <button onClick={dismissDensityHint} aria-label="dismiss hint"
              className="shrink-0 text-[var(--text-muted)] hover:text-[var(--text-primary)]">
              <X size={12} />
            </button>
          </div>
        )}
        {groups.map(g => (
          <TurnGroupView
            key={g.turnId}
            group={g}
            agentName={agentType === 'kiro' ? 'Kiro' : agentType === 'codex' ? 'Codex' : 'Claude'}
            density={density}
            onExpand={expandDensity}
          />
        ))}
        {notices.map(n => <NoticeBubble key={n.id} notice={n} />)}
      </div>

      <div className="relative flex flex-col px-4 py-3 border-t border-[var(--border)] bg-[var(--bg-secondary)]">
        {queuedCount > 0 && (
          <div className="px-2 pb-1 text-xs text-[var(--text-muted)]">
            已排队 {queuedCount} 条，本轮结束后合并发送
          </div>
        )}
        {busy && (
          <div className="flex items-center gap-2 px-2 pb-1 text-xs">
            {stuck ? (
              <>
                <span className="text-[var(--accent-red)]">已静默 {silenceSecs}s，可能卡住</span>
                <button
                  onClick={interrupt}
                  className="px-2 py-0.5 text-[10px] font-semibold text-[var(--accent-red)] border border-[var(--accent-red)] rounded hover:bg-[var(--accent-red)] hover:text-white transition-colors"
                >
                  中断
                </button>
              </>
            ) : (
              <span className="text-[var(--text-muted)] italic">已运行 {elapsed}s…</span>
            )}
          </div>
        )}
        {(pending.length > 0 || uploading > 0) && (
          <div className="flex flex-wrap gap-1.5 px-1 pb-1.5">
            {pending.map(p => (
              <span key={p} className="inline-flex items-center gap-1 max-w-[160px] text-xs bg-[var(--bg-primary)] border border-[var(--border)] rounded px-2 py-1 text-[var(--text-primary)]">
                <span className="truncate">{p.split('/').pop()}</span>
                <button onClick={() => removePending(p)} aria-label={`remove ${p}`} className="shrink-0 text-[var(--text-muted)] hover:text-[var(--text-primary)]">
                  <X size={12} />
                </button>
              </span>
            ))}
            {uploading > 0 && (
              <span className="text-xs text-[var(--text-muted)] px-1 py-1">上传中 {uploading} 个…</span>
            )}
            {pending.length > 0 && !input.trim() && (
              <button onClick={() => sendPrompt('')} aria-label="send attachments"
                className="text-xs bg-[var(--accent-green)] hover:bg-[var(--accent-green-hover)] text-white rounded px-2 py-1">
                发送
              </button>
            )}
          </div>
        )}
        <input ref={fileInputRef} type="file" accept="*/*" multiple className="hidden"
          onChange={e => { handleFiles(e.target.files); e.target.value = '' }} />
        {presetOpen && (
          // Tap-outside-to-close: transparent full-screen catcher behind the popover.
          <div className="fixed inset-0 z-10" onClick={closePreset} aria-hidden="true" />
        )}
        {presetOpen && (
          <div className="absolute bottom-full left-0 right-0 mb-2 mx-2 rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] shadow-lg z-20">
            {presetManaging ? (
              <PromptManager
                presets={presetStore.presets}
                error={presetStore.error}
                onAdd={presetStore.add}
                onEdit={presetStore.edit}
                onRemove={presetStore.remove}
                onClose={() => setPresetManaging(false)}
              />
            ) : (
              <div className="p-2 flex flex-col gap-2">
                <div className="flex flex-wrap gap-1">
                  {presetStore.presets.length === 0 && (
                    <span className="text-[10px] text-[var(--text-muted)] px-1 py-1">还没有常用 prompt</span>
                  )}
                  {presetStore.presets.map(p => (
                    <button
                      key={p.id}
                      onClick={() => { setInput(applyPreset(p.body, input)); setPresetOpen(false) }}
                      title={p.body}
                      className="px-2 py-0.5 text-[10px] rounded-full bg-[var(--bg-secondary)] border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--accent-blue)] transition-colors truncate max-w-[160px]"
                    >
                      {p.title}
                    </button>
                  ))}
                </div>
                <div className="flex justify-between">
                  <button
                    onClick={() => setPresetManaging(true)}
                    className="flex items-center gap-1 px-2 py-1 text-[10px] font-semibold text-[var(--accent-blue)] hover:opacity-80"
                  >
                    ✎ 管理
                  </button>
                  <button
                    onClick={closePreset}
                    className="px-2 py-1 text-[10px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                  >
                    关闭
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
        <Composer
          value={input}
          onChange={setInput}
          onSend={sendPrompt}
          submitOnEnter={true}
          placeholder={`Send a message to ${agentType === 'kiro' ? 'Kiro' : agentType === 'codex' ? 'Codex' : 'Claude'}...`}
          rightSlot={
            <div className="flex items-end gap-1">
              <button
                onClick={() => {
                  setPresetManaging(false)
                  setPresetOpen(o => { if (!o) presetStore.reload(); return !o })
                }}
                aria-label="prompt presets"
                className="self-end p-2 text-[var(--text-muted)] hover:text-[var(--text-primary)] rounded-lg transition-colors"
                title="常用 prompt"
              >
                <ListPlus size={16} />
              </button>
              <button onClick={() => fileInputRef.current?.click()} aria-label="attach"
                className="self-end p-2 text-[var(--text-muted)] hover:text-[var(--text-primary)] rounded-lg transition-colors" title="附件">
                <Paperclip size={16} />
              </button>
            </div>
          }
        />
      </div>
    </div>
  )
}

// ── Message rendering ──

// A turn = its user prompt bubble(s) followed by the assistant's blocks. A
// collect-merged turn has N userPrompts (P1) → N "You" bubbles, then one
// assistant section. A turn with no blocks yet (prompt sent, nothing streamed)
// renders just the user bubble(s).
function TurnGroupViewImpl({ group, agentName = 'Claude', density = 'concise', onExpand }: {
  group: TurnGroup; agentName?: string; density?: Density; onExpand?: () => void
}) {
  const { visible, collapsedCount } = partitionBlocks(group.blocks, density)
  return (
    <div className="space-y-4">
      {group.userPrompts.map((p, i) => (
        <div key={p.clientId ?? i}>
          <p className="text-[11px] font-semibold text-[var(--accent-blue)] mb-0.5">You</p>
          <p className="text-sm text-[var(--text-primary)] whitespace-pre-wrap">{p.text}</p>
        </div>
      ))}
      {group.blocks.length > 0 && (
        <div className="space-y-2">
          <p className="text-[11px] font-semibold text-[var(--accent-purple)] mb-0.5">{agentName}</p>
          {visible.map((b, i) => <BlockView key={i} block={b} isComplete={group.complete} />)}
          {collapsedCount > 0 && (
            <button onClick={onExpand}
              className="text-[11px] text-[var(--text-muted)] hover:text-[var(--accent-blue)] border border-[var(--border)] rounded px-2 py-0.5 transition-colors">
              +{collapsedCount} 条思考/工具 · 展开
            </button>
          )}
          {group.cost != null && (
            <p className="text-[10px] text-[var(--text-muted)] border-t border-[var(--border-light)] pt-1 mt-1">
              cost: ${group.cost.toFixed(4)}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

const TurnGroupView = memo(
  TurnGroupViewImpl,
  (prev, next) =>
    prev.group === next.group &&
    prev.agentName === next.agentName &&
    prev.density === next.density &&
    prev.onExpand === next.onExpand
)

function NoticeBubble({ notice }: { notice: Notice }) {
  if (notice.kind === 'system') {
    return <p className="text-[11px] text-[var(--text-muted)] italic">{notice.text}</p>
  }
  return (
    <div className="flex items-start gap-1.5 text-[var(--accent-red)] text-xs">
      <AlertCircle size={13} className="shrink-0 mt-0.5" />
      <span>{notice.text}</span>
    </div>
  )
}

// 工具名 → lucide 图标。未知/MCP 工具回落 Wrench。
const TOOL_ICONS: Record<string, LucideIcon> = {
  Read: FileText, Edit: FileText, Write: FileText,
  Bash: Terminal,
  Grep: Search, Glob: Search,
  Agent: Bot, Task: Bot,
}
const iconFor = (name?: string): LucideIcon =>
  (name && TOOL_ICONS[name]) || Wrench

function BlockView({ block, isComplete }: { block: ContentBlock; isComplete: boolean }) {
  switch (block.type) {
    case 'text':
      return (
        <div className="text-sm text-[var(--text-primary)] leading-relaxed">
          <MarkdownContent text={block.text || ''} isComplete={isComplete} />
        </div>
      )

    case 'error':
      // A non-terminal, mid-turn agent error (e.g. a transient Codex codex/event
      // error while the turn keeps running). Rendered inline as a red note so the
      // user sees it, but it does NOT end the turn (F-CODEX-1). Terminal errors
      // still arrive as the top-level 'error' event → NoticeBubble.
      return (
        <div className="flex items-start gap-1.5 text-[var(--accent-red)] text-xs">
          <AlertCircle size={13} className="shrink-0 mt-0.5" />
          <span className="whitespace-pre-wrap break-words">{block.text || 'Error'}</span>
        </div>
      )

    case 'thinking':
      return (
        <details open={!isComplete} className="border-l-2 border-[var(--accent-purple-dim)] pl-2.5 text-xs text-[var(--accent-purple-text)]">
          <summary className="cursor-pointer text-[var(--accent-purple-dim)] font-medium flex items-center gap-1 select-none">
            <Brain size={12} />
            <span>thinking...</span>
            <ChevronDown size={12} />
          </summary>
          <div className="mt-1 leading-relaxed">
            <MarkdownContent text={block.text || ''} isComplete={isComplete} />
          </div>
        </details>
      )

    case 'tool_use': {
      const inputStr = block.input ? JSON.stringify(block.input, null, 2) : null
      const truncated = inputStr && inputStr.length > 2000
        ? inputStr.substring(0, 2000) + '\n...(truncated)'
        : inputStr
      const hasRawInput = !!truncated && truncated !== '{}' && truncated !== 'null'
      return (
        <div className="border-l-2 border-[var(--accent-yellow)] pl-2.5 py-1 text-xs">
          <div className="flex items-center gap-1 text-[var(--accent-yellow)] font-medium">
            {createElement(iconFor(block.name), { size: 12 })}
            <span>{block.name || 'tool'}</span>
            {block.summary && (
              <span className="text-[var(--text-secondary)] font-normal truncate min-w-0 flex-1">· {block.summary}</span>
            )}
          </div>
          {hasRawInput && (
            <details className="mt-1">
              <summary className="cursor-pointer text-[10px] text-[var(--text-muted)] select-none">input</summary>
              <pre className="mt-1 text-[11px] text-[var(--text-secondary)] whitespace-pre-wrap break-words bg-[var(--bg-secondary)] rounded p-2 border border-[var(--border)] overflow-x-auto">
                {truncated}
              </pre>
            </details>
          )}
        </div>
      )
    }

    case 'tool_result': {
      const out = block.text || ''
      return (
        <div className="border-l-2 border-[var(--accent-green,#3fb950)] pl-2.5 py-1 text-xs">
          <div className="flex items-center gap-1 text-[var(--accent-green,#3fb950)] font-medium">
            {createElement(iconFor(block.name), { size: 12 })}
            <span>{block.name || 'tool'}</span>
            <span className="text-[var(--text-secondary)] font-normal">· result</span>
          </div>
          {out && (
            <pre className="mt-1 text-[11px] text-[var(--text-secondary)] whitespace-pre-wrap break-words bg-[var(--bg-secondary)] rounded p-2 border border-[var(--border)] overflow-x-auto max-h-60 overflow-y-auto">
              {out.length > 4000 ? out.substring(0, 4000) + '\n...(truncated)' : out}
            </pre>
          )}
        </div>
      )
    }

    default:
      return null
  }
}
