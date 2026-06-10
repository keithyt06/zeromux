import { describe, it, expect } from 'vitest'
import { partitionBlocks } from '../../lib/density'
import type { Block } from '../../lib/transcript'

const blocks: Block[] = [
  { type: 'text', text: 'the answer' },
  { type: 'thinking', text: 'hmm' },
  { type: 'tool_use', name: 'Read', input: { path: '/x' }, summary: 'x/y' },
]
describe('partitionBlocks density', () => {
  it('concise: shows text + tool summary, hides thinking + raw input', () => {
    const { visible, collapsedCount } = partitionBlocks(blocks, 'concise')
    expect(visible.map(b => b.type)).toEqual(['text', 'tool_use'])
    expect(visible.find(b => b.type === 'tool_use')?.input).toBeUndefined()
    expect(collapsedCount).toBe(1)
  })
  it('full: shows everything', () => {
    const { visible, collapsedCount } = partitionBlocks(blocks, 'full')
    expect(visible).toHaveLength(3)
    expect(collapsedCount).toBe(0)
  })
})
