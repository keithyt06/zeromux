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
  it('seeds when starting a fresh turn (not busy), any queue mode', () => {
    expect(shouldSeedTurnClock(false, 'collect')).toBe(true)
    expect(shouldSeedTurnClock(false, 'interrupt')).toBe(true)
  })
  it('does NOT re-seed a busy send in Collect mode (merely enqueued server-side)', () => {
    // Regression (68ab4f5): re-seeding a collect-queued send reset the silence
    // baseline of the running turn, resetting `stuck` and hiding the interrupt
    // button on a wedged turn.
    expect(shouldSeedTurnClock(true, 'collect')).toBe(false)
  })
  it('DOES re-seed a busy send in Interrupt mode (a fresh turn starts server-side)', () => {
    // Regression (F-FE-1, 2026-07-25): in Interrupt mode a send while busy is NOT
    // enqueued — the backend interrupts and starts a genuinely fresh turn
    // (turn_seq++/mark_turn Running). Suppressing the reseed there left the new
    // turn on the OLD turn's baseline → inflated elapsed + a false "可能卡住"
    // stuck flag on a brand-new turn. Only Collect mode enqueues.
    expect(shouldSeedTurnClock(true, 'interrupt')).toBe(true)
  })
})
