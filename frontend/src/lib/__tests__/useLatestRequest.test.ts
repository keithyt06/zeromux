import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useLatestRequest } from '../useLatestRequest'

describe('useLatestRequest', () => {
  it('only the latest begin() is current', () => {
    const { result } = renderHook(() => useLatestRequest())
    const a = result.current.begin()
    const b = result.current.begin()
    expect(result.current.isCurrent(a)).toBe(false)
    expect(result.current.isCurrent(b)).toBe(true)
  })
  it('bump() invalidates in-flight requests (optimistic write guard)', () => {
    const { result } = renderHook(() => useLatestRequest())
    const t = result.current.begin()
    result.current.bump()
    expect(result.current.isCurrent(t)).toBe(false)
  })
  it('is stable across renders', () => {
    const { result, rerender } = renderHook(() => useLatestRequest())
    const first = result.current
    rerender()
    expect(result.current).toBe(first)
  })
})
