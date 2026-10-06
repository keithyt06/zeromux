import { describe, it, expect } from 'vitest'
import { variantOf, CREW_VARIANT_FIELDS, CREW_VARIANT_OPTIONS, CREW_VARIANT_WORDS, GOAL_AGENT } from '../crewVariant'

describe('crewVariant', () => {
  it('derives the display variant from the raw Gateway values (agent wins over mode)', () => {
    expect(variantOf({ type: 'crew', crew_mode: '', crew_agent: GOAL_AGENT })).toBe('goal')
    expect(variantOf({ type: 'crew', crew_mode: 'crew', crew_agent: GOAL_AGENT })).toBe('goal')
    expect(variantOf({ type: 'crew', crew_mode: 'crew', crew_agent: '' })).toBe('topics')
    expect(variantOf({ type: 'crew', crew_mode: '', crew_agent: '' })).toBe('chat')
    expect(variantOf({ type: 'crew' })).toBe('chat')             // pre-S5 backend: fields absent
    expect(variantOf({ type: 'claude', crew_agent: GOAL_AGENT })).toBeNull()
  })
  it('variant → create fields; chat is the empty default', () => {
    expect(CREW_VARIANT_FIELDS.chat).toEqual({ crew_mode: '', crew_agent: '' })
    expect(CREW_VARIANT_FIELDS.goal).toEqual({ crew_mode: '', crew_agent: 'kirocrew-conductor' })
    expect(CREW_VARIANT_FIELDS.topics).toEqual({ crew_mode: 'crew', crew_agent: '' })
  })
  it('S5 offers no 并行话题 chip or keyword (D1)', () => {
    expect(CREW_VARIANT_OPTIONS.map(o => o.value)).not.toContain('topics')
    expect(Object.values(CREW_VARIANT_WORDS)).not.toContain('topics')
  })
})
