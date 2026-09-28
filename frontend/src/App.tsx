import { useState, useEffect, useCallback, useMemo, useRef, lazy, Suspense } from 'react'
import type { SessionInfo, SessionType, UserInfo, HostTmux } from './lib/api'
import { listSessions, listSessionsWithHost, createSession, deleteSession, closeCheck, checkAuth, legacyLogin, clearAuth, renameSession, listConfirmations, getSessionStatus, isAuthError } from './lib/api'
import { deepLinkView } from './lib/deeplink'
import { closeConfirmMessage } from './lib/closeSession'
import { notifyQuickTargetsChanged } from './lib/quickTargetsBus'
import { resyncPush, shouldResyncNow } from './lib/push'
import { useTheme } from './lib/theme'
import { useIsNarrow } from './lib/useMediaQuery'
import Sidebar from './components/Sidebar'
import TerminalView from './components/TerminalView'
import AcpChatView from './components/AcpChatView'
import LoginPage from './components/LoginPage'
import WaitingPage from './components/WaitingPage'
import SessionInfoBar from './components/SessionInfoBar'
import { Toaster, DialogHost, Skeleton, toast, confirm } from './components/ui'
// Off the first-screen graph (spec v3 M27): these are opened on demand.
const FileBrowser = lazy(() => import('./components/FileBrowser'))
const GitViewer = lazy(() => import('./components/GitViewer'))
const AgentDashboard = lazy(() => import('./components/AgentDashboard'))
const VaultReader = lazy(() => import('./components/VaultReader'))
const MemoryPanel = lazy(() => import('./components/MemoryPanel'))
const AdminPanel = lazy(() => import('./components/AdminPanel'))
const ScheduledTasksPanel = lazy(() => import('./components/ScheduledTasksPanel'))
const PushSettings = lazy(() => import('./components/PushSettings'))
const PromptsSheet = lazy(() => import('./components/PromptsSheet'))
import { undoCloseToast } from './lib/undoCloseToast'
import { type DocTab, newDocTab, isDocTabId, loadDocTabs, saveDocTabs, resolveActivePane, DEFAULT_DOC_TITLE } from './lib/docTabs'
import { pickDocTabForTarget } from './lib/docTarget'
import type { AskAgentTarget } from './lib/askAgent'
import { peerNamesKey, peerNamesFromKey } from './lib/peer'

type AuthState = 'loading' | 'unauthenticated' | 'pending' | 'active'
type OverlayView = 'none' | 'files' | 'git' | 'events' | 'memory'

