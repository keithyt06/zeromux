import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// @ts-expect-error — plain ESM script without types
import { parseThemes, TEXT, SURFACES, STATES, contrastRatio } from '../../../scripts/contrast.mjs'

const css = readFileSync(join(__dirname, '../../index.css'), 'utf8')
const t = parseThemes(css)

describe('design tokens v2', () => {
  it('defines every semantic token in both themes', () => {
    for (const k of [...TEXT, ...SURFACES, ...STATES, '--surface-hover', '--border', '--border-subtle', '--on-accent', '--brand', '--peer', '--focus-ring', '--term-selection']) {
      expect(t.dark[k], `dark ${k}`).toMatch(/^#[0-9a-f]{6,8}$/i)
      expect(t.light[k], `light ${k}`).toMatch(/^#[0-9a-f]{6,8}$/i)
    }
  })
  it('legacy names alias the semantic layer (no divergent values)', () => {
    for (const [legacy, semantic] of [
      ['--bg-primary', '--surface-1'], ['--bg-secondary', '--surface-2'], ['--bg-tertiary', '--surface-3'],
      ['--bg-hover', '--surface-hover'], ['--text-primary', '--fg'], ['--text-bright', '--fg-strong'],
      ['--text-secondary', '--fg-muted'], ['--text-muted', '--fg-subtle'], ['--accent-blue', '--accent'],
      ['--accent-red', '--danger'], ['--accent-yellow', '--attention'], ['--accent-green-text', '--success'],
      ['--accent-brand', '--brand'], ['--border-light', '--border-subtle'],
    ] as const) {
      expect(t.dark[legacy], legacy).toBe(t.dark[semantic])
      expect(t.light[legacy], legacy).toBe(t.light[semantic])
    }
  })
  it('text tokens clear 4.5:1 on every surface, both themes', () => {
    for (const theme of [t.dark, t.light]) {
      for (const fg of TEXT) for (const bg of SURFACES) {
        expect(contrastRatio(theme[fg], theme[bg]), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })
  it('keeps --text-muted distinct from the old failing value', () => {
    expect(t.dark['--text-muted']).not.toBe('#484f58')
  })
  it('ANSI palette matches the xterm palette the user actually sees', () => {
    expect(t.dark['--ansi-0']).toBe('#484f58')
    expect(t.light['--ansi-15']).toBe('#8c959f')
  })
  it('z-layers: popover sits above legacy z-50 overlays, below toasts', () => {
    const z = (n: string) => Number(css.match(new RegExp(`--z-${n}:\\s*(\\d+)`))?.[1])
    expect(z('sticky')).toBeLessThan(z('drawer'))
    expect(z('drawer')).toBeLessThan(z('modal'))
    // Hand-rolled `fixed inset-0 z-50` overlays (FileBrowser root picker) host
    // Menus that portal to #overlay-root — the popover must clear them.
    expect(z('popover')).toBeGreaterThan(50)
    expect(z('popover')).toBeGreaterThan(z('modal'))
    expect(z('popover')).toBeLessThan(z('toast'))
  })
})
