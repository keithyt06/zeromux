import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import type { SessionInfo, SessionType, UserInfo } from './lib/api'
import { listSessions, createSession, deleteSession, checkAuth, legacyLogin, clearAuth, renameSession, listConfirmations } from './lib/api'
import { useTheme } from './lib/theme'
import Sidebar from './components/Sidebar'
import TerminalView from './components/TerminalView'
import AcpChatView from './components/AcpChatView'
import LoginPage from './components/LoginPage'
import WaitingPage from './components/WaitingPage'
import SessionInfoBar from './components/SessionInfoBar'
import FileBrowser from './components/FileBrowser'
import GitViewer from './components/GitViewer'
import AgentDashboard from './components/AgentDashboard'

type AuthState = 'loading' | 'unauthenticated' | 'pending' | 'active'
type OverlayView = 'none' | 'files' | 'git' | 'events'

export default function App() {
  const [authState, setAuthState] = useState<AuthState>('loading')
  const [user, setUser] = useState<UserInfo | null>(null)
  const [sessions, setSessions] = useState<SessionInfo[]>([])
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
  const sessionControls = useRef<Record<string, { setQueueMode: (mode: string) => void }>>({})
  const registerControls = useCallback((sid: string, api: { setQueueMode: (mode: string) => void } | null) => {
    if (api) sessionControls.current[sid] = api
    else delete sessionControls.current[sid]
  }, [])
  const themeCtx = useTheme()
  const isMobile = useMemo(() => window.innerWidth < 768, [])
  const [sidebarOpen, setSidebarOpen] = useState(!isMobile)
  const [confirmCount, setConfirmCount] = useState(0)

  const initAuth = useCallback(async () => {
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
      setAuthState('unauthenticated')
    }
  }, [])

  useEffect(() => { initAuth() }, [initAuth])

  const loadSessions = useCallback(async () => {
    try {
      const list = await listSessions()
      setSessions(list)
      if (list.length > 0) {
        setActiveId(prev => prev && list.some(s => s.id === prev) ? prev : list[0].id)
      }
    } catch {
      setAuthState('unauthenticated')
    }
  }, [])

  // 3s polling: refresh session list so turn-state / activity fields stay live.
  // Replaces the whole list each tick; activeId is independent state so it's
  // unaffected. Transient failures are ignored (don't bounce to login).
  useEffect(() => {
    if (authState !== 'active') return
    const tick = setInterval(async () => {
      try {
        setSessions(await listSessions())
      } catch { /* ignore transient */ }
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

  const handleCreate = useCallback(async (type: SessionType, workDir?: string, tmuxTarget?: string, initialPrompt?: string) => {
    const s = await createSession(type, undefined, workDir, tmuxTarget, initialPrompt)
    setSessions(prev => [...prev, s])
    setActiveId(s.id)
  }, [])

  const handleLogout = useCallback(() => {
    clearAuth()
    setAuthState('unauthenticated')
    setUser(null)
    setSessions([])
    setActiveId(null)
  }, [])

  const handleDelete = useCallback(async (id: string) => {
    await deleteSession(id)
    setSessions(prev => {
      const next = prev.filter(s => s.id !== id)
      if (activeId === id) {
        setActiveId(next.length > 0 ? next[0].id : null)
      }
      return next
    })
  }, [activeId])

  const handleApproved = useCallback(() => {
    setAuthState('active')
    if (user) setUser({ ...user, status: 'active' })
    loadSessions()
  }, [user, loadSessions])

  const handleSessionUpdate = useCallback((id: string, updated: Partial<SessionInfo>) => {
    setSessions(prev => prev.map(s => s.id === id ? { ...s, ...updated } : s))
  }, [])

  const toggleOverlay = useCallback((id: string, view: 'files' | 'git' | 'events') => {
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
        sessions={sessions}
        activeId={activeId}
        onSelect={setActiveId}
        onCreate={handleCreate}
        onDelete={handleDelete}
        onRename={handleRename}
        hasUnread={hasUnread}
        onLogout={handleLogout}
        theme={themeCtx.theme}
        onToggleTheme={themeCtx.toggle}
        user={user}
        open={sidebarOpen}
        onToggle={() => setSidebarOpen(v => !v)}
        mobile={isMobile}
        confirmCount={confirmCount}
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
            onToggleMetrics={activeSession.type !== 'tmux'
              ? () => setMetricsOpen(m => ({ ...m, [activeSession.id]: !m[activeSession.id] }))
              : undefined}
            showMetrics={!!metricsOpen[activeSession.id]}
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
              <div key={s.id} className={`absolute inset-0 ${isActive ? '' : 'hidden'}`}>
                {/* Always keep terminal/chat mounted, hide with CSS when overlay is active */}
                <div className={`h-full ${view !== 'none' ? 'hidden' : ''}`}>
                  {s.type === 'tmux' ? (
                    <TerminalView sessionId={s.id} active={isActive && view === 'none'} theme={themeCtx.theme} />
                  ) : (
                    <AcpChatView sessionId={s.id} active={isActive && view === 'none'} agentType={s.type} onRegisterControls={registerControls} showMetrics={!!metricsOpen[s.id]} />
                  )}
                </div>
                {view === 'files' && <FileBrowser sessionId={s.id} />}
                {view === 'git' && <GitViewer sessionId={s.id} />}
                {view === 'events' && <AgentDashboard sessionId={s.id} />}
              </div>
            )
          })}
          {sessions.length === 0 && (
            <div className="flex items-center justify-center h-full text-[var(--text-muted)] text-sm">
              Create a session to get started
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
