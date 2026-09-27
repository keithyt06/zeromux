import { useEffect, useRef } from 'react'

/** Interval polling that pauses while the tab is hidden and fires once on
 *  return (phones background tabs constantly). Overlapping runs are skipped. */
export function usePolling(
  fn: () => void | Promise<void>,
  intervalMs: number,
  { enabled = true, immediate = true }: { enabled?: boolean; immediate?: boolean } = {},
) {
  const fnRef = useRef(fn)
  useEffect(() => { fnRef.current = fn })

  useEffect(() => {
    if (!enabled) return
    let inFlight = false
    let timer: ReturnType<typeof setInterval> | undefined
    const run = () => {
      if (inFlight || document.visibilityState === 'hidden') return
      const r = fnRef.current()
      if (r && typeof (r as Promise<void>).finally === 'function') {
        inFlight = true
        ;(r as Promise<void>).catch(() => {}).finally(() => { inFlight = false })
      }
    }
    const start = () => { if (!timer) timer = setInterval(run, intervalMs) }
    const stop = () => { if (timer) { clearInterval(timer); timer = undefined } }
    const onVis = () => {
      if (document.visibilityState === 'hidden') stop()
      else { run(); start() }
    }
    if (immediate) run()
    if (document.visibilityState !== 'hidden') start()
    document.addEventListener('visibilitychange', onVis)
    return () => { stop(); document.removeEventListener('visibilitychange', onVis) }
  }, [enabled, intervalMs, immediate])
}
