import { render, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import WaitingPage from '../WaitingPage'

const user = { id: 'u1', login: 'octo', role: 'user', status: 'pending', avatar: null }
const setVis = (v: DocumentVisibilityState) =>
  Object.defineProperty(document, 'visibilityState', { value: v, configurable: true })
const me = (status: string) =>
  new Response(JSON.stringify({ ...user, status }), { status: 200, headers: { 'Content-Type': 'application/json' } })

describe('WaitingPage approval poll', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    vi.useFakeTimers()
    setVis('visible')
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    setVis('visible')
  })

  it('calls onStatusChange once when /api/me flips from pending to active', async () => {
    fetchMock.mockResolvedValueOnce(me('pending')).mockResolvedValue(me('active'))
    const onStatusChange = vi.fn()
    render(<WaitingPage user={user} onStatusChange={onStatusChange} onLogout={() => {}} />)
    // usePolling fires immediately on mount → pending, no approval yet.
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/me')
    expect(onStatusChange).not.toHaveBeenCalled()
    // Next 5s tick → active → approved exactly once.
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(onStatusChange).toHaveBeenCalledTimes(1)
  })

  it('issues no requests while the page is hidden', async () => {
    fetchMock.mockResolvedValue(me('pending'))
    setVis('hidden')
    render(<WaitingPage user={user} onStatusChange={() => {}} onLogout={() => {}} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
