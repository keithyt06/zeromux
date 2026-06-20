import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { RunMetric, RunStats } from '../../lib/api'

// Two runs (one completed, one timeout) + stats. The panel must render aggregate
// pills (incl. P95) and use HONEST outcome labels: "completed" → 「完成（已退出）」,
// never "成功"/"success" (spec §honesty — a non-erroring exit is not proof of success).
const runs: RunMetric[] = [
  {
    run_id: 'r1', session_id: 's1', work_dir: '/w', agent_type: 'claude',
    turn_seq: 1, started_ms: 1000, ended_ms: 4000, duration_ms: 3000,
    outcome: 'completed', verdict_source: 'none', cost_usd: 0.0123,
  },
  {
    run_id: 'r2', session_id: 's1', work_dir: '/w', agent_type: 'claude',
    turn_seq: 2, started_ms: 5000, ended_ms: 9000, duration_ms: 4000,
    outcome: 'timeout', failure_kind: 'watchdog_timeout', verdict_source: 'none',
  },
]
const stats: RunStats = {
  count: 2, avg_ms: 3500, p50_ms: 3000, p95_ms: 4000, max_ms: 4000,
  completed_count: 1, errored_count: 0, timeout_count: 1, cancelled_count: 0,
}

vi.mock('../../lib/api', () => ({
  getSessionRuns: vi.fn().mockResolvedValue({ runs, stats }),
  postRunVerdict: vi.fn(),
}))

describe('RunMetricsPanel', () => {
  it('renders aggregate pills and HONEST completed label (never 成功)', async () => {
    const { RunMetricsPanel } = await import('../RunMetricsPanel')
    render(<RunMetricsPanel sessionId="s1" turnStartedMs={null} running={false} />)
    expect(await screen.findByText(/P95/)).toBeInTheDocument()
    expect(await screen.findByText('完成（已退出）')).toBeInTheDocument()
    expect(screen.queryByText(/成功/)).not.toBeInTheDocument()
    expect(screen.queryByText(/success/i)).not.toBeInTheDocument()
    // honest per-outcome labels for the timeout run (appears as both a pill
    // label and a timeline row label)
    expect(screen.getAllByText('超时').length).toBeGreaterThan(0)
  })
})
