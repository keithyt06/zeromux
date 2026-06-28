import { describe, it, expect } from 'vitest'
import { isStuck, STUCK_SILENCE_MS } from '../stuck'

describe('isStuck', () => {
  const now = 10_000_000
  it('true when running and silent past threshold', () => {
    expect(isStuck('running', now - STUCK_SILENCE_MS - 1, now)).toBe(true)
  })
  it('false when running but recently active', () => {
    expect(isStuck('running', now - 1000, now)).toBe(false)
  })
  it('false when idle', () => {
    expect(isStuck('idle', now - STUCK_SILENCE_MS - 1, now)).toBe(false)
  })
  it('false when no activity timestamp', () => {
    expect(isStuck('running', null, now)).toBe(false)
  })
})
