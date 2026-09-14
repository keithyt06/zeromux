import { render, screen, act, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import AcpChatView from '../AcpChatView'
import { installFakeWebSocket } from '../../test/fakeWs'
import type { CrewMemory } from '../../lib/api'

// T15:前两条约束由 zeromux 后端代理承担(浏览器不该持 Gateway token,也无法
// 跨源),所以前端侧的断言是「打的是代理端点、路径不带 key」。
//
// 关键手法:**拦 globalThis.fetch 而不是 mock api.ts** —— 约束在于发出的 HTTP
// 形状(路径带不带 key、有没有 X-Session-Key),mock 掉 api 层就什么都测不到了。
const memory = (over: Partial<CrewMemory> = {}): CrewMemory => ({
  preferences: '# User Preferences\n\n<!-- Learned from conversations -->\n',
  projects: '# Active Projects\n\n<!-- Current work context -->\n',
  semantic: [], lessons: [], gateway_ok: true, ...over,
})

describe('T15-c 走代理端点：路径不带 key，凭证不进前端', () => {
  const origWs = (globalThis as unknown as { WebSocket?: unknown }).WebSocket
  const origFetch = globalThis.fetch
  beforeEach(() => { vi.restoreAllMocks(); installFakeWebSocket() })
  afterEach(() => {
    (globalThis as unknown as { WebSocket?: unknown }).WebSocket = origWs
    globalThis.fetch = origFetch
  })

  const captureFetch = () => {
    const calls: { url: string; init?: RequestInit }[] = []
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      calls.push({ url, init })
      const isGet = !init?.method || init.method === 'GET'
      const body = url.includes('/api/crew/memory') && isGet ? memory() : { ok: true }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch
    return calls
  }

  it('composer 的「记住」PUT 到 /api/crew/memory/semantic —— 路径不带 key', async () => {
    const calls = captureFetch()
    render(<AcpChatView sessionId="s1" active agentType="crew" />)
    await act(async () => { screen.getByLabelText('memory').click() })
    const input = await screen.findByLabelText('memory draft')
    // 受控 input:必须走 fireEvent.change(React 合成事件),直接 dispatch 原生
    // input 事件不会触发 onChange,value 会被下一次 render 还原(实测撞到)。
    fireEvent.change(input, { target: { value: 'pkg_manager = pnpm' } })
    await act(async () => { screen.getByText('记住').click() })

    const put = await waitFor(() => {
      const c = calls.find(c => c.init?.method === 'PUT')
      if (!c) throw new Error('no PUT yet')
      return c
    })
    // 约束 1:key 只在 body 里,路径就是 .../semantic,末尾没有 /pref.xxx。
    expect(put.url).toBe('/api/crew/memory/semantic')
    expect(put.url).not.toMatch(/semantic\/.+/)
    // 约束 3:body 的 key 带前缀。source/confidence 是 Gateway 必需字段。
    expect(JSON.parse(put.init!.body as string)).toEqual({
      key: 'pref.pkg_manager', value: 'pnpm', source: 'user_explicit', confidence: 1.0,
    })
    // 约束 2:X-Session-Key / Gateway token 都**不**出现在前端请求里 —— 由后端补。
    const headers = (put.init!.headers ?? {}) as Record<string, string>
    expect(Object.keys(headers).map(h => h.toLowerCase())).not.toContain('x-session-key')
    expect(put.url).not.toContain('token=')
  })

  it('删除走 DELETE /api/crew/memory/semantic/{key}（这一侧路径**要**带 key），且二段确认', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      calls.push({ url, init })
      const isGet = !init?.method || init.method === 'GET'
      return new Response(JSON.stringify(isGet ? memory({
        semantic: [{
          key: 'pref.pkg_manager', value_json: '"pnpm"', confidence: 1.0,
          source: 'user_explicit', created_at: '2026-09-13T00:00:00Z',
          updated_at: '2026-09-13T00:00:00Z', is_deleted: 0,
        }],
      }) : { ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch

    render(<AcpChatView sessionId="s1" active agentType="crew" />)
    await act(async () => { screen.getByLabelText('memory').click() })
    // 最近 5 条直接可见(0 tap),✕ 常驻(不用 group-hover:手机上会变隐形按钮)。
    const x = await screen.findByTestId('mem-forget')
    expect(x.className).not.toMatch(/opacity-0|group-hover/)
    // 二段确认:第一下只展开确认行,不发请求。
    await act(async () => { x.click() })
    expect(calls.some(c => c.init?.method === 'DELETE')).toBe(false)
    await act(async () => { screen.getByTestId('mem-forget-confirm').click() })
    await waitFor(() => expect(calls.some(c =>
      c.init?.method === 'DELETE' && c.url === '/api/crew/memory/semantic/pref.pkg_manager')).toBe(true))
  })

  it('写入成功后在对话流留一行回执（可见性靠回执，不靠面板）', async () => {
    captureFetch()
    render(<AcpChatView sessionId="s1" active agentType="crew" />)
    await act(async () => { screen.getByLabelText('memory').click() })
    const input = await screen.findByLabelText('memory draft')
    fireEvent.change(input, { target: { value: '提交前必须先跑 npm test' } })
    await act(async () => { screen.getByText('记住').click() })
    expect(await screen.findByText('已记住：提交前必须先跑 npm test')).toBeInTheDocument()
  })

  it('非 Crew 会话没有记忆按钮（宽度预算只给 Crew）', () => {
    captureFetch()
    render(<AcpChatView sessionId="s2" active agentType="claude" />)
    expect(screen.queryByLabelText('memory')).not.toBeInTheDocument()
  })
})
