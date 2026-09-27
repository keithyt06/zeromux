// Core HTTP plumbing: token storage, ApiError, the api() wrapper, wsUrl.
// Every other domain module imports from here.

function getToken(): string {
  return localStorage.getItem('zeromux_token') || ''
}

export function setToken(token: string, maxAge?: number) {
  localStorage.setItem('zeromux_token', token)
  const age = maxAge || 604800
  document.cookie = `zeromux_token=${encodeURIComponent(token)};path=/;SameSite=Strict;max-age=${age}`
}

export function clearAuth() {
  localStorage.removeItem('zeromux_token')
  document.cookie = 'zeromux_token=;path=/;expires=Thu, 01 Jan 1970 00:00:00 GMT'
  document.cookie = 'zeromux_jwt=;path=/;expires=Thu, 01 Jan 1970 00:00:00 GMT'
}

// Carries the HTTP status so callers can distinguish a genuine auth failure (401/403)
// from a transient network error or 5xx. Used by the App's background poll to decide
// logout-vs-retry: a WS client can't observe the 401 on a failed upgrade, so this REST
// path is the one that reliably detects credential expiry / de-approval. (D-F1)
export class ApiError extends Error {
  status: number
  constructor(status: number, message?: string) {
    super(message || `HTTP ${status}`)
    this.name = 'ApiError'
    this.status = status
  }
}

/** True for an auth failure that should force logout (not a transient network/5xx). */
export function isAuthError(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 401 || err.status === 403)
}

export async function api(path: string, opts: RequestInit = {}): Promise<Response> {
  const token = getToken()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(opts.headers as Record<string, string> || {}),
  }
  // Only add Authorization header for legacy token mode
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
  return fetch(path, { ...opts, headers, credentials: 'same-origin' })
}

export function wsUrl(path: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const token = getToken()
  // Legacy mode: localStorage token → ?token=. OAuth mode: the zeromux_jwt cookie is
  // HttpOnly (oauth.rs) so this document.cookie read is always empty — auth then falls
  // through to the server reading that same cookie off the WS upgrade headers
  // (auth::verify_ws_auth, F-WS-OAUTH-COOKIE). We still pass it for any non-HttpOnly
  // deployment; the empty value is harmless.
  const jwt = document.cookie.split(';').map(c => c.trim()).find(c => c.startsWith('zeromux_jwt='))?.split('=')[1] || ''
  const authToken = token || jwt
  return `${proto}//${location.host}${path}?token=${encodeURIComponent(authToken)}`
}
