import { describe, it, expect } from 'vitest'
import { defaultGitTab, commitPrompt, discardPrompt } from '../../lib/gitviewer'

describe('defaultGitTab', () => {
  it('picks worktree when dirty', () => {
    expect(defaultGitTab(3)).toBe('worktree')
  })
  it('picks history when clean', () => {
    expect(defaultGitTab(0)).toBe('history')
  })
})

describe('forward prompts', () => {
  it('has commit and discard prompt text naming the absolute work dir (A2)', () => {
    expect(commitPrompt('/home/u/repo-a')).toContain('提交')
    expect(commitPrompt('/home/u/repo-a')).toContain('/home/u/repo-a')
    expect(discardPrompt('/home/u/repo-a')).toContain('撤销')
    expect(discardPrompt('/home/u/repo-a')).toContain('/home/u/repo-a')
  })
})
