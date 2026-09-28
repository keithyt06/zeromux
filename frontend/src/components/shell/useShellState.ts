import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import type { SessionInfo, SessionType, HostTmux, TaskRun } from '../../lib/api'
import { createSession, deleteSession, closeCheck, updateSession } from '../../lib/api'
import { closeConfirmMessage } from '../../lib/closeSession'
import { notifyQuickTargetsChanged } from '../../lib/quickTargetsBus'
import { undoCloseToast } from '../../lib/undoCloseToast'
import { type DocTab, newDocTab, loadDocTabs, saveDocTabs, DEFAULT_DOC_TITLE } from '../../lib/docTabs'
import { pickDocTabForTarget } from '../../lib/docTarget'
import { loadLastViewed, reconcileLastViewed, markViewed, saveLastViewed } from '../../lib/readState'
import { useControlsRegistry, type SessionControls, type RegisterControls } from '../../lib/sessionControls'
import { toast, confirm } from '../ui'
import { useSessionsPoll } from './useSessionsPoll'

export type ContextTab = 'git' | 'files' | 'runs'
/** tabChosen: the tab was set explicitly (user pick / deep link), so defaults must not override it. */
export interface ContextState { open: boolean; tab: ContextTab; nonce?: number; tabChosen?: boolean }
type VaultTarget = { path: string; kind: 'note' | 'folder' }

export interface ShellState {
  sessions: SessionInfo[]; hostTmux: HostTmux[]; docTabs: DocTab[]
  /** True once a session list has loaded from the server (a deep-linked id can't be judged gone before that). */
  sessionsLoaded: boolean
  activeId: string | null; select(id: string | null): void
  lastViewedMs: Record<string, number>
  queueModes: Record<string, string>; onQueueModeChange(sid: string, mode: string): void
  ctxUsage: Record<string, { used: number; total: number } | null>; onCtxUsage(sid: string, u: { used: number; total: number } | null): void
  confirmRuns: TaskRun[]; confirmsBySession: Record<string, number>; orphanConfirms: number; schedulerHealthy: boolean
  controls: React.RefObject<Record<string, SessionControls>>; registerControls: RegisterControls
  create(type: SessionType | 'vault', workDir?: string, tmuxTarget?: string, prompt?: string): Promise<void>
  close(id: string): Promise<void>; rename(id: string, name: string, description: string): Promise<void>
  openVault(t: VaultTarget): void; docTargets: Record<string, VaultTarget & { nonce: number }>
  closeDocTab(id: string): void; updateDocTabTitle(id: string, title: string | null): void
  historyReq: { id: string; nonce: number } | null; openHistory(id: string): void
  context: Record<string, ContextState>; contextOf(s: SessionInfo): ContextState
  setContext(sid: string, patch: Partial<ContextState>): void
  /** The session's dir is not a git repo: default its panel to 文件 unless a tab was chosen. */
  onNotGit(sid: string): void
}

/** Everything App.tsx used to own, minus auth (spec v3 M1). */
/** narrow = phone layout (triage is home; nothing auto-selected). wide = ≥1280px,
 *  where the ContextPanel is an inline column and so may default open (S3 V3). */
