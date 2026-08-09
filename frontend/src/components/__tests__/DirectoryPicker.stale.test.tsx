import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import DirectoryPicker from '../DirectoryPicker'
import * as api from '../../lib/api'
import type { DirListing } from '../../lib/api'

// review 2026-08-09: loadDirs wrote currentPath/dirs unconditionally after
// `await listDirectories`. On the JuiceFS/S3 FS a listing can take seconds (8s
// abort), and the nav buttons stay clickable while loading, so tapping folder A
// (slow) then `..` (fast) let the parent listing land, then A's stale listing
// overwrite it — and currentPath is committed as work_dir via onSelect, so the
// session/scheduled task would run in the wrong directory. The fix drops writes
// from a superseded request (dirReqRef token).
describe('DirectoryPicker stale-response race', () => {
  beforeEach(() => vi.restoreAllMocks())

  // home is /home; use non-home paths for current/parent so the picker renders the
  // literal path (it collapses a home-prefixed currentPath to "~", which would make
  // a getByText('/home') assertion miss).
  const listing = (current: string, parent: string | null, entries: string[]): DirListing => ({
    current,
    parent,
    home: '/home',
    entries: entries.map(name => ({ name, path: `${current}/${name}`, is_git: false })),
  })

  it('a slow navigation cannot overwrite the newer listing that committed as work_dir', async () => {
    // During a slow load the dir-entry buttons are replaced by "加载中…", but the
    // parent "…" button stays visible and clickable (it uses parentPath from the
    // pre-navigation listing). So the reachable race is: tap a slow child, then tap
    // "…" (fast) — the parent listing lands, then the slow child's listing must NOT
    // clobber it. currentPath is what "使用此目录" commits as work_dir.
    let resolveSlow: (v: DirListing) => void = () => {}
    const slowP = new Promise<DirListing>(r => { resolveSlow = r })
    vi.spyOn(api, 'listDirectories').mockImplementation((path?: string) => {
      if (path === '/srv/root/slow') return slowP                                       // slow child
      if (path === '/srv') return Promise.resolve(listing('/srv', null, []))            // fast parent
      return Promise.resolve(listing('/srv/root', '/srv', ['slow']))                    // initial
    })

    const onSelect = vi.fn()
    render(<DirectoryPicker initialPath="/srv/root" onSelect={onSelect} onCancel={() => {}} />)

    // Initial listing (/srv/root) shows the child button and the parent "…" nav.
    ;(await screen.findByText('slow')).click()  // slow child listing is now pending
    // The parent ".." button stays rendered during loading — tap it; /srv is fast.
    ;(await screen.findByText('..')).click()
    await waitFor(() => expect(screen.getByText('/srv')).toBeInTheDocument())

    // The slow child listing finally resolves — it must NOT clobber /srv.
    resolveSlow(listing('/srv/root/slow', '/srv/root', []))
    await waitFor(() => expect(screen.queryByText('/srv/root/slow')).not.toBeInTheDocument())
    expect(screen.getByText('/srv')).toBeInTheDocument()

    // Committing "use this directory" must send /srv, not the stale /srv/root/slow.
    screen.getByText('使用此目录').click()
    expect(onSelect).toHaveBeenCalledWith('/srv')
    expect(onSelect).not.toHaveBeenCalledWith('/srv/root/slow')
  })
})
