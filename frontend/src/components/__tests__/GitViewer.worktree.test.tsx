import { describe, it, expect } from 'vitest'
import { defaultGitTab, COMMIT_PROMPT, DISCARD_PROMPT } from '../GitViewer'

describe('defaultGitTab', () => {
  it('picks worktree when dirty', () => {
    expect(defaultGitTab(3)).toBe('worktree')
  })
  it('picks history when clean', () => {
    expect(defaultGitTab(0)).toBe('history')
  })
})

describe('forward prompts', () => {
  it('has commit and discard prompt text', () => {
    expect(COMMIT_PROMPT).toContain('提交')
    expect(DISCARD_PROMPT).toContain('撤销')
  })
})
