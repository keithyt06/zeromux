import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useDirBrowser } from '../useDirBrowser'
import * as api from '../api'

function deferred<T>() { let resolve!: (v: T) => void, reject!: (e: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const listing = (current: string) => ({ current, parent: '/h', home: '/h', entries: [{ name: 'x', path: current + '/x' }] })

describe('useDirBrowser', () => {
  beforeEach(() => vi.restoreAllMocks())
  it('a slower earlier listing never overwrites a newer one', async () => {
    const slow = deferred<ReturnType<typeof listing>>()
    vi.spyOn(api, 'listDirectories').mockImplementationOnce(() => slow.promise as never).mockResolvedValueOnce(listing('/h/b') as never)
    const { result } = renderHook(() => useDirBrowser())
    act(() => { void result.current.load('/h/a') })
    await act(async () => { await result.current.load('/h/b') })
    await act(async () => slow.resolve(listing('/h/a')))
    expect(result.current.currentPath).toBe('/h/b')
  })
  it('reset() drops state and an in-flight listing cannot repopulate it', async () => {
    const slow = deferred<ReturnType<typeof listing>>()
    vi.spyOn(api, 'listDirectories').mockImplementationOnce(() => slow.promise as never)
    const { result } = renderHook(() => useDirBrowser())
    act(() => { void result.current.load('/h/a') })
    act(() => result.current.reset())
    await act(async () => slow.resolve(listing('/h/a')))
    expect(result.current.currentPath).toBe('')
    expect(result.current.loading).toBe(false)
  })
  it('timeout surfaces a retryable message', async () => {
    vi.spyOn(api, 'listDirectories').mockRejectedValueOnce(new DOMException('x', 'AbortError')).mockResolvedValueOnce(listing('/h') as never)
    const { result } = renderHook(() => useDirBrowser())
    await act(async () => { await result.current.load('/h') })
    expect(result.current.error).toBe('加载超时，请重试')
    act(() => result.current.retry())
    await waitFor(() => expect(result.current.currentPath).toBe('/h'))
    expect(result.current.error).toBeNull()
  })
})
