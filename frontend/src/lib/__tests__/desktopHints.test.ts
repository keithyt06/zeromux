import { describe, it, expect } from 'vitest'
import { shouldShowShiftHint, mousePref, MOUSE_PREF_KEY } from '../desktopHints'

const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) } } }

describe('desktopHints', () => {
  it('shift hint only once', () => {
    const s = mem()
    expect(shouldShowShiftHint(s)).toBe(true)
    expect(shouldShowShiftHint(s)).toBe(false)
  })
  it('mouse pref defaults on, respects "0"', () => {
    const s = mem()
    expect(mousePref(s)).toBe(true)
    s.setItem(MOUSE_PREF_KEY, '0')
    expect(mousePref(s)).toBe(false)
  })
})
