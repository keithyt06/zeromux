import { describe, it, expect } from 'vitest'
import { shouldClearQueuedHint, busyAfterReplay } from '../collectHint'

describe('shouldClearQueuedHint', () => {
  // Regression (opposite direction from the turn-end fix): content_block belongs
  // to the STILL-RUNNING turn. Clearing on it wiped the hint mid-turn while the
  // agent was visibly still working, falsely implying the queued prompt was
  // sent/dropped. The merged turn can only start after this turn's result/error/
  // exit, which already clear the hint — so content_block must NOT clear.
  it('does NOT clear on content_block (the running turn\'s own output)', () => {
    expect(shouldClearQueuedHint('content_block')).toBe(false)
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

describe('busyAfterReplay', () => {
  // The bug: `replay_done` unconditionally forced busy=false, so a mid-turn
  // reconnect (idle-proxy drop during a silent tool call) hid the running
  // indicator AND the interrupt button for a turn still Running server-side.
  // The backend now sends the authoritative live turn state in the marker.
  it('stays busy when the backend reports the turn is still running', () => {
    expect(busyAfterReplay(true)).toBe(true)
  })

  it('clears busy when the backend reports the turn finished', () => {
    expect(busyAfterReplay(false)).toBe(false)
  })

  // Back-compat: an older backend omits the flag → treat as not-running (old
  // behavior), never accidentally stick busy on a missing/garbage value.
  it('treats missing/non-boolean as not running (legacy back-compat)', () => {
    expect(busyAfterReplay(undefined)).toBe(false)
    expect(busyAfterReplay(null)).toBe(false)
    expect(busyAfterReplay('true')).toBe(false)
    expect(busyAfterReplay(1)).toBe(false)
  })
})
