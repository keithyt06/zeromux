import { describe, it, expect, beforeEach } from 'vitest'
import { loadLastViewed, reconcileLastViewed, markViewed, saveLastViewed, READ_KEY } from '../readState'

describe('readState (spec v3 M10)', () => {
  beforeEach(() => localStorage.clear())
  it('baselines unseen sids at now and GCs vanished ones', () => {
    const r = reconcileLastViewed({ gone: 5, a: 10 }, ['a', 'b'], 100)
    expect(r).toEqual({ a: 10, b: 100 })
  })
  it('returns the same object when nothing changed (no re-render churn)', () => {
    const prev = { a: 10 }
    expect(reconcileLastViewed(prev, ['a'], 100)).toBe(prev)
  })
  it('markViewed only moves forward', () => {
    expect(markViewed({ a: 50 }, 'a', 40)).toEqual({ a: 50 })
    expect(markViewed({ a: 50 }, 'a', 60)).toEqual({ a: 60 })
  })
  it('round-trips through localStorage and survives garbage', () => {
    saveLastViewed({ a: 1 })
    expect(loadLastViewed()).toEqual({ a: 1 })
    localStorage.setItem(READ_KEY, '{not json')
    expect(loadLastViewed()).toEqual({})
    localStorage.setItem(READ_KEY, JSON.stringify({ a: 'x', b: 2 }))
    expect(loadLastViewed()).toEqual({ b: 2 })
  })
})
