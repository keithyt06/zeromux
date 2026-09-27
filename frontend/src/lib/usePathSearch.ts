import { useCallback, useEffect, useState } from 'react'
import { searchPaths } from './api'
import type { SearchResult } from './api'
import { useLatestRequest } from './useLatestRequest'

const REQUERY_MS = 4000

/** Debounced fuzzy path search with the "index still building → re-query in
 *  4s" behaviour. Shared by the New Session search, VaultReader and (S2) ⌘K. */
export function usePathSearch(
  query: string,
  { scope, limit, debounceMs, enabled = true, requeryWhile }: {
    scope: string; limit?: number; debounceMs: number; enabled?: boolean; requeryWhile: (r: SearchResult) => boolean
  },
) {
  const req = useLatestRequest()
  const [result, setResult] = useState<SearchResult | null>(null)
  const [resultQuery, setResultQuery] = useState('')
  const [failed, setFailed] = useState(false)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!enabled) return
    // Empty query clears synchronously (no debounce) and invalidates any
    // in-flight request, so reopen / Back can't flash a previous result.
    // Must live in the effect (not render) because it also bumps the request ref.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!query.trim()) { req.bump(); setResult(null); setFailed(false); return }
    let again: ReturnType<typeof setTimeout> | undefined
    const run = (q: string) => {
      const t = req.begin()
      if (!q.trim()) { setResult(null); setFailed(false); return }
      searchPaths(q, scope, limit)
        .then(r => {
          if (!req.isCurrent(t)) return
          setResult(r); setResultQuery(q); setFailed(false)
          if (requeryWhile(r)) again = setTimeout(() => { if (req.isCurrent(t)) run(q) }, REQUERY_MS)
        })
        .catch(() => { if (req.isCurrent(t)) { setResult(null); setFailed(true) } })
    }
    const d = setTimeout(() => run(query), debounceMs)
    return () => { clearTimeout(d); if (again) clearTimeout(again) }
    // requeryWhile is a predicate; callers pass a stable module-level function.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, scope, limit, debounceMs, enabled, tick, req])

  const retry = useCallback(() => setTick(n => n + 1), [])
  return { result, resultQuery, failed, retry }
}
