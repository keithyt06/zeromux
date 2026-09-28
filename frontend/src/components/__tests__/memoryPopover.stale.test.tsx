import { render, screen, act, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import AcpChatView from '../AcpChatView'
import { installFakeWebSocket } from '../../test/fakeWs'
import * as api from '../../lib/api'
import type { CrewMemory } from '../../lib/api'

// Code analysis §6.2-7: the ⌘ memory popover's memReqRef guard had no test. Opening
// the popover fires a cold GET (slow on JuiceFS); a write made meanwhile updates the
// list optimistically. Without the guard the stale snapshot lands last and the
// just-written entry vanishes (the user re-adds it → duplicate).
describe('⌘ memory popover — stale cold GET does not clobber a fresh write', () => {
  const origWs = (globalThis as unknown as { WebSocket?: unknown }).WebSocket
  beforeEach(() => {
    vi.restoreAllMocks()
    installFakeWebSocket()
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
  })
  afterEach(() => { (globalThis as unknown as { WebSocket?: unknown }).WebSocket = origWs })

  it('keeps the new entry when the pre-write snapshot resolves after the write', async () => {
    let resolveCold!: (m: CrewMemory) => void
    vi.spyOn(api, 'getCrewMemory').mockImplementationOnce(() => new Promise(r => { resolveCold = r }))
    vi.spyOn(api, 'putCrewSemantic').mockResolvedValue(undefined as never)
    render(<AcpChatView sessionId="s1" active agentType="crew" />)
    await act(async () => { screen.getByLabelText('更多').click() })
    await act(async () => { screen.getByLabelText('memory').click() })   // cold GET now pending
    fireEvent.change(await screen.findByLabelText('memory draft'), { target: { value: 'pkg_manager = pnpm' } })
    await act(async () => { screen.getByText('记住').click() })
    expect(screen.getByText(/= pnpm/)).toBeInTheDocument()
    // The cold GET started before the write returns its old (empty) snapshot.
    await act(async () => {
      resolveCold({ preferences: '', projects: '', semantic: [], lessons: [], gateway_ok: true })
    })
    expect(screen.getByText(/= pnpm/)).toBeInTheDocument()
    expect(screen.queryByText('还没有记住任何偏好')).toBeNull()
  })

  it('opening the 「＋」 menu closes the memory popover (no stacked layers on the same anchor)', async () => {
    vi.spyOn(api, 'getCrewMemory').mockResolvedValue({ preferences: '', projects: '', semantic: [], lessons: [], gateway_ok: true })
    render(<AcpChatView sessionId="s1" active agentType="crew" />)
    await act(async () => { screen.getByLabelText('更多').click() })
    await act(async () => { screen.getByLabelText('memory').click() })
    expect(await screen.findByLabelText('memory draft')).toBeInTheDocument()
    await act(async () => { screen.getByLabelText('更多').click() })
    expect(screen.queryByLabelText('memory draft')).toBeNull()
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })
})
