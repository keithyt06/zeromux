import { describe, it, expect } from 'vitest'
import { findMatches } from '../historySearch'

describe('findMatches', () => {
  it('finds across chunks, case-insensitive', () => {
    expect(findMatches(['Error a\nok', 'x error'], 'ERROR')).toEqual([{ chunk: 0, offset: 0 }, { chunk: 1, offset: 2 }])
  })
  it('empty query → none', () => {
    expect(findMatches(['a'], '')).toEqual([])
  })
})
