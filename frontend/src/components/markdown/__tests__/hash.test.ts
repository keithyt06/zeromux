import { describe, it, expect } from 'vitest'
import { fnv1a } from '../hash'

describe('fnv1a', () => {
  it('returns a string', () => {
    expect(typeof fnv1a('hello')).toBe('string')
  })

  it('is deterministic', () => {
    expect(fnv1a('graph TD; A-->B')).toBe(fnv1a('graph TD; A-->B'))
  })

  it('differs for different inputs', () => {
    expect(fnv1a('a')).not.toBe(fnv1a('b'))
  })

  it('handles empty string', () => {
    expect(fnv1a('')).toBe(fnv1a(''))
  })

  it('handles unicode', () => {
    expect(fnv1a('节点 → 边')).not.toBe(fnv1a('节点 → 边2'))
  })
})
