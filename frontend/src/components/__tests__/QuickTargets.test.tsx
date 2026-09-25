import { render, screen, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import QuickTargets from '../QuickTargets'
import * as api from '../../lib/api'
import { notifyQuickTargetsChanged } from '../../lib/quickTargetsBus'
import type { QuickTarget } from '../../lib/api'

const t = (over: Partial<QuickTarget> = {}): QuickTarget => ({
  kind: 'dir', path: '/w/a', agent: 'claude', display: 'a', hint: '~', ...over,
})
const list = (top: QuickTarget[]) => ({ top })

describe('QuickTargets 事件驱动刷新', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('notifyQuickTargetsChanged() 让挂载中的组件重新取数并重排', async () => {
    // 这是新约束 1 的核心：列表不能是「挂载时取一次」的静态快照。
    let call = 0
    vi.spyOn(api, 'listQuickTargets').mockImplementation(() => {
      call += 1
      return Promise.resolve(call === 1
        ? list([t({ path: '/w/old', display: 'old' })])
        : list([t({ path: '/w/new', display: 'new' })]))
    })

    render(<QuickTargets kind="dir" onPick={() => {}} />)
    await screen.findByText('old')

    notifyQuickTargetsChanged()
    await screen.findByText('new')
    expect(screen.queryByText('old')).not.toBeInTheDocument()
  })
})

describe('QuickTargets stale-response 防护', () => {
  beforeEach(() => vi.restoreAllMocks())

  // 本 repo 已因 stale-response clobber 修过 12 次。本组件同时具备「慢 GET」
  // （JuiceFS 上的 per-row 守卫）与「乐观 mutation」（forget 先改本地再 refetch）。
  //
  // 这个测试的时序是**实测确定**的，三点都关键，改动任一点都会让它退化成空转：
  // 1. forget 的网络调用**永不 resolve** —— 锁住时间窗，使唯一能改变 UI 的写入
  //    只有那个陈旧 GET。否则 forget 完成后的「纠正性 load」会把 ghost 修好，
  //    测试即便在无守卫时也绿（实测确认过这个陷阱）。
  // 2. 后续 GET 全部复用同一个慢 promise —— 同上，杜绝纠正性 load 掩盖问题。
  // 3. 断言用 `act` 精确围栏而非 `waitFor` 轮询 —— waitFor 会一直轮询到 ghost
  //    被修好为止，从而看不见中间那个错误状态。
  it('forget 在途期间到达的陈旧 GET 不得让已移除的行重新出现', async () => {
    let resolvePre: (v: { top: QuickTarget[] }) => void = () => {}
    const pre = new Promise<{ top: QuickTarget[] }>(r => { resolvePre = r })
    let call = 0
    vi.spyOn(api, 'listQuickTargets').mockImplementation(() => {
      call += 1
      if (call === 1) return Promise.resolve(list([
        t({ path: '/w/gone', display: 'gone' }),
        t({ path: '/w/keep', display: 'keep' }),
      ]))
      return pre   // 后续 GET 全用这个慢 promise
    })
    vi.spyOn(api, 'forgetQuickTarget').mockImplementation(() => new Promise<void>(() => {}))

    render(<QuickTargets kind="dir" onPick={() => {}} />)
    await screen.findByText('gone')

    act(() => { notifyQuickTargetsChanged() })   // GET#2 起飞（慢，携带移除前的快照）

    const row = screen.getByText('gone').closest('li')!
    await act(async () => {
      ;(row.querySelector('[data-testid="qt-menu"]') as HTMLElement).click()
    })
    await act(async () => { screen.getByTestId('qt-forget').click() })
    expect(screen.queryByText('gone')).not.toBeInTheDocument()   // 乐观移除已生效

    // 陈旧快照（仍含 gone）现在到达。有 reqRef bump → 丢弃；无 bump → gone 复活。
    await act(async () => {
      resolvePre(list([
        t({ path: '/w/gone', display: 'gone' }),
        t({ path: '/w/keep', display: 'keep' }),
      ]))
      await Promise.resolve(); await Promise.resolve()
    })
    expect(screen.queryByText('gone')).not.toBeInTheDocument()
  })
})

describe('QuickTargets agent 收敛与取用', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('agent 合法时点行直接 onPick 带类型', async () => {
    vi.spyOn(api, 'listQuickTargets').mockResolvedValue(
      list([t({ path: '/w/y', display: 'y', agent: 'codex' })]))
    const onPick = vi.fn()
    render(<QuickTargets kind="dir" onPick={onPick} onChangeAgent={() => {}} />)
    ;(await screen.findByText('y')).click()
    expect(onPick).toHaveBeenCalledWith('/w/y', 'codex')
  })

  it('agent 为未知字符串时点行走 onChangeAgent，不把脏值传给 onPick', async () => {
    vi.spyOn(api, 'listQuickTargets').mockResolvedValue(
      list([t({ path: '/w/x', display: 'x', agent: 'gemini' })]))
    const onPick = vi.fn()
    const onChangeAgent = vi.fn()
    render(<QuickTargets kind="dir" onPick={onPick} onChangeAgent={onChangeAgent} />)
    ;(await screen.findByText('x')).click()
    expect(onPick).not.toHaveBeenCalled()
    expect(onChangeAgent).toHaveBeenCalledWith('/w/x')
  })

  it('note 行（agent 空串）点行走 onPick 且 agent 为 null', async () => {
    vi.spyOn(api, 'listQuickTargets').mockResolvedValue(
      list([t({ kind: 'note', path: 'p/a.md', display: 'a', hint: 'p', agent: '' })]))
    const onPick = vi.fn()
    render(<QuickTargets kind="note" onPick={onPick} />)
    ;(await screen.findByText('a')).click()
    expect(onPick).toHaveBeenCalledWith('p/a.md', null)
  })
})

describe('QuickTargets 手机可用性', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('行级操作单入口不依赖 hover：无 hover 也可见可点', async () => {
    // Tailwind v4 把 group-hover:* 编译进 @media (hover:hover)，手机上整条规则不生效
    // → 元素永久 opacity:0 但仍可点击 = 隐形按钮。用户主设备是手机，故禁止 hover-only。
    vi.spyOn(api, 'listQuickTargets').mockResolvedValue(
      list([t({ path: '/w/a', display: 'a' })]))
    render(<QuickTargets kind="dir" onPick={() => {}} onChangeAgent={() => {}} />)
    const menu = await screen.findByTestId('qt-menu')
    expect(menu.className).not.toMatch(/opacity-0/)
    expect(menu.className).not.toMatch(/group-hover/)
  })

})
