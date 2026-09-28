import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { TriageList } from '../TriageList'
import { Toaster } from '../../ui'
import { mkSession } from '../../../test/appHarness'
import type { SessionControls } from '../../../lib/sessionControls'

const NOW = Date.now()
const ctrl = (o: Partial<SessionControls> = {}): SessionControls => ({
  setQueueMode: vi.fn(), sendPrompt: vi.fn(() => true), interrupt: vi.fn(() => true),
  resolveApproval: vi.fn(() => true), pendingApprovals: vi.fn(() => []), ...o,
})

function setup(sessions = [
  mkSession('err', { name: 'api-refactor', last_outcome: 'errored', last_outcome_ms: NOW - 10, last_snippet: 'cargo test 失败' }),
  mkSession('run', { name: 'zeromux-fe', turn_state: 'running', turn_started_ms: NOW - 5000, last_activity_ms: NOW, current_step: 'Edit · Sidebar.tsx' }),
  mkSession('crew', { name: 'crew-a', type: 'crew', turn_state: 'running', last_activity_ms: NOW - 400_000, pending_approvals: 1 }),
  mkSession('idle', { name: 'shell-main', type: 'tmux' }),
], controls: Record<string, SessionControls> = {}) {
  const onSelect = vi.fn()
  const utils = render(<><TriageList sessions={sessions} activeId={null} onSelect={onSelect}
    lastViewedMs={{ err: 0, run: 0, crew: 0, idle: 0 }} confirmsBySession={{}} controls={{ current: controls }}
    actionsFor={() => []} now={NOW} /><Toaster /></>)
  return { onSelect, ...utils }
}

