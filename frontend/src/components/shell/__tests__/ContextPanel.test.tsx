import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useState } from 'react'
import { mkSession } from '../../../test/appHarness'
import type { ContextTab } from '../useShellState'

const counts = { files: 0 }
const gitProps: unknown[] = []
const runProps: unknown[] = []
const failFiles = { on: false }
vi.mock('../lazyPanels', async () => {
  const { useState } = await import('react')
  return {
  // Counts constructions (mounts), not renders.
  FileBrowser: () => {
    useState(() => { counts.files++; return 0 })
    if (failFiles.on) throw new Error('Failed to fetch dynamically imported module')
    return <div>FILES</div>
  },
  GitViewer: (p: unknown) => { gitProps.push(p); return <div>GIT</div> },
  RunMetricsPanel: (p: unknown) => { runProps.push(p); return <div>RUNS</div> },
  AgentDashboard: (p: { sessionId: string }) => <div>EVENTS {p.sessionId}</div>,
  }
})
import { ContextPanel } from '../ContextPanel'

function Harness({ session = mkSession('s1'), asSheet = false, initial = 'git' as ContextTab, gitNonce }: { session?: ReturnType<typeof mkSession>; asSheet?: boolean; initial?: ContextTab; gitNonce?: number }) {
  const [tab, setTab] = useState<ContextTab>(initial)
  return <ContextPanel session={session} open tab={tab} onTab={setTab} onClose={() => {}} asSheet={asSheet} gitNonce={gitNonce} />
}

describe('ContextPanel', () => {
  beforeEach(() => { counts.files = 0; gitProps.length = 0; runProps.length = 0 })

  it('tabs mount lazily and then stay mounted (files → git → files mounts FileBrowser once)', async () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('radio', { name: '文件' }))
    await screen.findByText('FILES')
    fireEvent.click(screen.getByRole('radio', { name: 'Git' }))
    fireEvent.click(screen.getByRole('radio', { name: '文件' }))
    expect(counts.files).toBe(1)
    expect(screen.getByText('GIT')).toBeInTheDocument()   // still mounted, hidden
  })
  it('asSheet renders a bottom Sheet', () => {
    render(<Harness asSheet />)
    expect(screen.getByRole('dialog', { hidden: true }).dataset.side).toBe('bottom')
  })
  it('运行 tab: RunMetricsPanel fed from the polled SessionInfo (M9e) + 事件 details', async () => {
    const s = mkSession('s1', { turn_state: 'running', turn_started_ms: 123, last_outcome_ms: 456 })
    render(<Harness session={s} initial="runs" />)
    await screen.findByText('RUNS')
    expect(runProps.at(-1)).toMatchObject({ sessionId: 's1', running: true, turnStartedMs: 123, refreshKey: 456 })
    expect(screen.getByText('事件').tagName).toBe('SUMMARY')
    expect(screen.getByText('EVENTS s1')).toBeInTheDocument()
  })
  it('tmux sessions only get Git / 文件', () => {
    render(<Harness session={mkSession('t', { type: 'tmux' })} />)
    expect(screen.getAllByRole('radio').map(r => r.textContent)).toEqual(['Git', '文件'])
  })
  it('a push deep link (gitNonce) opens GitViewer on the worktree tab', async () => {
    render(<Harness gitNonce={42} />)
    await waitFor(() => expect(gitProps.at(-1)).toMatchObject({ sessionId: 's1', initialTab: 'worktree' }))
  })
  it('without a deep link GitViewer keeps its own default tab', async () => {
    render(<Harness />)
    await waitFor(() => expect(gitProps.length).toBeGreaterThan(0))
    expect((gitProps.at(-1) as { initialTab?: string }).initialTab).toBeUndefined()
  })

  // A1: a failing lazy panel shows the in-place fallback; the rest of the panel stays mounted.
  it('a panel that throws renders 出错了,点此刷新 in place; tabs and other panes survive', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    failFiles.on = true
    try {
      render(<Harness />)
      expect(screen.getByText('GIT')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('radio', { name: '文件' }))
      expect(await screen.findByRole('button', { name: '出错了,点此刷新' })).toBeInTheDocument()
      fireEvent.click(screen.getByRole('radio', { name: 'Git' }))
      expect(screen.getByText('GIT')).toBeInTheDocument()
      expect(screen.getByRole('radio', { name: '文件' })).toBeInTheDocument()
    } finally { failFiles.on = false; err.mockRestore() }
  })
})
