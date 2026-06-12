import { describe, it, expect } from 'vitest'
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
