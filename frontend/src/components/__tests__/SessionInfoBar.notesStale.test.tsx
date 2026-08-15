import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import SessionInfoBar from '../SessionInfoBar'
import * as api from '../../lib/api'
import type { SessionInfo, NoteEntry } from '../../lib/api'

// review 2026-08-15 (F-FE): SessionInfoBar.loadNotes committed
// `setNotes(data.notes)` unconditionally after `await listNotes`. The note
// input + delete buttons live INSIDE the panel that expand triggers loadNotes
// for, so a user can add/delete a note (optimistic setNotes) before the slow
// JuiceFS/S3 directory read resolves. The stale list (a pre-mutation snapshot)
// then resolves last and clobbers state: the added note vanishes / the deleted
// note reappears. Fix mirrors AgentDashboard's reqRef guard: bump at the top of
// loadNotes and before each optimistic write, drop superseded responses.
describe('SessionInfoBar notes stale-response race', () => {
  beforeEach(() => vi.restoreAllMocks())

  const session: SessionInfo = {
    id: 's1', name: 'sess', type: 'claude', cols: 80, rows: 24, work_dir: '/w',
    description: 'desc', status: 'running', running: true, turn_state: 'idle',
    turn_started_ms: null, last_activity_ms: 0, turns_completed: 0,
  }
  const note = (id: string, text: string): NoteEntry => ({
    id, work_dir: '/w', text, created_at: '2026-08-15T00:00:00Z',
    session_id: 's1', author: 'me', tags: [],
  })

  const renderBar = () => render(
    <SessionInfoBar
      session={session}
      onUpdate={() => {}}
      onToggleFiles={() => {}}
      onToggleGit={() => {}}
      onToggleEvents={() => {}}
      showFiles={false}
      showGit={false}
      showEvents={false}
    />,
  )

  it('optimistically-added note is not clobbered by a slow expand-time loadNotes', async () => {
    // listNotes (fired by expand) is SLOW and returns an empty pre-add snapshot.
    let resolveSlow: (v: { notes: NoteEntry[]; work_dir: string }) => void = () => {}
    const slowP = new Promise<{ notes: NoteEntry[]; work_dir: string }>(r => { resolveSlow = r })
    vi.spyOn(api, 'listNotes').mockReturnValue(slowP)
    vi.spyOn(api, 'createNote').mockResolvedValue(note('n1', 'fresh note'))

    renderBar()
    // Expand the info bar → fires the slow loadNotes (still pending).
    fireEvent.click(screen.getAllByRole('button')[0])
    const input = await screen.findByPlaceholderText('Add a note... (Enter to save)')

    // Add a note before loadNotes resolves → optimistic setNotes([note]).
    fireEvent.change(input, { target: { value: 'fresh note' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await screen.findByText('fresh note')

    // The slow list finally resolves with its EMPTY pre-add snapshot. It must NOT
    // wipe the note we just added and persisted.
    resolveSlow({ notes: [], work_dir: '/w' })
    await waitFor(() => expect(screen.getByText('fresh note')).toBeInTheDocument())
  })

  it('optimistically-deleted note is not resurrected by a slow expand-time loadNotes', async () => {
    // First expand: fast list with one note so it renders.
    vi.spyOn(api, 'listNotes').mockResolvedValueOnce({ notes: [note('n1', 'doomed note')], work_dir: '/w' })
    vi.spyOn(api, 'deleteNote').mockResolvedValue(undefined)

    renderBar()
    fireEvent.click(screen.getAllByRole('button')[0])
    await screen.findByText('doomed note')

    // Arrange a SECOND, slow loadNotes that still sees the note (pre-delete snapshot).
    let resolveSlow: (v: { notes: NoteEntry[]; work_dir: string }) => void = () => {}
    const slowP = new Promise<{ notes: NoteEntry[]; work_dir: string }>(r => { resolveSlow = r })
    ;(api.listNotes as unknown as ReturnType<typeof vi.fn>).mockReturnValue(slowP)
    // Collapse + re-expand to fire the slow loadNotes (pending).
    fireEvent.click(screen.getAllByRole('button')[0])
    fireEvent.click(screen.getAllByRole('button')[0])

    // Delete the note before the slow list resolves → optimistic removal.
    // The X delete button is hover-gated, so hover the row first, then click the
    // button scoped to that row.
    const noteRow = screen.getByText('doomed note').closest('.group') as HTMLElement
    fireEvent.mouseEnter(noteRow)
    fireEvent.click(within(noteRow).getByRole('button'))
    await waitFor(() => expect(screen.queryByText('doomed note')).not.toBeInTheDocument())

    // Slow list resolves with its pre-delete snapshot — must NOT resurrect the row.
    resolveSlow({ notes: [note('n1', 'doomed note')], work_dir: '/w' })
    await waitFor(() => expect(screen.queryByText('doomed note')).not.toBeInTheDocument())
  })
})
