import { describe, it, expect } from 'vitest'
import { fuzzyScore, rankBy } from '../fuzzy'

describe('fuzzy', () => {
  it('subsequence, case-insensitive; contiguous and early beats scattered', () => {
    expect(fuzzyScore('zmx', 'zeromux')).not.toBeNull()
    expect(fuzzyScore('xyz', 'zeromux')).toBeNull()
    expect(fuzzyScore('API', 'api-refactor')!).toBeLessThan(fuzzyScore('api', 'my-cool-app-index')!)
    expect(fuzzyScore('', 'anything')).toBe(0)
  })
  it('handles CJK', () => { expect(fuzzyScore('重构', '接口重构')).not.toBeNull() })
  it('rankBy uses the best key and is stable on ties', () => {
    const items = [{ n: 'docs-sync', d: '/w/docs' }, { n: 'api', d: '/w/zeromux' }, { n: 'api2', d: '/w/x' }]
    expect(rankBy('zero', items, t => [t.n, t.d]).map(t => t.n)).toEqual(['api'])
    expect(rankBy('api', items, t => [t.n]).map(t => t.n)).toEqual(['api', 'api2'])
    expect(rankBy('', items, t => [t.n])).toBe(items)
  })
})
