import { describe, it, expect } from 'vitest'

describe('test infra', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2)
  })

  it('has happy-dom globals', () => {
    expect(typeof document).toBe('object')
    expect(typeof window).toBe('object')
  })
})
