import { describe, it, expect } from 'vitest'
import { contrastRatio, parseThemes, checkPairs } from '../contrast.mjs'

describe('contrast', () => {
  it('matches WCAG reference values', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1)
    expect(contrastRatio('#484f58', '#11161d')).toBeCloseTo(2.19, 2)
  })
  it('parses :root and :root.light custom properties', () => {
    const css = ':root { --a: #111111; --b: #eeeeee; }\n:root.light { --a: #ffffff; }'
    const t = parseThemes(css)
    expect(t.dark['--a']).toBe('#111111')
    expect(t.light['--a']).toBe('#ffffff')
    expect(t.light['--b']).toBe('#eeeeee') // light inherits unspecified dark values
  })
  it('resolves var() aliases', () => {
    const t = parseThemes(':root { --x: #222222; --y: var(--x); }')
    expect(t.dark['--y']).toBe('#222222')
  })
  it('reports failing pairs', () => {
    const r = checkPairs({ '--fg': '#484f58', '--bg': '#11161d' }, [['--fg', '--bg', 4.5]])
    expect(r[0].ok).toBe(false)
  })
})
