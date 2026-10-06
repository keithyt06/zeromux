import { useState, useEffect, useRef, useCallback, useMemo, lazy, Suspense } from 'react'
import { uploadSessionFile, getSessionRuns, getCrewMemory, putCrewSemantic, deleteCrewSemantic } from '../lib/api'
import type { SemanticEntry } from '../lib/api'
import { normalizeMemoryKey, parseSemanticValue } from '../lib/crewMemory'
import { Brain, AlertCircle, ClipboardCheck, Paperclip, Plus, X } from 'lucide-react'
import Composer from './Composer'
import ConnectionBar from './ConnectionBar'
import { usePromptPresets } from '../lib/usePromptPresets'
import { resolvePresetPick, splitSlash } from '../lib/presetPick'
import type { PromptPreset } from '../lib/api'
import { IconButton, Menu, Popover, toast, type MenuItem } from './ui'
import { QueueChip } from './composer/QueueChip'
import { PresetPicker } from './composer/PresetPicker'
import { conventionPrompt, lastOwnPrompt } from '../lib/conventionPrompt'
import { SessionLifetimeBadge } from './SessionLifetimeBadge'
import { foldTranscript, stabilizeGroups, type TurnGroup } from '../lib/transcript'
import { shouldStickToBottom, shouldAutoScrollOnAppend, shouldTrackScrollUp } from '../lib/scrollReplay'
import type { PendingApproval, RegisterControls } from '../lib/sessionControls'
import { useAcpSocket, newId, type Notice } from '../hooks/useAcpSocket'
import { TurnView } from './turn/TurnView'
import { TurnStatusBar } from './turn/TurnStatusBar'

// F4 first-screen budget (≤0.5KB br): the 记为约定 editor loads on first open.
const ConventionDialog = lazy(() => import('./composer/ConventionDialog').then(m => ({ default: m.ConventionDialog })))

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
  /** Backend-authoritative queue mode for this session (shell.queueModes, I-6). The
   *  composer chip shows ONLY this; it changes once a flip is delivered. */
  queueMode?: string
  /** 「管理…」 at the bottom of the `/` preset list → the shell's prompts Sheet. */
  onManagePresets?: () => void
  // 「全部 →」打开记忆面板 Sheet（由 AppShell 拥有）。未传时 popover 里
  // 那个入口仅关弹层，不报错 —— composer 的就地写入不依赖面板存在。
  onOpenMemory?: () => void
  // Claude peer name → session title, for labeling cross-session messages.
  peerNames?: Record<string, string>
  /** Clicking a turn's touched-file chip opens the ContextPanel Git「改动」view.
   *  Takes the session id so the shell can pass ONE stable function to every view. */
  onOpenChanges?: (sessionId: string) => void
  /** Crew context usage, reported up so FocusHeader shows it. When absent (standalone
   *  mount) the view renders it inline itself. */
  onCtxUsage?: (sessionId: string, usage: { used: number; total: number } | null) => void
}

const EMPTY_PEERS: Record<string, string> = {}

