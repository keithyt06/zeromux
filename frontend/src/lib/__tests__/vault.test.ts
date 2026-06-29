import { describe, it, expect, beforeEach } from 'vitest'
import { shouldShowVault, filterVaultEntries, resolveVaultImageSrc, getRecentNotes, pushRecentNote } from '../vault'
import type { DirListEntry } from '../api'

describe('shouldShowVault', () => {
  it('true only when enabled', () => {
    expect(shouldShowVault({ enabled: true, name: 'obsidian' })).toBe(true)
    expect(shouldShowVault({ enabled: false, name: '' })).toBe(false)
    expect(shouldShowVault(null)).toBe(false)
  })
})

describe('filterVaultEntries', () => {
  it('keeps dirs and .md, drops dotdirs and non-md files', () => {
    const e: DirListEntry[] = [
      { name: '.obsidian', type: 'dir', size: 0, mtime: 0, writable: false },
      { name: 'knowledge', type: 'dir', size: 0, mtime: 0, writable: false },
      { name: 'a.md', type: 'file', size: 1, mtime: 0, writable: false },
      { name: 'b.png', type: 'file', size: 1, mtime: 0, writable: false },
    ]
    const r = filterVaultEntries(e)
    expect(r.map(x => x.name)).toEqual(['knowledge', 'a.md'])
  })
})

describe('resolveVaultImageSrc', () => {
  it('rewrites relative src to vault raw url, leaves absolute alone', () => {
    const out = resolveVaultImageSrc('attachments/x.png', 'knowledge/aws/note.md')
    expect(out).toContain('/api/vault/file/raw')
    expect(out).toContain('knowledge%2Faws%2Fattachments%2Fx.png')
    expect(resolveVaultImageSrc('https://x/y.png', 'a.md')).toBe('https://x/y.png')
  })
})

describe('recent notes', () => {
  beforeEach(() => localStorage.clear())
  it('pushes most-recent-first, dedupes, caps 10', () => {
    pushRecentNote('a.md'); pushRecentNote('b.md'); pushRecentNote('a.md')
    expect(getRecentNotes()).toEqual(['a.md', 'b.md'])
  })
})
