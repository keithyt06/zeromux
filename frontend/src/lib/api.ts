export type SessionType = 'tmux' | 'claude' | 'kiro' | 'codex'

export type SessionMetaStatus = 'running' | 'done' | 'blocked' | 'idle'

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
}

export interface NoteEntry {
  id: string
  work_dir: string
  text: string
  created_at: string
  session_id: string
  author: string
  tags: string[]
}

export interface SessionStatus {
  work_dir: string
  git_branch: string | null
  git_dirty: number
  is_git: boolean
}

export interface UserInfo {
  id: string
  login: string
  role: string
  status: string
  avatar: string | null
}

export interface AuthMode {
  oauth: boolean
  legacy: boolean
}

export async function getSessionStatus(id: string): Promise<SessionStatus> {
  const res = await api(`/api/sessions/${id}/status`)
  if (!res.ok) throw new Error('Failed to get status')
  return res.json()
}

function getToken(): string {
  return localStorage.getItem('zeromux_token') || ''
}

export function setToken(token: string, maxAge?: number) {
  localStorage.setItem('zeromux_token', token)
  const age = maxAge || 604800
  document.cookie = `zeromux_token=${encodeURIComponent(token)};path=/;SameSite=Strict;max-age=${age}`
}

export function clearAuth() {
  localStorage.removeItem('zeromux_token')
  document.cookie = 'zeromux_token=;path=/;expires=Thu, 01 Jan 1970 00:00:00 GMT'
  document.cookie = 'zeromux_jwt=;path=/;expires=Thu, 01 Jan 1970 00:00:00 GMT'
}

async function api(path: string, opts: RequestInit = {}): Promise<Response> {
  const token = getToken()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(opts.headers as Record<string, string> || {}),
  }
  // Only add Authorization header for legacy token mode
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
  return fetch(path, { ...opts, headers, credentials: 'same-origin' })
}

export async function getAuthMode(): Promise<AuthMode> {
  const res = await fetch('/auth/mode')
  return res.json()
}

export async function getMe(): Promise<UserInfo> {
  const res = await api('/api/me')
  if (!res.ok) throw new Error('Not authenticated')
  return res.json()
}

export async function legacyLogin(password: string, remember?: boolean): Promise<UserInfo> {
  const res = await fetch('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password, remember: remember || false }),
  })
  if (!res.ok) throw new Error('Invalid token')
  const data = await res.json()
  setToken(data.token, data.max_age)
  return data.user
}

export async function listSessions(): Promise<SessionInfo[]> {
  const res = await api('/api/sessions')
  if (!res.ok) throw new Error('Unauthorized')
  const data = await res.json()
  return data.sessions || []
}

export async function createSession(type: SessionType, name?: string, workDir?: string, tmuxTarget?: string, initialPrompt?: string): Promise<SessionInfo> {
  const res = await api('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ type, name: name || null, work_dir: workDir || null, tmux_target: tmuxTarget || null, initial_prompt: initialPrompt || null }),
  })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export interface TmuxSession {
  name: string
  windows: number
  attached: number
  created: number
}

export async function listTmuxSessions(): Promise<TmuxSession[]> {
  const res = await api('/api/tmux/sessions')
  if (!res.ok) throw new Error('Failed to list tmux sessions')
  const data = await res.json()
  return data.sessions || []
}

export interface DirEntry {
  name: string
  path: string
  is_git: boolean
}

export interface DirListing {
  current: string
  home: string
  parent: string | null
  entries: DirEntry[]
}

export async function listDirectories(path?: string): Promise<DirListing> {
  const params = path ? `?path=${encodeURIComponent(path)}` : ''
  // 8s timeout: on flaky mobile networks a stalled fetch would otherwise leave
  // the picker stuck on "Loading…" forever. AbortController turns it into a
  // catchable error so the caller can show a retry.
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 8000)
  try {
    const res = await api(`/api/directories${params}`, { signal: ctrl.signal })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  } finally {
    clearTimeout(timer)
  }
}

export async function deleteSession(id: string): Promise<void> {
  await api(`/api/sessions/${id}`, { method: 'DELETE' })
}

export async function checkAuth(): Promise<UserInfo | null> {
  try {
    const res = await api('/api/me')
    if (!res.ok) return null
    return res.json()
  } catch {
    return null
  }
}

// Admin APIs
export interface AdminUser {
  id: string
  github_id: number
  github_login: string
  display_name: string | null
  avatar_url: string | null
  role: string
  status: string
  created_at: string
  last_login: string | null
}

export async function listUsers(): Promise<AdminUser[]> {
  const res = await api('/api/admin/users')
  if (!res.ok) throw new Error('Forbidden')
  const data = await res.json()
  return data.users || []
}

export async function approveUser(id: string): Promise<void> {
  const res = await api(`/api/admin/users/${id}/approve`, { method: 'PUT' })
  if (!res.ok) throw new Error('Failed to approve')
}

