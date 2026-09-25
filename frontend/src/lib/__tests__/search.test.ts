import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { searchPaths, warmSearchIndex, resolveWikiLink } from '../api'

describe('search API', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock) })
  afterEach(() => vi.unstubAllGlobals())

  it('searchPaths maps sections by kind and coerces unknown agents to null', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ sections: [
      { kind: 'notes', indexing: false, refreshing: false, truncated: false, items: [] },
      { kind: 'dirs', indexing: false, refreshing: true, truncated: false,
        items: [{ path: '/h/a', display: 'a', hint: '~', agent: 'kiro', score: 50 },
                { path: '/h/b', display: 'b', hint: '~', agent: 'claude', score: 40 }] },
      { kind: 'future-thing', items: [] },
    ] }) })
    const r = await searchPaths('zmx', 'dirs,notes')
    expect(fetchMock.mock.calls[0][0]).toBe('/api/search?q=zmx&scope=dirs%2Cnotes&limit=6')
    expect(r.dirs!.refreshing).toBe(true)
    expect(r.dirs!.items[0].agent).toBeNull()
    expect(r.dirs!.items[1].agent).toBe('claude')
    expect(r.notes!.items).toEqual([])
  })

  it('searchPaths throws on non-ok', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400, text: async () => 'bad' })
    await expect(searchPaths('x', 'dirs')).rejects.toThrow()
  })

  it('warmSearchIndex swallows failures', async () => {
    fetchMock.mockRejectedValue(new Error('offline'))
    await expect(warmSearchIndex('dirs,notes')).resolves.toBeUndefined()
  })

  it('resolveWikiLink distinguishes indexing (503) from not found (404)', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 })
    expect(await resolveWikiLink('x')).toEqual({ indexing: true })
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 })
    expect(await resolveWikiLink('x')).toBeNull()
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ path: 'a/b.md' }) })
    expect(await resolveWikiLink('x')).toEqual({ path: 'a/b.md' })
  })
})
