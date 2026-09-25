import { describe, it, expect } from 'vitest'
import { pickDocTabForTarget } from '../docTarget'

describe('pickDocTabForTarget', () => {
  it('reuses the most recently created doc tab', () => {
    expect(pickDocTabForTarget([{ id: 'doc-a', title: 't', kind: 'vault' }, { id: 'doc-b', title: 't', kind: 'vault' }])).toBe('doc-b')
  })
  it('returns null when there is none (caller creates one)', () => {
    expect(pickDocTabForTarget([])).toBeNull()
  })
})
