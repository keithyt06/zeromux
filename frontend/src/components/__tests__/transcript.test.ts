import { describe, it, expect } from 'vitest'
import { foldTranscript, type WireEvent } from '../../lib/transcript'

describe('foldTranscript — turn grouping (T1)', () => {
  it('keeps a streaming turn together when a new prompt arrives mid-stream', () => {
    // ContentBlocks of turn 1 interleaved with a UserPrompt for turn 2.
    const events: WireEvent[] = [
      { type: 'content_block', block_type: 'text', text: 'answer part 1', turn_id: 1 },
      { type: 'content_block', block_type: 'text', text: ' part 2', turn_id: 1 },
      { type: 'user_prompt', text: 'new question', turn_id: 2, client_id: 'c2' },
      { type: 'content_block', block_type: 'text', text: ' part 3', turn_id: 1 },
    ]
    const groups = foldTranscript(events)
    // Turn 1 assistant text is contiguous; turn 2 prompt is its own group AFTER.
    const t1 = groups.find(g => g.turnId === 1)!
    const t2 = groups.find(g => g.turnId === 2)!
    expect(t1.assistantText()).toBe('answer part 1 part 2 part 3')
    expect(groups.indexOf(t1)).toBeLessThan(groups.indexOf(t2))
    expect(t2.userPrompts.map(p => p.text)).toEqual(['new question'])
  })

  it('orders user→assistant→user across turns', () => {
    const events: WireEvent[] = [
      { type: 'user_prompt', text: 'q1', turn_id: 1, client_id: 'c1' },
      { type: 'content_block', block_type: 'text', text: 'a1', turn_id: 1 },
      { type: 'result', text: '', turn_id: 1 },
      { type: 'user_prompt', text: 'q2', turn_id: 2, client_id: 'c2' },
      { type: 'content_block', block_type: 'text', text: 'a2', turn_id: 2 },
    ]
    const groups = foldTranscript(events)
    expect(groups.map(g => g.turnId)).toEqual([1, 2])
    expect(groups[0].userPrompts[0].text).toBe('q1')
    expect(groups[0].assistantText()).toBe('a1')
  })

  it('dedupes a user_prompt that matches an existing optimistic client_id', () => {
    const events: WireEvent[] = [
      { type: 'user_prompt', text: 'q1', turn_id: 1, client_id: 'c1' },
    ]
    const groups = foldTranscript(events, new Set(['c1']))
    // optimistic bubble c1 already shown → not re-added
    expect(groups.find(g => g.turnId === 1)?.userPrompts ?? []).toHaveLength(0)
  })
})
