import { describe, it, expect } from 'vitest'
import { MIN_COLS, MIN_ROWS, shouldSendResize } from '../terminalSize'

const base = {
  active: true,
  containerWidth: 400,
  containerHeight: 300,
  cols: 53,
  rows: 20,
  last: { cols: 80, rows: 24 },
}

describe('shouldSendResize', () => {
  it('normal change on a visible, active view → true', () => {
    expect(shouldSendResize(base)).toBe(true)
  })
  it('hidden (display:none → 0x0 container) → false', () => {
    expect(shouldSendResize({ ...base, containerWidth: 0, containerHeight: 0 })).toBe(false)
    expect(shouldSendResize({ ...base, containerWidth: 400, containerHeight: 0 })).toBe(false)
  })
  it('inactive view → false even with real size', () => {
    expect(shouldSendResize({ ...base, active: false })).toBe(false)
  })
  it('tiny fallback dims (12x5 / 10x5) → false', () => {
    expect(shouldSendResize({ ...base, cols: 12, rows: 5 })).toBe(false)
    expect(shouldSendResize({ ...base, cols: 10, rows: 5 })).toBe(false)
    expect(shouldSendResize({ ...base, cols: 80, rows: MIN_ROWS - 1 })).toBe(false)
  })
  it('exact minimum is allowed', () => {
    expect(shouldSendResize({ ...base, cols: MIN_COLS, rows: MIN_ROWS })).toBe(true)
  })
  it('same as last sent → false', () => {
    expect(shouldSendResize({ ...base, last: { cols: 53, rows: 20 } })).toBe(false)
  })
})
