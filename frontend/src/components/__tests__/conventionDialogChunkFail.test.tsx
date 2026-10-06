import { render, screen, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { installFakeWebSocket } from '../../test/fakeWs'

// Review I1: a failed ConventionDialog chunk load (post-deploy 404, already reloaded
// once this tab) must stay local to the dialog — not bubble to App's boundary.
describe('记为约定 chunk load failure', () => {
  const origWs = (globalThis as unknown as { WebSocket?: unknown }).WebSocket
  beforeEach(() => {
    vi.resetModules()
    installFakeWebSocket()
    globalThis.fetch = vi.fn(async () => new Response('{"runs":[],"lifetime":{"turns":0,"duration_ms":0,"cost_usd":0}}', { status: 200 })) as unknown as typeof fetch
    sessionStorage.setItem('zmx_chunk_reload', '1') // reloadOnceForStaleChunk refuses → error is thrown
    vi.doMock('../composer/ConventionDialog', () => { throw new Error('chunk 404') })
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.doUnmock('../composer/ConventionDialog')
    sessionStorage.clear()
    vi.restoreAllMocks()
    ;(globalThis as unknown as { WebSocket?: unknown }).WebSocket = origWs
  })

  it('keeps AcpChatView and the composer mounted', async () => {
    const { default: AcpChatView } = await import('../AcpChatView')
    render(<AcpChatView sessionId="s1" active agentType="claude" />)
    await act(async () => { screen.getByLabelText('更多').click() })
    await act(async () => { screen.getByRole('menuitem', { name: '记为约定…' }).click() })
    expect(await screen.findByRole('button', { name: /出错了/ })).toBeInTheDocument()
    expect(screen.queryByLabelText('约定内容')).toBeNull()
    expect(screen.getByLabelText('更多')).toBeInTheDocument()
    expect(screen.getByRole('textbox')).toBeInTheDocument()
  })

  it('the boundary button dismisses it (lazy caches the rejection; closing, not retry)', async () => {
    const { default: AcpChatView } = await import('../AcpChatView')
    render(<AcpChatView sessionId="s1" active agentType="claude" />)
    await act(async () => { screen.getByLabelText('更多').click() })
    await act(async () => { screen.getByRole('menuitem', { name: '记为约定…' }).click() })
    const btn = await screen.findByRole('button', { name: /出错了/ })
    await act(async () => { btn.click() })
    expect(screen.queryByRole('button', { name: /出错了/ })).toBeNull()
    expect(screen.getByLabelText('更多')).toBeInTheDocument()
    expect(screen.getByRole('textbox')).toBeInTheDocument()
  })
})
