import { describe, it, expect, vi } from 'vitest'
import { dragToScroll, inertiaLines, ScrollBatcher, scheduleInertia } from '../terminalScroll'

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
