import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { runReason, parseCronToForm, TaskForm } from '../ScheduledTasksPanel'
import type { TaskRun } from '../../lib/api'

describe('runReason', () => {
  const base = {
    id: 'r', task_id: 't', scheduled_for_ms: 1, session_id: null, verdict: null,
    started_ms: 1, ended_ms: 2, input_snapshot: null, confirm_status: null, replay_of: null,
  } as const
  it('labels watchdog_timeout aborts', () => {
    expect(runReason({ ...base, state: 'aborted', failure_kind: 'watchdog_timeout' } as TaskRun).label).toBe('超过最长运行时长')
  })
  it('labels idle_timeout aborts', () => {
    expect(runReason({ ...base, state: 'aborted', failure_kind: 'idle_timeout' } as TaskRun).label).toBe('静默超时(无输出)')
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
    render(<ScheduledTasksPanel open onClose={() => {}} />)
    expect(await screen.findByText('夜间提 PR')).toBeInTheDocument()       // Finding B: which task
    expect(await screen.findByText(/PR #42 opened/)).toBeInTheDocument()  // Finding C: evidence
  })
})

describe('TaskForm edit prefill (B2)', () => {
  it('editing a daily 07:30 task pre-fills 每天 07:30, not cron 09:00 (B2)', async () => {
    const t = { id: 't', owner_id: 'u', name: 'n', trigger_type: 'cron', trigger_spec: '0 30 7 * * *', tz: 'Asia/Shanghai', agent_type: 'claude', work_dir: '/w', prompt: 'p', enabled: true, retention_n: 20, created_ms: 1, side_effects: false, max_runtime_min: null, idle_timeout_min: null }
    render(<TaskForm task={t} onCancel={() => {}} onSaved={() => {}} />)
    expect((screen.getByDisplayValue('每天') as HTMLSelectElement).value).toBe('daily')
    expect(screen.getByDisplayValue('7')).toBeInTheDocument()
    expect(screen.getByDisplayValue('30')).toBeInTheDocument()
  })
  it('weekly option is labelled 每周 (any weekday set, not only workdays)', () => {
    const t = { id: 't', owner_id: 'u', name: 'n', trigger_type: 'cron', trigger_spec: '0 0 9 * * 0,6', tz: 'Asia/Shanghai', agent_type: 'claude', work_dir: '/w', prompt: 'p', enabled: true, retention_n: 20, created_ms: 1, side_effects: false, max_runtime_min: null, idle_timeout_min: null }
    render(<TaskForm task={t} onCancel={() => {}} onSaved={() => {}} />)
    expect((screen.getByDisplayValue('每周') as HTMLSelectElement).value).toBe('weekly')
  })
})

describe('parseCronToForm', () => {
  it('daily', () => expect(parseCronToForm('0 30 7 * * *')).toEqual({ kind: 'daily', hour: 7, minute: 30, weekdays: [1, 2, 3, 4, 5] }))
  it('weekly workdays', () => expect(parseCronToForm('0 0 9 * * 1,2,3,4,5')).toEqual({ kind: 'weekly', hour: 9, minute: 0, weekdays: [1, 2, 3, 4, 5] }))
  it('weekly weekend', () => expect(parseCronToForm('0 0 9 * * 0,6')).toEqual({ kind: 'weekly', hour: 9, minute: 0, weekdays: [0, 6] }))
  it('step expressions stay cron', () => expect(parseCronToForm('0 */5 * * * *')).toBeNull())
  it('day-of-month stays cron', () => expect(parseCronToForm('0 0 9 1 * *')).toBeNull())
})
