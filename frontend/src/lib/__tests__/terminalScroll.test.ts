import { describe, it, expect, vi } from 'vitest'
import { dragToScroll, inertiaLines, pillFromScrollState, ScrollBatcher, scheduleInertia, shouldCancelBeforeInput } from '../terminalScroll'

describe('dragToScroll', () => {
  // linesFromDrag convention: finger moves UP → positive → newer content (scroll down).
  it('negative lines (finger down) → up into history', () => {
    expect(dragToScroll(-3)).toEqual({ op: 'up', n: 3 })
  })
  it('positive lines → down', () => {
    expect(dragToScroll(4)).toEqual({ op: 'down', n: 4 })
  })
  it('zero → nothing', () => {
    expect(dragToScroll(0)).toBeNull()
  })
})

describe('inertiaLines', () => {
  it('slow flick → no inertia', () => {
    expect(inertiaLines(0.1, 20)).toEqual([])
  })
  it('fast flick decays and keeps direction', () => {
    const steps = inertiaLines(-2, 20)
    expect(steps.length).toBeGreaterThan(2)
    expect(steps.every(s => s < 0)).toBe(true)
    expect(Math.abs(steps[0])).toBeGreaterThanOrEqual(Math.abs(steps[steps.length - 1]))
  })
})

describe('ScrollBatcher', () => {
  it('coalesces same-direction lines per interval and splits on direction change', () => {
    vi.useFakeTimers()
    const send = vi.fn()
    const b = new ScrollBatcher(send, 50)
    b.add(-1); b.add(-2)
    expect(send).not.toHaveBeenCalled()
    vi.advanceTimersByTime(50)
    expect(send).toHaveBeenCalledWith({ op: 'up', n: 3 })
    b.add(-1); b.add(2)          // direction change flushes the pending up first
    expect(send).toHaveBeenLastCalledWith({ op: 'up', n: 1 })
    vi.advanceTimersByTime(50)
    expect(send).toHaveBeenLastCalledWith({ op: 'down', n: 2 })
    b.dispose()
    vi.useRealTimers()
  })
})

describe('scheduleInertia', () => {
  it('feeds steps one per stepMs and cancel stops the rest', () => {
    vi.useFakeTimers()
    const add = vi.fn()
    const cancel = scheduleInertia([-3, -2, -1], add, 16)
    vi.advanceTimersByTime(0)
    expect(add).toHaveBeenCalledTimes(1)
    expect(add).toHaveBeenLastCalledWith(-3)
    vi.advanceTimersByTime(16)
    expect(add).toHaveBeenCalledTimes(2)
    cancel()
    vi.advanceTimersByTime(100)
    expect(add).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })
})

describe('ScrollBatcher.cancel', () => {
  it('drops pending lines and stays usable', () => {
    vi.useFakeTimers()
    const send = vi.fn()
    const b = new ScrollBatcher(send, 50)
    b.add(-4)
    b.cancel()
    vi.advanceTimersByTime(100)
    expect(send).not.toHaveBeenCalled()
    b.add(2)
    vi.advanceTimersByTime(50)
    expect(send).toHaveBeenCalledWith({ op: 'down', n: 2 })
    b.dispose()
    vi.useRealTimers()
  })
})

describe('shouldCancelBeforeInput', () => {
  it('touch: cancels only when scrolling', () => {
    expect(shouldCancelBeforeInput({ scrolling: true, isTouch: true, hasTmux: true, wheelSinceInput: false })).toBe(true)
    expect(shouldCancelBeforeInput({ scrolling: false, isTouch: true, hasTmux: true, wheelSinceInput: true })).toBe(false)
  })
  it('desktop tmux after a wheel event: cancels even though not scrolling', () => {
    expect(shouldCancelBeforeInput({ scrolling: false, isTouch: false, hasTmux: true, wheelSinceInput: true })).toBe(true)
  })
  it('desktop tmux, no wheel, not scrolling: no cancel', () => {
    expect(shouldCancelBeforeInput({ scrolling: false, isTouch: false, hasTmux: true, wheelSinceInput: false })).toBe(false)
  })
  it('non-tmux: never force-cancels from a wheel event', () => {
    expect(shouldCancelBeforeInput({ scrolling: false, isTouch: false, hasTmux: false, wheelSinceInput: true })).toBe(false)
  })
})

describe('pillFromScrollState', () => {
  it('copy-mode route follows in_mode (unchanged behavior)', () => {
    expect(pillFromScrollState({ in_mode: true }, 'up')).toEqual({ scrolling: true, appScroll: false })
    expect(pillFromScrollState({ in_mode: false }, 'up')).toEqual({ scrolling: false, appScroll: false })
    expect(pillFromScrollState({ in_mode: false, app_scroll: false }, 'down')).toEqual({ scrolling: false, appScroll: false })
  })
  it('app-wheel route keeps the pill while reading, even though in_mode is false', () => {
    expect(pillFromScrollState({ in_mode: false, app_scroll: true }, 'up')).toEqual({ scrolling: true, appScroll: true })
    expect(pillFromScrollState({ in_mode: false, app_scroll: true }, 'down')).toEqual({ scrolling: true, appScroll: true })
  })
  it('app-wheel reply after the last sent op was bottom/cancel clears the pill (late replies cannot reopen it)', () => {
    expect(pillFromScrollState({ in_mode: false, app_scroll: true }, 'bottom')).toEqual({ scrolling: false, appScroll: false })
    expect(pillFromScrollState({ in_mode: false, app_scroll: true }, 'cancel')).toEqual({ scrolling: false, appScroll: false })
  })
})
