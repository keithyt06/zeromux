import { render, screen, act, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import AcpChatView from '../AcpChatView'
import { installFakeWebSocket, type FakeSocket } from '../../test/fakeWs'

// T14:防的是「静默丢弃」陷阱 ——
//   · handleEvent 的 switch **没有 default 分支**（:307-437 改动前）
//   · BlockView 的 default 是 `return null`（:967-968 改动前）
// 所以「后端先发新变体、前端以后补 case」的表现是**什么都没发生**。
//
// 断言必须是「渲染出东西」而不是「代码里有 case 'approval'」：源码字符串断言在
// case 存在但落进 default:null 时仍然绿。
describe('T14 Crew 新事件变体在前端有 case（防静默丢弃）', () => {
  const origWs = (globalThis as unknown as { WebSocket?: unknown }).WebSocket
  let ws: () => FakeSocket
  beforeEach(() => { vi.restoreAllMocks(); ws = installFakeWebSocket().latest })
  afterEach(() => { (globalThis as unknown as { WebSocket?: unknown }).WebSocket = origWs })

  const mount = () => render(<AcpChatView sessionId="s1" active agentType="crew" />)

  it('approval 帧渲染出内联审批卡片与两个 ≥44px 按钮', async () => {
    mount()
    await act(async () => {
      ws().emit({ type: 'approval', approval_id: 'ap1', tool: 'rm -rf /tmp/build',
                  tool_purpose: '清理构建产物', turn_id: 1 })
    })
    expect(await screen.findByText('需要你批准')).toBeInTheDocument()
    expect(screen.getByText(/rm -rf \/tmp\/build/)).toBeInTheDocument()
    expect(screen.getByText('清理构建产物')).toBeInTheDocument()
    const approve = screen.getByTestId('approval-approve')
    const reject = screen.getByTestId('approval-reject')
    // 触控目标 ≥44px（手机是主设备）。
    expect(approve.className).toMatch(/min-h-\[44px\]/)
    expect(reject.className).toMatch(/min-h-\[44px\]/)
  })

  it('点「批准」把决定沿同一条 /ws/acp socket 上行，并收起按钮', async () => {
    mount()
    await act(async () => {
      ws().emit({ type: 'approval', approval_id: 'ap1', tool: 'bash', tool_purpose: 'p', turn_id: 1 })
    })
    await act(async () => { screen.getByTestId('approval-approve').click() })
    // 上行格式（后端 fan-out 据此代理 POST /api/approvals/{id}/{action}）。
    const msgs = ws().sent.map(s => JSON.parse(s))
    expect(msgs).toContainEqual({ type: 'approval', approval_id: 'ap1', action: 'approve' })
    // 已决定 → 按钮消失（Gateway 不回执，收起只能由本端记账）。
    // 这一条同时钉住 memo 比较器：不加 resolvedApprovals 比较项时它会红。
    await waitFor(() => expect(screen.queryByTestId('approval-approve')).not.toBeInTheDocument())
    expect(screen.getByText('已批准')).toBeInTheDocument()
  })

  it('拒绝路径同样上行 reject', async () => {
    mount()
    await act(async () => {
      ws().emit({ type: 'approval', approval_id: 'ap2', tool: 'bash', tool_purpose: 'p', turn_id: 1 })
    })
    await act(async () => { screen.getByTestId('approval-reject').click() })
    expect(ws().sent.map(s => JSON.parse(s)))
      .toContainEqual({ type: 'approval', approval_id: 'ap2', action: 'reject' })
    await waitFor(() => expect(screen.getByText('已拒绝')).toBeInTheDocument())
  })

  it('approval_id 缺失时不渲染两个点了没反应的按钮', async () => {
    mount()
    await act(async () => {
      ws().emit({ type: 'approval', tool: 'bash', tool_purpose: 'p', turn_id: 1 })
    })
    await waitFor(() => expect(screen.queryByTestId('approval-approve')).not.toBeInTheDocument())
    expect(screen.queryByText('需要你批准')).not.toBeInTheDocument()
  })

  it('context_usage 帧渲染出上下文用量（zeromux 自己没有这个能力，纯白拿）', async () => {
    mount()
    await act(async () => { ws().emit({ type: 'context_usage', used: 30_000, total: 200_000 }) })
    expect(await screen.findByText('ctx 15%')).toBeInTheDocument()
  })

  it('context_usage 的 total 为 0 时不渲染（不产生 NaN%/Infinity%）', async () => {
    mount()
    await act(async () => { ws().emit({ type: 'context_usage', used: 5, total: 0 }) })
    await waitFor(() => expect(screen.queryByText(/^ctx /)).not.toBeInTheDocument())
  })
})
