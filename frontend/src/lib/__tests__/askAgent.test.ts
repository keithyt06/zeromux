import { describe, it, expect } from 'vitest'
import { askAgentPrompt } from '../askAgent'

describe('askAgentPrompt', () => {
  it('prefixes the ABSOLUTE note path (the agent cwd is the note folder, so a vault-relative path would not resolve)', () => {
    expect(askAgentPrompt({ absDir: '/v/p/a', relPath: 'p/a/Text3.md', kind: 'note' })).toBe('当前笔记：/v/p/a/Text3.md\n\n')
  })
  it('prefixes the absolute folder path with a trailing slash', () => {
    expect(askAgentPrompt({ absDir: '/v/p/a', relPath: 'p/a', kind: 'folder' })).toBe('当前目录：/v/p/a/\n\n')
  })
})
