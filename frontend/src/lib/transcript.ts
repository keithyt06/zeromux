// Pure transcript folder: a flat list of wire events → turn-grouped view.
// Grouping by turn_id (not raw arrival order) is what fixes the "send while
// streaming" misalignment (spec T1): a new prompt's UserPrompt carries the
// NEXT turn_id, so it lands in its own group rather than splicing into the
// still-streaming prior turn's ContentBlocks.

export interface WireEvent {
  type: string
  block_type?: string
  text?: string
  name?: string
  input?: unknown
  summary?: string
  streaming?: boolean
  turn_id?: number
  client_id?: string
  cost_usd?: number
}

export interface Block {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result'
  text?: string
  name?: string
  input?: unknown
  summary?: string
}

export interface TurnGroup {
  turnId: number
  userPrompts: { text: string; clientId?: string }[]
  blocks: Block[]
  complete: boolean
  cost?: number
  assistantText: () => string
}

// Strip ALL whitespace for the divergence comparison (compare-only; the stored
// text is untouched). Whitespace-insensitive because the streamed text blocks
// are joined with '' while the authoritative `result.text` may carry whitespace
// between what were separate blocks (Claude sends each message's text as its own
// non-streaming block) or a trailing newline — either would look like divergence
// under a literal compare and wrongly DUPLICATE the message. Dropped deltas
// remove real characters, so a whitespace-stripped stream still won't contain a
// whitespace-stripped `result.text`; divergence detection is preserved.
const stripWs = (s: string): string => s.replace(/\s+/g, '')

export function foldTranscript(
  events: WireEvent[],
): TurnGroup[] {
  const byTurn = new Map<number, TurnGroup>()
  const order: number[] = []

  const group = (tid: number): TurnGroup => {
    let g = byTurn.get(tid)
    if (!g) {
      g = {
        turnId: tid,
        userPrompts: [],
        blocks: [],
        complete: false,
        assistantText() {
          return this.blocks.filter(b => b.type === 'text').map(b => b.text ?? '').join('')
        },
      }
      byTurn.set(tid, g)
      order.push(tid)
    }
    return g
  }

  for (const e of events) {
    const tid = e.turn_id ?? 0
    if (e.type === 'user_prompt') {
      // No dedupe here: AcpChatView handles the server echo by rewriting the
      // optimistic entry's turn_id in place (replace, not append), so there is
      // only ever one user_prompt per client_id in `events`. Deduping by a
      // seenClientIds set would skip the optimistic entry itself — hiding the
      // user's own prompt until reconnect.
      group(tid).userPrompts.push({ text: e.text ?? '', clientId: e.client_id })
    } else if (e.type === 'content_block') {
      const g = group(tid)
      const bt = (e.block_type ?? 'text') as Block['type']
      const last = g.blocks[g.blocks.length - 1]
      const mergeable = bt === 'text' || bt === 'thinking'
      if (e.streaming && mergeable && last && last.type === bt) {
        last.text = (last.text ?? '') + (e.text ?? '')
      } else {
        g.blocks.push({ type: bt, text: e.text, name: e.name, input: e.input, summary: e.summary })
      }
    } else if (e.type === 'result') {
      const g = group(tid)
      g.complete = true
      if (typeof e.cost_usd === 'number') g.cost = e.cost_usd
      const finalText = (e.text ?? '').trim()
      // The `result` carries the authoritative full assistant text. Normally the
      // streamed text blocks already contain it, so re-appending would double the
      // message. But Codex streams token deltas via a non-blocking try_send that
      // DROPS chunks under backpressure (src/acp/codex_process.rs) — the surviving
      // stream then has a permanent hole, yet the old `!hasStreamed` gate discarded
      // the complete `result` on any streamed text, so the hole never healed.
      // Fix: suppress only when the stream already CONTAINS finalText (dedup);
      // append the authoritative text when the stream diverged (dropped delta).
      // Append (not replace) is deliberate — it can't delete interleaved tool
      // blocks or pre-tool narration; worst case is a rare redundant render, which
      // beats silent truncation. Compared whitespace-insensitively (stripWs) so a
      // trailing newline or block-seam space isn't misread as divergence.
      if (finalText) {
        const streamed = stripWs(
          g.blocks.filter(b => b.type === 'text').map(b => b.text ?? '').join(''),
        )
        if (!streamed.includes(stripWs(finalText))) {
          g.blocks.push({ type: 'text', text: finalText })
        }
      }
    }
  }

  // Stable sort by turnId so cross-turn order is deterministic regardless of
  // raw event interleaving.
  return order.sort((a, b) => a - b).map(tid => byTurn.get(tid)!)
}
