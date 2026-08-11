import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import AgentDashboard from '../AgentDashboard'
import * as api from '../../lib/api'
import type { AgentEvent } from '../../lib/api'

// review 2026-08-11 (F-FE): loadEvents applied `setEvents(data.events)`
// unconditionally after `await listEvents`. loadEvents fires from the
// filter-change effect, the 10s interval, AND the manual Refresh button, so a
// slower earlier request (the wider `agent=claude` query) could resolve AFTER a
// later one (the unfiltered "All" click) and overwrite it — the list then shows
// the filtered subset while the filter UI highlights "All". Fix: a monotonic
// request-token ref, bumped at the top of every loadEvents (and in handleDelete),
// drops writes from a superseded request.
describe('AgentDashboard stale-response race', () => {
  beforeEach(() => vi.restoreAllMocks())

  const ev = (id: string, agent: string): AgentEvent => ({
    id, agent, event: 'task_start', summary: `sum-${id}`,
    session_id: 's1', work_dir: null, metadata: null, timestamp: '2026-08-11T00:00:00Z',
  })

  it('slow prior fetch is dropped in favor of the newer selection', async () => {
    // Fast query (initial + "All") returns two rows so both agent filters render.
    const allRows = { events: [ev('a-claude', 'claude'), ev('b-codex', 'codex')], total: 2 }
    let resolveSlow: (v: { events: AgentEvent[]; total: number }) => void = () => {}
    const slowP = new Promise<{ events: AgentEvent[]; total: number }>(r => { resolveSlow = r })

    vi.spyOn(api, 'listEvents').mockImplementation((params?: { agent?: string }) => {
      if (params?.agent === 'claude') return slowP                                   // SLOW filtered
      return Promise.resolve(allRows)                                                // initial + All fast
    })

    render(<AgentDashboard sessionId="s1" />)
    await screen.findByText('sum-a-claude')

    // Click the "claude" agent filter → issues the SLOW filtered fetch (pending).
    // ("claude" also appears in the footer stats, so scope to the button.)
    fireEvent.click(screen.getByRole('button', { name: 'claude' }))
    // Now click "All" → issues the fast unfiltered fetch, which resolves first and
    // paints both rows.
    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    await waitFor(() => expect(screen.getByText('sum-b-codex')).toBeInTheDocument())

    // The slow claude-only fetch finally resolves with just the claude row. It must
    // NOT clobber the newer "All" result (which shows both rows).
    resolveSlow({ events: [ev('a-claude', 'claude')], total: 1 })
    await waitFor(() => {
      // codex row still present → stale filtered response was dropped.
      expect(screen.getByText('sum-b-codex')).toBeInTheDocument()
    })
    expect(screen.getByText('sum-a-claude')).toBeInTheDocument()
  })
})
