import { vi } from 'vitest'
import * as api from '../lib/api'
import type { SessionInfo } from '../lib/api'
import { installFakeWebSocket } from './fakeWs'

export function mkSession(id: string, over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id, name: `s-${id}`, type: 'claude', cols: 80, rows: 24, work_dir: `/w/${id}`, description: '',
    status: 'idle', running: true, turn_state: 'idle', turn_started_ms: null, last_activity_ms: 1,
    turns_completed: 0, tmux_name: null, tmux_origin: null, other_clients: 0, peer_name: null,
    last_outcome: null, last_outcome_ms: null, last_snippet: null, current_step: null,
    pending_approvals: 0, lifetime_cost_usd: 0, ...over,
  }
}

export function setupApp(opts: { sessions?: SessionInfo[] } = {}) {
  let current = opts.sessions ?? [mkSession('a'), mkSession('b', { type: 'tmux', tmux_name: 'zmx-b', tmux_origin: 'own' })]
  const ws = installFakeWebSocket()
  vi.spyOn(api, 'checkAuth').mockResolvedValue({ id: 'u', login: 'u', avatar: null, role: 'admin', status: 'active' } as api.UserInfo)
  vi.spyOn(api, 'getAuthMode').mockResolvedValue({ oauth: false, legacy: true })
  const list = vi.spyOn(api, 'listSessionsWithHost').mockImplementation(async () => ({ sessions: current, host_tmux: [] }))
  vi.spyOn(api, 'listSessions').mockImplementation(async () => current)
  vi.spyOn(api, 'listConfirmations').mockResolvedValue({ runs: [], count: 0 })
  vi.spyOn(api, 'getSchedulerHealth').mockResolvedValue({ heartbeat_ms: 1, healthy: true })
  vi.spyOn(api, 'getVaultMeta').mockResolvedValue({ enabled: false, name: '' })
  vi.spyOn(api, 'listQuickTargets').mockResolvedValue({ top: [] })
  vi.spyOn(api, 'listPrompts').mockResolvedValue([])
  vi.spyOn(api, 'getSessionRuns').mockResolvedValue({ runs: [], stats: null, lifetime: { turns: 0, duration_ms: 0, cost_usd: 0 } } as never)
  vi.spyOn(api, 'getSessionStatus').mockResolvedValue({ work_dir: '/w', git_branch: 'main', git_dirty: 0, is_git: true })
  vi.spyOn(api, 'getTmuxHealth').mockResolvedValue({ server: true, in_unit: true })
  const del = vi.spyOn(api, 'deleteSession').mockResolvedValue({ pending_until: Date.now() + 5000 })
  vi.spyOn(api, 'closeCheck').mockResolvedValue(null)
  globalThis.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
  return { ws, list, del, setSessions: (s: SessionInfo[]) => { current = s } }
}
