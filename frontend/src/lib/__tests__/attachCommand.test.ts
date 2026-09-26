import { describe, it, expect } from 'vitest'
import { attachCommand } from '../attachCommand'

describe('attachCommand', () => {
  it('exact-match target, quoted', () => {
    expect(attachCommand('zmx-3f2a9c1e')).toBe("tmux attach -t '=zmx-3f2a9c1e'")
  })
  it('escapes single quotes', () => {
    expect(attachCommand("a'b")).toBe("tmux attach -t '=a'\\''b'")
  })
})
