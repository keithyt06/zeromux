import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useMediaQuery, useIsTouch } from '../useMediaQuery'

function stubMq(initial: Record<string, boolean>) {
  const state = { ...initial }
  const ls: Record<string, (() => void)[]> = {}
  vi.stubGlobal('matchMedia', (q: string) => ({
    get matches() { return !!state[q] },
    addEventListener: (_: string, f: () => void) => { (ls[q] ||= []).push(f) },
    removeEventListener: (_: string, f: () => void) => { ls[q] = (ls[q] || []).filter(x => x !== f) },
  }))
  return { set(q: string, v: boolean) { state[q] = v; (ls[q] || []).forEach(f => f()) } }
}

describe('useMediaQuery', () => {
  beforeEach(() => vi.unstubAllGlobals())
  it('reflects changes live (not computed once)', () => {
    const mq = stubMq({ '(max-width: 767px)': true })
    const { result } = renderHook(() => useMediaQuery('(max-width: 767px)'))
    expect(result.current).toBe(true)
    act(() => mq.set('(max-width: 767px)', false))
    expect(result.current).toBe(false)
  })
  it('useIsTouch is true for maxTouchPoints>0 even without coarse pointer', () => {
    stubMq({})
    Object.defineProperty(navigator, 'maxTouchPoints', { value: 5, configurable: true })
    const { result } = renderHook(() => useIsTouch())
    expect(result.current).toBe(true)
    Object.defineProperty(navigator, 'maxTouchPoints', { value: 0, configurable: true })
  })
  it('falls back to addListener/removeListener when addEventListener is missing (old Safari)', () => {
    const state: Record<string, boolean> = { '(max-width: 767px)': true }
    const ls: Record<string, (() => void)[]> = {}
    vi.stubGlobal('matchMedia', (q: string) => ({
      get matches() { return !!state[q] },
      addListener: (f: () => void) => { (ls[q] ||= []).push(f) },
      removeListener: (f: () => void) => { ls[q] = (ls[q] || []).filter(x => x !== f) },
    }))
    const { result } = renderHook(() => useMediaQuery('(max-width: 767px)'))
    expect(result.current).toBe(true)
    act(() => { state['(max-width: 767px)'] = false; ls['(max-width: 767px)']?.forEach(f => f()) })
    expect(result.current).toBe(false)
  })
})
