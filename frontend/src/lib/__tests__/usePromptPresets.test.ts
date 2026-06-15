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
})
