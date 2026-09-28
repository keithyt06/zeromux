import { useEffect, useState } from 'react'
import { STUCK_SILENCE_MS } from '../../lib/stuck'
import { formatDuration } from '../../lib/format'

/** Busy/queue line above the composer. Owns the 1s clock so the conversation
 *  view no longer re-renders every second (audit §6.4). */
export function TurnStatusBar({ busy, turnStartedMs, lastEventMs, queuedCount, onInterrupt }: {
  busy: boolean; turnStartedMs: number | null; lastEventMs: number | null; queuedCount: number; onInterrupt: () => void
}) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!busy) return
    // Deps are [busy] ONLY: re-arming on every lastEventMs bump (each streamed
    // block) would reset the interval before it ever fires and freeze the clock.
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [busy])
  if (!busy && queuedCount === 0) return null
  // `now` may lag a fresh turnStartedMs/lastEventMs by <1s (no setState in the
  // effect); never let it read earlier than the timestamps it is compared to.
  const t = Math.max(now, turnStartedMs ?? 0, lastEventMs ?? 0)
  const elapsed = turnStartedMs ? t - turnStartedMs : 0
  const silence = lastEventMs != null ? t - lastEventMs : 0
  const stuck = busy && lastEventMs != null && silence > STUCK_SILENCE_MS
  return (
    <div className="px-2 pb-1 flex flex-col gap-0.5 text-ui-xs">
      {queuedCount > 0 && <span className="text-[var(--fg-subtle)]">已排队 {queuedCount} 条，本轮结束后合并发送</span>}
      {busy && (
        <div className="flex items-center gap-2">
          {stuck
            ? <span className="text-[var(--stuck)]">已静默 {Math.floor(silence / 1000)}s，可能卡住</span>
            : <span className="num text-[var(--fg-subtle)]">运行中 {formatDuration(elapsed) || '0s'}</span>}
          <button type="button" onClick={onInterrupt}
            className={`ctl px-3 rounded-[var(--r-md)] border text-ui-xs font-semibold ${stuck ? 'border-[var(--stuck)] text-[var(--stuck)]' : 'border-[var(--border)] text-[var(--fg-muted)] hover:text-[var(--fg)]'}`}>
            中断
          </button>
        </div>
      )}
    </div>
  )
}
