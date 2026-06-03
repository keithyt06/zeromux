import { useState, useEffect, useCallback, useMemo } from 'react'
import type { SessionInfo, SessionType, UserInfo } from './lib/api'
import { listSessions, createSession, deleteSession, checkAuth, legacyLogin, clearAuth } from './lib/api'
import { useTheme } from './lib/theme'
import Sidebar from './components/Sidebar'
import TerminalView from './components/TerminalView'
import AcpChatView from './components/AcpChatView'
import LoginPage from './components/LoginPage'
import WaitingPage from './components/WaitingPage'
import SessionInfoBar from './components/SessionInfoBar'
import MarkdownViewer from './components/MarkdownViewer'
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
  const themeCtx = useTheme()
  const isMobile = useMemo(() => window.innerWidth < 768, [])
  const [sidebarOpen, setSidebarOpen] = useState(!isMobile)

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

  const handleCreate = useCallback(async (type: SessionType, workDir?: string, tmuxTarget?: string) => {
    const s = await createSession(type, undefined, workDir, tmuxTarget)
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
        onLogout={handleLogout}
        theme={themeCtx.theme}
        onToggleTheme={themeCtx.toggle}
        user={user}
        open={sidebarOpen}
        onToggle={() => setSidebarOpen(v => !v)}
        mobile={isMobile}
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
                    <AcpChatView sessionId={s.id} active={isActive && view === 'none'} agentType={s.type} />
                  )}
                </div>
                {view === 'files' && <MarkdownViewer sessionId={s.id} sessionType={s.type} />}
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
