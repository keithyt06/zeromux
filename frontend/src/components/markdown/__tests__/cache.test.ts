import { describe, it, expect, beforeEach } from 'vitest'
import { mermaidCache } from '../cache'

describe('mermaidCache', () => {
  beforeEach(() => mermaidCache.clear())

  it('starts empty', () => {
    expect(mermaidCache.size).toBe(0)
  })

  it('stores and retrieves svg by hash', () => {
    mermaidCache.set('abc', '<svg/>')
    expect(mermaidCache.get('abc')).toBe('<svg/>')
    expect(mermaidCache.has('abc')).toBe(true)
  })

  it('is the same Map across imports (module singleton)', async () => {
    mermaidCache.set('x', 'y')
    const reimported = (await import('../cache')).mermaidCache
    expect(reimported.get('x')).toBe('y')
  })
})