export default function App() {
  const [authState, setAuthState] = useState<AuthState>('loading')
  const [user, setUser] = useState<UserInfo | null>(null)
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const peerKey = peerNamesKey(sessions)
  const peerNames = useMemo(() => peerNamesFromKey(peerKey), [peerKey])
  const [hostTmux, setHostTmux] = useState<HostTmux[]>([])
  const [docTabs, setDocTabs] = useState<DocTab[]>(() => loadDocTabs())
  // Ref mirror so loadSessions (captures a stale docTabs closure) can resolve the
  // initial active pane against the live doc-tab list.
  const docTabsRef = useRef(docTabs)
  useEffect(() => { docTabsRef.current = docTabs; saveDocTabs(docTabs) }, [docTabs])
  // In-memory only (never persisted): refresh reopens doc tabs in list mode.
  const [docTargets, setDocTargets] = useState<Record<string, { path: string; kind: 'note' | 'folder'; nonce: number }>>({})
  const [askAgentRequest, setAskAgentRequest] = useState<(AskAgentTarget & { nonce: number }) | null>(null)
  const nonceRef = useRef(0)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [overlay, setOverlay] = useState<Record<string, OverlayView>>({})
  // session id → turns_completed already seen (red-dot read baseline)
  const [readCounts, setReadCounts] = useState<Record<string, number>>({})
  // session id → inline run-metrics panel visibility. Inline (alongside chat),
  // not an overlay mode, so it coexists with the conversation.
  const [metricsOpen, setMetricsOpen] = useState<Record<string, boolean>>({})
  const baselineInit = useRef(false)
  // WS-only controls each AcpChatView registers, keyed by session id, so the
  // sibling SessionInfoBar can drive them (G2b queue mode).
  const sessionControls = useRef<Record<string, { setQueueMode: (mode: string) => void; sendPrompt: (text: string) => boolean }>>({})
  const registerControls = useCallback((sid: string, api: { setQueueMode: (mode: string) => void; sendPrompt: (text: string) => boolean } | null) => {
    if (api) sessionControls.current[sid] = api
    else delete sessionControls.current[sid]
  }, [])
  // Backend-authoritative queue mode per session, reported up by AcpChatView from
  // replay_done / the live queue_mode broadcast / a delivered flip. Drives the
  // SessionInfoBar dropdown so the VISIBLE control reflects the real mode — an
  // observer tab or a reconnected tab must not show 'Collect' while the backend is
  // 'Interrupt' (which would make a send silently interrupt the running turn).
  // The functional path (clock seeding) still uses AcpChatView's own queueModeRef;
  // this is display-truth only. (review 2026-07-28, F-OBS-LIVE follow-through)
  const [queueModes, setQueueModes] = useState<Record<string, string>>({})
  const handleQueueModeChange = useCallback((sid: string, mode: string) => {
    setQueueModes(prev => (prev[sid] === mode ? prev : { ...prev, [sid]: mode }))
  }, [])
  const themeCtx = useTheme()
  const isMobile = useIsNarrow()
  const [sidebarOpen, setSidebarOpen] = useState(!isMobile)
  const [confirmCount, setConfirmCount] = useState(0)
  const [panel, setPanel] = useState<null | 'admin' | 'scheduled' | 'push' | 'prompts'>(null)
  // One-shot request from the sidebar's ⋯ menu (查看历史) → the active
  // TerminalView opens its history drawer. nonce so re-requesting the same
  // session (already open) still re-fires the effect.
  const [historyReq, setHistoryReq] = useState<{ id: string; nonce: number } | null>(null)

  const initAuth = useCallback(async () => {
    try {
      const me = await checkAuth()
      if (me) {
        setUser(me)
        if (me.status === 'active') {
          setAuthState('active')
          loadSessions()
        } else {
          setAuthState('pending')
        }
      } else {
        // Genuine 401/403 → not authenticated.
        setAuthState('unauthenticated')
      }
    } catch {
      // Transient (5xx / network drop) at startup — e.g. a reload during the deploy
      // window (502/503) with a perfectly valid token. Do NOT eject to LoginPage;
      // stay in 'loading' (blank splash) and retry shortly. Only a real 401/403 (the
      // null branch above) means logged out. Mirrors the D-F1 fail-open poll. (F2)
      setTimeout(() => { initAuth() }, 2000)
    }
  }, [])

  useEffect(() => { initAuth() }, [initAuth])

  const loadSessions = useCallback(async () => {
    try {
      const r = await listSessionsWithHost()
      const list = r.sessions
      setSessions(list)
      setHostTmux(r.host_tmux)
      // Keep the prior selection if it still resolves; otherwise pick a session,
      // then a doc tab. Doc tabs alone (0 sessions) must still get a live pane.
      setActiveId(prev => resolveActivePane(prev, list.map(s => s.id), docTabsRef.current.map(t => t.id)))
    } catch (err) {
      // Only a real 401/403 means the session is gone — bounce to LoginPage. A
      // transient 5xx/network error must NOT log the user out (pre-D-F1 this caught
      // every error and could eject the user on a momentary blip). (D-F1)
      if (isAuthError(err)) setAuthState('unauthenticated')
    }
  }, [])

  // 3s polling: refresh session list so turn-state / activity fields stay live.
  // Replaces the whole list each tick; activeId is deliberately left untouched —
  // a background poll must not move user focus (a stale-snapshot response arriving
  // just after a local create would otherwise yank focus off the new session).
  // Transient failures are ignored (don't bounce to login).
  useEffect(() => {
    if (authState !== 'active') return
    const tick = setInterval(async () => {
      try {
        const r = await listSessionsWithHost()
        setSessions(r.sessions)
        setHostTmux(r.host_tmux)
      } catch (err) {
        // A WS client can't observe the 401 on a failed upgrade, so its onclose just
        // reconnects forever. This REST poll is the reliable detector of credential
        // expiry / de-approval: on a genuine 401/403, log out (→ LoginPage) instead of
        // leaving every mounted pane in a silent reconnect loop against stale creds.
        // A transient network drop / 5xx is NOT an auth failure — keep retrying. (D-F1)
        if (isAuthError(err)) {
          clearAuth()
          setAuthState('unauthenticated')
          setUser(null)
          setSessions([])
          setActiveId(null)
        }
        /* else: transient — ignore */
      }
    }, 3000)
    return () => clearInterval(tick)
  }, [authState])

  // Poll the confirmation queue so the sidebar badge stays live (now + every 30s).
  useEffect(() => {
    if (authState !== 'active') return
    let cancelled = false
    const poll = async () => {
      try {
        const r = await listConfirmations()
        if (!cancelled) setConfirmCount(r.count)
      } catch { /* ignore transient */ }
    }
    poll()
    const id = setInterval(poll, 30_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [authState])

  // SW: report active session on change (allows SW to suppress front-tab notifications)
  useEffect(() => {
    const sw = navigator.serviceWorker?.controller
    if (sw) sw.postMessage({ type: 'active_session', id: activeId, visible: document.visibilityState === 'visible' })
  }, [activeId])
  useEffect(() => {
    const onVis = () => navigator.serviceWorker?.controller?.postMessage(
      { type: 'active_session', id: activeId, visible: document.visibilityState === 'visible' })
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [activeId])
  // Push: resync subscription on return to foreground, throttled to ≤ once/hour.
  // Bypass the throttle if the SW wrote a resync-needed marker (e.g. subscribe failed).
  useEffect(() => {
    let last: number | null = null
    const onVis = async () => {
      if (document.visibilityState !== 'visible') return
      let forced = false
      try { const c = await caches.open('zmx-push'); const m = await c.match('resync-needed'); if (m) { forced = true; await c.delete('resync-needed') } } catch { /* ignore */ }
      const now = Date.now()
      if (!forced && !shouldResyncNow(last, now)) return
      last = now
      resyncPush().catch(() => {})
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])
  // SW: listen for notification click → deep-link to session
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.data?.type === 'open_session' && e.data.id) {
        const targetSession: string = e.data.id
        setActiveId(targetSession)
        // route to worktree diff if the finished turn left uncommitted changes
        getSessionStatus(targetSession)
          .then(st => setOverlay(prev => ({ ...prev, [targetSession]: deepLinkView(st.git_dirty) })))
          .catch(() => {})
      }
    }
    navigator.serviceWorker?.addEventListener('message', onMsg)
    return () => navigator.serviceWorker?.removeEventListener('message', onMsg)
  }, [])
  // Deep-link: parse ?session= query param on startup
  useEffect(() => {
    const sid = new URLSearchParams(location.search).get('session')
    if (sid) setActiveId(sid)
  }, [])

  // First time we have a session list, treat all existing completions as read
  // so pre-existing history doesn't light up every row's red dot.
  useEffect(() => {
    if (baselineInit.current || sessions.length === 0) return
    baselineInit.current = true
    setReadCounts(Object.fromEntries(sessions.map(s => [s.id, s.turns_completed])))
  }, [sessions])

  // Switching to a session marks its completions read (clears its red dot).
  useEffect(() => {
    if (!activeId) return
    const s = sessions.find(x => x.id === activeId)
    if (s) setReadCounts(prev => ({ ...prev, [activeId]: s.turns_completed }))
  }, [activeId, sessions])

  const hasUnread = useCallback((s: SessionInfo) =>
    s.id !== activeId && s.turns_completed > (readCounts[s.id] ?? 0),
  [activeId, readCounts])

  const handleRename = useCallback(async (id: string, name: string) => {
    const trimmed = name.trim()
    const cur = sessions.find(s => s.id === id)
    if (!trimmed || !cur || trimmed === cur.name) return
    try {
      await renameSession(id, trimmed)
      setSessions(prev => prev.map(s => s.id === id ? { ...s, name: trimmed } : s))
    } catch { /* keep old name on failure */ }
  }, [sessions])

  const handleLegacyLogin = useCallback(async (password: string, remember?: boolean) => {
    const userInfo = await legacyLogin(password, remember)
    setUser(userInfo)
    setAuthState('active')
    const list = await listSessions()
    setSessions(list)
    if (list.length === 0) {
      const s = await createSession('tmux')
      setSessions([s])
      setActiveId(s.id)
    } else {
      setActiveId(list[0].id)
    }
  }, [])

  const handleCreate = useCallback(async (type: SessionType | 'vault', workDir?: string, tmuxTarget?: string, initialPrompt?: string) => {
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

  const handleOpenVault = useCallback((target: { path: string; kind: 'note' | 'folder' }) => {
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

  const handleAskAgent = useCallback((t: AskAgentTarget) => {
    setAskAgentRequest({ ...t, nonce: ++nonceRef.current })
  }, [])

  const handleLogout = useCallback(() => {
    clearAuth()
    setAuthState('unauthenticated')
    setUser(null)
    setSessions([])
    setActiveId(null)
  }, [])

  const handleDeleteDocTab = useCallback((id: string) => {
    setDocTabs(prev => {
      const next = prev.filter(t => t.id !== id)
      setActiveId(cur => cur === id
        ? (next[0]?.id ?? sessions[0]?.id ?? null)   // fall back within doc tabs, else a real session, else null
        : cur)
      return next
    })
    setDocTargets(prev => { const { [id]: _, ...rest } = prev; return rest })
  }, [sessions])

  const updateDocTabTitle = useCallback((id: string, title: string | null) => {
    setDocTabs(prev => prev.map(t => t.id === id ? { ...t, title: title ?? DEFAULT_DOC_TITLE } : t))
  }, [])

  const handleDelete = useCallback(async (id: string) => {
    const s = sessions.find(x => x.id === id)
    if (s?.tmux_name) {
      const msg = closeConfirmMessage(s.name, await closeCheck(id))
      if (msg && !(await confirm({ title: msg, confirmLabel: '关闭', danger: true }))) return
    }
    let r: { pending_until?: number }
    try {
      r = await deleteSession(id)
    } catch {
      await loadSessions()
      return
    }
    setSessions(prev => {
      const next = prev.filter(x => x.id !== id)
      if (activeId === id) {
        setActiveId(next[0]?.id ?? docTabs[0]?.id ?? null)
      }
      return next
    })
    // End the toast a bit before the server's undo window so a late click can't
    // silently hit 410.
    if (r.pending_until && s) {
      const durationMs = Math.max(1000, (r.pending_until ?? 0) - Date.now() - 500) || 4500
      toast.push(undoCloseToast(id, s.name, durationMs, async () => { await loadSessions(); setActiveId(id) }))
    }
  }, [activeId, docTabs, sessions, loadSessions])

  const handleApproved = useCallback(() => {
    setAuthState('active')
    if (user) setUser({ ...user, status: 'active' })
    loadSessions()
  }, [user, loadSessions])

  const handleSessionUpdate = useCallback((id: string, updated: Partial<SessionInfo>) => {
    setSessions(prev => prev.map(s => s.id === id ? { ...s, ...updated } : s))
  }, [])

  const toggleOverlay = useCallback((id: string, view: 'files' | 'git' | 'events' | 'memory') => {
    setOverlay(prev => ({
      ...prev,
      [id]: prev[id] === view ? 'none' : view,
    }))
  }, [])

  if (authState === 'loading') {
    return <div className="h-full bg-[var(--bg-primary)]" />
  }

  if (authState === 'unauthenticated') {
    return <LoginPage onLegacyLogin={handleLegacyLogin} />
  }

  if (authState === 'pending' && user) {
    return <WaitingPage user={user} onStatusChange={handleApproved} onLogout={handleLogout} />
  }

  const activeSession = sessions.find(s => s.id === activeId)

  return (
    <div className="h-full flex bg-[var(--bg-primary)] text-[var(--text-primary)]">
      <Sidebar
        hostTmux={hostTmux}
        sessions={sessions}
        docTabs={docTabs}
        activeId={activeId}
        onSelect={setActiveId}
        onCreate={handleCreate}
        onDelete={(id) => isDocTabId(id) ? handleDeleteDocTab(id) : handleDelete(id)}
        onRename={handleRename}
        hasUnread={hasUnread}
        onLogout={handleLogout}
        theme={themeCtx.theme}
        onToggleTheme={themeCtx.toggle}
        themePref={themeCtx.pref}
        onSetThemePref={themeCtx.setPref}
        user={user}
        open={sidebarOpen}
        onToggle={() => setSidebarOpen(v => !v)}
        mobile={isMobile}
        confirmCount={confirmCount}
        onOpenVault={handleOpenVault}
        askAgentRequest={askAgentRequest}
        onOpenHistory={(id) => { setActiveId(id); setHistoryReq({ id, nonce: Date.now() }) }}
        onOpenPanel={p => { setPanel(p); if (isMobile) setSidebarOpen(false) }}
      />
      <main className="flex-1 min-w-0 flex flex-col">
        {/* Info bar for active session */}
        {activeSession && (
          <SessionInfoBar
            key={activeSession.id}
            session={activeSession}
            onUpdate={(updated) => handleSessionUpdate(activeSession.id, updated)}
            onToggleFiles={() => toggleOverlay(activeSession.id, 'files')}
            onToggleGit={() => toggleOverlay(activeSession.id, 'git')}
            onToggleEvents={() => toggleOverlay(activeSession.id, 'events')}
            showFiles={(overlay[activeSession.id] || 'none') === 'files'}
            showGit={(overlay[activeSession.id] || 'none') === 'git'}
            showEvents={(overlay[activeSession.id] || 'none') === 'events'}
            onOpenSidebar={isMobile && !sidebarOpen ? () => setSidebarOpen(true) : undefined}
            onQueueMode={activeSession.type !== 'tmux'
              ? (mode) => sessionControls.current[activeSession.id]?.setQueueMode(mode)
              : undefined}
            queueMode={queueModes[activeSession.id] ?? 'collect'}
            onToggleMetrics={activeSession.type !== 'tmux'
              ? () => setMetricsOpen(m => ({ ...m, [activeSession.id]: !m[activeSession.id] }))
              : undefined}
            showMetrics={!!metricsOpen[activeSession.id]}
            // 第 5 个图标只给 Crew：5 个是硬上限（375px 核算，见计划 Task 10）。
            // 其余会话传 undefined → SessionInfoBar 的 {onToggleMemory && ...} 门控
            // 直接不渲染，照 onToggleMetrics 的既有 idiom。
            onToggleMemory={activeSession.type === 'crew'
              ? () => toggleOverlay(activeSession.id, 'memory')
              : undefined}
            showMemory={(overlay[activeSession.id] || 'none') === 'memory'}
          />
        )}
        {/* Mobile: show menu button when no active session */}
        {!activeSession && isMobile && !sidebarOpen && (
          <div className="h-9 border-b border-[var(--border)] bg-[var(--bg-secondary)] flex items-center px-3">
            <button
              onClick={() => setSidebarOpen(true)}
              className="p-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12h18M3 6h18M3 18h18"/></svg>
            </button>
          </div>
        )}

        {/* Main content area */}
        <div className="flex-1 min-h-0 relative">
          {sessions.map(s => {
            const view = overlay[s.id] || 'none'
            const isActive = s.id === activeId
            return (
              <div key={s.id} data-session-pane={s.id} data-active={isActive ? '1' : '0'} className={`absolute inset-0 ${isActive ? '' : 'hidden'}`}>
                {/* Always keep terminal/chat mounted, hide with CSS when overlay is active */}
                <div className={`h-full ${view !== 'none' ? 'hidden' : ''}`}>
                  {s.type === 'tmux' ? (
                    <TerminalView sessionId={s.id} active={isActive && view === 'none'} theme={themeCtx.theme} tmuxName={s.tmux_name} tmuxOrigin={s.tmux_origin} onClose={() => handleDelete(s.id)} historyRequest={historyReq?.id === s.id ? historyReq.nonce : 0} onAskAgent={(prompt) => { handleCreate('claude', s.work_dir, undefined, prompt).catch(() => toast.push({ message: '创建会话失败' })) }} />
                  ) : (
                    <AcpChatView sessionId={s.id} active={isActive && view === 'none'} agentType={s.type} onRegisterControls={registerControls} onQueueModeChange={handleQueueModeChange} showMetrics={!!metricsOpen[s.id]} onOpenMemory={s.type === 'crew' ? () => toggleOverlay(s.id, 'memory') : undefined} peerNames={peerNames} />
                  )}
                </div>
                <Suspense fallback={<Skeleton rows={4} />}>
                  {view === 'files' && <FileBrowser sessionId={s.id} />}
                  {view === 'git' && <GitViewer sessionId={s.id} onForward={s.type !== 'tmux' ? (t) => sessionControls.current[s.id]?.sendPrompt(t) ?? false : undefined} />}
                  {view === 'events' && <AgentDashboard sessionId={s.id} />}
                  {/* 记忆是 Crew 侧全局的（一份 Gateway 一份记忆），故不接 sessionId。 */}
                  {view === 'memory' && <MemoryPanel />}
                </Suspense>
              </div>
            )
          })}
          {docTabs.map(t => {
            const isActive = t.id === activeId
            return (
              <div key={t.id} className={`absolute inset-0 ${isActive ? '' : 'hidden'}`}>
                <Suspense fallback={null}>
                  <VaultReader onTitleChange={(title) => updateDocTabTitle(t.id, title)} target={docTargets[t.id] ?? null} onAskAgent={handleAskAgent} />
                </Suspense>
              </div>
            )
          })}
          {sessions.length === 0 && docTabs.length === 0 && (
            <div className="flex items-center justify-center h-full text-[var(--text-muted)] text-sm">
              Create a session to get started
            </div>
          )}
        </div>
        {panel === 'admin' && <Suspense fallback={null}><AdminPanel open onClose={() => setPanel(null)} /></Suspense>}
        {panel === 'scheduled' && <Suspense fallback={null}><ScheduledTasksPanel open onClose={() => setPanel(null)} /></Suspense>}
        {panel === 'push' && <Suspense fallback={null}><PushSettings open onClose={() => setPanel(null)} /></Suspense>}
        {panel === 'prompts' && <Suspense fallback={null}><PromptsSheet open onClose={() => setPanel(null)} /></Suspense>}
        <Toaster /><DialogHost />
      </main>
    </div>
  )
}
