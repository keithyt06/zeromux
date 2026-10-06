import { render, screen, act, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import AcpChatView from '../AcpChatView'
import { Toaster } from '../ui'
import { installFakeWebSocket } from '../../test/fakeWs'

describe('记为约定 (F4)', () => {
  const origWs = (globalThis as unknown as { WebSocket?: unknown }).WebSocket
  let ws: ReturnType<typeof installFakeWebSocket>
  beforeEach(() => {
    vi.restoreAllMocks()
    ws = installFakeWebSocket()
    globalThis.fetch = vi.fn(async () => new Response('{"runs":[],"lifetime":{"turns":0,"duration_ms":0,"cost_usd":0}}', { status: 200 })) as unknown as typeof fetch
  })
  afterEach(() => { (globalThis as unknown as { WebSocket?: unknown }).WebSocket = origWs })

  const openDialog = async () => {
    await act(async () => { screen.getByLabelText('更多').click() })
    await act(async () => { screen.getByRole('menuitem', { name: '记为约定…' }).click() })
    return await screen.findByLabelText('约定内容') as HTMLTextAreaElement
  }

  for (const agentType of ['claude', 'codex', 'crew'] as const) {
    it(`${agentType}: ＋ menu offers 记为约定…`, async () => {
      render(<AcpChatView sessionId="s1" active agentType={agentType} />)
      await act(async () => { screen.getByLabelText('更多').click() })
      expect(screen.getByRole('menuitem', { name: '记为约定…' })).toBeInTheDocument()
    })
  }

  it('prefills from the last own prompt and sends the template without attachments', async () => {
    render(<><AcpChatView sessionId="s1" active agentType="claude" /><Toaster /></>)
    act(() => { ws.latest().fireOpen() })
    await act(async () => { ws.latest().emit({ type: 'user_prompt', text: '以后都用 pnpm', turn_id: 1 }) })
    const box = await openDialog()
    expect(box.value).toBe('以后都用 pnpm')
    fireEvent.change(box, { target: { value: '包管理一律用 pnpm' } })
    await act(async () => { screen.getByRole('button', { name: '发送给 agent' }).click() })
    const sent = ws.latest().sent.map(s => JSON.parse(s)).filter(m => m.type === 'prompt')
    expect(sent).toHaveLength(1)
    expect(sent[0].text).toContain('约定：包管理一律用 pnpm')
    expect(sent[0].text).not.toContain('[用户上传了以下文件')
    expect(screen.getByText('已交给 agent 记录')).toBeInTheDocument()
    expect(screen.queryByLabelText('约定内容')).toBeNull()
  })

  it('socket not open → toast, dialog stays open with the text', async () => {
    render(<><AcpChatView sessionId="s1" active agentType="claude" /><Toaster /></>)
    ws.latest().readyState = 3
    const box = await openDialog()
    fireEvent.change(box, { target: { value: '不要改 CI 配置' } })
    await act(async () => { screen.getByRole('button', { name: '发送给 agent' }).click() })
    expect(screen.getByText('未连接，稍后再试')).toBeInTheDocument()
    expect((screen.getByLabelText('约定内容') as HTMLTextAreaElement).value).toBe('不要改 CI 配置')
  })

  it('buttons are ≥44px touch targets on coarse pointers', async () => {
    render(<AcpChatView sessionId="s1" active agentType="claude" />)
    await openDialog()
    for (const name of ['取消', '发送给 agent']) {
      const b = screen.getByRole('button', { name })
      // Unlayered `.ctl` (min-height: --ctl-h) beats Tailwind's @layer utilities, so `ctl` must be absent (jsdom has no cascade).
      expect(b).toHaveClass('min-h-[var(--hit)]')
      expect(b).not.toHaveClass('ctl')
    }
  })

  it('blank text cannot be sent', async () => {
    render(<AcpChatView sessionId="s1" active agentType="claude" />)
    await openDialog()
    expect(screen.getByRole('button', { name: '发送给 agent' })).toBeDisabled()
  })
})
