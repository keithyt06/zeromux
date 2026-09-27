import { useCallback, useEffect, useRef, useState } from 'react'
import { useLatestRequest } from './useLatestRequest'

/** Keyed async resource with stale-response protection.
 *  - key change: data is cleared DURING render (no stale rows under a new key, B4)
 *  - reload(): refetch without clearing (no "flash empty" after writes, fe5396b)
 *  - setData(): optimistic write; invalidates any in-flight fetch first (I-8) */
export function useAsyncResource<T>(key: string | null, fetcher: () => Promise<T>) {
  const req = useLatestRequest()
  const fetcherRef = useRef(fetcher)
  useEffect(() => { fetcherRef.current = fetcher })

  const [data, setDataState] = useState<T | undefined>(undefined)
  const [loading, setLoading] = useState(key !== null)
  const [error, setError] = useState<unknown>(undefined)
  const [tick, setTick] = useState(0)

  const [shownKey, setShownKey] = useState(key)
  if (shownKey !== key) {
    setShownKey(key)
    setDataState(undefined)
    setError(undefined)
    setLoading(key !== null)
  }

  useEffect(() => {
    if (key === null) { req.bump(); return }
    const t = req.begin()
    fetcherRef.current().then(
      v => { if (req.isCurrent(t)) { setDataState(v); setError(undefined); setLoading(false) } },
      e => { if (req.isCurrent(t)) { setError(e); setLoading(false) } },
    )
  }, [key, tick, req])

  const reload = useCallback(() => { setLoading(true); setTick(n => n + 1) }, [])
  const setData = useCallback((updater: (prev: T | undefined) => T | undefined) => {
    req.bump()
    setDataState(updater)
    setLoading(false)
  }, [req])

  return { data, loading: key !== null && loading, error, reload, setData }
}
