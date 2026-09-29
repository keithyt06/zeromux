import { render, screen, act, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import AcpChatView from '../AcpChatView'
import * as api from '../../lib/api'
import { installFakeWebSocket } from '../../test/fakeWs'
import type { SessionControls } from '../../lib/sessionControls'

// A7: a prompt sent into this session from elsewhere (SendToMenu / TriageRow) must not
// carry off — or clear — the attachments waiting in this session's composer.
describe('SessionControls.sendPrompt attachments (A7)', () => {
  const origWs = (globalThis as unknown as { WebSocket?: unknown }).WebSocket
  let ws: ReturnType<typeof installFakeWebSocket>
  let controls: SessionControls | null = null
  beforeEach(() => {
    vi.restoreAllMocks()
    ws = installFakeWebSocket()
    controls = null
    globalThis.fetch = vi.fn(async () => new Response('{"runs":[],"lifetime":{"turns":0,"duration_ms":0,"cost_usd":0}}', { status: 200 })) as unknown as typeof fetch
    vi.spyOn(api, 'uploadSessionFile').mockResolvedValue('/w/uploads/shot.png')
  })
  afterEach(() => { (globalThis as unknown as { WebSocket?: unknown }).WebSocket = origWs })

  const mountWithAttachment = async () => {
    const { container } = render(<AcpChatView sessionId="s1" active agentType="claude" onRegisterControls={(_, c) => { controls = c }} />)
    act(() => { ws.latest().fireOpen() })
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    await act(async () => { fireEvent.change(input, { target: { files: [new File(['x'], 'shot.png')] } }) })
    await waitFor(() => expect(screen.getByLabelText('remove /w/uploads/shot.png')).toBeInTheDocument())
  }
  const lastPrompt = () => JSON.parse(ws.latest().sent.filter(s => s.includes('"prompt"')).pop()!).text as string

  it('{ withAttachments: false } sends only the text and leaves the pending attachment', async () => {
    await mountWithAttachment()
    act(() => { controls!.sendPrompt('from elsewhere', { withAttachments: false }) })
    expect(lastPrompt()).toBe('from elsewhere')
    expect(screen.getByLabelText('remove /w/uploads/shot.png')).toBeInTheDocument()
  })
  it('default still attaches and clears (composer path unchanged)', async () => {
    await mountWithAttachment()
    act(() => { controls!.sendPrompt('mine') })
    expect(lastPrompt()).toContain('/w/uploads/shot.png')
    await waitFor(() => expect(screen.queryByLabelText('remove /w/uploads/shot.png')).toBeNull())
  })
})
