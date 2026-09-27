import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { usePathSearch } from '../usePathSearch'
import * as api from '../api'

const res = (indexing: boolean) => ({ dirs: null, notes: { indexing, refreshing: false, items: [] } })

describe('usePathSearch', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
  it('debounces and ignores empty queries', async () => {
    vi.useFakeTimers()
    const spy = vi.spyOn(api, 'searchPaths').mockResolvedValue(res(false) as never)
    const { rerender } = renderHook(({ q }) => usePathSearch(q, { scope: 'notes', debounceMs: 200, requeryWhile: r => !!r.notes?.indexing }), { initialProps: { q: '' } })
    rerender({ q: 'a' }); rerender({ q: 'ab' })
    await act(async () => { await vi.advanceTimersByTimeAsync(199) })
    expect(spy).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith('ab', 'notes', undefined)
  })
  it('re-queries every 4s while indexing, stops when superseded', async () => {
    vi.useFakeTimers()
    const spy = vi.spyOn(api, 'searchPaths').mockResolvedValue(res(true) as never)
    const { rerender } = renderHook(({ q }) => usePathSearch(q, { scope: 'notes', debounceMs: 0, requeryWhile: r => !!r.notes?.indexing }), { initialProps: { q: 'a' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
    expect(spy).toHaveBeenCalledTimes(2)
    rerender({ q: '' })
    await act(async () => { await vi.advanceTimersByTimeAsync(8000) })
    expect(spy).toHaveBeenCalledTimes(2)
  })
})
