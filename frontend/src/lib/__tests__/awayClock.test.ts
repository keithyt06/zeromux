import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useAwayWindow, readLeft, LEFT_KEY } from '../awayClock'

const T0 = 1_000_000_000
const setVis = (v: 'visible' | 'hidden') =>
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v })

describe('awayClock', () => {
  beforeEach(() => { localStorage.clear(); vi.useFakeTimers(); vi.setSystemTime(T0) })
  afterEach(() => {
    vi.useRealTimers()
    delete (document as unknown as Record<string, unknown>).visibilityState
  })

  it('first open ever: no left time, so no window', () => {
    const { result } = renderHook(() => useAwayWindow())
    expect(result.current.leftMs).toBeNull()
  })

  it('pagehide and visibilitychange→hidden both stamp the left time', () => {
    renderHook(() => useAwayWindow())
    act(() => { window.dispatchEvent(new Event('pagehide')) })
    expect(localStorage.getItem(LEFT_KEY)).toBe(String(T0))
    vi.setSystemTime(T0 + 5)
    setVis('hidden')
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(readLeft()).toBe(T0 + 5)
  })

  it('resume from background re-arms the card', () => {
    // Review Focus 2: iOS PWAs resume without reloading, so mount-time reads are not enough.
    const { result } = renderHook(() => useAwayWindow())
    act(() => result.current.dismiss())
    expect(result.current.dismissed).toBe(true)
    setVis('hidden')
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    vi.setSystemTime(T0 + 2 * 3_600_000)
    setVis('visible')
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(result.current.leftMs).toBe(T0)
    expect(result.current.backMs).toBe(T0 + 2 * 3_600_000)
    expect(result.current.dismissed).toBe(false)
  })

  it('garbage in storage reads as no left time', () => {
    localStorage.setItem(LEFT_KEY, 'soon')
    expect(readLeft()).toBeNull()
  })
})
