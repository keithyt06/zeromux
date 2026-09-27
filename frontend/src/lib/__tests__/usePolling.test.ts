import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { usePolling } from '../usePolling'

function setVisibility(v: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: v, configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
}

describe('usePolling', () => {
  afterEach(() => { vi.useRealTimers(); setVisibility('visible') })

  it('runs immediately then every interval', async () => {
    vi.useFakeTimers()
    const fn = vi.fn()
    renderHook(() => usePolling(fn, 1000))
    expect(fn).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(fn).toHaveBeenCalledTimes(4)
  })
  it('pauses while hidden and fires once on return', async () => {
    vi.useFakeTimers()
    const fn = vi.fn()
    renderHook(() => usePolling(fn, 1000))
    act(() => setVisibility('hidden'))
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(fn).toHaveBeenCalledTimes(1)
    act(() => setVisibility('visible'))
    expect(fn).toHaveBeenCalledTimes(2)
  })
  it('disabled does nothing', async () => {
    vi.useFakeTimers()
    const fn = vi.fn()
    renderHook(() => usePolling(fn, 1000, { enabled: false }))
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(fn).not.toHaveBeenCalled()
  })
  it('skips a tick while the previous run is still pending', async () => {
    vi.useFakeTimers()
    let release!: () => void
    const fn = vi.fn(() => new Promise<void>(r => { release = r }))
    renderHook(() => usePolling(fn, 1000))
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(fn).toHaveBeenCalledTimes(1)
    await act(async () => { release(); await vi.advanceTimersByTimeAsync(1000) })
    expect(fn).toHaveBeenCalledTimes(2)
  })
})
