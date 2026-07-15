import { describe, it, expect } from 'vitest'
import { shouldClearQueuedHint } from '../collectHint'

describe('shouldClearQueuedHint', () => {
  it('clears when the merged turn starts producing output', () => {
    expect(shouldClearQueuedHint('content_block')).toBe(true)
  })

  it('clears on normal turn end (result)', () => {
    expect(shouldClearQueuedHint('result')).toBe(true)
  })

  // The regression: error/exit end the turn but the merged turn never fires,
  // so a hint cleared only on content_block would stick forever.
  it('clears when the turn ends with an error', () => {
    expect(shouldClearQueuedHint('error')).toBe(true)
  })

  it('clears when the process exits', () => {
    expect(shouldClearQueuedHint('exit')).toBe(true)
  })

  it('does NOT clear on the queued hint itself', () => {
    expect(shouldClearQueuedHint('system')).toBe(false)
  })

  it('does NOT clear on user_prompt echo', () => {
    expect(shouldClearQueuedHint('user_prompt')).toBe(false)
  })
})
