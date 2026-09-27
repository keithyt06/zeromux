import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { resolveTheme, applyResolvedTheme, useTheme } from '../theme'

function mockSystem(light: boolean) {
  const listeners: ((e: { matches: boolean }) => void)[] = []
  const mq = { matches: light, addEventListener: (_: string, f: (e: { matches: boolean }) => void) => listeners.push(f), removeEventListener: () => {} }
  vi.stubGlobal('matchMedia', (q: string) => (q.includes('prefers-color-scheme: light') ? mq : { matches: false, addEventListener() {}, removeEventListener() {} }))
  return { flip(v: boolean) { mq.matches = v; listeners.forEach(f => f({ matches: v })) } }
}

describe('theme', () => {
  beforeEach(() => { localStorage.clear(); document.documentElement.className = ''; vi.unstubAllGlobals() })

  it('resolves system to the OS preference', () => {
    expect(resolveTheme('system', true)).toBe('light')
    expect(resolveTheme('system', false)).toBe('dark')
    expect(resolveTheme('dark', true)).toBe('dark')
  })
  it('applyResolvedTheme sets class and color-scheme synchronously', () => {
    applyResolvedTheme('light')
    expect(document.documentElement.classList.contains('light')).toBe(true)
    expect(document.documentElement.style.colorScheme).toBe('light')
    applyResolvedTheme('dark')
    expect(document.documentElement.classList.contains('light')).toBe(false)
  })
  it('defaults to system and follows OS changes live', () => {
    const sys = mockSystem(false)
    const { result } = renderHook(() => useTheme())
    expect(result.current.pref).toBe('system')
    expect(result.current.theme).toBe('dark')
    act(() => sys.flip(true))
    expect(result.current.theme).toBe('light')
    expect(document.documentElement.classList.contains('light')).toBe(true)
  })
  it('explicit pref overrides OS and persists', () => {
    mockSystem(true)
    const { result } = renderHook(() => useTheme())
    act(() => result.current.setPref('dark'))
    expect(result.current.theme).toBe('dark')
    expect(localStorage.getItem('zeromux_theme')).toBe('dark')
  })
  it('class is applied BEFORE state commits (child effects read new vars)', () => {
    mockSystem(false)
    const { result } = renderHook(() => useTheme())
    let classAtSet = false
    act(() => { result.current.setPref('light'); classAtSet = document.documentElement.classList.contains('light') })
    expect(classAtSet).toBe(true)
  })
  it('legacy stored value keeps working', () => {
    mockSystem(false)
    localStorage.setItem('zeromux_theme', 'light')
    const { result } = renderHook(() => useTheme())
    expect(result.current.pref).toBe('light')
  })
  it('falls back to addListener/removeListener when addEventListener is missing (old Safari)', () => {
    const listeners: ((e: { matches: boolean }) => void)[] = []
    const mq = { matches: false, addListener: (f: (e: { matches: boolean }) => void) => listeners.push(f), removeListener: () => {} }
    vi.stubGlobal('matchMedia', (q: string) => (q.includes('prefers-color-scheme: light') ? mq : { matches: false, addListener() {}, removeListener() {} }))
    const { result } = renderHook(() => useTheme())
    expect(result.current.theme).toBe('dark')
    act(() => { mq.matches = true; listeners.forEach(f => f({ matches: true })) })
    expect(result.current.theme).toBe('light')
  })
})
