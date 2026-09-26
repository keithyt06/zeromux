import { describe, it, expect } from 'vitest'
import { parseAnsiLine, stripAnsi } from '../ansi'

describe('parseAnsiLine', () => {
  it('plain text → one span', () => {
    expect(parseAnsiLine('hello')).toEqual([{ text: 'hello' }])
  })
  it('basic fg + reset', () => {
    expect(parseAnsiLine('\x1b[31mred\x1b[0m ok')).toEqual([{ text: 'red', fg: 'var(--ansi-1)' }, { text: ' ok' }])
  })
  it('bold + 256 + truecolor', () => {
    const s = parseAnsiLine('\x1b[1;38;5;196mA\x1b[38;2;1;2;3mB')
    expect(s[0]).toEqual({ text: 'A', fg: 'rgb(255,0,0)', bold: true })
    expect(s[1]).toEqual({ text: 'B', fg: 'rgb(1,2,3)', bold: true })
  })
  it('drops non-SGR escapes', () => {
    expect(stripAnsi('\x1b[2Ka\x1b]0;title\x07b')).toBe('ab')
    expect(parseAnsiLine('\x1b[2Kx')).toEqual([{ text: 'x' }])
  })
})
