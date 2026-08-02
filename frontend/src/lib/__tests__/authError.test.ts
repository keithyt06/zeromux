import { describe, it, expect, vi, afterEach } from 'vitest'
import { ApiError, isAuthError, checkAuth } from '../api'

// D-F1: the background poll must log out ONLY on a genuine auth failure (401/403),
// never on a transient network drop or 5xx — otherwise a momentary proxy restart
// would eject the user, and a WS-only credential expiry would loop silently forever.
describe('isAuthError', () => {
  it('is true for 401 and 403', () => {
    expect(isAuthError(new ApiError(401))).toBe(true)
    expect(isAuthError(new ApiError(403))).toBe(true)
  })

  it('is false for 5xx and other statuses (transient — keep retrying)', () => {
    expect(isAuthError(new ApiError(500))).toBe(false)
    expect(isAuthError(new ApiError(502))).toBe(false)
    expect(isAuthError(new ApiError(503))).toBe(false)
    expect(isAuthError(new ApiError(404))).toBe(false)
    expect(isAuthError(new ApiError(429))).toBe(false)
  })

  it('is false for a plain network Error (fetch reject) and non-errors', () => {
    expect(isAuthError(new Error('Failed to fetch'))).toBe(false)
    expect(isAuthError('nope')).toBe(false)
    expect(isAuthError(null)).toBe(false)
    expect(isAuthError(undefined)).toBe(false)
  })
})

// F2 (review 2026-08-02): startup auth check must be fail-OPEN like the D-F1 poll.
// A 401/403 → null (logged out → LoginPage); a transient 5xx/network → THROW so
// initAuth stays in 'loading' and retries, instead of ejecting a validly-authed user
// on a reload during the deploy window.
describe('checkAuth', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  const stubFetch = (init: { status?: number; ok?: boolean; reject?: boolean }) => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (init.reject) throw new Error('Failed to fetch')
      const status = init.status ?? 200
      return {
        ok: init.ok ?? (status >= 200 && status < 300),
        status,
        json: async () => ({ id: 'u1', status: 'active' }),
      } as Response
    }))
  }

  it('returns the user on 200', async () => {
    stubFetch({ status: 200 })
    await expect(checkAuth()).resolves.toMatchObject({ id: 'u1' })
  })

  it('returns null on a genuine 401/403 (logged out)', async () => {
    stubFetch({ status: 401 })
    await expect(checkAuth()).resolves.toBeNull()
    stubFetch({ status: 403 })
    await expect(checkAuth()).resolves.toBeNull()
  })

  it('THROWS on a transient 5xx (deploy window) so startup retries, not logs out', async () => {
    stubFetch({ status: 503 })
    await expect(checkAuth()).rejects.toBeInstanceOf(ApiError)
    stubFetch({ status: 502 })
    await expect(checkAuth()).rejects.toBeInstanceOf(ApiError)
  })

  it('propagates a network reject (does not resolve null)', async () => {
    stubFetch({ reject: true })
    await expect(checkAuth()).rejects.toThrow()
  })
})