// `active` only gates the `/` preset list (a hidden pane must not show or keep it).
// The Composer owns its own textarea and we intentionally don't auto-focus it,
// so switching to a chat session doesn't pop the mobile keyboard.
export default function AcpChatView({ sessionId, active, agentType = 'claude', onRegisterControls, onQueueModeChange, queueMode = 'collect', onManagePresets, onOpenMemory, peerNames = EMPTY_PEERS, onOpenChanges, onCtxUsage }: Props) {
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
    busy, turnStartedMs, lastEventMs,
    queuedCount, wsStatus, ctxUsage: ctxUsageRaw, resolvedApprovals, metricsRefresh,
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
  // rendered list so already-finished turns keep their identity and the TurnView
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
  useEffect(() => { onCtxUsage?.(sessionId, ctxUsageRaw) }, [onCtxUsage, sessionId, ctxUsageRaw])
  const ctxUsage = onCtxUsage ? null : ctxUsageRaw
  const agentName = agentType === 'crew' ? 'Crew' : agentType === 'codex' ? 'Codex' : 'Claude'
  // Stable identities so TurnView's memo keeps skipping finished turns (I-9).
  const resolveApprovalVoid = useCallback((id: string, a: 'approve' | 'reject') => { resolveApproval(id, a) }, [resolveApproval])
  const onInterrupt = useCallback(() => { interrupt() }, [interrupt])
  const openChanges = useCallback(() => { onOpenChanges?.(sessionId) }, [onOpenChanges, sessionId])
  const [input, setInput] = useState('')
  const presetStore = usePromptPresets()
  const { reload: reloadPresets } = presetStore
  // Line-start `/` → preset list (V7). null = not in slash mode; `slashDismissed`
  // keeps an Esc/tap-outside/pick/leave closed until the user types again (a pick's
  // own setInput must not reopen it, even if the preset body starts with `/`).
  const [slashQuery, setSlashQuery] = useState<string | null>(null)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const [composerBox, setComposerBox] = useState<HTMLDivElement | null>(null)
  const slashOnRef = useRef(false)
  const onSlash = useCallback((q: string | null) => {
    // Entering slash mode re-lists presets (last-writer-wins, see usePromptPresets).
    if (q !== null && !slashOnRef.current) reloadPresets()
    slashOnRef.current = q !== null
    setSlashQuery(q)
  }, [reloadPresets])
  const onType = useCallback((v: string) => { setInput(v); setSlashDismissed(false) }, [])
  // Leaving the session closes the list; coming back does not reopen it until typing.
  const [prevActive, setPrevActive] = useState(active)
  if (prevActive !== active) { setPrevActive(active); if (!active) setSlashDismissed(true) }
  const pickPreset = useCallback(async (p: PromptPreset) => {
    // Close first: the overwrite confirm must not share the keyboard with the list.
    setSlashDismissed(true)
    const next = await resolvePresetPick(p.body, splitSlash(slashQuery ?? '').arg)
    if (next !== null) setInput(next)
  }, [slashQuery])
  const [plusAnchor, setPlusAnchor] = useState<HTMLButtonElement | null>(null)
  const [plusOpen, setPlusOpen] = useState(false)
  // 「记为约定…」 (F4): prefill = composer text, else this session's last own prompt.
  const [convention, setConvention] = useState<string | null>(null)
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
  // Session lifetime (cumulative turns/duration/cost) — fetched from /runs so the
  // header badge is always available.
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

  // Latest folded groups / resolved map mirrored into refs so pendingApprovals stays a
  // stable callback — otherwise the registration effect below would re-run on
  // every streamed event. Only turns still in progress: an unanswered card in a
  // completed turn can no longer be resolved.
  const groupsRef = useRef<TurnGroup[]>([])
  useEffect(() => { groupsRef.current = groups }, [groups])
  const resolvedRef = useRef(resolvedApprovals)
  useEffect(() => { resolvedRef.current = resolvedApprovals }, [resolvedApprovals])
  const pendingApprovals = useCallback((): PendingApproval[] =>
    groupsRef.current.filter(g => !g.complete).flatMap(g => g.blocks)
      .filter(b => b.type === 'approval' && b.approvalId && !resolvedRef.current[b.approvalId])
      .map(b => ({ id: b.approvalId!, tool: b.name ?? '', ...(b.summary ? { purpose: b.summary } : {}) })),
  [])

  // Register WS-only controls so SessionInfoBar (rendered by App, a sibling)
  // can drive them for the active session. Clear on unmount.
  useEffect(() => {
    onRegisterControls?.(sessionId, { setQueueMode, sendPrompt, interrupt, resolveApproval, pendingApprovals })
    return () => onRegisterControls?.(sessionId, null)
  }, [sessionId, setQueueMode, sendPrompt, interrupt, resolveApproval, pendingApprovals, onRegisterControls])

  // 「＋」 menu (V8): 附件 upload, 记为约定 (F4, every agent), and ⌘ memory for Crew only.
  const plusItems: MenuItem[] = [
    { label: '附件', icon: Paperclip, onSelect: () => fileInputRef.current?.click() },
    { label: '记为约定…', icon: ClipboardCheck, onSelect: () => setConvention(input.trim() ? input : lastOwnPrompt(events)) },
    ...(agentType === 'crew' ? [{ label: '记忆', ariaLabel: 'memory', icon: Brain, onSelect: () => {
      setMemConfirming(null)
      setMemOpen(true)
      loadMemRecent()
    } }] : []),
  ]

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
        {groups.map(g => (
          <TurnView key={g.turnId} group={g} agentName={agentName} resolvedApprovals={resolvedApprovals}
            onResolveApproval={resolveApprovalVoid} peerNames={peerNames} onOpenChanges={onOpenChanges ? openChanges : undefined} />
        ))}
        {notices.map(n => <NoticeBubble key={n.id} notice={n} />)}
      </div>

      <ConnectionBar status={wsStatus.status} sinceMs={wsStatus.since} />
      <div className="relative flex flex-col px-4 py-3 border-t border-[var(--border)] bg-[var(--bg-secondary)]">
        {/* Interrupt is always available while busy: a CLI-started (cross-session)
            turn is autonomous work the user did not start and must be able to stop
            from a phone (spec 2026-09-26 v2 §3e). */}
        <TurnStatusBar busy={busy} turnStartedMs={turnStartedMs} lastEventMs={lastEventMs}
          queuedCount={queuedCount} onInterrupt={onInterrupt} />
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
        <Popover open={memOpen} onClose={closeMem} anchor={plusAnchor} placement="top" sheetTitle="记忆">
            <div className="p-2 flex flex-col gap-2 md:w-[296px]">
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
        </Popover>
        <PresetPicker open={active && slashQuery !== null && !slashDismissed} query={slashQuery ?? ''} presets={presetStore.presets}
          anchor={composerBox} onPick={pickPreset} onClose={() => setSlashDismissed(true)}
          onManage={() => { setSlashDismissed(true); onManagePresets?.() }} />
        <div ref={setComposerBox}>
        <Composer
          value={input}
          onChange={onType}
          onSend={(t) => { const ok = sendPrompt(t); if (ok) setInput(''); return ok }}
          submitOnEnter={true}
          placeholder={`Send a message to ${agentName}...`}
          onSlash={onSlash}
          leftSlot={
            <>
              <QueueChip mode={queueMode} busy={busy} onToggle={() => setQueueMode(queueMode === 'collect' ? 'interrupt' : 'collect')} />
              <span className="flex-1" />
              <IconButton ref={setPlusAnchor} label="更多" icon={Plus} onClick={() => { setSlashDismissed(true); closeMem(); setPlusOpen(o => !o) }} aria-haspopup="menu" aria-expanded={plusOpen} />
              <Menu open={plusOpen} onClose={() => setPlusOpen(false)} anchor={plusAnchor} items={plusItems} title="更多" />
              {convention !== null && <Suspense fallback={null}>
                <ConventionDialog open initial={convention} onClose={() => setConvention(null)}
                  onSend={t => {
                    // Same sendPrompt this view registers as sessionControls; never carry composer attachments.
                    const ok = sendPrompt(conventionPrompt(t), { withAttachments: false })
                    toast.push({ message: ok ? '已交给 agent 记录' : '未连接，稍后再试' })
                    return ok
                  }} />
              </Suspense>}
            </>
          }
        />
        </div>
      </div>
    </div>
  )
}

// ── Message rendering ──

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
