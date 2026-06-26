import { useState, useEffect, useCallback } from 'react'
import { ChevronRight, ThumbsUp, ThumbsDown } from 'lucide-react'
import { getSessionRuns, postRunVerdict } from '../lib/api'
import type { RunMetric, RunStats, RunOutcome, SessionLifetime } from '../lib/api'

interface Props {
  sessionId: string
  // Stamped at turn start by AcpChatView; the live timer is computed locally
  // from this, NOT driven by WS, so a quiet socket still ticks.
  turnStartedMs: number | null
  running: boolean
  // Bumped by the parent on each turn boundary (debounced) to re-GET runs.
  refreshKey?: number
  // Called after each successful fetch so the parent can show lifetime stats.
  onLifetime?: (lt: SessionLifetime) => void
}

// HONEST labels (spec-mandated, tested): a non-erroring exit is NOT proof the
// task succeeded — "completed" means "the process exited without error", which
// we say verbatim. Never "成功"/"success".
const OUTCOME: Record<RunOutcome, { label: string; color: string }> = {
  completed: { label: '完成（已退出）', color: 'var(--accent-green)' },
  errored: { label: '出错', color: 'var(--accent-red)' },
  timeout: { label: '超时', color: 'var(--accent-yellow)' },
  cancelled: { label: '已取消', color: 'var(--accent-purple)' },
}

