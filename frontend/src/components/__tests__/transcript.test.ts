import { describe, it, expect } from 'vitest'
import { foldTranscript, stabilizeGroups, type WireEvent } from '../../lib/transcript'

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

  it('renders the local optimistic user_prompt as its own bubble', () => {
    // foldTranscript does NOT dedupe by client_id — AcpChatView handles the
    // server echo by rewriting the optimistic entry's turn_id in place, so
    // there is only ever one user_prompt per cid. The folder must render it.
    const events: WireEvent[] = [
      { type: 'user_prompt', text: 'q1', turn_id: 1, client_id: 'c1' },
    ]
    const groups = foldTranscript(events)
    expect(groups.find(g => g.turnId === 1)?.userPrompts.map(p => p.text)).toEqual(['q1'])
  })
})

describe('foldTranscript — result reconcile (F1: lossy Codex stream)', () => {
  it('does not duplicate: suppresses final result when the stream already carries it', () => {
    // Healthy stream (Claude/Kiro/Codex no-drop): the concatenated deltas equal
    // the authoritative result.text, so re-appending would double the message.
    const events: WireEvent[] = [
      { type: 'content_block', block_type: 'text', text: 'Hello ', streaming: true, turn_id: 1 },
      { type: 'content_block', block_type: 'text', text: 'world', streaming: true, turn_id: 1 },
      { type: 'result', text: 'Hello world', turn_id: 1 },
    ]
    const g = foldTranscript(events).find(g => g.turnId === 1)!
    expect(g.assistantText()).toBe('Hello world')
  })

  it('heals a dropped delta: appends authoritative text when the stream diverged', () => {
    // Codex drops a chunk under backpressure (try_send full) → the stream is
    // missing " brown" but result.text is complete. The old !hasStreamed gate
    // discarded result.text on any streamed text, leaving a permanent hole.
    const events: WireEvent[] = [
      { type: 'content_block', block_type: 'text', text: 'The quick ', streaming: true, turn_id: 1 },
      // " brown" delta dropped here
      { type: 'content_block', block_type: 'text', text: 'fox', streaming: true, turn_id: 1 },
      { type: 'result', text: 'The quick brown fox', turn_id: 1 },
    ]
    const g = foldTranscript(events).find(g => g.turnId === 1)!
    // The authoritative full text is present (not the lossy 'The quick fox').
    expect(g.assistantText()).toContain('The quick brown fox')
  })

  it('still fills the text when every delta was dropped', () => {
    // Full-drop case the old gate already handled (!hasStreamed): result.text
    // is the only surviving copy and must render.
    const events: WireEvent[] = [
      { type: 'result', text: 'answer', turn_id: 1 },
    ]
    const g = foldTranscript(events).find(g => g.turnId === 1)!
    expect(g.assistantText()).toBe('answer')
  })

  it('ignores trailing-whitespace differences (no spurious duplication)', () => {
    // result.text is trimmed backend-side / here; streamed text may carry a
    // trailing newline. A raw !== check would wrongly declare divergence and
    // duplicate. Containment must be whitespace-tolerant.
    const events: WireEvent[] = [
      { type: 'content_block', block_type: 'text', text: 'done\n', streaming: true, turn_id: 1 },
      { type: 'result', text: 'done', turn_id: 1 },
    ]
    const g = foldTranscript(events).find(g => g.turnId === 1)!
    expect(g.assistantText().trim()).toBe('done')
  })

  it('does not duplicate Claude multi-block turns (separate non-streaming text blocks)', () => {
    // Claude emits each message's text as its own block with streaming unset, so
    // the fold pushes SEPARATE text blocks joined with ''. result.text may carry
    // whitespace between them (e.g. a paragraph break). A whitespace-sensitive
    // compare would wrongly declare divergence and duplicate the whole answer.
    const events: WireEvent[] = [
      { type: 'content_block', block_type: 'text', text: 'First para.', turn_id: 1 },
      { type: 'content_block', block_type: 'tool_use', name: 'ls', summary: 'ls', turn_id: 1 },
      { type: 'content_block', block_type: 'text', text: 'Second para.', turn_id: 1 },
      { type: 'result', text: 'First para.\n\nSecond para.', turn_id: 1 },
    ]
    const g = foldTranscript(events).find(g => g.turnId === 1)!
    // The two text blocks survive once each; the result is NOT re-appended.
    expect(g.assistantText()).toBe('First para.Second para.')
    expect(g.blocks.filter(b => b.type === 'text').length).toBe(2)
  })

  it('does not append when the stream is a superset (tool narration before final)', () => {
    // Codex result.content may be only the final assistant message while the
    // stream carried more (pre-tool narration). If the stream already contains
    // the final text, appending would duplicate it — suppress.
    const events: WireEvent[] = [
      { type: 'content_block', block_type: 'text', text: 'Let me check. ', streaming: true, turn_id: 1 },
      { type: 'content_block', block_type: 'text', text: 'The answer is 42.', streaming: true, turn_id: 1 },
      { type: 'result', text: 'The answer is 42.', turn_id: 1 },
    ]
    const g = foldTranscript(events).find(g => g.turnId === 1)!
    expect(g.assistantText()).toBe('Let me check. The answer is 42.')
  })
})

