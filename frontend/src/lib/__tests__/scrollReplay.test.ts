import { describe, it, expect } from 'vitest'
import { shouldStickToBottom } from '../scrollReplay'

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
