import { render, screen, waitFor, fireEvent } from '@testing-library/react'
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

  // An optimistic verdict flip must not be reverted by a slow load already in
  // flight (a turn-boundary refreshKey bump). setVerdict does an optimistic
  // setRuns; without bumping reqRef, the pre-click getSessionRuns snapshot
  // resolves last and clobbers the human mark back to unmarked until the next
  // turn. Mirrors AgentDashboard.handleDelete / SessionInfoBar note mutations.
  it('optimistic verdict survives a slow turn-boundary load resolving after the click', async () => {
    // Call 1 (mount) resolves fast → paints r1 (unmarked). Call 2 (refreshKey
    // bump) is a SLOW turn-boundary load carrying the pre-verdict snapshot.
    let resolveSlow: (v: { runs: RunMetric[]; stats: RunStats }) => void = () => {}
    const slowP = new Promise<{ runs: RunMetric[]; stats: RunStats }>(r => { resolveSlow = r })
    let call = 0
    vi.spyOn(api, 'getSessionRuns').mockImplementation(() => {
      call += 1
      return (call === 1
        ? Promise.resolve({ runs: [run('r1', 1)], stats: stats(1) })
        : slowP
      ) as ReturnType<typeof api.getSessionRuns>
    })
    vi.spyOn(api, 'postRunVerdict').mockResolvedValue(undefined as unknown as Awaited<ReturnType<typeof api.postRunVerdict>>)

    const { RunMetricsPanel } = await import('../RunMetricsPanel')
    const { rerender } = render(
      <RunMetricsPanel sessionId="s1" turnStartedMs={null} running={false} refreshKey={0} />
    )
    fireEvent.click(screen.getByText('运行记录'))
    const up = await screen.findByLabelText('thumbs up')

    // A turn boundary fires the SLOW load (still in flight).
    rerender(<RunMetricsPanel sessionId="s1" turnStartedMs={null} running={false} refreshKey={1} />)

    // Unmarked rows carry `text-[var(--text-muted)]`; a marked 'good' drops it
    // for the solid accent-green class. (Both states contain the substring
    // "accent-green" via the hover: class, so text-muted is the real discriminator.)
    const marked = () => !screen.getByLabelText('thumbs up').className.includes('text-[var(--text-muted)]')
    expect(marked()).toBe(false)

    // User clicks the verdict while that load is in flight → optimistic mark.
    fireEvent.click(up)
    await waitFor(() => expect(marked()).toBe(true))

    // The stale pre-click snapshot (r1 unmarked) resolves LAST. reqRef was bumped
    // by setVerdict, so it must be dropped — the verdict must stay marked.
    resolveSlow({ runs: [run('r1', 1)], stats: stats(1) })
    await new Promise(r => setTimeout(r, 0))
    expect(marked()).toBe(true)
  })
})