export function useShellState(authActive: boolean, onAuthLost: () => void, { narrow = false, wide = true }: { narrow?: boolean; wide?: boolean } = {}): ShellState {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [sessionsLoaded, setSessionsLoaded] = useState(false)
  const setLoadedSessions = useCallback((list: SessionInfo[]) => { setSessions(list); setSessionsLoaded(true) }, [])
  const [hostTmux, setHostTmux] = useState<HostTmux[]>([])
  const [docTabs, setDocTabs] = useState<DocTab[]>(() => loadDocTabs())
  // Ref mirror so loadSessions (captures a stale docTabs closure) can resolve the
  // initial active pane against the live doc-tab list.
  const docTabsRef = useRef(docTabs)
  useEffect(() => { docTabsRef.current = docTabs; saveDocTabs(docTabs) }, [docTabs])
  // In-memory only (never persisted): refresh reopens doc tabs in list mode.
  const [docTargets, setDocTargets] = useState<Record<string, VaultTarget & { nonce: number }>>({})
  const nonceRef = useRef(0)
  const [activeId, setActiveId] = useState<string | null>(null)
  const { controls, register: registerControls } = useControlsRegistry()
  // Backend-authoritative queue mode per session, reported up by AcpChatView from
  // replay_done / the live queue_mode broadcast / a delivered flip. Drives the
  // VISIBLE control so it reflects the real mode — an observer tab or a reconnected
  // tab must not show 'Collect' while the backend is 'Interrupt' (which would make a
  // send silently interrupt the running turn). Display-truth only (I-6).
  const [queueModes, setQueueModes] = useState<Record<string, string>>({})
  const onQueueModeChange = useCallback((sid: string, mode: string) => {
    setQueueModes(prev => (prev[sid] === mode ? prev : { ...prev, [sid]: mode }))
  }, [])
  const [ctxUsage, setCtxUsage] = useState<Record<string, { used: number; total: number } | null>>({})
  const onCtxUsage = useCallback((sid: string, u: { used: number; total: number } | null) => {
    setCtxUsage(prev => (prev[sid]?.used === u?.used && prev[sid]?.total === u?.total ? prev : { ...prev, [sid]: u }))
  }, [])
  const [confirmRuns, setConfirmRuns] = useState<TaskRun[]>([])
  const [schedulerHealthy, setSchedulerHealthy] = useState(true)
  // One-shot request from ⋯ 查看历史 → the target TerminalView opens its history
  // drawer. nonce so re-requesting the same session still re-fires the effect.
  const [historyReq, setHistoryReq] = useState<{ id: string; nonce: number } | null>(null)
  // Per-session ContextPanel state, page lifetime only (S3 V3: not persisted).
  const [context, setContextState] = useState<Record<string, ContextState>>({})

  // ── read state (M10) ──
  const [lastViewedMs, setLastViewedMs] = useState(loadLastViewed)
  useEffect(() => {
    // Baseline new sids at "now" (never mark history unread) and GC vanished ones (M10).
    // Only once the list has loaded: an empty pre-load list would GC every entry.
    if (sessions.length === 0) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- derived bookkeeping on each poll; returns prev when unchanged
    setLastViewedMs(prev => reconcileLastViewed(prev, sessions.map(s => s.id), Date.now()))
  }, [sessions])
  useEffect(() => { saveLastViewed(lastViewedMs) }, [lastViewedMs])
  const select = useCallback((id: string | null) => {
    setActiveId(id)
    if (id) setLastViewedMs(prev => markViewed(prev, id, Date.now()))
  }, [])
  // Every path that sets activeId (poll resolve, ?session=, create) marks on enter;
  // and again on leave, so a turn that completed while being watched isn't unread afterwards.
  useEffect(() => {
    if (!activeId) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read-state bookkeeping keyed on focus
    setLastViewedMs(p => markViewed(p, activeId, Date.now()))
    return () => setLastViewedMs(p => markViewed(p, activeId, Date.now()))
  }, [activeId])

  const sessionsRef = useRef(sessions)
  useEffect(() => { sessionsRef.current = sessions }, [sessions])
  const narrowRef = useRef(narrow)
  useEffect(() => { narrowRef.current = narrow }, [narrow])
  const wideRef = useRef(wide)
  useEffect(() => { wideRef.current = wide }, [wide])
  const setContext = useCallback((sid: string, patch: Partial<ContextState>) => {
    setContextState(prev => {
      const cur = prev[sid]
      const s = sessionsRef.current.find(x => x.id === sid)
      const base = cur ?? { open: !!s && s.type !== 'tmux' && wideRef.current, tab: 'git' as ContextTab }
      return { ...prev, [sid]: { ...base, ...patch, ...(patch.tab ? { tabChosen: true } : {}) } }
    })
  }, [])
  const onNotGit = useCallback((sid: string) => {
    setContextState(prev => {
      const cur = prev[sid]
      if (cur?.tabChosen || cur?.tab === 'files') return prev
      const s = sessionsRef.current.find(x => x.id === sid)
      const base = cur ?? { open: !!s && s.type !== 'tmux' && wideRef.current, tab: 'git' as ContextTab }
      return { ...prev, [sid]: { ...base, tab: 'files' } }
    })
  }, [])
  const contextOf = useCallback((s: SessionInfo): ContextState =>
    context[s.id] ?? { open: s.type !== 'tmux' && wide, tab: 'git' }, [context, wide])

  const onOpenFromPush = useCallback((sid: string, gitDirty: number) => {
    select(sid)
    // M26: a finished turn that left uncommitted changes opens the Git「改动」view.
    if (gitDirty > 0) setContext(sid, { open: true, tab: 'git', nonce: Date.now() })
  }, [select, setContext])

  const { reload } = useSessionsPoll({
    enabled: authActive, onAuthLost, setSessions: setLoadedSessions, setHostTmux, setActiveId,
    docTabIds: () => docTabsRef.current.map(t => t.id),
    setConfirmRuns, setSchedulerHealthy, onOpenFromPush, activeId, autoSelect: !narrow,
  })

  const { confirmsBySession, orphanConfirms } = useMemo(() => {
    const ids = new Set(sessions.map(s => s.id))
    const by: Record<string, number> = {}
    let orphan = 0
    for (const r of confirmRuns) {
      if (r.session_id && ids.has(r.session_id)) by[r.session_id] = (by[r.session_id] ?? 0) + 1
      else orphan++
    }
    return { confirmsBySession: by, orphanConfirms: orphan }
  }, [confirmRuns, sessions])

  const create = useCallback(async (type: SessionType | 'vault', workDir?: string, tmuxTarget?: string, initialPrompt?: string) => {
    if (type === 'vault') {
      const tab = newDocTab(DEFAULT_DOC_TITLE)
      setDocTabs(prev => [...prev, tab])
      setActiveId(tab.id)
      return
    }
    const s = await createSession(type, undefined, workDir, tmuxTarget, initialPrompt)
    notifyQuickTargetsChanged()   // the backend just bumped; re-rank any mounted quick lists
    setSessions(prev => [...prev, s])
    // Attached host tmux is tracked now: drop it from the group before the next poll.
    if (tmuxTarget) setHostTmux(prev => prev.filter(h => h.name !== tmuxTarget))
    setActiveId(s.id)
  }, [])

  const openVault = useCallback((target: VaultTarget) => {
    const nonce = ++nonceRef.current
    const existing = pickDocTabForTarget(docTabsRef.current)
    const id = existing ?? (() => {
      const tab = newDocTab(DEFAULT_DOC_TITLE)
      setDocTabs(prev => [...prev, tab])
      return tab.id
    })()
    setDocTargets(prev => ({ ...prev, [id]: { ...target, nonce } }))
    setActiveId(id)
  }, [])

  const closeDocTab = useCallback((id: string) => {
    setDocTabs(prev => {
      const next = prev.filter(t => t.id !== id)
      setActiveId(cur => cur === id
        ? (narrowRef.current ? null : (next[0]?.id ?? sessionsRef.current[0]?.id ?? null))   // fall back within doc tabs, else a real session, else null
        : cur)
      return next
    })
    setDocTargets(prev => { const { [id]: _, ...rest } = prev; return rest })
  }, [])

  const updateDocTabTitle = useCallback((id: string, title: string | null) => {
    setDocTabs(prev => prev.map(t => t.id === id ? { ...t, title: title ?? DEFAULT_DOC_TITLE } : t))
  }, [])

  const activeIdRef = useRef(activeId)
  useEffect(() => { activeIdRef.current = activeId }, [activeId])
  // Stable identity (reads live state through refs) so memoized triage rows that
  // captured it never act on a stale session list.
  const close = useCallback(async (id: string) => {
    const s = sessionsRef.current.find(x => x.id === id)
    if (s?.tmux_name) {
      const msg = closeConfirmMessage(s.name, await closeCheck(id))
      if (msg && !(await confirm({ title: msg, confirmLabel: '关闭', danger: true }))) return
    }
    let r: { pending_until?: number }
    try {
      r = await deleteSession(id)
    } catch {
      await reload()
      return
    }
    setSessions(prev => {
      const next = prev.filter(x => x.id !== id)
      if (activeIdRef.current === id) {
        setActiveId(narrowRef.current ? null : (next[0]?.id ?? docTabsRef.current[0]?.id ?? null))
      }
      return next
    })
    // End the toast a bit before the server's undo window so a late click can't
    // silently hit 410.
    if (r.pending_until && s) {
      const durationMs = Math.max(1000, (r.pending_until ?? 0) - Date.now() - 500) || 4500
      toast.push(undoCloseToast(id, s.name, durationMs, async () => { await reload(); setActiveId(id) }))
    }
  }, [reload])

  const rename = useCallback(async (id: string, name: string, description: string) => {
    const trimmed = name.trim()
    const cur = sessionsRef.current.find(s => s.id === id)
    if (!trimmed || !cur) return
    if (trimmed === cur.name && description === cur.description) return
    try {
      await updateSession(id, { name: trimmed, description })
      setSessions(prev => prev.map(s => s.id === id ? { ...s, name: trimmed, description } : s))
    } catch { toast.push({ message: '保存失败' }) }
  }, [])

  const openHistory = useCallback((id: string) => {
    select(id)
    setHistoryReq({ id, nonce: Date.now() })
  }, [select])

  return {
    sessions, sessionsLoaded, hostTmux, docTabs, activeId, select, lastViewedMs,
    queueModes, onQueueModeChange, ctxUsage, onCtxUsage,
    confirmRuns, confirmsBySession, orphanConfirms, schedulerHealthy,
    controls, registerControls, create, close, rename,
    openVault, docTargets, closeDocTab, updateDocTabTitle,
    historyReq, openHistory, context, contextOf, setContext, onNotGit,
  }
}
