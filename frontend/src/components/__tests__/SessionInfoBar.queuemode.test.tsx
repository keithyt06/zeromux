import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import SessionInfoBar from '../SessionInfoBar'
import type { SessionInfo } from '../../lib/api'

// Notes only load when the panel is expanded; stub the api so the mount is inert.
vi.mock('../../lib/api', () => ({
  updateSession: vi.fn(),
  listNotes: vi.fn().mockResolvedValue({ notes: [] }),
  createNote: vi.fn(),
  deleteNote: vi.fn(),
}))

const session: SessionInfo = {
  id: 's1', name: 'agent', type: 'claude', cols: 80, rows: 24, work_dir: '/w',
  description: '', status: 'running', running: true, turn_state: 'running',
  turn_started_ms: null, last_activity_ms: 0, turns_completed: 0,
}

// The queue dropdown lives inside the collapsed details panel — expand it first.
function expandPanel() {
  // The header toggle is the first button; clicking it flips `expanded`.
  fireEvent.click(screen.getAllByRole('button')[0])
}

describe('SessionInfoBar queue-mode dropdown (review 2026-07-28, F-OBS-LIVE follow-through)', () => {
  it('is a CONTROLLED reflection of the backend-authoritative queueMode prop', () => {
    // The bug: the dropdown used a local useState('collect') never synced from the
    // backend, so an observer/reconnected tab showed 'Collect' while the backend was
    // 'Interrupt' → a send would silently interrupt the running turn. Now the prop is
    // the single source of truth.
    render(
      <SessionInfoBar
        session={session}
        onUpdate={() => {}}
        onToggleFiles={() => {}}
        onToggleGit={() => {}}
        onToggleEvents={() => {}}
        showFiles={false}
        showGit={false}
        showEvents={false}
        onQueueMode={() => {}}
        queueMode="interrupt"
      />,
    )
    expandPanel()
    const select = screen.getByTitle('多条消息同时在途时如何处理') as HTMLSelectElement
    expect(select.value).toBe('interrupt')
  })

  it('changing the dropdown calls onQueueMode and does NOT locally override the prop', () => {
    // Controlled: the local value must track the prop, not a private mirror. If the
    // WS send is dropped, App never updates queueMode and the dropdown snaps back to
    // the real mode — no split-brain (the prop+useState footgun codex flagged).
    const onQueueMode = vi.fn()
    const { rerender } = render(
      <SessionInfoBar
        session={session}
        onUpdate={() => {}}
        onToggleFiles={() => {}}
        onToggleGit={() => {}}
        onToggleEvents={() => {}}
        showFiles={false}
        showGit={false}
        showEvents={false}
        onQueueMode={onQueueMode}
        queueMode="collect"
      />,
    )
    expandPanel()
    const select = screen.getByTitle('多条消息同时在途时如何处理') as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'interrupt' } })
    expect(onQueueMode).toHaveBeenCalledWith('interrupt')
    // No local mirror: since the parent prop hasn't changed yet, the controlled
    // select still shows the authoritative 'collect'.
    expect(select.value).toBe('collect')
    // When the parent adopts the delivered mode, the dropdown follows.
    rerender(
      <SessionInfoBar
        session={session}
        onUpdate={() => {}}
        onToggleFiles={() => {}}
        onToggleGit={() => {}}
        onToggleEvents={() => {}}
        showFiles={false}
        showGit={false}
        showEvents={false}
        onQueueMode={onQueueMode}
        queueMode="interrupt"
      />,
    )
    expect(select.value).toBe('interrupt')
  })
})
