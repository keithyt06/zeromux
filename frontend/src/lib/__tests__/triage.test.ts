import { describe, it, expect } from 'vitest'
import { triage, groupTriage, nextNeedsYou, needsYouCount, toneOf, labelOf, type TriageCtx } from '../triage'
import type { SessionInfo } from '../api'

const NOW = 1_000_000_000
const s = (id: string, o: Partial<SessionInfo> = {}): SessionInfo => ({
  id, name: id, type: 'claude', cols: 80, rows: 24, work_dir: '/w', description: '', status: 'idle',
  running: true, turn_state: 'idle', turn_started_ms: null, last_activity_ms: NOW - 1000, turns_completed: 0,
  tmux_name: null, tmux_origin: null, other_clients: 0, last_outcome: null, last_outcome_ms: null,
  last_snippet: null, current_step: null, pending_approvals: 0, lifetime_cost_usd: 0, ...o,
})
const ctx = (o: Partial<TriageCtx> = {}): TriageCtx => ({ now: NOW, activeId: null, lastViewedMs: {}, confirmsBySession: {}, ...o })

describe('triage()', () => {
  it('error: last turn errored/timeout after last view', () => {
    expect(triage(s('a', { last_outcome: 'errored', last_outcome_ms: NOW - 10 }), ctx({ lastViewedMs: { a: NOW - 20 } }))).toBe('error')
    expect(triage(s('a', { last_outcome: 'timeout', last_outcome_ms: NOW - 10 }), ctx({ lastViewedMs: { a: NOW - 20 } }))).toBe('error')
  })
  it('error already seen → idle', () => {
    expect(triage(s('a', { last_outcome: 'errored', last_outcome_ms: NOW - 30 }), ctx({ lastViewedMs: { a: NOW - 20 } }))).toBe('idle')
  })
  it('approval beats stuck (waiting on the user looks silent)', () => {
    const x = s('a', { turn_state: 'running', last_activity_ms: NOW - 400_000, pending_approvals: 1 })
    expect(triage(x, ctx())).toBe('approval')
  })
  it('stuck: running and silent past STUCK_SILENCE_MS', () => {
    expect(triage(s('a', { turn_state: 'running', last_activity_ms: NOW - 181_000 }), ctx())).toBe('stuck')
    expect(triage(s('a', { turn_state: 'running', last_activity_ms: NOW - 179_000 }), ctx())).toBe('running')
  })
  it('confirm: pending scheduled confirmation for this session', () => {
    expect(triage(s('a'), ctx({ confirmsBySession: { a: 2 } }))).toBe('confirm')
  })
  it('done_unread: completed after last view; not while running', () => {
    const done = s('a', { last_outcome: 'completed', last_outcome_ms: NOW - 10 })
    expect(triage(done, ctx({ lastViewedMs: { a: NOW - 20 } }))).toBe('done_unread')
    expect(triage({ ...done, turn_state: 'running', last_activity_ms: NOW }, ctx({ lastViewedMs: { a: NOW - 20 } }))).toBe('running')
  })
  it('no outcome known (fresh backend restart) is never unread/error', () => {
    expect(triage(s('a', { last_outcome: null, last_outcome_ms: null }), ctx({ lastViewedMs: {} }))).toBe('idle')
  })
  it('missing lastViewed entry means not yet baselined → not unread', () => {
    expect(triage(s('a', { last_outcome: 'completed', last_outcome_ms: NOW - 10 }), ctx({ lastViewedMs: {} }))).toBe('idle')
  })
  it('the active session never shows error/done_unread', () => {
    const x = s('a', { last_outcome: 'errored', last_outcome_ms: NOW - 10 })
    expect(triage(x, ctx({ activeId: 'a', lastViewedMs: { a: 0 } }))).toBe('idle')
  })
  it('cancelled outcome is not an error', () => {
    expect(triage(s('a', { last_outcome: 'cancelled', last_outcome_ms: NOW - 10 }), ctx({ lastViewedMs: { a: 0 } }))).toBe('idle')
  })
  it('ended: process not running', () => {
    expect(triage(s('a', { running: false, turn_state: null }), ctx())).toBe('ended')
  })
  it('tmux sessions are only running/idle/ended', () => {
    expect(triage(s('t', { type: 'tmux', last_outcome: 'errored', last_outcome_ms: NOW }), ctx({ lastViewedMs: { t: 0 } }))).toBe('idle')
  })
  it('tone and label cover all 8 states', () => {
    const all = ['error', 'approval', 'stuck', 'confirm', 'done_unread', 'running', 'idle', 'ended'] as const
    for (const a of all) { expect(toneOf(a)).toBeTruthy(); expect(labelOf(a)).toBeTruthy() }
    expect(toneOf('stuck')).toBe('stuck')
    expect(toneOf('error')).toBe('danger')
    expect(toneOf('done_unread')).toBe('attention')
  })
})

describe('groupTriage / next', () => {
  const list = [
    s('idle1', { last_activity_ms: NOW - 50 }),
    s('run1', { turn_state: 'running', turn_started_ms: NOW - 9000, last_activity_ms: NOW }),
    s('err', { last_outcome: 'errored', last_outcome_ms: NOW - 100 }),
    s('done', { last_outcome: 'completed', last_outcome_ms: NOW - 5 }),
    s('run2', { turn_state: 'running', turn_started_ms: NOW - 1000, last_activity_ms: NOW }),
    s('idle2', { last_activity_ms: NOW - 10 }),
  ]
  const c = ctx({ lastViewedMs: { err: 0, done: 0, idle1: 0, idle2: 0, run1: 0, run2: 0 } })

  it('groups and orders: needsYou by priority then recency; running longest first; idle by recency', () => {
    const g = groupTriage(list, c)
    expect(g.needsYou.map(i => i.s.id)).toEqual(['err', 'done'])
    expect(g.running.map(i => i.s.id)).toEqual(['run1', 'run2'])
    expect(g.idle.map(i => i.s.id)).toEqual(['idle2', 'idle1'])
    expect(needsYouCount(g)).toBe(2)
  })
  it('next: first needs-you after current, wrapping; null when empty', () => {
    const g = groupTriage(list, c)
    expect(nextNeedsYou(g, null)).toBe('err')
    expect(nextNeedsYou(g, 'err')).toBe('done')
    expect(nextNeedsYou(g, 'done')).toBe('err')
    expect(nextNeedsYou(g, 'run1')).toBe('err')
    expect(nextNeedsYou(groupTriage([s('x')], ctx({ lastViewedMs: { x: 0 } })), null)).toBeNull()
  })
  it('next skips the current session when it is the only needs-you item', () => {
    const g = groupTriage([s('only', { pending_approvals: 1 })], ctx())
    expect(nextNeedsYou(g, 'only')).toBeNull()
  })
})
