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

export function foldTranscript(
  events: WireEvent[],
  seenClientIds: Set<string> = new Set(),
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
      if (e.client_id && seenClientIds.has(e.client_id)) continue // dedupe optimistic
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
      const hasStreamed = g.blocks.some(b => b.type === 'text' && (b.text ?? '').length > 0)
      if (finalText && !hasStreamed) g.blocks.push({ type: 'text', text: finalText })
    }
  }

  // Stable sort by turnId so cross-turn order is deterministic regardless of
  // raw event interleaving.
  return order.sort((a, b) => a - b).map(tid => byTurn.get(tid)!)
}
