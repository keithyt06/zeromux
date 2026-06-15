import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { usePromptPresets } from '../usePromptPresets'

describe('usePromptPresets', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ presets: [{ id: 'p1', title: 't', body: 'b', created_at: '1', updated_at: '1', sort_order: 1 }] }),
    })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('reload populates presets', async () => {
    const { result } = renderHook(() => usePromptPresets())
    await act(async () => { await result.current.reload() })
    expect(result.current.presets).toHaveLength(1)
    expect(result.current.error).toBeNull()
  })

  it('reload failure sets error and keeps presets empty (no throw)', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, text: async () => 'boom' })
    const { result } = renderHook(() => usePromptPresets())
    await act(async () => { await result.current.reload() })
    expect(result.current.presets).toEqual([])
    expect(result.current.error).not.toBeNull()
  })

  it('add returns true on success, false when the POST fails', async () => {
    const { result } = renderHook(() => usePromptPresets())
    let ok: boolean | undefined
    await act(async () => { ok = await result.current.add('t', 'b') })
    expect(ok).toBe(true)
    // next create rejects (e.g. 400 too long)
    fetchMock.mockResolvedValueOnce({ ok: false, text: async () => 'too long' })
    await act(async () => { ok = await result.current.add('t', 'b') })
    expect(ok).toBe(false)
    expect(result.current.error).not.toBeNull()
  })

  it('remove failure (404) re-lists so the stale row self-corrects', async () => {
    const { result } = renderHook(() => usePromptPresets())
    // DELETE rejects (404), then the catch's reload() GET succeeds (default mock).
    fetchMock.mockResolvedValueOnce({ ok: false, text: async () => 'not found' })
    await act(async () => { await result.current.remove('gone') })
    const methods = fetchMock.mock.calls.map(c => c[1]?.method ?? 'GET')
    expect(methods).toContain('DELETE')
    // a GET (reload) fired after the failed DELETE → view re-syncs to server truth
    expect(methods.lastIndexOf('GET')).toBeGreaterThan(methods.indexOf('DELETE'))
    expect(result.current.presets).toHaveLength(1)
  })
})
