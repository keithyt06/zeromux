import { describe, it, expect } from 'vitest'
import { ApiError, isAuthError } from '../api'

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
