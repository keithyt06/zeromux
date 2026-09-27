import { api } from './core'

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
