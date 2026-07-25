import { describe, it, expect } from 'vitest'
import { isStuck, shouldSeedTurnClock, STUCK_SILENCE_MS } from '../stuck'

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

describe('shouldSeedTurnClock', () => {
  it('seeds when starting a fresh turn (not busy)', () => {
    expect(shouldSeedTurnClock(false)).toBe(true)
  })
  it('does NOT re-seed when a turn is already in flight (collect-queued send)', () => {
    // Regression: re-seeding here reset the silence baseline of the running turn,
    // resetting `stuck` and hiding the interrupt button on a wedged turn.
    expect(shouldSeedTurnClock(true)).toBe(false)
  })
})
