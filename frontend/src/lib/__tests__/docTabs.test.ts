import { describe, it, expect, beforeEach } from 'vitest'
import { newDocTab, isDocTabId, loadDocTabs, saveDocTabs, docTitleFromPath, resolveActivePane, DEFAULT_DOC_TITLE, type DocTab } from '../docTabs'

describe('docTabs', () => {
  beforeEach(() => localStorage.clear())

  it('newDocTab produces a doc- prefixed id and kind vault', () => {
    const t = newDocTab('笔记')
    expect(t.id.startsWith('doc-')).toBe(true)
    expect(t.kind).toBe('vault')
    expect(t.title).toBe('笔记')
  })

  it('isDocTabId distinguishes doc tabs from backend uuids', () => {
    expect(isDocTabId('doc-abc')).toBe(true)
    expect(isDocTabId('550e8400-e29b-41d4-a716-446655440000')).toBe(false)
    expect(isDocTabId(null)).toBe(false)
  })

  it('saveDocTabs strips vault tab title down to the generic label on disk', () => {
    const tabs: DocTab[] = [{ id: 'doc-1', title: '我的笔记', kind: 'vault' }]
    saveDocTabs(tabs)
    expect(loadDocTabs()).toEqual([{ id: 'doc-1', title: '文档', kind: 'vault' }])
  })

  it('docTitleFromPath returns basename without a trailing .md', () => {
    expect(docTitleFromPath('a/b/My Note.md')).toBe('My Note')
    expect(docTitleFromPath('Top Level.md')).toBe('Top Level')
    expect(docTitleFromPath('folder/no-ext')).toBe('no-ext')
    expect(docTitleFromPath('folder/Weird.MD')).toBe('Weird')
    // a basename that is only the extension must not strip down to '' (would show a blank tab)
    expect(docTitleFromPath('folder/.md')).toBe('.md')
  })

  it('DEFAULT_DOC_TITLE is 文档', () => {
    expect(DEFAULT_DOC_TITLE).toBe('文档')
  })

  describe('resolveActivePane', () => {
    it('keeps the current selection when it still resolves to a session', () => {
      expect(resolveActivePane('s1', ['s1', 's2'], [])).toBe('s1')
    })
    it('keeps the current selection when it still resolves to a doc tab', () => {
      expect(resolveActivePane('doc-1', ['s1'], ['doc-1'])).toBe('doc-1')
    })
    it('falls back to the first doc tab when only doc tabs exist (refresh with 0 sessions)', () => {
      expect(resolveActivePane(null, [], ['doc-1', 'doc-2'])).toBe('doc-1')
    })
    it('recovers to a doc tab when a dangling activeId no longer resolves (session deleted server-side)', () => {
      expect(resolveActivePane('gone', [], ['doc-1'])).toBe('doc-1')
    })
    it('prefers a live session over a doc tab on a fresh (null) selection', () => {
      expect(resolveActivePane(null, ['s1'], ['doc-1'])).toBe('s1')
    })
    it('returns null when nothing is available', () => {
      expect(resolveActivePane(null, [], [])).toBeNull()
      expect(resolveActivePane('gone', [], [])).toBeNull()
    })
    // Documents why this must only run at initial load (activeId===null), never on
    // the 3s poll: fed a stale snapshot taken before a just-created session/doc tab
    // committed, it cannot tell "not created yet" from "deleted" and would demote a
    // still-valid selection — a silent focus-steal. Callers must pass a fresh list.
    it('would demote a just-created id absent from a stale list (why the poll must not call it)', () => {
      expect(resolveActivePane('s-new', ['s-old'], [])).toBe('s-old')
      expect(resolveActivePane('doc-new', ['s-old'], [])).toBe('s-old')
    })
  })

  it('loadDocTabs tolerates missing / corrupt storage', () => {
    expect(loadDocTabs()).toEqual([])
    localStorage.setItem('zeromux:doc-tabs', '"not-an-array"')
    expect(loadDocTabs()).toEqual([])
    localStorage.setItem('zeromux:doc-tabs', '[{"id":"doc-x","title":"X","kind":"vault"},{"bad":1}]')
    expect(loadDocTabs()).toEqual([{ id: 'doc-x', title: 'X', kind: 'vault' }])
  })
})
