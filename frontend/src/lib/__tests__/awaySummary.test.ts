import { describe, it, expect } from 'vitest'
import { summarizeAway, formatAway, AWAY_PRIORITY } from '../awaySummary'
import { mkSession } from '../../test/appHarness'

const H = 3_600_000
const BACK = 100 * H
const LEFT = BACK - 7 * H

describe('summarizeAway', () => {
  it('counts only events inside (left, back], in priority order, omitting zero items', () => {
    const s = [
      mkSession('c1', { last_outcome: 'completed', last_outcome_ms: LEFT + H, lifetime_cost_usd: 1.5 }),
      mkSession('c2', { last_outcome: 'completed', last_outcome_ms: LEFT + 2 * H, lifetime_cost_usd: 1.6 }),
      mkSession('e1', { last_outcome: 'timeout', last_outcome_ms: LEFT + 3 * H }),
      mkSession('old', { last_outcome: 'completed', last_outcome_ms: LEFT - 1, lifetime_cost_usd: 9 }),
      mkSession('late', { last_outcome: 'errored', last_outcome_ms: BACK + 1 }),
      mkSession('cx', { last_outcome: 'cancelled', last_outcome_ms: LEFT + H }),
    ]
    const r = summarizeAway(s, { c1: 2 }, LEFT, BACK)!
    expect(r.awayMs).toBe(7 * H)
    expect(r.items.map(i => [i.key, i.label, i.count, i.firstId])).toEqual([
      ['errored', '出错', 1, 'e1'],
      ['confirm', '待确认', 2, 'c1'],
      ['completed', '完成', 2, 'c2'],          // newest first
    ])
    expect(r.costUsd).toBeCloseTo(3.1)          // windowed sessions only: c1 + c2 (+ e1, cx at $0)
    expect(r.costPartial).toBe(false)
  })
  it('null when away < 30 min, never left, or nothing happened', () => {
    const s = [mkSession('c', { last_outcome: 'completed', last_outcome_ms: BACK - 60_000 })]
    expect(summarizeAway(s, {}, BACK - 29 * 60_000, BACK)).toBeNull()
    expect(summarizeAway(s, {}, null, BACK)).toBeNull()
    expect(summarizeAway([mkSession('o', { last_outcome: 'completed', last_outcome_ms: LEFT - H })], {}, LEFT, BACK)).toBeNull()
  })
  it('only a stale out-of-window confirm → null (confirms carry no timestamp, so they never trigger the card alone)', () => {
    expect(summarizeAway([mkSession('a')], { a: 1 }, LEFT, BACK)).toBeNull()
  })
  it('pending confirms ride along once an in-window event shows the card', () => {
    const r = summarizeAway([mkSession('a'), mkSession('d', { last_outcome: 'completed', last_outcome_ms: LEFT + H })], { a: 1 }, LEFT, BACK)!
    expect(r.items).toEqual([
      { key: 'confirm', label: '待确认', count: 1, firstId: 'a' },
      { key: 'completed', label: '完成', count: 1, firstId: 'd' },
    ])
  })
  it('Codex / Crew in the window mark the cost as partial; tmux is ignored', () => {
    const r = summarizeAway([
      mkSession('x', { type: 'codex', last_outcome: 'completed', last_outcome_ms: LEFT + H }),
      mkSession('t', { type: 'tmux', last_outcome: 'errored', last_outcome_ms: LEFT + H }),
    ], {}, LEFT, BACK)!
    expect(r.costPartial).toBe(true)
    expect(r.items.map(i => i.key)).toEqual(['completed'])
  })
  it('the priority key is the spec §3.2 order (S6 appends rows by it)', () => {
    expect(AWAY_PRIORITY).toEqual(['errored', 'awaiting', 'confirm', 'completed', 'other'])
  })
})

describe('formatAway', () => {
  it('minutes, hours, then days', () => {
    expect(formatAway(45 * 60_000)).toBe('45m')
    expect(formatAway(7 * H + 20 * 60_000)).toBe('7h')
    expect(formatAway(50 * H)).toBe('2d')
  })
})
