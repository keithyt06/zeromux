import { StrictMode } from 'react'
import { describe, it, expect } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useAsyncResource } from '../useAsyncResource'

function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}

describe('useAsyncResource', () => {
  it('loads data for a key', async () => {
    const { result } = renderHook(() => useAsyncResource('k', async () => 42))
    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.data).toBe(42))
    expect(result.current.loading).toBe(false)
  })
  it('key change clears data synchronously (no stale rows)', async () => {
    const d2 = deferred<string>()
    const { result, rerender } = renderHook(({ k }) => useAsyncResource(k, k === 'a' ? async () => 'A' : () => d2.promise), { initialProps: { k: 'a' } })
    await waitFor(() => expect(result.current.data).toBe('A'))
    rerender({ k: 'b' })
    expect(result.current.data).toBeUndefined()
    expect(result.current.loading).toBe(true)
    await act(async () => d2.resolve('B'))
    expect(result.current.data).toBe('B')
  })
  it('reload keeps showing old data while refetching', async () => {
    let n = 0
    const d = deferred<number>()
    const { result } = renderHook(() => useAsyncResource('k', () => (n++ === 0 ? Promise.resolve(1) : d.promise)))
    await waitFor(() => expect(result.current.data).toBe(1))
    act(() => result.current.reload())
    expect(result.current.data).toBe(1)
    expect(result.current.loading).toBe(true)
    await act(async () => d.resolve(2))
    expect(result.current.data).toBe(2)
  })
  it('a slow earlier response never overwrites a newer key', async () => {
    const slowA = deferred<string>()
    const { result, rerender } = renderHook(({ k }) => useAsyncResource(k, k === 'a' ? () => slowA.promise : async () => 'B'), { initialProps: { k: 'a' } })
    rerender({ k: 'b' })
    await waitFor(() => expect(result.current.data).toBe('B'))
    await act(async () => slowA.resolve('A'))
    expect(result.current.data).toBe('B')
  })
  it('a slow response for the old key is dropped when the key changes to null', async () => {
    const slowA = deferred<string>()
    const { result, rerender } = renderHook(({ k }: { k: string | null }) => useAsyncResource(k, async () => slowA.promise), { initialProps: { k: 'a' as string | null } })
    rerender({ k: null })
    await act(async () => slowA.resolve('A'))
    expect(result.current.data).toBeUndefined()
  })
  it('reload() with a null key does not leave loading stuck true', () => {
    const { result } = renderHook(() => useAsyncResource(null, async () => 1))
    act(() => result.current.reload())
    expect(result.current.loading).toBe(false)
  })
  it('setData (optimistic) wins over an in-flight reload', async () => {
    let n = 0
    const d = deferred<string[]>()
    const { result } = renderHook(() => useAsyncResource('k', () => (n++ === 0 ? Promise.resolve(['x', 'y']) : d.promise)))
    await waitFor(() => expect(result.current.data).toEqual(['x', 'y']))
    act(() => result.current.reload())
    act(() => result.current.setData(prev => (prev ?? []).filter(v => v !== 'x')))
    await act(async () => d.resolve(['x', 'y']))  // stale snapshot from before the delete
    expect(result.current.data).toEqual(['y'])
  })
  it('loads data for a key under StrictMode (double-invoked effects drop the first token)', async () => {
    const { result } = renderHook(() => useAsyncResource('k', async () => 42), { wrapper: StrictMode })
    await waitFor(() => expect(result.current.data).toBe(42))
    expect(result.current.loading).toBe(false)
  })
  it('null key does not fetch', () => {
    let called = false
    const { result } = renderHook(() => useAsyncResource(null, async () => { called = true; return 1 }))
    expect(called).toBe(false)
    expect(result.current.loading).toBe(false)
  })
  it('exposes errors and clears them on success', async () => {
    let fail = true
    const { result } = renderHook(() => useAsyncResource('k', async () => { if (fail) throw new Error('x'); return 1 }))
    await waitFor(() => expect(result.current.error).toBeInstanceOf(Error))
    fail = false
    act(() => result.current.reload())
    await waitFor(() => expect(result.current.data).toBe(1))
    expect(result.current.error).toBeUndefined()
  })
})