describe('TriageList', () => {
  it('groups into 需要你 / 运行中 / 空闲 with counts, approval ahead of stuck', () => {
    setup()
    expect(screen.getByText('需要你 (2)')).toBeInTheDocument()
    expect(screen.getByText('运行中 (1)')).toBeInTheDocument()
    const needs = screen.getByRole('list', { name: '需要你' })
    const names = [...needs.querySelectorAll('[data-row-name]')].map(e => e.textContent)
    expect(names).toEqual(['api-refactor', 'crew-a'])
    expect(screen.getByRole('img', { name: '待审批' })).toBeInTheDocument()
  })
  it('row second line: snippet, else current step, else description', () => {
    setup()
    expect(screen.getByText('cargo test 失败')).toBeInTheDocument()
    expect(screen.getByText('Edit · Sidebar.tsx')).toBeInTheDocument()
  })
  it('row second line: a running turn shows its live step over a stale snippet; idle shows the snippet', () => {
    setup([
      mkSession('r2', { name: 'live', turn_state: 'running', turn_started_ms: NOW - 1000, last_activity_ms: NOW,
        last_snippet: 'previous turn done', current_step: 'Bash · cargo test' }),
      mkSession('i2', { name: 'resting', last_snippet: 'all green', current_step: 'Read · old.rs' }),
    ])
    expect(screen.getByText('Bash · cargo test')).toBeInTheDocument()
    expect(screen.queryByText('previous turn done')).toBeNull()
    expect(screen.getByText('all green')).toBeInTheDocument()
    expect(screen.queryByText('Read · old.rs')).toBeNull()
  })
  it('clicking a row selects it', () => {
    const { onSelect } = setup()
    fireEvent.click(screen.getByText('zeromux-fe'))
    expect(onSelect).toHaveBeenCalledWith('run')
  })
  it('inline 中断 on a running row does not select it; false → toast, nothing else', () => {
    const c = ctrl({ interrupt: vi.fn(() => false) })
    const { onSelect } = setup(undefined, { run: c })
    fireEvent.click(screen.getByRole('button', { name: '中断 zeromux-fe' }))
    expect(c.interrupt).toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()
    expect(screen.getByText('未连接,稍后重试')).toBeInTheDocument()
  })
  it('inline 批准 expands the approval summary from the mounted view and resolves it', () => {
    const c = ctrl({ pendingApprovals: vi.fn(() => [{ id: 'ap1', tool: 'rm -rf /tmp/x', purpose: '清理' }]) })
    const { onSelect } = setup(undefined, { crew: c })
    fireEvent.click(screen.getByRole('button', { name: '批准 crew-a' }))
    expect(screen.getByText('rm -rf /tmp/x')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '批准' }))
    expect(c.resolveApproval).toHaveBeenCalledWith('ap1', 'approve')
    expect(onSelect).not.toHaveBeenCalled()
  })
  it('poll keeps expanded approval open across a sessions prop replacement', () => {
    const c = ctrl({ pendingApprovals: vi.fn(() => [{ id: 'ap1', tool: 'rm' }]) })
    const { rerender } = setup(undefined, { crew: c })
    fireEvent.click(screen.getByRole('button', { name: '批准 crew-a' }))
    rerender(<TriageList sessions={[mkSession('crew', { name: 'crew-a', type: 'crew', turn_state: 'running', last_activity_ms: NOW, pending_approvals: 1 })]}
      activeId={null} onSelect={() => {}} lastViewedMs={{ crew: 0 }} confirmsBySession={{}} controls={{ current: { crew: c } }} actionsFor={() => []} now={NOW} />)
    expect(screen.getByText('rm')).toBeInTheDocument()
  })
  it('unchanged rows do not re-render when the list is replaced with equal data (I-9)', () => {
    const renders = vi.fn()
    const sessions = [mkSession('a', { name: 'alpha' })]
    const { rerender } = render(<TriageList sessions={sessions} activeId={null} onSelect={() => {}} lastViewedMs={{ a: 0 }}
      confirmsBySession={{}} controls={{ current: {} }} actionsFor={() => []} now={NOW} onRowRender={renders} />)
    const n = renders.mock.calls.length
    rerender(<TriageList sessions={[{ ...sessions[0] }]} activeId={null} onSelect={() => {}} lastViewedMs={{ a: 0 }}
      confirmsBySession={{}} controls={{ current: {} }} actionsFor={() => []} now={NOW} onRowRender={renders} />)
    expect(renders.mock.calls.length).toBe(n)
  })
  // Added: parity rows (§0.5.4) — host tmux group, doc tab close, other_clients badge.
  it('本机 tmux group is collapsible, flags orphans, attaches on click', () => {
    const onAttachTmux = vi.fn()
    render(<TriageList sessions={[]} activeId={null} onSelect={() => {}} lastViewedMs={{}} confirmsBySession={{}}
      controls={{ current: {} }} actionsFor={() => []} now={NOW} onAttachTmux={onAttachTmux}
      hostTmux={[{ name: 'vscode-dev', windows: 3, attached: 1, created: 0, path: '/w' }, { name: 'zmx-deadbeef', windows: 1, attached: 0, created: 0, path: '/w' }]} />)
    expect(screen.getByText('本机 tmux (2)')).toBeInTheDocument()
    expect(screen.getByText('zeromux 遗留')).toBeInTheDocument()
    fireEvent.click(screen.getByText('vscode-dev'))
    expect(onAttachTmux).toHaveBeenCalledWith('vscode-dev')
  })
  // Ported from Sidebar.newflow 'no host group when list is empty'.
  it('no 本机 tmux group when the host list is empty', () => {
    render(<TriageList sessions={[]} activeId={null} onSelect={() => {}} lastViewedMs={{}} confirmsBySession={{}}
      controls={{ current: {} }} actionsFor={() => []} now={NOW} onAttachTmux={vi.fn()} hostTmux={[]} />)
    expect(screen.queryByText(/本机 tmux/)).toBeNull()
  })
  it('文档 group rows have a ⋯ menu with only 关闭', () => {
    const onCloseDocTab = vi.fn()
    render(<TriageList sessions={[]} activeId={null} onSelect={() => {}} lastViewedMs={{}} confirmsBySession={{}}
      controls={{ current: {} }} actionsFor={() => []} now={NOW} docTabs={[{ id: 'doc-1', title: '笔记', kind: 'vault' }]} onCloseDocTab={onCloseDocTab} />)
    fireEvent.click(screen.getByRole('button', { name: '文档菜单' }))
    expect(screen.getAllByRole('menuitem').map(e => e.textContent)).toEqual(['关闭'])
    fireEvent.click(screen.getByRole('menuitem', { name: '关闭' }))
    expect(onCloseDocTab).toHaveBeenCalledWith('doc-1')
  })
  it('shows other-clients count with a Monitor badge', () => {
    setup([mkSession('x', { name: 'watched', other_clients: 2 })])
    expect(screen.getByTitle('其他终端也在查看')).toHaveTextContent('2')
  })
})
