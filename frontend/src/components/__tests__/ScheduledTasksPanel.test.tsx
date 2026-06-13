import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { runReason } from '../ScheduledTasksPanel'
import type { TaskRun } from '../../lib/api'

describe('runReason', () => {
  const base = {
    id: 'r', task_id: 't', scheduled_for_ms: 1, session_id: null, verdict: null,
    started_ms: 1, ended_ms: 2, input_snapshot: null, confirm_status: null, replay_of: null,
  } as const
  it('labels watchdog_timeout aborts', () => {
    expect(runReason({ ...base, state: 'aborted', failure_kind: 'watchdog_timeout' } as TaskRun).label).toBe('超时中止')
  })
  it('labels orphaned_restart aborts', () => {
    expect(runReason({ ...base, state: 'aborted', failure_kind: 'orphaned_restart' } as TaskRun).label).toBe('重启中断')
  })
  it('falls back to state label for non-aborted', () => {
    expect(runReason({ ...base, state: 'succeeded', failure_kind: null } as TaskRun).label).toBe('成功')
  })
})

// The confirmation card must show WHICH task is pending and WHAT it managed to
// do before being aborted — the two pieces of evidence a person needs to judge
// "already done vs replay" (spec §4.4). Findings B + C.
vi.mock('../../lib/api', () => ({
  listScheduledTasks: vi.fn().mockResolvedValue([]),
  listConfirmations: vi.fn().mockResolvedValue({
    count: 1,
    runs: [{
      id: 'r1', task_id: 't1', task_name: '夜间提 PR',
      scheduled_for_ms: 1, state: 'aborted', failure_kind: 'watchdog_timeout',
      session_id: null, verdict: null, started_ms: 1, ended_ms: 2,
      input_snapshot: '{}', confirm_status: null, replay_of: null,
      output_tail: ['opening a PR', 'PR #42 opened'],
    }],
  }),
  confirmRunDone: vi.fn(),
  replayRun: vi.fn(),
  createScheduledTask: vi.fn(),
  updateScheduledTask: vi.fn(),
  deleteScheduledTask: vi.fn(),
  runScheduledTaskNow: vi.fn(),
  listTaskRuns: vi.fn().mockResolvedValue([]),
}))

describe('ConfirmationQueue card', () => {
  it('shows the task name and captured output tail', async () => {
    const { default: ScheduledTasksPanel } = await import('../ScheduledTasksPanel')
    render(<ScheduledTasksPanel onClose={() => {}} />)
    expect(await screen.findByText('夜间提 PR')).toBeInTheDocument()       // Finding B: which task
    expect(await screen.findByText(/PR #42 opened/)).toBeInTheDocument()  // Finding C: evidence
  })
})