function fmtDuration(ms: number | null): string {
  if (ms == null) return '—'
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`
  const m = Math.floor(s / 60)
  return `${m}m${String(Math.floor(s % 60)).padStart(2, '0')}s`
}

function fmtTime(ms: number): string {
  try {
    const d = new Date(ms)
    const h = String(d.getHours()).padStart(2, '0')
    const mi = String(d.getMinutes()).padStart(2, '0')
    return `${h}:${mi}`
  } catch {
    return ''
  }
}

function Pill({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[var(--bg-primary)] border border-[var(--border)] text-[10px] text-[var(--text-secondary)]">
      <span className="text-[var(--text-muted)]">{label}</span>
      <span className="text-[var(--text-primary)] font-medium">{value}</span>
    </span>
  )
}

export function RunMetricsPanel({ sessionId, turnStartedMs, running, refreshKey, onLifetime }: Props) {
  const [runs, setRuns] = useState<RunMetric[]>([])
  const [stats, setStats] = useState<RunStats | null>(null)
  const [nowMs, setNowMs] = useState(() => Date.now())

  const load = useCallback(async () => {
    try {
      const data = await getSessionRuns(sessionId, { limit: 50 })
      setRuns(data.runs)
      setStats(data.stats)
      if (data.lifetime && onLifetime) onLifetime(data.lifetime)
    } catch { /* ignore */ }
  }, [sessionId, onLifetime])

  // On mount + whenever the parent signals a turn boundary.
  useEffect(() => { load() }, [load, refreshKey])

  // Local timer: tick a 1s clock only while a turn is in flight. Computed from
  // turnStartedMs (NOT WS-driven), so a quiet socket still ticks. The interval
  // updates within 1s of (re)start — no eager setState in the effect body.
  useEffect(() => {
    if (!running || turnStartedMs == null) return
    const t = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(t)
  }, [running, turnStartedMs])

  const setVerdict = useCallback(async (runId: string, verdict: string) => {
    // Optimistic: flip the row immediately, mark it human-sourced.
    setRuns(prev => prev.map(r =>
      r.run_id === runId ? { ...r, verdict, verdict_source: 'human' } : r
    ))
    try {
      await postRunVerdict(sessionId, runId, verdict)
    } catch {
      load()  // reconcile on failure
    }
  }, [sessionId, load])

  const elapsed = running && turnStartedMs != null
    ? Math.max(0, Math.floor((nowMs - turnStartedMs) / 1000))
    : null

  return (
    <details className="group border-b border-[var(--border)] bg-[var(--bg-secondary)]">
      <summary className="flex items-center gap-2 px-3 py-1.5 cursor-pointer select-none text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
        <ChevronRight size={13} className="transition-transform group-open:rotate-90 shrink-0" />
        <span className="font-medium">运行记录</span>
        {stats && <span className="text-[var(--text-muted)]">· {stats.count} 次</span>}
        {elapsed != null && (
          <span className="ml-auto text-[var(--accent-yellow)] tabular-nums">运行中 {elapsed}s</span>
        )}
      </summary>

      <div className="px-3 pb-2 space-y-2">
        {/* Aggregate pills */}
        {stats && stats.count > 0 && (
          <div className="flex flex-wrap gap-1">
            <Pill label="次数" value={String(stats.count)} />
            <Pill label="均值" value={fmtDuration(stats.avg_ms)} />
            <Pill label="P95" value={fmtDuration(stats.p95_ms)} />
            <Pill label="最长" value={fmtDuration(stats.max_ms)} />
            {stats.completed_count > 0 && <Pill label="完成" value={String(stats.completed_count)} />}
            {stats.errored_count > 0 && <Pill label="出错" value={String(stats.errored_count)} />}
            {stats.timeout_count > 0 && <Pill label="超时" value={String(stats.timeout_count)} />}
            {stats.cancelled_count > 0 && <Pill label="已取消" value={String(stats.cancelled_count)} />}
          </div>
        )}

        {/* History timeline */}
        {runs.length === 0 ? (
          <p className="text-[11px] text-[var(--text-muted)] italic py-1">暂无运行记录</p>
        ) : (
          <div className="max-h-60 overflow-y-auto space-y-0.5">
            {runs.map(r => (
              <RunRow key={r.run_id} run={r} onVerdict={setVerdict} />
            ))}
          </div>
        )}
      </div>
    </details>
  )
}

function RunRow({ run, onVerdict }: { run: RunMetric; onVerdict: (id: string, v: string) => void }) {
  const o = OUTCOME[run.outcome]
  const isClaude = run.agent_type === 'claude'
  return (
    <div className="flex items-center gap-2 px-1.5 py-1 rounded hover:bg-[var(--bg-primary)] text-[11px]">
      <span
        className="inline-block w-2 h-2 rounded-full shrink-0"
        style={{ backgroundColor: o.color }}
      />
      <span className="text-[var(--text-primary)] shrink-0" style={{ color: o.color }}>
        {o.label}
      </span>
      <span className="text-[var(--text-muted)] tabular-nums shrink-0">{fmtTime(run.started_ms)}</span>
      {/* Cost (仅 Claude). Non-Claude backends don't report cost → 「—」 with a
          tooltip, never a fabricated number. */}
      <span
        className="text-[var(--text-muted)] tabular-nums shrink-0"
        title={isClaude ? '成本（仅 Claude）' : '该后端不上报成本'}
      >
        {isClaude && run.cost_usd != null ? `$${run.cost_usd.toFixed(4)}` : '—'}
      </span>
      <span className="ml-auto text-[var(--text-secondary)] tabular-nums shrink-0">
        {fmtDuration(run.duration_ms)}
      </span>
      <div className="flex items-center gap-0.5 shrink-0">
        <button
          onClick={() => onVerdict(run.run_id, 'good')}
          aria-label="thumbs up"
          title="标记为好结果"
          className={`p-0.5 rounded transition-colors ${
            run.verdict === 'good'
              ? 'text-[var(--accent-green)]'
              : 'text-[var(--text-muted)] hover:text-[var(--accent-green)]'
          }`}
        >
          <ThumbsUp size={12} />
        </button>
        <button
          onClick={() => onVerdict(run.run_id, 'bad')}
          aria-label="thumbs down"
          title="标记为差结果"
          className={`p-0.5 rounded transition-colors ${
            run.verdict === 'bad'
              ? 'text-[var(--accent-red)]'
              : 'text-[var(--text-muted)] hover:text-[var(--accent-red)]'
          }`}
        >
          <ThumbsDown size={12} />
        </button>
      </div>
    </div>
  )
}
