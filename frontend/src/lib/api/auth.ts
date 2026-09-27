import { api, ApiError, setToken } from './core'

// Auth: mode probe, legacy login, current-user check, GitHub-OAuth admin APIs.

export interface UserInfo {
  id: string
  login: string
  role: string
  status: string
  avatar: string | null
}

export interface AuthMode {
  oauth: boolean
  legacy: boolean
}

export async function getAuthMode(): Promise<AuthMode> {
  const res = await fetch('/auth/mode')
  return res.json()
}

export async function getMe(): Promise<UserInfo> {
  const res = await api('/api/me')
  if (!res.ok) throw new Error('Not authenticated')
  return res.json()
}

export async function legacyLogin(password: string, remember?: boolean): Promise<UserInfo> {
  const res = await fetch('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password, remember: remember || false }),
  })
  if (!res.ok) throw new Error('Invalid token')
  const data = await res.json()
  setToken(data.token, data.max_age)
  return data.user
}

// Returns the user on 200, null on a genuine 401/403 (not authenticated), and THROWS
// (ApiError for a 5xx, the original error for a network drop) on anything transient.
// initAuth uses this to keep startup fail-OPEN: a reload during the deploy window
// (502/503) or a momentary network blip must NOT eject a validly-authed user to the
// login page — only a real 401/403 should. This mirrors the D-F1 hardening already
// applied to the running poll (listSessions). (review 2026-08-02, F2)
export async function checkAuth(): Promise<UserInfo | null> {
  const res = await api('/api/me')
  if (res.status === 401 || res.status === 403) return null
  if (!res.ok) throw new ApiError(res.status, 'checkAuth failed')
  return res.json()
}

// Admin APIs
export interface AdminUser {
  id: string
  github_id: number
  github_login: string
  display_name: string | null
  avatar_url: string | null
  role: string
  status: string
  created_at: string
  last_login: string | null
}

export async function listUsers(): Promise<AdminUser[]> {
  const res = await api('/api/admin/users')
  if (!res.ok) throw new Error('Forbidden')
  const data = await res.json()
  return data.users || []
}

export async function approveUser(id: string): Promise<void> {
  const res = await api(`/api/admin/users/${id}/approve`, { method: 'PUT' })
  if (!res.ok) throw new Error('Failed to approve')
}

export async function removeUser(id: string): Promise<void> {
  const res = await api(`/api/admin/users/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error('Failed to remove')
}
