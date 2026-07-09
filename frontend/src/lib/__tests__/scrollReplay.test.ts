import { describe, it, expect } from 'vitest'
import { shouldStickToBottom, shouldAutoScrollOnAppend, shouldTrackScrollUp } from '../scrollReplay'

describe('shouldStickToBottom', () => {
  it('sticks during replay when user has not scrolled up', () => {
    expect(shouldStickToBottom({ replaying: true, userScrolledUp: false })).toBe(true)
  })
  it('does not stick if user scrolled up during replay (passive reconnect case)', () => {
    expect(shouldStickToBottom({ replaying: true, userScrolledUp: true })).toBe(false)
  })
  it('does not stick outside the replay window (live output)', () => {
    expect(shouldStickToBottom({ replaying: false, userScrolledUp: false })).toBe(false)
  })
})

describe('shouldAutoScrollOnAppend', () => {
  // distanceFromBottom is measured synchronously BEFORE the new content commits,
  // i.e. "was the user near the bottom when this event arrived?".
  it('scrolls when the user is pinned at the bottom', () => {
    expect(shouldAutoScrollOnAppend({ force: false, distanceFromBottom: 0 })).toBe(true)
  })
  it('scrolls when within the near-bottom tolerance (last-chunk jitter)', () => {
    expect(shouldAutoScrollOnAppend({ force: false, distanceFromBottom: 40 })).toBe(true)
  })
  it('does NOT scroll when the user has scrolled up to read history', () => {
    expect(shouldAutoScrollOnAppend({ force: false, distanceFromBottom: 800 })).toBe(false)
  })
  it('force always scrolls (user just sent a prompt), even scrolled far up', () => {
    expect(shouldAutoScrollOnAppend({ force: true, distanceFromBottom: 800 })).toBe(true)
  })
  it('treats a jsdom zero-metrics container as near-bottom (gate stays transparent in tests)', () => {
    expect(shouldAutoScrollOnAppend({ force: false, distanceFromBottom: 0 })).toBe(true)
  })
})

describe('shouldTrackScrollUp', () => {
  // The scroll-up detector must be armed across BOTH the replay window and the
  // post-replay_done follow window, so a scroll-up during the 2s ResizeObserver
  // follow is still detected (otherwise the follow observer's own guard is dead
  // and it yanks a scrolled-up reader).
  it('tracks during the replay window', () => {
    expect(shouldTrackScrollUp({ replaying: true, following: false })).toBe(true)
  })
  it('tracks during the post-replay_done follow window', () => {
    expect(shouldTrackScrollUp({ replaying: false, following: true })).toBe(true)
  })
  it('does NOT track once both windows are closed (steady-state live output)', () => {
    expect(shouldTrackScrollUp({ replaying: false, following: false })).toBe(false)
  })
})
