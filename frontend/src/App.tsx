import { useState, useEffect, useCallback } from 'react'
import type { UserInfo } from './lib/api'
import { listSessions, createSession, checkAuth, legacyLogin, clearAuth } from './lib/api'
import { useTheme } from './lib/theme'
import LoginPage from './components/LoginPage'
import WaitingPage from './components/WaitingPage'
import { AppShell } from './components/shell/AppShell'

type AuthState = 'loading' | 'unauthenticated' | 'pending' | 'active'

/** Auth gating only; everything after login lives in AppShell (spec v3 §0.5, M1). */
export default function App() {
  const [authState, setAuthState] = useState<AuthState>('loading')
  const [user, setUser] = useState<UserInfo | null>(null)
  const themeCtx = useTheme()

  const initAuth = useCallback(async () => {
    try {
      const me = await checkAuth()
      if (me) {
        setUser(me)
        setAuthState(me.status === 'active' ? 'active' : 'pending')
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

  const handleLegacyLogin = useCallback(async (password: string, remember?: boolean) => {
    const userInfo = await legacyLogin(password, remember)
    // First login on an empty server: create a terminal BEFORE the shell mounts so
    // its first load sees (and selects) it. Login already succeeded — a failure here
    // must not surface as a login error; the shell just loads empty.
    try {
      const list = await listSessions()
      if (list.length === 0) await createSession('tmux')
    } catch { /* shell's own poll handles auth / transient errors */ }
    setUser(userInfo)
    setAuthState('active')
  }, [])

  const handleLogout = useCallback(() => {
    clearAuth()
    setAuthState('unauthenticated')
    setUser(null)
  }, [])

  const handleApproved = useCallback(() => {
    setAuthState('active')
    setUser(u => (u ? { ...u, status: 'active' } : u))
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

  // A 401/403 from the session poll: the credentials are gone (D-F1) — same as logout.
  return <AppShell user={user} theme={themeCtx} onLogout={handleLogout} onAuthLost={handleLogout} />
}