export async function removeUser(id: string): Promise<void> {
  const res = await api(`/api/admin/users/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error('Failed to remove')
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

// Notes API
export async function listNotes(sessionId: string): Promise<{ notes: NoteEntry[]; work_dir: string }> {
  const res = await api(`/api/sessions/${sessionId}/notes`)
  if (!res.ok) throw new Error('Failed to list notes')
  return res.json()
}

export async function createNote(sessionId: string, text: string, tags?: string[]): Promise<NoteEntry> {
  const res = await api(`/api/sessions/${sessionId}/notes`, {
    method: 'POST',
    body: JSON.stringify({ text, tags: tags || [] }),
  })
  if (!res.ok) throw new Error('Failed to create note')
  return res.json()
}

export async function deleteNote(sessionId: string, noteId: string): Promise<void> {
  const res = await api(`/api/sessions/${sessionId}/notes/${noteId}`, {
    method: 'DELETE',
  })
  if (!res.ok) throw new Error('Failed to delete note')
}

// File browser
export interface FileEntry {
  path: string
  name: string
  size: number
  modified: number
}

export async function listSessionFiles(id: string, pattern?: string, baseDir?: string): Promise<FileEntry[]> {
  const params = new URLSearchParams()
  if (pattern) params.set('pattern', pattern)
  if (baseDir) params.set('base_dir', baseDir)
  const qs = params.toString()
  const res = await api(`/api/sessions/${id}/files${qs ? `?${qs}` : ''}`)
  if (!res.ok) throw new Error('Failed to list files')
  const data = await res.json()
  return data.files || []
}

export async function getSessionFile(id: string, path: string, baseDir?: string): Promise<string> {
  const params = new URLSearchParams({ path })
  if (baseDir) params.set('base_dir', baseDir)
  const res = await api(`/api/sessions/${id}/file?${params}`)
  if (!res.ok) throw new Error('Failed to read file')
  const data = await res.json()
  return data.content
}

// Git
export interface GitCommit {
  hash: string
  short_hash: string
  author: string
  date: string
  subject: string
  body: string
  refs: string
}

export interface GitGraphEntry {
  graph: string
  commit: GitCommit | null
}

export interface GitFileChange {
  additions: number
  deletions: number
  path: string
}

export async function getGitLog(id: string, limit = 50): Promise<{ entries: GitGraphEntry[]; total: number }> {
  const res = await api(`/api/sessions/${id}/git/log?limit=${limit}`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function getGitShow(id: string, commit: string): Promise<{ commit: GitCommit; diff: string; files: GitFileChange[] }> {
  const res = await api(`/api/sessions/${id}/git/show?commit=${encodeURIComponent(commit)}`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

// File CRUD
export async function writeSessionFile(id: string, path: string, content: string): Promise<void> {
  const res = await api(`/api/sessions/${id}/file`, {
    method: 'POST',
    body: JSON.stringify({ path, content }),
  })
  if (!res.ok) throw new Error(await res.text())
}

export async function deleteSessionFile(id: string, path: string): Promise<void> {
  const res = await api(`/api/sessions/${id}/file?path=${encodeURIComponent(path)}`, {
    method: 'DELETE',
  })
  if (!res.ok) throw new Error(await res.text())
}

export async function renameSessionFile(id: string, from: string, to: string): Promise<void> {
  const res = await api(`/api/sessions/${id}/file/rename`, {
    method: 'POST',
    body: JSON.stringify({ from, to }),
  })
  if (!res.ok) throw new Error(await res.text())
}

export async function uploadSessionFile(id: string, path: string, data: string): Promise<string> {
  const res = await api(`/api/sessions/${id}/upload`, {
    method: 'POST',
    body: JSON.stringify({ path, data }),
  })
  if (!res.ok) throw new Error(await res.text())
  const body = await res.json() as { path: string }
  return body.path
}

// Directory CRUD
export async function createSessionDir(id: string, path: string): Promise<void> {
  const res = await api(`/api/sessions/${id}/dir`, {
    method: 'POST',
    body: JSON.stringify({ path }),
  })
  if (!res.ok) throw new Error(await res.text())
}

export async function deleteSessionDir(id: string, path: string): Promise<void> {
  const res = await api(`/api/sessions/${id}/dir?path=${encodeURIComponent(path)}`, {
    method: 'DELETE',
  })
  if (!res.ok) throw new Error(await res.text())
}

export async function renameSessionDir(id: string, from: string, to: string): Promise<void> {
  const res = await api(`/api/sessions/${id}/dir/rename`, {
    method: 'POST',
    body: JSON.stringify({ from, to }),
  })
  if (!res.ok) throw new Error(await res.text())
}

// Agent Events
export interface AgentEvent {
  id: string
  agent: string
  event: string
  summary: string
  session_id: string | null
  work_dir: string | null
  metadata: Record<string, any> | null
  timestamp: string
}

export async function listEvents(params?: { session_id?: string; agent?: string; event?: string; since?: string; limit?: number }): Promise<{ events: AgentEvent[]; total: number }> {
  const qs = new URLSearchParams()
  if (params?.session_id) qs.set('session_id', params.session_id)
  if (params?.agent) qs.set('agent', params.agent)
  if (params?.event) qs.set('event', params.event)
  if (params?.since) qs.set('since', params.since)
  if (params?.limit) qs.set('limit', String(params.limit))
  const q = qs.toString()
  const res = await api(`/api/events${q ? `?${q}` : ''}`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function deleteEvent(id: string): Promise<void> {
  const res = await api(`/api/events/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(await res.text())
}

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

export function wsUrl(path: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const token = getToken()
  // For OAuth mode, extract JWT from cookie
  const jwt = document.cookie.split(';').map(c => c.trim()).find(c => c.startsWith('zeromux_jwt='))?.split('=')[1] || ''
  const authToken = token || jwt
  return `${proto}//${location.host}${path}?token=${encodeURIComponent(authToken)}`
}
