import type { SessionInfo } from './api'
import type { DotTone } from '../components/ui/StatusDot'
import { STUCK_SILENCE_MS } from './stuck'

export type Attention = 'error' | 'approval' | 'stuck' | 'confirm' | 'done_unread' | 'running' | 'idle' | 'ended'

export interface TriageCtx {
  now: number
  activeId: string | null
  lastViewedMs: Record<string, number>
  confirmsBySession: Record<string, number>
}

export const NEEDS_YOU: ReadonlySet<Attention> = new Set(['error', 'approval', 'stuck', 'confirm', 'done_unread'])

const PRIORITY: Record<Attention, number> = { error: 0, approval: 1, stuck: 2, confirm: 3, done_unread: 4, running: 5, idle: 6, ended: 7 }

// Unread/error are "happened after I last looked". A missing lastViewed entry
// means the sid hasn't been baselined yet (first poll) — treat as seen.
function newerThanView(s: SessionInfo, ctx: TriageCtx): boolean {
  const seen = ctx.lastViewedMs[s.id]
  return s.last_outcome_ms != null && seen != null && s.last_outcome_ms > seen && s.id !== ctx.activeId
}

/** Spec v3 M12 order. Pure; the shell derives it on every poll. */
export function triage(s: SessionInfo, ctx: TriageCtx): Attention {
  if (!s.running) return 'ended'
  const running = s.turn_state === 'running'
  if (s.type === 'tmux') return running ? 'running' : 'idle'
  if (!running && (s.last_outcome === 'errored' || s.last_outcome === 'timeout') && newerThanView(s, ctx)) return 'error'
  if ((s.pending_approvals ?? 0) > 0) return 'approval'
  if (running && ctx.now - s.last_activity_ms > STUCK_SILENCE_MS) return 'stuck'
  if ((ctx.confirmsBySession[s.id] ?? 0) > 0) return 'confirm'
  if (!running && s.last_outcome === 'completed' && newerThanView(s, ctx)) return 'done_unread'
  return running ? 'running' : 'idle'
}

export function toneOf(a: Attention): DotTone {
  switch (a) {
    case 'error': return 'danger'
    case 'stuck': return 'stuck'
    case 'approval': case 'confirm': case 'done_unread': return 'attention'
    case 'running': return 'running'
    default: return 'muted'
  }
}

const LABELS: Record<Attention, string> = {
  error: '出错', approval: '待审批', stuck: '可能卡住', confirm: '待确认',
  done_unread: '完成·未读', running: '运行中', idle: '空闲', ended: '已结束',
}
export const labelOf = (a: Attention): string => LABELS[a]

export interface TriageItem { s: SessionInfo; attention: Attention; eventMs: number }
export interface TriageGroups { needsYou: TriageItem[]; running: TriageItem[]; idle: TriageItem[] }

export function groupTriage(sessions: SessionInfo[], ctx: TriageCtx): TriageGroups {
  const g: TriageGroups = { needsYou: [], running: [], idle: [] }
  for (const s of sessions) {
    const attention = triage(s, ctx)
    const eventMs = s.last_outcome_ms ?? s.last_activity_ms
    const item = { s, attention, eventMs }
    if (NEEDS_YOU.has(attention)) g.needsYou.push(item)
    else if (attention === 'running') g.running.push(item)
    else g.idle.push(item)
  }
  g.needsYou.sort((a, b) => PRIORITY[a.attention] - PRIORITY[b.attention] || b.eventMs - a.eventMs)
  g.running.sort((a, b) => (a.s.turn_started_ms ?? a.s.last_activity_ms) - (b.s.turn_started_ms ?? b.s.last_activity_ms))
  g.idle.sort((a, b) => b.s.last_activity_ms - a.s.last_activity_ms)
  return g
}

export function needsYouCount(g: TriageGroups): number { return g.needsYou.length }

/** Next needs-you session after `currentId` in queue order, wrapping; never returns currentId. */
export function nextNeedsYou(g: TriageGroups, currentId: string | null): string | null {
  const ids = g.needsYou.map(i => i.s.id).filter(id => id !== currentId)
  if (ids.length === 0) return null
  const all = g.needsYou.map(i => i.s.id)
  const at = currentId ? all.indexOf(currentId) : -1
  if (at === -1) return ids[0]
  for (let k = 1; k <= all.length; k++) {
    const id = all[(at + k) % all.length]
    if (id !== currentId) return id
  }
  return null
}
