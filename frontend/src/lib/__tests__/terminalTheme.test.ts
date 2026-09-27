import { describe, it, expect } from 'vitest'
import { readTerminalTheme } from '../terminalTheme'

describe('readTerminalTheme', () => {
  it('maps CSS variables to an xterm ITheme', () => {
    const s = document.documentElement.style
    s.setProperty('--surface-0', '#0d1117'); s.setProperty('--term-fg', '#c9d1d9')
    s.setProperty('--accent', '#58a6ff'); s.setProperty('--term-selection', '#264f78')
    for (let i = 0; i < 16; i++) s.setProperty(`--ansi-${i}`, `#0000${i.toString(16).padStart(2, '0')}`)
    const t = readTerminalTheme()
    expect(t.background).toBe('#0d1117')
    expect(t.foreground).toBe('#c9d1d9')
    expect(t.cursor).toBe('#58a6ff')
    expect(t.selectionBackground).toBe('#264f78')
    expect(t.black).toBe('#000000')
    expect(t.brightWhite).toBe('#00000f')
  })
})
