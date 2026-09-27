import { useRef, useMemo } from 'react'

/** Monotonic stale-response guard (I-8). The three touch points stay explicit
 *  at the call site: begin() before the request, isCurrent(t) after every
 *  await, bump() before any optimistic setState. Deliberately no run()
 *  wrapper — it would hide the third point, which is the one that regresses. */
export function useLatestRequest() {
  const seq = useRef(0)
  return useMemo(() => ({
    begin: () => ++seq.current,
    isCurrent: (t: number) => t === seq.current,
    bump: () => { seq.current++ },
  }), [])
}
