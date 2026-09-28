import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PresetPicker } from '../PresetPicker'
import AcpChatView from '../../AcpChatView'
import { DialogHost } from '../../ui'
import * as api from '../../../lib/api'
import type { PromptPreset } from '../../../lib/api'
import { applyPreset } from '../../../lib/applyPreset'
import { installFakeWebSocket } from '../../../test/fakeWs'

const P = (id: string, title: string, body: string): PromptPreset => ({ id, title, body, created_at: '', updated_at: '', sort_order: 0 })
const PRESETS = [
  P('1', 'fix bug', '修复这个问题:{{input}}'),
  P('2', 'review', '请审查最近的改动'),
  P('3', 'explain', '解释这段代码'),
]

describe('PresetPicker', () => {
  const setup = (query: string, over: Partial<React.ComponentProps<typeof PresetPicker>> = {}) => {
    // Keys only count when typed inside the anchor (the caller's input box).
    const anchor = document.createElement('div')
    const field = document.createElement('textarea')
    anchor.appendChild(field)
    document.body.appendChild(anchor)
    const onPick = vi.fn(), onManage = vi.fn(), onClose = vi.fn()
    const el = (q: string) => <PresetPicker open query={q} presets={PRESETS} anchor={anchor} onPick={onPick} onManage={onManage} onClose={onClose} {...over} />
    const u = render(el(query))
    fieldEl = field
    return { onPick, onManage, onClose, rerender: (q: string) => u.rerender(el(q)) }
  }
  let fieldEl: HTMLTextAreaElement
  const field = () => fieldEl
  const titles = () => screen.getAllByRole('option').map(o => o.querySelector('span')!.textContent)

  it('filters by title (rankBy), ↑↓ + Enter picks, 「管理…」 calls onManage', () => {
    const { onPick, onManage, rerender } = setup('')
    expect(titles()).toEqual(['fix bug', 'review', 'explain'])
    rerender('fix 登录页')
    expect(titles()).toEqual(['fix bug'])
    rerender('e')
    expect(titles()).toEqual(['explain', 'review'])
    rerender('')
    fireEvent.keyDown(field(), { key: 'ArrowDown' })
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(field(), { key: 'ArrowUp' })
    fireEvent.keyDown(field(), { key: 'ArrowUp' })
    expect(screen.getAllByRole('option')[2]).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(field(), { key: 'Enter' })
    expect(onPick).toHaveBeenCalledWith(PRESETS[2])
    fireEvent.click(screen.getByText('管理…'))
    expect(onManage).toHaveBeenCalledTimes(1)
  })

  it('Enter during IME composition does not pick', () => {
    const { onPick } = setup('')
    fireEvent.keyDown(field(), { key: 'Enter', isComposing: true })
    fireEvent.keyDown(field(), { key: 'Enter', keyCode: 229 })
    expect(onPick).not.toHaveBeenCalled()
    fireEvent.keyDown(field(), { key: 'Enter' })
    expect(onPick).toHaveBeenCalledTimes(1)
  })

  it('ignores keys typed outside its anchor (another input keeps its Enter)', () => {
    const { onPick } = setup('')
    const other = document.createElement('input')
    document.body.appendChild(other)
    const ev = fireEvent.keyDown(other, { key: 'Enter' })
    expect(ev).toBe(true) // not preventDefault-ed
    expect(onPick).not.toHaveBeenCalled()
  })

  it('a / that matches no title (e.g. a path) shows nothing', () => {
    setup('usr/bin')
    expect(screen.queryByRole('listbox')).toBeNull()
  })
})

