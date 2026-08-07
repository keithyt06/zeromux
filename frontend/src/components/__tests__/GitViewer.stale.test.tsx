import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import GitViewer from '../GitViewer'
import * as api from '../../lib/api'
import type { GitCommit, SessionStatus } from '../../lib/api'

// F2 (review 2026-08-06): selectCommit wrote diff/files/commitMeta unconditionally
// after `await getGitShow`. Clicking commit A (slow) then B (fast) let B land, then
// A overwrite — the list highlighted B but the header/diff showed A. The fix bails
// when selectedHashRef.current no longer matches the resolved request's hash.
describe('GitViewer stale-response race', () => {
  beforeEach(() => vi.restoreAllMocks())

  const commit = (hash: string, subject: string): GitCommit => ({
    hash, short_hash: hash.slice(0, 7), author: 'x',
    date: '2026-01-01T00:00:00Z', subject, body: '', refs: '',
  })
  const show = (c: GitCommit, diff: string) => ({
    commit: c, diff, files: [{ path: `${c.hash}.rs`, additions: 1, deletions: 0 }],
  })

  it('a slow first git-show cannot overwrite the newer selection', async () => {
    const status: SessionStatus = { work_dir: '/w', git_branch: 'main', git_dirty: 0, is_git: true }
    vi.spyOn(api, 'getSessionStatus').mockResolvedValue(status)
    const cA = commit('aaaa1111', 'commit A')
    const cB = commit('bbbb2222', 'commit B')
    vi.spyOn(api, 'getGitLog').mockResolvedValue({
      total: 2,
      entries: [{ graph: '*', commit: cA }, { graph: '*', commit: cB }],
    })

    // A's show is slow (pending), B's is fast.
    let resolveA: (v: ReturnType<typeof show>) => void = () => {}
    const aShow = new Promise<ReturnType<typeof show>>(r => { resolveA = r })
    vi.spyOn(api, 'getGitShow').mockImplementation((_id, hash) =>
      hash === 'aaaa1111' ? aShow : Promise.resolve(show(cB, 'DIFF-OF-B')),
    )

    render(<GitViewer sessionId="s1" />)

    // loadLog auto-selects the first commit (A) → A's show is pending.
    const commitB = await screen.findByText('commit B')
    // Now click B; its fast show resolves first.
    commitB.click()
    await waitFor(() => expect(screen.getByText('DIFF-OF-B')).toBeInTheDocument())

    // A's slow show finally resolves — it must NOT clobber B's diff/header.
    resolveA(show(cA, 'DIFF-OF-A'))
    await waitFor(() => expect(screen.queryByText('DIFF-OF-A')).not.toBeInTheDocument())
    expect(screen.getByText('DIFF-OF-B')).toBeInTheDocument()
  })
})
