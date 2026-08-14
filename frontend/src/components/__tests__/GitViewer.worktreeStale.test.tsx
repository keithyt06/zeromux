import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import GitViewer from '../GitViewer'
import * as api from '../../lib/api'
import type { SessionStatus } from '../../lib/api'

// F3 (review 2026-08-14): loadWorktree committed setWt unconditionally after the slow
// `git diff HEAD` await, with NO stale guard — unlike its sibling selectCommit
// (selectedHashRef, 2026-08-06). It has TWO concurrent entry points (the tab effect
// and WorktreePanel's Refresh button). On the JuiceFS/S3 prod FS a slow first fetch
// could land AFTER a fast Refresh and overwrite the current worktree with a stale one,
// so a just-made change looks missing. The fix bumps wtReqRef at the top and compares
// before setWt.
describe('GitViewer worktree stale-response race', () => {
  beforeEach(() => vi.restoreAllMocks())

  const wt = (path: string, diff: string) => ({
    is_git: true,
    truncated: false,
    diff,
    files: [{ path, status: ' M', staged: false, old_path: null }],
  })

  it('a slow first worktree load cannot overwrite the newer Refresh result', async () => {
    // git_dirty > 0 → defaultGitTab opens the 工作区改动 (worktree) tab on mount.
    const status: SessionStatus = { work_dir: '/w', git_branch: 'main', git_dirty: 1, is_git: true }
    vi.spyOn(api, 'getSessionStatus').mockResolvedValue(status)
    vi.spyOn(api, 'getGitLog').mockResolvedValue({ total: 0, entries: [] })

    // First worktree fetch (from the tab effect) is slow; the Refresh fetch is fast.
    let resolveFirst: (v: ReturnType<typeof wt>) => void = () => {}
    const firstWt = new Promise<ReturnType<typeof wt>>(r => { resolveFirst = r })
    let call = 0
    vi.spyOn(api, 'getGitWorktree').mockImplementation(() => {
      call += 1
      return call === 1 ? firstWt : Promise.resolve(wt('fresh.rs', 'DIFF-FRESH'))
    })

    render(<GitViewer sessionId="s1" />)

    // Wait until the worktree tab is actually active. The history tab ALSO has a
    // "Refresh" button, so key off the worktree-only "Files" header (rendered while
    // the first fetch is still pending, wt === null) to be sure we're on the right tab.
    await screen.findByText('Files')
    // fetch #1 (tab effect) is now pending. Tap the worktree Refresh → fetch #2 resolves
    // fast and paints the current worktree.
    fireEvent.click(screen.getByTitle('Refresh'))
    await waitFor(() => expect(screen.getByText('fresh.rs')).toBeInTheDocument())

    // The slow first fetch finally resolves — it must NOT clobber the fresh result.
    resolveFirst(wt('stale.rs', 'DIFF-STALE'))
    await waitFor(() => expect(screen.queryByText('stale.rs')).not.toBeInTheDocument())
    expect(screen.getByText('fresh.rs')).toBeInTheDocument()
  })
})
