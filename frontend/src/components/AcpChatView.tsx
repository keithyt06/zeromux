import { useState, useEffect, useRef, useCallback, useMemo, memo, createElement, lazy, Suspense } from 'react'
import { uploadSessionFile, getSessionRuns, getCrewMemory, putCrewSemantic, deleteCrewSemantic } from '../lib/api'
import type { SemanticEntry } from '../lib/api'
import { normalizeMemoryKey, parseSemanticValue } from '../lib/crewMemory'
import { peerLabel } from '../lib/peer'
import { ChevronDown, Wrench, Brain, AlertCircle, FileText, Terminal, Search, Bot, Paperclip, ListPlus, X, Ban, Check, type LucideIcon } from 'lucide-react'
import MarkdownContent from './markdown/MarkdownContent'
import Composer from './Composer'
import ConnectionBar from './ConnectionBar'
import PromptManager from './PromptManager'
import { usePromptPresets } from '../lib/usePromptPresets'
import { applyPreset } from '../lib/applyPreset'
const RunMetricsPanel = lazy(() => import('./RunMetricsPanel').then(m => ({ default: m.RunMetricsPanel })))
import { SessionLifetimeBadge } from './SessionLifetimeBadge'
import { foldTranscript, stabilizeGroups, type WireEvent, type Block, type TurnGroup } from '../lib/transcript'
import { partitionBlocks, type Density } from '../lib/density'
import { STUCK_SILENCE_MS } from '../lib/stuck'
import { shouldStickToBottom, shouldAutoScrollOnAppend, shouldTrackScrollUp } from '../lib/scrollReplay'
import type { PendingApproval, RegisterControls } from '../lib/sessionControls'
import { useAcpSocket, newId, type Notice } from '../hooks/useAcpSocket'

// ── Message types ──

type ContentBlock = Block

interface Props {
  sessionId: string
  active: boolean
  agentType?: 'claude' | 'crew' | 'codex'
  // Lets the parent (App→SessionInfoBar) drive WS-only controls that live in
  // this component. Registered on mount, cleared on unmount. (G2b queue mode.)
  onRegisterControls?: RegisterControls
  // Report the backend-authoritative queue mode UP to App so the sibling
  // SessionInfoBar dropdown reflects the real mode (review 2026-07-28). The
  // functional path uses queueModeRef; this only mirrors the same value into
  // App state so the visible control can't lie (observer tab / reconnect showing
  // 'Collect' while the backend is 'Interrupt' → an unintended interrupt on send).
  onQueueModeChange?: (sessionId: string, mode: string) => void
  // Inline run-metrics panel visibility, owned by App (toggled from SessionInfoBar).
  showMetrics?: boolean
  // 「全部 →」跳记忆面板（第 5 个 overlay view，由 App 拥有）。未传时 popover 里
  // 那个入口仅关弹层，不报错 —— composer 的就地写入不依赖面板存在。
  onOpenMemory?: () => void
  // Claude peer name → session title, for labeling cross-session messages.
  peerNames?: Record<string, string>
}

const EMPTY_PEERS: Record<string, string> = {}

