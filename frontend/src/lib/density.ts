// Output-side density filter (spec G2b). concise = mobile triage: show signal
// (text, tool_result, tool "what" summary), collapse noise (thinking, raw tool input).
// Agent errors surface separately as Notice bubbles, not Blocks, so they always show.
// Lossless: nothing is dropped from the underlying data — collapsedCount drives a
// visible "+N · 展开" placeholder so users never think the agent skipped steps (P2).
import type { Block } from './transcript'

export type { Block }
export type Density = 'concise' | 'full'

export function partitionBlocks(blocks: Block[], density: Density): {
  visible: Block[]
  collapsedCount: number
} {
  if (density === 'full') return { visible: blocks, collapsedCount: 0 }
  let collapsed = 0
  const visible: Block[] = []
  for (const b of blocks) {
    if (b.type === 'thinking') { collapsed++; continue }
    if (b.type === 'tool_use') {
      visible.push({ type: 'tool_use', name: b.name, summary: b.summary })
      continue
    }
    visible.push(b)
  }
  return { visible, collapsedCount: collapsed }
}
