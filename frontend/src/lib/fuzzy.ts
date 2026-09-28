// Tiny subsequence matcher for ⌘K (sessions/actions are in-memory; dirs/notes
// use the backend fuzzy index). Score: gaps between matched chars + start offset.
export function fuzzyScore(query: string, text: string): number | null {
  const q = [...query.trim().toLowerCase()]
  if (q.length === 0) return 0
  const t = [...text.toLowerCase()]
  let qi = 0, score = 0, last = -1, first = -1
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      if (first < 0) first = i
      if (last >= 0) score += i - last - 1
      last = i; qi++
    }
  }
  return qi === q.length ? score + first : null
}

export function rankBy<T>(query: string, items: T[], keys: (t: T) => string[]): T[] {
  if (!query.trim()) return items
  const scored: { t: T; s: number; i: number }[] = []
  items.forEach((t, i) => {
    let best: number | null = null
    for (const k of keys(t)) { const sc = fuzzyScore(query, k); if (sc != null && (best == null || sc < best)) best = sc }
    if (best != null) scored.push({ t, s: best, i })
  })
  return scored.sort((a, b) => a.s - b.s || a.i - b.i).map(x => x.t)
}