// `active` is accepted (App passes it for all session views) but no longer used:
// the Composer owns its own textarea and we intentionally don't auto-focus it,
// so switching to a chat session doesn't pop the mobile keyboard.
export default function AcpChatView({ sessionId, agentType = 'claude', onRegisterControls, onQueueModeChange, showMetrics, onOpenMemory, peerNames = EMPTY_PEERS }: Props) {
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
  const onReplayDone = useCallback(() => {
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
  }, [])
  const [pending, setPending] = useState<string[]>([])   // 已上传待发的实际路径
  const pendingRef = useRef(pending)
  useEffect(() => { pendingRef.current = pending }, [pending])
  const {
    events, notices, pushNotice,
    busy, turnStartedMs, lastEventMs, nowMs,
    queuedCount, wsStatus, ctxUsage, resolvedApprovals, metricsRefresh,
    sendPrompt, setQueueMode, interrupt, resolveApproval,
  } = useAcpSocket({
    sessionId, onQueueModeChange,
    onAppend: scrollBottom,
    // Arm the replay window: auto bottom-stick is allowed until replay_done,
    // and only while the user hasn't scrolled up to read history.
    onOpen: () => { replayingRef.current = true; userScrolledUpRef.current = false },
    onReplayDone,
    getPending: () => pendingRef.current, clearPending: () => setPending([]),
  })
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
  const [input, setInput] = useState('')
  const presetStore = usePromptPresets()
  const [presetOpen, setPresetOpen] = useState(false)
  const [presetManaging, setPresetManaging] = useState(false)
  const closePreset = useCallback(() => { setPresetOpen(false); setPresetManaging(false) }, [])
  // ── 就地记忆写入（composer 第 3 个按钮）──
  // 人只在「被冒犯的那一刻」想纠正记忆（agent 刚用了 npm 而你说过 pnpm），那一刻
  // 拇指在输入框上。要求用户「打开设置去配置偏好」= 问卷 = 没人填。
  const [memOpen, setMemOpen] = useState(false)
  const [memDraft, setMemDraft] = useState('')
  const [memRecent, setMemRecent] = useState<SemanticEntry[]>([])
  const [memBusy, setMemBusy] = useState(false)
  const [memErr, setMemErr] = useState<string | null>(null)
  const [memConfirming, setMemConfirming] = useState<string | null>(null)
  // 单调请求令牌：popover 一开就冷 GET，同时用户可能立刻写/删（乐观 setMemRecent）。
  // 没有它，写入前发出的旧快照迟到会盖掉刚加的条目 / 复活刚删的 ghost。
  const memReqRef = useRef(0)
  const closeMem = useCallback(() => { setMemOpen(false); setMemConfirming(null); setMemErr(null) }, [])
  const [uploading, setUploading] = useState(0)           // 上传中计数
  const fileInputRef = useRef<HTMLInputElement>(null)
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


  // 记忆的读/写/删。**必须放在 pushNotice 之后** —— 它们依赖它，放前面会 TDZ 报错。
  const loadMemRecent = useCallback(async () => {
    const req = ++memReqRef.current
    try {
      const data = await getCrewMemory()
      if (memReqRef.current !== req) return
      // 最近 5 条：updated_at 倒序（Gateway 不保证顺序）。
      setMemRecent([...data.semantic]
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .slice(0, 5))
      setMemErr(null)
    } catch (e) {
      if (memReqRef.current !== req) return
      setMemErr(e instanceof Error ? e.message : String(e))
    }
  }, [])

  const rememberMem = useCallback(async () => {
    const text = memDraft.trim()
    if (!text || memBusy) return
    setMemBusy(true)
    setMemErr(null)
    try {
      const { key, value } = normalizeMemoryKey(text)
      await putCrewSemantic(key, value)
      memReqRef.current++
      const now = new Date().toISOString()
      setMemRecent(prev => [
        { key, value_json: JSON.stringify(value), confidence: 1.0, source: 'user_explicit',
          created_at: now, updated_at: now, is_deleted: 0 },
        ...prev.filter(e => e.key !== key),
      ].slice(0, 5))
      setMemDraft('')
      // 写入回执：在对话流留一行轻量提示。可见性靠回执，不靠面板 —— 用户一天不会
      // 主动打开记忆面板。NoticeBubble 的 system 分支正是这个视觉。
      pushNotice({ id: newId(), kind: 'system', text: `已记住：${value}` })
    } catch (e) {
      setMemErr(e instanceof Error ? e.message : String(e))
    }
    setMemBusy(false)
  }, [memDraft, memBusy, pushNotice])

  const forgetMem = useCallback(async (key: string) => {
    setMemConfirming(null)
    memReqRef.current++
    setMemRecent(prev => prev.filter(e => e.key !== key))
    try {
      await deleteCrewSemantic(key)
      pushNotice({ id: newId(), kind: 'system', text: `已忘掉：${key}` })
    } catch (e) {
      setMemErr(e instanceof Error ? e.message : String(e))
    }
    loadMemRecent()
  }, [pushNotice, loadMemRecent])


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

  const elapsed = turnStartedMs ? Math.floor((nowMs - turnStartedMs) / 1000) : 0
  // Silence-based, not turn-total-duration: a long but actively-streaming turn
  // is not stuck. Mirrors the sidebar amber dot / backend STUCK_SILENCE_MS.
  const stuck = busy && lastEventMs != null && (nowMs - lastEventMs) > STUCK_SILENCE_MS
  const silenceSecs = lastEventMs != null ? Math.floor((nowMs - lastEventMs) / 1000) : 0

  // Latest events / resolved map mirrored into refs so pendingApprovals stays a
  // stable callback — otherwise the registration effect below would re-run on
  // every streamed event.
  const eventsRef = useRef<WireEvent[]>([])
  useEffect(() => { eventsRef.current = events }, [events])
  const resolvedRef = useRef(resolvedApprovals)
  useEffect(() => { resolvedRef.current = resolvedApprovals }, [resolvedApprovals])
  const pendingApprovals = useCallback((): PendingApproval[] =>
    eventsRef.current
      .filter(e => e.type === 'content_block' && e.block_type === 'approval' && e.approval_id && !resolvedRef.current[e.approval_id])
      .map(e => ({ id: e.approval_id!, tool: e.name ?? '', ...(e.summary ? { purpose: e.summary } : {}) })),
  [])

  // Register WS-only controls so SessionInfoBar (rendered by App, a sibling)
  // can drive them for the active session. Clear on unmount.
  useEffect(() => {
    onRegisterControls?.(sessionId, { setQueueMode, sendPrompt, interrupt, resolveApproval, pendingApprovals })
    return () => onRegisterControls?.(sessionId, null)
  }, [sessionId, setQueueMode, sendPrompt, interrupt, resolveApproval, pendingApprovals, onRegisterControls])

  // Esc closes the preset popover (parity with the Sidebar pick-prompt step).
  useEffect(() => {
    if (!presetOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closePreset() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [presetOpen, closePreset])

  // Esc 同样关记忆 popover（与 preset 一致，否则桌面端两个弹层行为不一致）。
  useEffect(() => {
    if (!memOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeMem() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [memOpen, closeMem])


  // Disconnect the replay-follow ResizeObserver and its disarm timer on unmount.
  useEffect(() => () => {
    roRef.current?.disconnect()
    followingRef.current = false
    if (roTimerRef.current) clearTimeout(roTimerRef.current)
  }, [])

  return (
    <div className="flex flex-col h-full">
      {(lifetime.turns > 0 || ctxUsage) && (
        <div className="px-5 pt-2 pb-0 flex justify-end items-center gap-2">
          {ctxUsage && (
            <span className="text-[10px] text-[var(--text-muted)]" title="上下文用量（Crew 提供）">
              ctx {Math.round((ctxUsage.used / ctxUsage.total) * 100)}%
            </span>
          )}
          {lifetime.turns > 0 && <SessionLifetimeBadge agentType={agentType} lifetime={lifetime} />}
        </div>
      )}
      {showMetrics && (
        <Suspense fallback={null}>
          <RunMetricsPanel
            sessionId={sessionId}
            turnStartedMs={turnStartedMs}
            running={busy}
            refreshKey={metricsRefresh}
          />
        </Suspense>
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
            agentName={agentType === 'crew' ? 'Crew' : agentType === 'codex' ? 'Codex' : 'Claude'}
            density={density}
            onExpand={expandDensity}
            resolvedApprovals={resolvedApprovals}
            onResolveApproval={resolveApproval}
            peerNames={peerNames}
          />
        ))}
        {notices.map(n => <NoticeBubble key={n.id} notice={n} />)}
      </div>

      <ConnectionBar status={wsStatus.status} sinceMs={wsStatus.since} />
      <div className="relative flex flex-col px-4 py-3 border-t border-[var(--border)] bg-[var(--bg-secondary)]">
        {queuedCount > 0 && (
          <div className="px-2 pb-1 text-xs text-[var(--text-muted)]">
            已排队 {queuedCount} 条，本轮结束后合并发送
          </div>
        )}
        {busy && (
          <div className="flex items-center gap-2 px-2 pb-1 text-xs">
            {stuck ? (
              <span className="text-[var(--accent-red)]">已静默 {silenceSecs}s，可能卡住</span>
            ) : (
              <span className="text-[var(--text-muted)] italic">已运行 {elapsed}s…</span>
            )}
            {/* Always available while busy: a CLI-started (cross-session) turn is
                autonomous work the user did not start and must be able to stop
                from a phone (spec 2026-09-26 v2 §3e). */}
            <button
              onClick={interrupt}
              className={`px-2 py-0.5 text-[10px] font-semibold border rounded transition-colors ${
                stuck
                  ? 'text-[var(--accent-red)] border-[var(--accent-red)] hover:bg-[var(--accent-red)] hover:text-white'
                  : 'text-[var(--text-secondary)] border-[var(--border)] hover:text-[var(--text-primary)]'
              }`}
            >
              中断
            </button>
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
        {memOpen && (
          <div className="fixed inset-0 z-10" onClick={closeMem} aria-hidden="true" />
        )}
        {memOpen && (
          <div className="absolute bottom-full left-0 right-0 mb-2 mx-2 rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] shadow-lg z-20">
            <div className="p-2 flex flex-col gap-2">
              <div className="flex items-center gap-1.5">
                <Brain size={12} className="text-[var(--accent-purple)] shrink-0" />
                <span className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider flex-1">记忆</span>
              </div>
              <div className="flex gap-2">
                <input
                  value={memDraft}
                  onChange={e => setMemDraft(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); rememberMem() } }}
                  placeholder="让它记住…"
                  aria-label="memory draft"
                  /* text-base = 16px：低于 16px 时 iOS Safari 聚焦会自动放大整页，
                     把发送键挤出视口（Composer.tsx 的既有教训）。 */
                  className="flex-1 min-w-0 text-base bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg px-3 py-2 min-h-[44px] text-[var(--text-primary)] outline-none focus:border-[var(--accent-purple)] placeholder-[var(--text-muted)]"
                />
                <button
                  onClick={rememberMem}
                  disabled={!memDraft.trim() || memBusy}
                  className="shrink-0 px-3 min-h-[44px] rounded-lg bg-[var(--accent-purple)] disabled:bg-[var(--btn-disabled-bg)] disabled:text-[var(--btn-disabled-text)] text-white text-xs font-medium transition-colors"
                >
                  {memBusy ? '写入中' : '记住'}
                </button>
              </div>
              {memErr && <p className="text-[10px] text-[var(--accent-red)] break-words">{memErr}</p>}
              <div className="text-[10px] text-[var(--text-muted)]">
                {memRecent.length > 0 ? `它记错了？(最近 ${memRecent.length} 条)` : '还没有记住任何偏好'}
              </div>
              {/* ✕ 常驻，绝不 group-hover（Tailwind v4 编进 @media (hover:hover)，
                  手机上 = 隐形按钮）。点 ✕ → 该行下沉展开确认，不用 window.confirm。 */}
              {memRecent.map(e => (
                <div key={e.key} className="rounded border border-[var(--border)]">
                  <div className="flex items-center gap-2 px-2 py-1.5 min-h-[44px]">
                    <span className="flex-1 min-w-0 text-[11px] text-[var(--text-primary)] break-words leading-snug">
                      {e.key.replace(/^(pref|project|user|lesson)\./, '')}
                      <span className="text-[var(--accent-purple)]"> = {parseSemanticValue(e.value_json)}</span>
                    </span>
                    <button
                      onClick={() => setMemConfirming(cur => cur === e.key ? null : e.key)}
                      data-testid="mem-forget"
                      aria-label={`forget ${e.key}`}
                      className="shrink-0 w-8 min-h-[44px] -my-1.5 flex items-center justify-center text-[var(--text-secondary)] hover:text-[var(--accent-red)] transition-colors"
                    >
                      <X size={13} />
                    </button>
                  </div>
                  {memConfirming === e.key && (
                    <button
                      data-testid="mem-forget-confirm"
                      onClick={() => forgetMem(e.key)}
                      className="flex items-center gap-2 w-full px-2 py-2 min-h-[44px] border-t border-[var(--border)] text-[11px] text-[var(--text-secondary)] hover:text-[var(--accent-red)] hover:bg-[var(--bg-hover)]"
                    >
                      <X size={12} className="shrink-0" />确认移除，让它忘掉
                    </button>
                  )}
                </div>
              ))}
              <div className="flex justify-between">
                <button
                  onClick={() => { closeMem(); onOpenMemory?.() }}
                  className="px-2 py-1 text-[10px] font-semibold text-[var(--accent-purple)] hover:opacity-80"
                >
                  全部 →
                </button>
                <button onClick={closeMem} className="px-2 py-1 text-[10px] text-[var(--text-muted)] hover:text-[var(--text-primary)]">
                  关闭
                </button>
              </div>
            </div>
          </div>
        )}
        <Composer
          value={input}
          onChange={setInput}
          onSend={(t) => { const ok = sendPrompt(t); if (ok) setInput(''); return ok }}
          submitOnEnter={true}
          placeholder={`Send a message to ${agentType === 'crew' ? 'Crew' : agentType === 'codex' ? 'Codex' : 'Claude'}...`}
          rightSlot={
            <div className="flex items-end gap-1">
              <button
                onClick={() => {
                  setPresetManaging(false)
                  // 两个 popover 都是 absolute bottom-full，同时开会重叠 —— 互斥。
                  setMemOpen(false)
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
              {/* 仅 Crew 会话。宽度核算：现有 2 按钮各 p-2+size16 ≈ 32px 加发送键
                  40px = 104px；375px 屏下 textarea 约 246px。加这个 → 136px，
                  textarea 剩 ~214px。接近极限，故其它后端不渲染。 */}
              {agentType === 'crew' && (
                <button
                  onClick={() => {
                    setMemConfirming(null)
                    closePreset()
                    setMemOpen(o => { if (!o) loadMemRecent(); return !o })
                  }}
                  aria-label="memory"
                  className="self-end p-2 text-[var(--text-muted)] hover:text-[var(--accent-purple)] rounded-lg transition-colors"
                  title="记忆"
                >
                  <Brain size={16} />
                </button>
              )}
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
function TurnGroupViewImpl({ group, agentName = 'Claude', density = 'concise', onExpand, resolvedApprovals, onResolveApproval, peerNames }: {
  group: TurnGroup; agentName?: string; density?: Density; onExpand?: () => void
  /** approval id → 本端已作出的决定；有值则卡片收起按钮，显示结果。 */
  resolvedApprovals?: Record<string, 'approve' | 'reject'>
  onResolveApproval?: (approvalId: string, action: 'approve' | 'reject') => void
  peerNames?: Record<string, string>
}) {
  const { visible, collapsedCount } = partitionBlocks(group.blocks, density)
  return (
    <div className="space-y-4">
      {group.userPrompts.map((p, i) => (
        <div key={p.clientId ?? i}>
          <p className={`text-[11px] font-semibold mb-0.5 ${p.fromName ? 'text-[var(--accent-purple)]' : 'text-[var(--accent-blue)]'}`}>
            {p.fromName ? `来自 @${peerLabel(p.fromName, peerNames ?? {})}` : 'You'}
          </p>
          <p className="text-sm text-[var(--text-primary)] whitespace-pre-wrap">{p.text}</p>
        </div>
      ))}
      {group.blocks.length > 0 && (
        <div className="space-y-2">
          <p className="text-[11px] font-semibold text-[var(--accent-purple)] mb-0.5">{agentName}</p>
          {visible.map((b, i) => (
            <BlockView
              key={i}
              block={b}
              isComplete={group.complete}
              approvalDecision={b.approvalId ? resolvedApprovals?.[b.approvalId] : undefined}
              onResolveApproval={onResolveApproval}
            />
          ))}
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
    prev.onExpand === next.onExpand &&
    // Must be compared, or answering an approval would not re-render the card:
    // stabilizeGroups (:92, 2026-08-03 F-perf) deliberately keeps a completed
    // turn's object identity, so nothing else changes when the decision lands.
    prev.resolvedApprovals === next.resolvedApprovals &&
    prev.onResolveApproval === next.onResolveApproval &&
    // Same reason: a renamed session must relabel already-finished peer bubbles.
    prev.peerNames === next.peerNames
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

function BlockView({ block, isComplete, approvalDecision, onResolveApproval }: {
  block: ContentBlock
  isComplete: boolean
  approvalDecision?: 'approve' | 'reject'
  onResolveApproval?: (approvalId: string, action: 'approve' | 'reject') => void
}) {
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

    case 'approval': {
      // 内联而非图标位：审批天然属于某个 turn 的某个 tool_call，且 SessionInfoBar
      // 的 5 图标已是硬上限。**必须有这个 case** —— BlockView 的 default 是
      // `return null`，未知 block_type 渲染为空 = 什么都没发生。
      const aid = block.approvalId
      return (
        <div className="border-l-2 border-[var(--accent-red)] pl-2.5 py-1.5 text-xs">
          <div className="flex items-center gap-1 text-[var(--accent-red)] font-medium">
            <AlertCircle size={12} className="shrink-0" />
            <span>需要你批准</span>
            {block.name && (
              <span className="text-[var(--text-primary)] font-normal truncate min-w-0 flex-1">· {block.name}</span>
            )}
          </div>
          {block.summary && (
            <p className="mt-1 text-[11px] text-[var(--text-secondary)] break-words leading-snug">{block.summary}</p>
          )}
          {block.text && (
            <pre className="mt-1 text-[11px] text-[var(--text-secondary)] whitespace-pre-wrap break-words bg-[var(--bg-secondary)] rounded p-2 border border-[var(--border)] overflow-x-auto max-h-40 overflow-y-auto">
              {block.text.length > 2000 ? block.text.substring(0, 2000) + '\n...(truncated)' : block.text}
            </pre>
          )}
          {approvalDecision ? (
            <p className="mt-1.5 text-[11px] text-[var(--text-muted)] italic">
              {approvalDecision === 'approve' ? '已批准' : '已拒绝'}
            </p>
          ) : aid ? (
            /* min-h-[44px] 触控目标。 */
            <div className="mt-2 flex gap-2">
              <button
                data-testid="approval-reject"
                onClick={() => onResolveApproval?.(aid, 'reject')}
                className="flex-1 min-h-[44px] rounded-lg border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--accent-red)] hover:border-[var(--accent-red)] text-xs font-medium transition-colors inline-flex items-center justify-center gap-1"
              >
                <Ban size={13} />拒绝
              </button>
              <button
                data-testid="approval-approve"
                onClick={() => onResolveApproval?.(aid, 'approve')}
                className="flex-1 min-h-[44px] rounded-lg bg-[var(--accent-green)] hover:bg-[var(--accent-green-hover)] text-white text-xs font-medium transition-colors inline-flex items-center justify-center gap-1"
              >
                <Check size={13} />批准
              </button>
            </div>
          ) : (
            /* approval_id 缺失 = 后端 bug。绝不渲染两个点了没反应的按钮。 */
            <p className="mt-1.5 text-[11px] text-[var(--accent-yellow)]">审批 id 缺失，无法在此回答</p>
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
