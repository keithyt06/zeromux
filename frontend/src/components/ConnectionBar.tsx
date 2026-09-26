import { useEffect, useState } from 'react'
import { connectionBarText, CONNECTION_BAR_DELAY_MS, type WsStatus } from '../lib/wsStatus'

// Thin status strip above the composer. Re-renders once after the delay so a
// long outage becomes visible without a 1s ticker (busy sessions already tick).
export default function ConnectionBar({ status, sinceMs }: { status: WsStatus; sinceMs: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (status === 'open' || status === 'ended') return
    const t = setTimeout(() => setNow(Date.now()), CONNECTION_BAR_DELAY_MS - (Date.now() - sinceMs) + 10)
    return () => clearTimeout(t)
  }, [status, sinceMs])
  // `now` only ever lags real time, so a stale value can delay the bar but never
  // show it early; the timer above re-arms on every new `sinceMs`.
  const text = connectionBarText(status, sinceMs, now)
  if (!text) return null
  return (
    <div role="status" aria-live="polite"
      className={`px-3 py-1 text-xs text-center border-t border-[var(--border)] ${
        status === 'ended' ? 'text-[var(--text-secondary)] bg-[var(--bg-tertiary)]' : 'text-[var(--accent-yellow)] bg-[var(--bg-secondary)]'
      }`}>
      {text}
    </div>
  )
}
