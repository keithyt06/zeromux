import { render, screen, act, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import AcpChatView from '../AcpChatView'
import MemoryPanel from '../MemoryPanel'
import { installFakeWebSocket } from '../../test/fakeWs'
import type { CrewMemory } from '../../lib/api'
import { mdLines } from '../../lib/crewMemory'

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
    // V8: ⌘ 记忆收进输入框内「＋」菜单 —— 先开菜单。
    await act(async () => { screen.getByLabelText('更多').click() })
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
    // V8: ⌘ 记忆收进输入框内「＋」菜单 —— 先开菜单。
    await act(async () => { screen.getByLabelText('更多').click() })
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
    // V8: ⌘ 记忆收进输入框内「＋」菜单 —— 先开菜单。
    await act(async () => { screen.getByLabelText('更多').click() })
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

// T15-d 记忆面板（第 5 个 overlay view）。这一组全部是**面板级**断言 —— mdLines /
// dropMdLine 的纯函数行为已由 lib/__tests__/crewMemory.test.ts 的 T15-b 钉死，这里
// 测的是 MemoryPanel 有没有真的用上它们（历史上「纯函数对了但组件没接」的失败模式
// 表现为面板把 markdown 骨架列成可删行，或删错行后整文件 PUT 不可逆）。
describe('T15-d 记忆面板', () => {
  const origFetch = globalThis.fetch
  beforeEach(() => { vi.restoreAllMocks() })
  afterEach(() => { globalThis.fetch = origFetch })

  /** 拦 fetch 而不是 mock api.ts：约束在于**发出的 HTTP 形状**（哪个 doc、body 是什么）。 */
  const fetchMemory = (mem: CrewMemory) => {
    const calls: { url: string; init?: RequestInit }[] = []
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      calls.push({ url, init })
      const isGet = !init?.method || init.method === 'GET'
      return new Response(JSON.stringify(isGet ? mem : { ok: true }),
        { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch
    return calls
  }

  it('全空时空状态本身就是写入表单（不是一块「暂无数据」）', async () => {
    fetchMemory(memory())
    render(<MemoryPanel />)
    expect(await screen.findByText('它还什么都没记住')).toBeInTheDocument()
    const input = screen.getByPlaceholderText('例：提交前必须先跑 npm test')
    // iOS Safari 在 <16px 的输入框聚焦时会放大整页，把按钮挤出视口 → 必须 text-base(16px)。
    expect(input.className).toMatch(/text-base/)
    const btn = screen.getByText('记住这条')
    expect(btn.className).toMatch(/min-h-\[44px\]/)
  })

  it('markdown 骨架不算记忆：56 字节的 preferences.md 仍是空态，而不是「已记 2 条」', async () => {
    // 实测 preferences.md 只有一个标题 + 一行 HTML 注释。若面板把它们列成可删行，
    // 用户会误以为已经记了两条，点删则删掉文件结构（PUT 是整文件覆盖，不可逆）。
    fetchMemory(memory())
    render(<MemoryPanel />)
    expect(await screen.findByText('它还什么都没记住')).toBeInTheDocument()
    expect(screen.queryByText(/User Preferences/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Active Projects/)).not.toBeInTheDocument()
    expect(screen.queryByText(/偏好/)).not.toBeInTheDocument()
  })

  it('删 markdown 行按过滤后下标映射回原始行号，整文件 PUT 保留骨架', async () => {
    const calls = fetchMemory(memory({
      preferences: '# User Preferences\n\n<!-- note -->\n- 用 pnpm\n- 提交前跑测试\n',
    }))
    render(<MemoryPanel />)
    // ✕ 常驻（绝不 group-hover：Tailwind v4 把它编进 @media (hover:hover)，
    // 手机上元素永久 opacity:0 但仍可点击 = 隐形按钮）。
    const x = await screen.findByLabelText('remove - 提交前跑测试')
    expect(x.className).not.toMatch(/opacity-0|group-hover/)
    // 二段确认：第一下只展开确认行，不发请求（破坏性操作不用 window.confirm）。
    await act(async () => { x.click() })
    expect(calls.some(c => c.init?.method === 'PUT')).toBe(false)
    await act(async () => { screen.getByTestId('mem-remove-confirm').click() })

    const put = await waitFor(() => {
      const c = calls.find(c => c.init?.method === 'PUT')
      if (!c) throw new Error('no PUT yet')
      return c
    })
    expect(put.url).toBe('/api/crew/memory/preferences')
    const body = JSON.parse(put.init!.body as string) as { content: string }
    // 删的是**过滤后**第 1 条（「提交前跑测试」）；按原始行号 1 会删掉空行、留下两条。
    expect(mdLines(body.content)).toEqual(['- 用 pnpm'])
    expect(body.content).toContain('# User Preferences')
    expect(body.content).toContain('<!-- note -->')
  })

  it('gateway_ok:false 显示黄色降级条，而不是「它还什么都没记住」（两者含义完全不同）', async () => {
    fetchMemory(memory({ gateway_ok: false }))
    render(<MemoryPanel />)
    expect(await screen.findByText(/Gateway 未响应/)).toBeInTheDocument()
    // 读不到 ≠ 真的空。此时显示空态写入表单，用户会以为记忆被清空（而且写必然失败）。
    expect(screen.queryByText('它还什么都没记住')).not.toBeInTheDocument()
  })
})
