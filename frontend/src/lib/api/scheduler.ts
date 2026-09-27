import { api } from './core'

// Scheduled tasks
export type ScheduleInput =
  | { kind: 'daily'; hour: number; minute: number }
  | { kind: 'weekly'; weekdays: number[]; hour: number; minute: number }
  | { kind: 'cron'; expr: string }

export interface ScheduledTask {
  id: string
  owner_id: string
  name: string
  trigger_type: string
  trigger_spec: string
  tz: string
  agent_type: string
  work_dir: string
  prompt: string
  enabled: boolean
  retention_n: number
  created_ms: number
  side_effects: boolean
  max_runtime_min: number | null
  idle_timeout_min: number | null
}

export interface TaskRun {
  id: string
  task_id: string
  scheduled_for_ms: number
  state: 'claimed' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'aborted'
  session_id: string | null
  verdict: string | null
  failure_kind: string | null
  started_ms: number | null
  ended_ms: number | null
  input_snapshot: string | null
  confirm_status: 'confirmed_done' | 'replayed' | null
  replay_of: string | null
  // Only populated by the confirmation-queue endpoint (joins task name + tails
  // the captured output so the card can show which task + what it managed to do).
  task_name?: string
  output_tail?: string[]
}

export interface ScheduledTaskReq {
  name: string
  schedule: ScheduleInput
  work_dir: string
  prompt: string
  enabled?: boolean
  retention_n?: number
  side_effects?: boolean
  max_runtime_min?: number | null
  idle_timeout_min?: number | null
}

export async function listScheduledTasks(): Promise<ScheduledTask[]> {
  const res = await api('/api/scheduled-tasks')
  if (!res.ok) throw new Error(await res.text())
  return (await res.json()).tasks
}

export async function createScheduledTask(body: ScheduledTaskReq): Promise<ScheduledTask> {
  const res = await api('/api/scheduled-tasks', { method: 'POST', body: JSON.stringify(body) })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function updateScheduledTask(id: string, body: ScheduledTaskReq): Promise<ScheduledTask> {
  const res = await api(`/api/scheduled-tasks/${id}`, { method: 'PUT', body: JSON.stringify(body) })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function deleteScheduledTask(id: string): Promise<void> {
  const res = await api(`/api/scheduled-tasks/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(await res.text())
}

export async function runScheduledTaskNow(id: string): Promise<{ skipped?: boolean; reason?: string; session_id?: string; run_id?: string }> {
  const res = await api(`/api/scheduled-tasks/${id}/run`, { method: 'POST' })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function listTaskRuns(id: string): Promise<TaskRun[]> {
  const res = await api(`/api/scheduled-tasks/${id}/runs`)
  if (!res.ok) throw new Error(await res.text())
  return (await res.json()).runs
}

export async function listConfirmations(): Promise<{ runs: TaskRun[]; count: number }> {
  const res = await api('/api/scheduled-tasks/confirmations')
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function confirmRunDone(runId: string): Promise<void> {
  const res = await api(`/api/scheduled-tasks/runs/${runId}/confirm-done`, { method: 'POST' })
  if (!res.ok) throw new Error(await res.text())
}

export async function replayRun(runId: string, fromQueue = false): Promise<{ run_id?: string; skipped?: boolean; reason?: string }> {
  const res = await api(`/api/scheduled-tasks/runs/${runId}/replay${fromQueue ? '?from_queue=true' : ''}`, { method: 'POST' })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function getSchedulerHealth(): Promise<{ heartbeat_ms: number; healthy: boolean }> {
  const res = await api('/api/scheduler/health')
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}
