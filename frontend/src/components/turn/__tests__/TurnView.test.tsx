import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { TurnView } from '../TurnView'
import { foldTranscript, type WireEvent } from '../../../lib/transcript'

const fold = (ev: WireEvent[]) => foldTranscript(ev)[0]
const running = fold([
  { type: 'user_prompt', text: '修复 sidebar', turn_id: 1 },
  { type: 'content_block', block_type: 'tool_use', name: 'Read', summary: 'Sidebar.tsx', turn_id: 1 },
  { type: 'content_block', block_type: 'thinking', text: 'hmm', turn_id: 1 },
  { type: 'content_block', block_type: 'tool_use', name: 'Bash', summary: 'npx vitest run', turn_id: 1 },
])
const done = fold([
  { type: 'user_prompt', text: '修复 sidebar', turn_id: 1 },
  { type: 'content_block', block_type: 'tool_use', name: 'Edit', summary: 'x', input: { file_path: '/r/src/Sidebar.tsx' }, turn_id: 1 },
  { type: 'content_block', block_type: 'text', text: 'Fixed the double tap.\n\nMore detail.', turn_id: 1 },
  { type: 'result', turn_id: 1, text: 'Fixed the double tap.\n\nMore detail.', cost_usd: 0.4213 },
])

describe('TurnView', () => {
  it('running: timeline with one row per step, last tool running, thinking collapsed to one line', () => {
    render(<TurnView group={running} agentName="Claude" />)
    expect(screen.getByText('修复 sidebar')).toBeInTheDocument()
    expect(screen.getByText('Sidebar.tsx')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: '运行中' })).toBeInTheDocument()
    expect(screen.getByText('思考 · 1 段')).toBeInTheDocument()
    expect(screen.queryByText('hmm')).toBeNull()
  })
  it('complete: summary card with conclusion, touched file, steps and cost', () => {
    render(<TurnView group={done} agentName="Claude" />)
    expect(screen.getByText('Fixed the double tap.')).toBeInTheDocument()
    expect(screen.queryByText('More detail.')).toBeNull()
    expect(screen.getByRole('button', { name: 'src/Sidebar.tsx' })).toBeInTheDocument()
    expect(screen.getByText(/1 步/)).toBeInTheDocument()
    expect(screen.getByText('$0.4213')).toBeInTheDocument()
  })
  it('过程 ▾ expands the timeline in place; a file chip calls onOpenChanges', () => {
    const onOpen = vi.fn()
    render(<TurnView group={done} agentName="Claude" onOpenChanges={onOpen} />)
    fireEvent.click(screen.getByRole('button', { name: /过程/ }))
    expect(screen.getByText('Edit')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'src/Sidebar.tsx' }))
    expect(onOpen).toHaveBeenCalled()
  })
  it('a step the user expanded keeps the turn in timeline form after completion', () => {
    const { rerender } = render(<TurnView group={running} agentName="Claude" />)
    fireEvent.click(screen.getByText('npx vitest run'))
    rerender(<TurnView group={{ ...running, complete: true, assistantText: running.assistantText }} agentName="Claude" />)
    expect(screen.queryByRole('button', { name: /过程/ })).toBeNull()
    expect(screen.getByText('npx vitest run')).toBeInTheDocument()
  })
  it('errored turn: danger tint + error line, not a left border (V9)', () => {
    const g = fold([{ type: 'user_prompt', text: 'go', turn_id: 2 }, { type: 'content_block', block_type: 'tool_use', name: 'shell', summary: 'ls', turn_id: 2 }, { type: 'content_block', block_type: 'text', text: 'partial', turn_id: 2 }, { type: 'result', turn_id: 2, text: '', is_error: true }])
    render(<TurnView group={g} agentName="Codex" />)
    const card = screen.getByTestId('turn-summary')
    expect(card.dataset.errored).toBe('1')
    expect(card.className).not.toMatch(/border-l/)
    expect(screen.getByText('本轮出错结束')).toBeInTheDocument()
  })
  it('approval step keeps the 44px approve/reject buttons and resolves via callback', () => {
    const onR = vi.fn()
    const g = fold([{ type: 'content_block', block_type: 'approval', approval_id: 'a1', name: 'rm -rf', summary: 'cleanup', turn_id: 3 }])
    render(<TurnView group={g} agentName="Crew" onResolveApproval={onR} />)
    fireEvent.click(screen.getByTestId('approval-approve'))
    expect(onR).toHaveBeenCalledWith('a1', 'approve')
    expect(screen.getByTestId('approval-approve').className).toMatch(/min-h-\[44px\]/)
  })
  it('peer prompt keeps its sender label', () => {
    const g = fold([{ type: 'peer_message', text: 'hi', from_name: 'zmx-ai-abc', turn_id: 4 }])
    render(<TurnView group={g} agentName="Claude" peerNames={{ 'zmx-ai-abc': 'docs' }} />)
    expect(screen.getByText(/来自 @docs/)).toBeInTheDocument()
  })
  it('text-only completed turn renders the full reply, not a 「0 步」 card', () => {
    const g = fold([{ type: 'user_prompt', text: 'hi', turn_id: 5 }, { type: 'content_block', block_type: 'text', text: 'Para one.\n\nPara two.', turn_id: 5 }, { type: 'result', turn_id: 5, text: '', cost_usd: 0.01 }])
    render(<TurnView group={g} agentName="Claude" />)
    expect(screen.queryByTestId('turn-summary')).toBeNull()
    expect(screen.queryByText(/0 步/)).toBeNull()
    expect(screen.getByText('Para two.')).toBeInTheDocument()
    expect(screen.getByText('$0.0100')).toBeInTheDocument()
  })
  it('long conclusion is clamped with 展开全文, which removes the clamp', () => {
    const long = 'word '.repeat(100).trim()
    const g = fold([{ type: 'content_block', block_type: 'tool_use', name: 'Read', summary: 'a', turn_id: 6 }, { type: 'content_block', block_type: 'text', text: long, turn_id: 6 }, { type: 'result', turn_id: 6, text: '' }])
    render(<TurnView group={g} agentName="Claude" />)
    expect(screen.getByTestId('turn-conclusion').className).toMatch(/line-clamp-6/)
    fireEvent.click(screen.getByRole('button', { name: '展开全文' }))
    expect(screen.getByTestId('turn-conclusion').className).not.toMatch(/line-clamp/)
    expect(screen.queryByRole('button', { name: '展开全文' })).toBeNull()
  })
  it('short conclusion has no 展开全文', () => {
    render(<TurnView group={done} agentName="Claude" />)
    expect(screen.queryByRole('button', { name: '展开全文' })).toBeNull()
  })
  it('collapsing the step that pinned a turn returns the completed turn to its card', () => {
    const { rerender } = render(<TurnView group={running} agentName="Claude" />)
    fireEvent.click(screen.getByText('npx vitest run'))
    rerender(<TurnView group={{ ...running, complete: true }} agentName="Claude" />)
    expect(screen.queryByTestId('turn-summary')).toBeNull()
    fireEvent.click(screen.getByText('npx vitest run'))
    expect(screen.getByTestId('turn-summary')).toBeInTheDocument()
  })
  it('a second open step keeps the turn pinned until both are closed', () => {
    const { rerender } = render(<TurnView group={running} agentName="Claude" />)
    fireEvent.click(screen.getByText('npx vitest run'))
    fireEvent.click(screen.getByText('Sidebar.tsx'))
    rerender(<TurnView group={{ ...running, complete: true }} agentName="Claude" />)
    fireEvent.click(screen.getByText('npx vitest run'))
    expect(screen.queryByTestId('turn-summary')).toBeNull()
    fireEvent.click(screen.getByText('Sidebar.tsx'))
    expect(screen.getByTestId('turn-summary')).toBeInTheDocument()
  })
  it('tool input {} is not rendered as a raw block; error step falls back to Error', () => {
    const g = fold([
      { type: 'content_block', block_type: 'tool_use', name: 'Glob', summary: 'x', input: {}, turn_id: 7 },
      { type: 'content_block', block_type: 'error', text: '', turn_id: 7 },
    ])
    render(<TurnView group={g} agentName="Claude" />)
    fireEvent.click(screen.getByText('Glob'))
    expect(screen.queryByText('{}')).toBeNull()
    expect(screen.getByText('Error')).toBeInTheDocument()
  })
  it('approval without a name renders no dangling separator', () => {
    const g = fold([{ type: 'content_block', block_type: 'approval', approval_id: 'a2', turn_id: 8 }])
    render(<TurnView group={g} agentName="Crew" />)
    expect(screen.getByText('需要你批准')).toBeInTheDocument()
    expect(screen.queryByText(/^·/)).toBeNull()
  })
})
