import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { listPrompts, createPrompt, updatePrompt, deletePrompt } from '../api'

describe('prompt presets api', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ presets: [{ id: 'p1', title: 't', body: 'b', created_at: '1', updated_at: '1', sort_order: 1 }] }),
    })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('listPrompts unwraps data.presets', async () => {
    const out = await listPrompts()
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('p1')
  })

  it('listPrompts returns [] when presets missing', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({}) })
    expect(await listPrompts()).toEqual([])
  })

  it('createPrompt posts title + body', async () => {
    await createPrompt('审查 PR', '审查这个 PR')
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toContain('/api/prompts')
    expect(opts.method).toBe('POST')
    const body = JSON.parse(opts.body)
    expect(body).toEqual({ title: '审查 PR', body: '审查这个 PR' })
  })

  it('updatePrompt sends only provided fields', async () => {
    await updatePrompt('p1', { body: 'new' })
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toContain('/api/prompts/p1')
    expect(opts.method).toBe('PUT')
    const body = JSON.parse(opts.body)
    expect(body).toEqual({ body: 'new' })
    expect('title' in body).toBe(false)
  })

  it('deletePrompt issues DELETE', async () => {
    await deletePrompt('p1')
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toContain('/api/prompts/p1')
    expect(opts.method).toBe('DELETE')
  })

  it('listPrompts throws on !ok (caller/hook catches)', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, text: async () => 'err' })
    await expect(listPrompts()).rejects.toThrow()
  })
})
