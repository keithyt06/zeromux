import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { usePathSearch } from '../usePathSearch'
import * as api from '../api'

const res = (indexing: boolean) => ({ dirs: null, notes: { indexing, refreshing: false, items: [] } })
const named = (display: string) => ({ dirs: null, notes: { indexing: false, refreshing: false, items: [{ path: display, kind: 'note', display, hint: '', abs_dir: '/v', score: 1 }] } })
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(a => { resolve = a }); return { promise, resolve } }
const noRequery = () => false

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
  it('a slow response for an older query never overwrites the newer query result', async () => {
    const slow = deferred<ReturnType<typeof named>>()
    vi.spyOn(api, 'searchPaths')
      .mockImplementationOnce(() => slow.promise as never)
      .mockResolvedValueOnce(named('new') as never)
    const { result, rerender } = renderHook(({ q }) => usePathSearch(q, { scope: 'notes', debounceMs: 0, requeryWhile: noRequery }), { initialProps: { q: 'old' } })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    rerender({ q: 'new' })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(result.current.resultQuery).toBe('new')
    // Flush the stale response fully before asserting.
    await act(async () => { slow.resolve(named('old')); await new Promise(r => setTimeout(r, 0)) })
    expect(result.current.resultQuery).toBe('new')
    expect(result.current.result?.notes?.items[0].display).toBe('new')
  })
  it('enabled=false sends no request and keeps the existing result', async () => {
    const spy = vi.spyOn(api, 'searchPaths').mockResolvedValue(named('kept') as never)
    const { result, rerender } = renderHook(({ q, on }) => usePathSearch(q, { scope: 'notes', debounceMs: 0, enabled: on, requeryWhile: noRequery }), { initialProps: { q: 'k', on: true } })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(result.current.resultQuery).toBe('k')
    rerender({ q: 'other', on: false })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    rerender({ q: '', on: false })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(result.current.result?.notes?.items[0].display).toBe('kept')
  })
  it('clearing the query clears the result immediately (no debounce wait)', async () => {
    vi.useFakeTimers()
    vi.spyOn(api, 'searchPaths').mockResolvedValue(named('x') as never)
    const { result, rerender } = renderHook(({ q }) => usePathSearch(q, { scope: 'notes', debounceMs: 150, requeryWhile: noRequery }), { initialProps: { q: 'x' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(150) })
    expect(result.current.result).not.toBeNull()
    act(() => rerender({ q: '' }))
    expect(result.current.result).toBeNull()
  })
})