describe('/ presets in the AcpChatView composer', () => {
  const origWs = (globalThis as unknown as { WebSocket?: unknown }).WebSocket
  beforeEach(() => {
    vi.restoreAllMocks()
    installFakeWebSocket()
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
    vi.spyOn(api, 'listPrompts').mockResolvedValue(PRESETS)
  })
  afterEach(() => { (globalThis as unknown as { WebSocket?: unknown }).WebSocket = origWs })

  const mount = () => {
    render(<><AcpChatView sessionId="s1" active agentType="claude" /><DialogHost /></>)
    const box = screen.getByPlaceholderText(/Send a message/) as HTMLTextAreaElement
    const type = (v: string) => fireEvent.change(box, { target: { value: v } })
    return { box, type }
  }

  it('line-start / opens the list (reloading presets); no / → no list', async () => {
    const { type } = mount()
    type('hello /fix')
    expect(screen.queryByRole('listbox')).toBeNull()
    type('/')
    expect(await screen.findByRole('option', { name: /fix bug/ })).toBeInTheDocument()
    expect(api.listPrompts).toHaveBeenCalledTimes(1)
    type('x')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('{{input}} preset: `/fix 登录页` → applyPreset(body, 登录页)', async () => {
    const { box, type } = mount()
    type('/fix 登录页')
    await screen.findByRole('option', { name: /fix bug/ })
    await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }) })
    expect(box.value).toBe(applyPreset(PRESETS[0].body, '登录页'))
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('Enter on an open list picks the preset and does NOT send', async () => {
    const { box, type } = mount()
    type('/rev')
    await screen.findByRole('option', { name: /review/ })
    await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }) })
    expect(box.value).toBe(PRESETS[1].body)
    expect(screen.queryByText('You')).toBeNull()
  })

  it('preset without {{input}} over typed text asks 用预设覆盖当前输入?; cancel keeps the input', async () => {
    const { box, type } = mount()
    type('/review 我已经写了一段')
    const opt = await screen.findByRole('option', { name: /review/ })
    await act(async () => { fireEvent.click(opt) })
    expect(await screen.findByText('用预设覆盖当前输入?')).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByText('取消')) })
    expect(box.value).toBe('/review 我已经写了一段')
    // Confirm path replaces it.
    type('/re')
    type('/review 我已经写了一段')
    const again = await screen.findByRole('option', { name: /review/ })
    await act(async () => { fireEvent.click(again) })
    const ok = await screen.findByText('确定')
    await act(async () => { fireEvent.click(ok) })
    await waitFor(() => expect(box.value).toBe(PRESETS[1].body))
  })

  it('preset without {{input}} and nothing typed after the token replaces without asking', async () => {
    const { box, type } = mount()
    type('/review')
    const opt = await screen.findByRole('option', { name: /review/ })
    await act(async () => { fireEvent.click(opt) })
    expect(box.value).toBe(PRESETS[1].body)
    expect(screen.queryByText('用预设覆盖当前输入?')).toBeNull()
  })

  it('「管理…」 calls onManagePresets (the shell opens the prompts Sheet)', async () => {
    const onManagePresets = vi.fn()
    render(<AcpChatView sessionId="s1" active agentType="claude" onManagePresets={onManagePresets} />)
    fireEvent.change(screen.getByPlaceholderText(/Send a message/), { target: { value: '/' } })
    fireEvent.click(await screen.findByText('管理…'))
    expect(onManagePresets).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('a picked preset whose body starts with / does not reopen the list', async () => {
    vi.spyOn(api, 'listPrompts').mockResolvedValue([P('9', 'compact', '/compact 请压缩上下文')])
    const { box, type } = mount()
    type('/com')
    const opt = await screen.findByRole('option', { name: /compact/ })
    await act(async () => { fireEvent.click(opt) })
    expect(box.value).toBe('/compact 请压缩上下文')
    await act(async () => {})
    expect(screen.queryByRole('listbox')).toBeNull()
    // Typing again re-arms it.
    type('/c')
    expect(await screen.findByRole('option', { name: /compact/ })).toBeInTheDocument()
  })

  it('a picker left open in a hidden pane does not eat Enter in another pane, and closes when inactive', async () => {
    const ws = installFakeWebSocket()
    const { rerender } = render(<>
      <AcpChatView sessionId="a" active agentType="claude" />
      <AcpChatView sessionId="b" active={false} agentType="claude" />
    </>)
    const [boxA, boxB] = screen.getAllByPlaceholderText(/Send a message/) as HTMLTextAreaElement[]
    fireEvent.change(boxA, { target: { value: '/fix' } })
    await screen.findByRole('option', { name: /fix bug/ })
    // User leaves A for B (⌘K / J / ⌘] — no pointerdown).
    rerender(<>
      <AcpChatView sessionId="a" active={false} agentType="claude" />
      <AcpChatView sessionId="b" active agentType="claude" />
    </>)
    expect(screen.queryByRole('listbox')).toBeNull()
    const sockB = ws.all.find(s => /\/ws\/acp\/b(\?|$)/.test((s as unknown as { url: string }).url))!
    fireEvent.change(boxB, { target: { value: 'hello' } })
    fireEvent.keyDown(boxB, { key: 'Enter', keyCode: 13 })
    expect(sockB.sent.some(s => s.includes('"prompt"') && s.includes('hello'))).toBe(true)
    expect(boxA.value).toBe('/fix')
  })

  it('an open picker in the active pane still ignores Enter typed in another pane', async () => {
    const ws = installFakeWebSocket()
    render(<>
      <AcpChatView sessionId="a" active agentType="claude" />
      <AcpChatView sessionId="b" active agentType="claude" />
    </>)
    const [boxA, boxB] = screen.getAllByPlaceholderText(/Send a message/) as HTMLTextAreaElement[]
    fireEvent.change(boxA, { target: { value: '/fix' } })
    await screen.findByRole('option', { name: /fix bug/ })
    fireEvent.change(boxB, { target: { value: 'hi' } })
    fireEvent.keyDown(boxB, { key: 'Enter', keyCode: 13 })
    expect(ws.all.find(s => /\/ws\/acp\/b(\?|$)/.test((s as unknown as { url: string }).url))!.sent.some(s => s.includes('"prompt"'))).toBe(true)
    expect(boxA.value).toBe('/fix')
  })

  it('the old ListPlus presets button is gone (V7: / is the only entry)', () => {
    mount()
    expect(screen.queryByLabelText('prompt presets')).toBeNull()
  })
})
