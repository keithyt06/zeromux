import type { SessionInfo } from './api'

export const AWAY_MIN_MS = 30 * 60_000

export type AwayKey = 'errored' | 'awaiting' | 'confirm' | 'completed' | 'other'
/** Card row / item order (spec §3.2). S6 appends rows (Crew external, gate silence)
 *  under this key and truncates to 3 lines + 「更多 (N)」. */
export const AWAY_PRIORITY: readonly AwayKey[] = ['errored', 'awaiting', 'confirm', 'completed', 'other']

export interface AwayItem { key: AwayKey; label: string; count: number; firstId: string | null }
export interface AwaySummary { awayMs: number; items: AwayItem[]; costUsd: number; costPartial: boolean }

const LABEL: Record<AwayKey, string> = { errored: '出错', awaiting: '待回答', confirm: '待确认', completed: '完成', other: '其他' }

/** What happened in (leftMs, nowMs]. Pure. null = don't show the card. */
export function summarizeAway(sessions: SessionInfo[], confirms: Record<string, number>, leftMs: number | null, nowMs: number): AwaySummary | null {
  if (leftMs == null || nowMs - leftMs < AWAY_MIN_MS) return null
  const inWindow = sessions
    .filter(s => s.type !== 'tmux' && s.last_outcome_ms != null && s.last_outcome_ms > leftMs && s.last_outcome_ms <= nowMs)
    .sort((a, b) => (b.last_outcome_ms ?? 0) - (a.last_outcome_ms ?? 0))
  const bucket = (pred: (s: SessionInfo) => boolean) => inWindow.filter(pred)
  const errored = bucket(s => s.last_outcome === 'errored' || s.last_outcome === 'timeout')
  const completed = bucket(s => s.last_outcome === 'completed')
  // Pending confirms carry no timestamp here, so they can't prove something
  // happened in the window: they only ride along once an in-window event exists.
  if (errored.length + completed.length === 0) return null
  const confirmIds = sessions.filter(s => (confirms[s.id] ?? 0) > 0).map(s => s.id)
  const confirmCount = confirmIds.reduce((n, id) => n + confirms[id], 0)
  const counts: Partial<Record<AwayKey, { count: number; firstId: string | null }>> = {
    errored: { count: errored.length, firstId: errored[0]?.id ?? null },
    confirm: { count: confirmCount, firstId: confirmIds[0] ?? null },
    completed: { count: completed.length, firstId: completed[0]?.id ?? null },
  }
  const items: AwayItem[] = AWAY_PRIORITY.flatMap(key => {
    const c = counts[key]
    return c && c.count > 0 ? [{ key, label: LABEL[key], count: c.count, firstId: c.firstId }] : []
  })
  return {
    awayMs: nowMs - leftMs,
    items,
    costUsd: inWindow.reduce((sum, s) => sum + (s.lifetime_cost_usd ?? 0), 0),
    // Codex / Crew report no cost (spec §3.2 「部分未计」).
    costPartial: inWindow.some(s => s.type === 'codex' || s.type === 'crew'),
  }
}

export function formatAway(ms: number): string {
  const m = Math.floor(ms / 60_000)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.floor(h / 24)}d`
}
