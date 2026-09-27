import { describe, it, expect } from 'vitest'
import { formatCost, formatDuration, formatRelative } from '../format'

describe('format', () => {
  it('cost', () => {
    expect(formatCost(0.4213, 'short')).toBe('$0.42')
    expect(formatCost(0.4213, 'long')).toBe('$0.4213')
    expect(formatCost(0.004, 'short')).toBe('<$0.01')
    expect(formatCost(0, 'short')).toBe('$0.00')
    expect(formatCost(null, 'short')).toBe('')
    expect(formatCost(undefined, 'long')).toBe('')
  })
  it('duration', () => {
    expect(formatDuration(400)).toBe('0.4s')
    expect(formatDuration(12_000)).toBe('12s')
    expect(formatDuration(192_000)).toBe('3m12s')
    expect(formatDuration(3_900_000)).toBe('1h05m')
    expect(formatDuration(null)).toBe('')
    expect(formatDuration(-5)).toBe('')
  })
  it('relative', () => {
    const now = new Date('2026-09-27T12:00:00+08:00').getTime()
    expect(formatRelative(now - 20_000, now)).toBe('刚刚')
    expect(formatRelative(now - 3 * 60_000, now)).toBe('3 分钟前')
    expect(formatRelative(now - 2 * 3600_000, now)).toBe('2 小时前')
    expect(formatRelative(now - 26 * 3600_000, now)).toBe('昨天')
    expect(formatRelative(new Date('2026-09-01T09:00:00+08:00').getTime(), now)).toBe('9月1日')
  })
})
