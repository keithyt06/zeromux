import { describe, it, expect, beforeEach } from 'vitest'
import { newDocTab, isDocTabId, loadDocTabs, saveDocTabs, docTitleFromPath, DEFAULT_DOC_TITLE, type DocTab } from '../docTabs'

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
  })

  it('DEFAULT_DOC_TITLE is 文档', () => {
    expect(DEFAULT_DOC_TITLE).toBe('文档')
  })

  it('loadDocTabs tolerates missing / corrupt storage', () => {
    expect(loadDocTabs()).toEqual([])
    localStorage.setItem('zeromux:doc-tabs', '"not-an-array"')
    expect(loadDocTabs()).toEqual([])
    localStorage.setItem('zeromux:doc-tabs', '[{"id":"doc-x","title":"X","kind":"vault"},{"bad":1}]')
    expect(loadDocTabs()).toEqual([{ id: 'doc-x', title: 'X', kind: 'vault' }])
  })
})
