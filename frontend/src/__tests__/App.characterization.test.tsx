// Characterization of the current App shell (spec §0.5 I-1/I-2/I-3/I-17/I-18).
// This file is a contract: the Task 11 AppShell must pass it UNCHANGED, so it
// locates things only by visible text / role / aria-label / data-session-pane.
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { setupApp, mkSession } from '../test/appHarness'
import { xtermInstances } from '../test/xtermMock'
import * as api from '../lib/api'
import App from '../App'

vi.mock('@xterm/xterm', async () => (await import('../test/xtermMock')).xtermModule)
vi.mock('@xterm/addon-fit', async () => (await import('../test/xtermMock')).fitModule)
vi.mock('@xterm/addon-webgl', async () => (await import('../test/xtermMock')).webglModule)
vi.mock('@xterm/addon-search', async () => (await import('../test/xtermMock')).searchModule)
vi.mock('@xterm/addon-clipboard', async () => (await import('../test/xtermMock')).clipboardModule)

const pane = (id: string) => document.querySelector(`[data-session-pane="${id}"]`) as HTMLElement | null
const activePane = () => document.querySelector('[data-session-pane][data-active="1"]')?.getAttribute('data-session-pane')

async function boot(sessions = [mkSession('a'), mkSession('b', { type: 'tmux', tmux_name: 'zmx-b', tmux_origin: 'own' })]) {
  const h = setupApp({ sessions })
  render(<App />)
  await waitFor(() => expect(pane(sessions[0].id)).not.toBeNull())
  return h
}

async function selectSession(name: string) {
  // Works for both the old Sidebar row and the new TriageRow: both render the session name as clickable text.
  fireEvent.click((await screen.findAllByText(name))[0])
}

describe('App characterization', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.useFakeTimers({ shouldAdvanceTime: true })
    xtermInstances.length = 0
    history.replaceState(null, '', '/')
    localStorage.clear()
  })
  afterEach(() => { vi.useRealTimers() })

  describe('I-1 switching keeps views mounted', () => {
    it('switching sessions does not recreate xterm nor reconnect WS', async () => {
      const h = await boot()
      const wsBefore = h.ws.all.length
      const termBefore = xtermInstances.length
      await selectSession('s-b')
      await waitFor(() => expect(activePane()).toBe('b'))
      await selectSession('s-a')
      await waitFor(() => expect(activePane()).toBe('a'))
      expect(h.ws.all.length).toBe(wsBefore)
      expect(xtermInstances.length).toBe(termBefore)
      expect(pane('b')).not.toBeNull()   // hidden, still mounted
    })
  })

  describe('I-2 poll never moves focus', () => {
    it('a poll that reorders / prepends sessions keeps activeId', async () => {
      const h = await boot()
      await selectSession('s-b')
      await waitFor(() => expect(activePane()).toBe('b'))
      h.setSessions([mkSession('z', { last_activity_ms: 999 }), mkSession('b', { type: 'tmux', tmux_name: 'zmx-b', tmux_origin: 'own' }), mkSession('a')])
      await act(async () => { vi.advanceTimersByTime(3100) })
      await waitFor(() => expect(pane('z')).not.toBeNull())
      expect(activePane()).toBe('b')
    })
  })

  describe('I-3 auth errors', () => {
    it('poll 5xx keeps the user in; poll 401 logs out', async () => {
      const h = await boot()
      h.list.mockRejectedValueOnce(new api.ApiError(503))
      await act(async () => { vi.advanceTimersByTime(3100) })
      expect(pane('a')).not.toBeNull()
      h.list.mockRejectedValue(new api.ApiError(401))
      await act(async () => { vi.advanceTimersByTime(3100) })
      await waitFor(() => expect(pane('a')).toBeNull())
      await waitFor(() => expect(document.querySelector('input[type="password"]')).not.toBeNull())
    })
  })

  describe('I-17 deep links', () => {
    it('?session= selects that session on startup', async () => {
      history.replaceState(null, '', '/?session=b')
      await boot()
      await waitFor(() => expect(activePane()).toBe('b'))
    })
  })

  describe('I-18 undo close toast', () => {
    it('closing shows an undo toast that ends ~500ms before pending_until', async () => {
      const h = await boot([mkSession('a'), mkSession('c')])
      const now = Date.now()
      h.del.mockResolvedValue({ pending_until: now + 5000 })
      // Old UI: row ⋯ → 关闭. New UI (Task 11): same aria-label + same item label.
      fireEvent.click(screen.getAllByRole('button', { name: '会话菜单' })[0])
      fireEvent.click(await screen.findByRole('menuitem', { name: '关闭' }))
      expect(await screen.findByText(/已关闭/)).toBeInTheDocument()
      await act(async () => { vi.advanceTimersByTime(4400) })
      expect(screen.queryByText(/已关闭/)).not.toBeNull()
      await act(async () => { vi.advanceTimersByTime(300) })
      await waitFor(() => expect(screen.queryByText(/已关闭/)).toBeNull())
    })
  })
})
