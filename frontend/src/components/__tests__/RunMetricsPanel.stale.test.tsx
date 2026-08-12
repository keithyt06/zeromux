import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { RunMetric, RunStats } from '../../lib/api'
import * as api from '../../lib/api'

// review 2026-08-12 (F-METRICS-STALE): RunMetricsPanel.load applied
// `setRuns/setStats` unconditionally after `await getSessionRuns`. It fires on
// mount and on every `refreshKey` bump (a debounced turn-boundary signal). On the
// JuiceFS/S3-backed FS the fetch can take seconds, so a slow earlier load can
// resolve AFTER a fast later one and overwrite it — dropping the newest run rows
// and reverting stats, with no self-correction until the next turn. Fix: a
// monotonic reqRef bumped at the top of load(), dropping superseded writes.

vi.mock('../../lib/api', () => ({
  getSessionRuns: vi.fn(),
  postRunVerdict: vi.fn(),
}))

const run = (id: string, seq: number): RunMetric => ({
  run_id: id, session_id: 's1', work_dir: '/w', agent_type: 'claude',
  turn_seq: seq, started_ms: seq * 1000, ended_ms: seq * 1000 + 2000,
  duration_ms: 2000, outcome: 'completed', verdict_source: 'none',
})
const stats = (count: number): RunStats => ({
  count, avg_ms: 2000, p50_ms: 2000, p95_ms: 2000, max_ms: 2000,
  completed_count: count, errored_count: 0, timeout_count: 0, cancelled_count: 0,
})

describe('RunMetricsPanel stale-response race', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('slow prior load is dropped in favor of the newer refresh', async () => {
    const fresh = { runs: [run('r1', 1), run('r2', 2)], stats: stats(2) }
    let resolveSlow: (v: { runs: RunMetric[]; stats: RunStats }) => void = () => {}
    const slowP = new Promise<{ runs: RunMetric[]; stats: RunStats }>(r => { resolveSlow = r })

    let call = 0
    vi.spyOn(api, 'getSessionRuns').mockImplementation(() => {
      call += 1
      // First load (mount, refreshKey=0) is SLOW and returns only one stale row.
      // Second load (refreshKey=1) is FAST and returns the fresh two-row set.
      return (call === 1 ? slowP : Promise.resolve(fresh)) as ReturnType<typeof api.getSessionRuns>
    })

    const { RunMetricsPanel } = await import('../RunMetricsPanel')
    const { rerender } = render(
      <RunMetricsPanel sessionId="s1" turnStartedMs={null} running={false} refreshKey={0} />
    )
    // Bump refreshKey → fires the FAST load, which resolves first and paints 2 次.
    rerender(
      <RunMetricsPanel sessionId="s1" turnStartedMs={null} running={false} refreshKey={1} />
    )
    // The header count `· N 次` reflects stats.count and renders whenever stats is set.
    await waitFor(() => expect(screen.getByText(/2 次/)).toBeInTheDocument())

    // The slow mount load finally resolves with its stale one-row snapshot. It must
    // NOT clobber the newer result — the count must stay at 2.
    resolveSlow({ runs: [run('r1', 1)], stats: stats(1) })
    await waitFor(() => expect(screen.getByText(/2 次/)).toBeInTheDocument())
    expect(screen.queryByText(/1 次/)).not.toBeInTheDocument()
  })
})
