import { api, ApiError } from './core'

export type SessionType = 'tmux' | 'claude' | 'crew' | 'codex'

export type SessionMetaStatus = 'running' | 'done' | 'blocked' | 'idle' | 'ended'

export interface SessionInfo {
  id: string
  name: string
  type: SessionType
  cols: number
  rows: number
  work_dir: string
  description: string
  status: SessionMetaStatus
  running: boolean
  turn_state: 'idle' | 'running' | null
  turn_started_ms: number | null
  last_activity_ms: number
  turns_completed: number
  source_task_id?: string | null
  tmux_name: string | null
  tmux_origin: 'own' | 'external' | null
  other_clients: number
  peer_name?: string | null
  // Triage posture (spec v3 M8). All reset to null/0 on a backend restart.
  last_outcome?: RunOutcome | null
  last_outcome_ms?: number | null
  last_snippet?: string | null
  current_step?: string | null
  pending_approvals?: number
  lifetime_cost_usd?: number
  // Crew only (S5 U1): raw Gateway values; see lib/crewVariant.ts. Absent for other types.
  crew_mode?: string
  crew_agent?: string
  crew_origin?: 'zeromux' | 'external' | string
}

export interface SessionStatus {
  work_dir: string
  git_branch: string | null
  git_dirty: number
  is_git: boolean
}

export async function getSessionStatus(id: string): Promise<SessionStatus> {
  const res = await api(`/api/sessions/${id}/status`)
  if (!res.ok) throw new Error('Failed to get status')
  return res.json()
}

export async function getHistory(id: string, ansi = false): Promise<{ text: string; truncated: boolean; alternate?: boolean }> {
  const res = await api(`/api/sessions/${id}/history?ansi=${ansi ? 1 : 0}`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export interface HostTmux { name: string; windows: number; attached: number; created: number; path: string }

export async function listSessionsWithHost(): Promise<{ sessions: SessionInfo[]; host_tmux: HostTmux[] }> {
  const res = await api('/api/sessions')
  // Throw a status-carrying error so the background poll can tell a real 401/403
  // (→ logout) from a transient 5xx/network drop (→ keep retrying). (D-F1)
  if (!res.ok) throw new ApiError(res.status, 'listSessions failed')
  const data = await res.json()
  return { sessions: data.sessions || [], host_tmux: data.host_tmux || [] }
}

export async function listSessions(): Promise<SessionInfo[]> {
  return (await listSessionsWithHost()).sessions
}

export async function createSession(type: SessionType, name?: string, workDir?: string, tmuxTarget?: string, initialPrompt?: string,
  crew?: { crew_mode: string; crew_agent: string }): Promise<SessionInfo> {
  const res = await api('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ type, name: name || null, work_dir: workDir || null, tmux_target: tmuxTarget || null, initial_prompt: initialPrompt || null, ...(crew ?? {}) }),
  })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export interface TmuxSession {
  name: string
  windows: number
  attached: number
  created: number
  path: string
}

export async function listTmuxSessions(): Promise<TmuxSession[]> {
  const res = await api('/api/tmux/sessions')
  if (!res.ok) throw new Error('Failed to list tmux sessions')
  const data = await res.json()
  return data.sessions || []
}

export interface TmuxHealth { server: boolean; in_unit: boolean }
export async function getTmuxHealth(): Promise<TmuxHealth | null> {
  const res = await api('/api/tmux/health')
  if (!res.ok) return null
  return res.json()
}

export async function deleteSession(id: string): Promise<{ pending_until?: number }> {
  const res = await api(`/api/sessions/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new ApiError(res.status, 'deleteSession failed')
  return res.json().catch(() => ({}))
}

export interface CloseCheck { external: boolean; other_clients: number; busy_command: string | null }
export async function closeCheck(id: string): Promise<CloseCheck | null> {
  const res = await api(`/api/sessions/${id}/close-check`)
  if (!res.ok) return null
  return res.json()
}
export async function restoreSession(id: string): Promise<boolean> {
  const res = await api(`/api/sessions/${id}/restore`, { method: 'POST' })
  return res.ok
}

export async function reviveSession(id: string): Promise<void> {
  const res = await api(`/api/sessions/${id}/revive`, { method: 'POST' })
  if (!res.ok) throw new Error(await res.text())
}

// Session metadata
export async function updateSession(id: string, data: {
  name?: string
  description?: string
  status?: SessionMetaStatus
}): Promise<void> {
  const res = await api(`/api/sessions/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error('Failed to update session')
}

export async function renameSession(id: string, name: string): Promise<void> {
  return updateSession(id, { name })
}

// Per-run metrics
export type RunOutcome = 'completed' | 'errored' | 'timeout' | 'cancelled'

export interface RunMetric {
  run_id: string
  session_id: string
  work_dir: string
  agent_type: SessionType
  turn_seq: number
  started_ms: number
  ended_ms: number | null
  duration_ms: number | null
  outcome: RunOutcome
  failure_kind?: string | null
  verdict?: string | null
  verdict_source: 'none' | 'agent_marker' | 'human'
  cost_usd?: number | null
  tokens_in?: number | null
  tokens_out?: number | null
}

export interface RunStats {
  count: number
  avg_ms: number
  p50_ms: number
  p95_ms: number
  max_ms: number
  completed_count: number
  errored_count: number
  timeout_count: number
  cancelled_count: number
}

export interface SessionLifetime {
  turns: number
  duration_ms: number
  cost_usd: number
}

export async function getSessionRuns(
  id: string,
  opts: { limit?: number; before?: number } = {},
): Promise<{ runs: RunMetric[]; stats: RunStats; lifetime?: SessionLifetime }> {
  const qs = new URLSearchParams()
  if (opts.limit != null) qs.set('limit', String(opts.limit))
  if (opts.before != null) qs.set('before', String(opts.before))
  const q = qs.toString()
  const res = await api(`/api/sessions/${id}/runs${q ? `?${q}` : ''}`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function postRunVerdict(
  id: string,
  runId: string,
  verdict: string,
  note?: string,
): Promise<void> {
  const res = await api(`/api/sessions/${id}/runs/${runId}/verdict`, {
    method: 'POST',
    body: JSON.stringify({ verdict, note: note ?? null }),
  })
  if (!res.ok) throw new Error(await res.text())
}
