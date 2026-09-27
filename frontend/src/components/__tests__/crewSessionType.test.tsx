import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import QuickTargets from '../QuickTargets'
import MobileKeyBar from '../MobileKeyBar'
import AcpChatView from '../AcpChatView'
import * as api from '../../lib/api'
import { coerceAgent } from '../../lib/quickTargets'
import { launchSequence } from '../../lib/terminalInput'
import type { QuickTarget } from '../../lib/api'
import { installFakeWebSocket } from '../../test/fakeWs'

// T13:每加/换一个 SessionType，八处映射都必须跟着改。历史上漏一处的表现是
// 「会话能建但列表里图标是终端」或「composer 说 Send a message to Claude」——
// 都不报错，只是静默错。因此逐处断言，而不是只断言类型定义。
//
// 八处（文件:行号，改动前）：
//   1. api.ts:1                 SessionType 联合类型
//   2. Sidebar.tsx:69-77        SessionTypeIcon
//   3. QuickTargets.tsx:11-20   RowIcon
//   4. AcpChatView.tsx:57       agentType
//   5. MobileKeyBar.tsx:18-22   AGENT_KEYS
//   6. lib/quickTargets.ts:6    AGENTS 白名单（spec 漏列）
//   7. lib/terminalInput.ts:81  AgentKey / LAUNCH（spec 漏列）
//   8. TerminalView.tsx:128     虚拟键盘分派（spec 漏列）
describe('T13 crew 八处类型映射不漏', () => {
  const origWs = (globalThis as unknown as { WebSocket?: unknown }).WebSocket
  beforeEach(() => { vi.restoreAllMocks(); installFakeWebSocket() })
  afterEach(() => { (globalThis as unknown as { WebSocket?: unknown }).WebSocket = origWs })

  const src = (rel: string) => readFileSync(resolve(__dirname, '../../', rel), 'utf8')

  it('① api.ts 的 SessionType 含 crew 且不再含 kiro', () => {
    // Task 6 把 SessionType 的声明移到 lib/api/sessions.ts；lib/api.ts 现在只做
    // `export * from './api/sessions'` 聚合，不再含这行文本。
    const t = src('lib/api/sessions.ts')
    const line = t.split('\n').find(l => l.startsWith('export type SessionType'))!
    expect(line).toContain("'crew'")
    // Task 11 之后这条才该绿；Task 6 时它是本任务的「先验红」之一。
    expect(line).not.toContain("'kiro'")
    // 白名单（QuickTargets 用它把库里的脏字符串收敛）必须同步，否则历史 kiro 行
    // 与新 crew 行都会掉进「未知类型」分支。
    expect(coerceAgent('crew')).toBe('crew')
    expect(coerceAgent('kiro')).toBeNull()
  })

  it('② Sidebar 的 SessionTypeIcon 有 crew 分支，类型菜单仍是 4 项', () => {
    const t = src('components/Sidebar.tsx')
    expect(t).toMatch(/case 'crew':\s*return <CrewIcon/)
    expect(t).toContain('Kiro Crew')
    expect(t).toContain("selectType('crew')")
    expect(t).not.toContain("selectType('kiro')")
    expect(t.match(/selectType\('(tmux|claude|crew|codex)'\)/g)?.length).toBe(4)
  })

  it('③ QuickTargets 的 RowIcon 用 CrewIcon 渲染 crew 行', async () => {
    vi.spyOn(api, 'listQuickTargets').mockResolvedValue({
      top: [{ kind: 'dir', path: '/w/a', agent: 'crew', display: 'a', hint: '~' } as QuickTarget],
    })
    render(<QuickTargets kind="dir" onPick={() => {}} />)
    await screen.findByText('a')
    // CrewIcon 的 <title> 是它唯一稳定的可断言标识（SVG path 会变）。
    expect(screen.getByTitle('Kiro Crew')).toBeInTheDocument()
  })

  it('③b crew 行点一下直接带 crew 类型创建，不掉进 onChangeAgent（第 6 处映射）', async () => {
    // 这条覆盖 AGENTS 白名单 —— 唯一一处漏了会让「日常 90% 路径」直接坏掉的地方：
    // crew 行被判为脏值 → 走 onChangeAgent → 用户每次都得重选类型。
    vi.spyOn(api, 'listQuickTargets').mockResolvedValue({
      top: [{ kind: 'dir', path: '/w/a', agent: 'crew', display: 'a', hint: '~' } as QuickTarget],
    })
    const onPick = vi.fn()
    const onChangeAgent = vi.fn()
    render(<QuickTargets kind="dir" onPick={onPick} onChangeAgent={onChangeAgent} />)
    ;(await screen.findByText('a')).click()
    expect(onPick).toHaveBeenCalledWith('/w/a', 'crew')
    expect(onChangeAgent).not.toHaveBeenCalled()
  })

  it('④ AcpChatView 的 agentType 接受 crew，且文案说 Crew', () => {
    render(<AcpChatView sessionId="s1" active={false} agentType="crew" />)
    expect(screen.getByPlaceholderText('Send a message to Crew...')).toBeInTheDocument()
    const t = src('components/AcpChatView.tsx')
    const line = t.split('\n').find(l => l.includes('agentType?:'))!
    expect(line).toContain("'crew'")
    expect(line).not.toContain("'kiro'")
  })

  it('⑤⑦⑧ MobileKeyBar 有 crew 键、发 kirocrew chat，且 TerminalView 真的分派它', () => {
    const onKey = vi.fn()
    render(<MobileKeyBar onKey={onKey} />)
    expect(screen.getByLabelText('crew')).toBeInTheDocument()
    expect(screen.queryByLabelText('kiro')).not.toBeInTheDocument()
    expect(launchSequence('crew')).toBe('kirocrew chat\r')
    // 第 8 处映射（附录 E1-C 的表头列了它但原文没断言 —— 补上）：键存在但
    // TerminalView 的 handleBarKey 不认它 = 点了没反应，且不报错。
    const t = src('components/TerminalView.tsx')
    const line = t.split('\n').find(l => l.includes("key === 'claude'"))!
    expect(line).toContain("'crew'")
    expect(line).not.toContain("'kiro'")
  })
})
