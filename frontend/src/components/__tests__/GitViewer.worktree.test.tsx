import { describe, it, expect } from 'vitest'
import { defaultGitTab } from '../GitViewer'

describe('defaultGitTab', () => {
  it('picks worktree when dirty', () => {
    expect(defaultGitTab(3)).toBe('worktree')
  })
  it('picks history when clean', () => {
    expect(defaultGitTab(0)).toBe('history')
  })
})