describe('foldTranscript — non-terminal error block (F-CODEX-1)', () => {
  it('keeps a mid-turn error block as its own block without ending the turn', () => {
    // F-CODEX-1 (review 2026-07-27): a transient mid-turn Codex codex/event error
    // now arrives as a ContentBlock{block_type:'error'} (non-terminal), NOT the
    // top-level 'error' event. It must render as its own block, not merge into
    // text/thinking, and not mark the turn complete — the turn is only completed by
    // the real 'result' (call_fut resolving).
    const events: WireEvent[] = [
      { type: 'content_block', block_type: 'text', text: 'Working on it. ', streaming: true, turn_id: 1 },
      { type: 'content_block', block_type: 'error', text: 'Codex: stream retry', streaming: false, turn_id: 1 },
      { type: 'content_block', block_type: 'text', text: 'Done.', streaming: true, turn_id: 1 },
      { type: 'result', text: 'Working on it. Done.', turn_id: 1 },
    ]
    const g = foldTranscript(events).find(g => g.turnId === 1)!
    // The error is its own block, distinct from the text blocks around it.
    const errBlocks = g.blocks.filter(b => b.type === 'error')
    expect(errBlocks.length).toBe(1)
    expect(errBlocks[0].text).toBe('Codex: stream retry')
    // It did not merge into the surrounding text; assistant text is intact.
    expect(g.assistantText()).toBe('Working on it. Done.')
    // The turn completes only via the result.
    expect(g.complete).toBe(true)
  })

  it('an error block alone does not complete the turn (only result/error event does)', () => {
    const events: WireEvent[] = [
      { type: 'content_block', block_type: 'text', text: 'Thinking ', streaming: true, turn_id: 1 },
      { type: 'content_block', block_type: 'error', text: 'Codex: transient', streaming: false, turn_id: 1 },
    ]
    const g = foldTranscript(events).find(g => g.turnId === 1)!
    expect(g.complete).toBe(false)
    expect(g.blocks.some(b => b.type === 'error')).toBe(true)
  })

  // F4 (review 2026-08-03): AcpChatView settles an errored/exited turn by injecting an
  // EMPTY synthetic `result` (no turn_id on the wire error/exit). The fold must mark
  // complete WITHOUT appending a phantom text block.
  it('an empty synthetic result completes the turn without appending a block', () => {
    const events: WireEvent[] = [
      { type: 'content_block', block_type: 'text', text: 'partial answer', turn_id: 1 },
      { type: 'result', text: '', turn_id: 1 }, // synthetic settle on error/exit
    ]
    const g = foldTranscript(events).find(g => g.turnId === 1)!
    expect(g.complete).toBe(true)
    // Exactly one text block (the streamed one), no phantom empty append.
    expect(g.blocks.filter(b => b.type === 'text').length).toBe(1)
    expect(g.assistantText()).toBe('partial answer')
  })
})

describe('stabilizeGroups — object identity for React.memo (F-perf, 2026-08-03)', () => {
  const fold = (evts: WireEvent[]) => foldTranscript(evts)

  it('reuses prior identity for an unchanged (completed) turn', () => {
    const turn1: WireEvent[] = [
      { type: 'user_prompt', text: 'q1', turn_id: 1, client_id: 'c1' },
      { type: 'content_block', block_type: 'text', text: 'a1', turn_id: 1 },
      { type: 'result', text: '', turn_id: 1 },
    ]
    const first = fold(turn1)
    const stable1 = stabilizeGroups([], first)
    // A new delta arrives for turn 2; turn 1 is unchanged.
    const withTurn2 = [...turn1,
      { type: 'content_block', block_type: 'text', text: 'a2 ', turn_id: 2 } as WireEvent]
    const second = fold(withTurn2)
    const stable2 = stabilizeGroups(stable1, second)
    const t1a = stable1.find(g => g.turnId === 1)!
    const t1b = stable2.find(g => g.turnId === 1)!
    // Same object identity → React.memo(prev.group === next.group) skips re-render.
    expect(t1b).toBe(t1a)
  })

  it('gives a NEW identity to the actively-streaming turn', () => {
    const base: WireEvent[] = [
      { type: 'content_block', block_type: 'text', text: 'hello', turn_id: 1 },
    ]
    const stable1 = stabilizeGroups([], fold(base))
    const grown = [...base,
      { type: 'content_block', block_type: 'text', text: ' world', streaming: true, turn_id: 1 } as WireEvent]
    const stable2 = stabilizeGroups(stable1, fold(grown))
    const t1a = stable1.find(g => g.turnId === 1)!
    const t1b = stable2.find(g => g.turnId === 1)!
    // Content changed → new object so the memo re-renders it.
    expect(t1b).not.toBe(t1a)
    expect(t1b.assistantText()).toBe('hello world')
  })

  it('preserves order and turn set', () => {
    const evts: WireEvent[] = [
      { type: 'content_block', block_type: 'text', text: 'a1', turn_id: 1 },
      { type: 'result', text: '', turn_id: 1 },
      { type: 'content_block', block_type: 'text', text: 'a2', turn_id: 2 },
    ]
    const stable = stabilizeGroups([], fold(evts))
    expect(stable.map(g => g.turnId)).toEqual([1, 2])
  })
})
