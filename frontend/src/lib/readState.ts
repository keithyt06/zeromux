// Persisted "last time I looked at this session" (spec v3 M10). Timestamps,
// not turn counts: turns_completed resets to 0 on every backend restart, which
// would make a persisted count exceed it forever and hide new completions.
export const READ_KEY = 'zmx_read'

export function loadLastViewed(): Record<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(READ_KEY) ?? '{}')
    if (!raw || typeof raw !== 'object') return {}
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(raw)) if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
    return out
  } catch { return {} }
}

/** Baseline unseen sids at `now`, GC sids no longer listed. Returns the same
 *  object when nothing changed. */
export function reconcileLastViewed(prev: Record<string, number>, sids: string[], now: number): Record<string, number> {
  const keep = new Set(sids)
  let changed = Object.keys(prev).some(k => !keep.has(k))
  const next: Record<string, number> = {}
  for (const id of sids) {
    if (id in prev) next[id] = prev[id]
    else { next[id] = now; changed = true }
  }
  return changed ? next : prev
}

export function markViewed(prev: Record<string, number>, sid: string, now: number): Record<string, number> {
  return (prev[sid] ?? 0) >= now ? prev : { ...prev, [sid]: now }
}

export function saveLastViewed(m: Record<string, number>): void {
  try { localStorage.setItem(READ_KEY, JSON.stringify(m)) } catch { /* quota / private mode */ }
}
