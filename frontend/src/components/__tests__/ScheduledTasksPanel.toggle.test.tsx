import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import ScheduledTasksPanel from '../ScheduledTasksPanel'
import * as api from '../../lib/api'

const task: api.ScheduledTask = {
  id: 't1', owner_id: 'u', name: '夜间任务', trigger_type: 'cron', trigger_spec: '0 0 9 * * 1-5',
  tz: 'Asia/Shanghai', agent_type: 'claude', work_dir: '/w', prompt: 'p', enabled: true,
  retention_n: 20, created_ms: 1, side_effects: true, max_runtime_min: 30, idle_timeout_min: 15,
}

describe('ScheduledTasksPanel toggle (B1)', () => {
  it('toggle preserves idle_timeout_min and every other field', async () => {
    vi.spyOn(api, 'listScheduledTasks').mockResolvedValue([task])
    vi.spyOn(api, 'listConfirmations').mockResolvedValue({ count: 0, runs: [] })
    const upd = vi.spyOn(api, 'updateScheduledTask').mockResolvedValue({ ...task, enabled: false })
    render(<ScheduledTasksPanel onClose={() => {}} />)
    fireEvent.click(await screen.findByTitle('点击暂停'))
    await waitFor(() => expect(upd).toHaveBeenCalled())
    expect(upd).toHaveBeenCalledWith('t1', {
      name: '夜间任务',
      schedule: { kind: 'cron', expr: '0 0 9 * * 1-5' },
      work_dir: '/w', prompt: 'p', enabled: false, retention_n: 20,
      side_effects: true, max_runtime_min: 30, idle_timeout_min: 15,
    })
  })
})
