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
    const anchor = document.createElement('div')
    document.body.appendChild(anchor)
    const onPick = vi.fn(), onManage = vi.fn(), onClose = vi.fn()
    const el = (q: string) => <PresetPicker open query={q} presets={PRESETS} anchor={anchor} onPick={onPick} onManage={onManage} onClose={onClose} {...over} />
    const u = render(el(query))
    return { onPick, onManage, onClose, rerender: (q: string) => u.rerender(el(q)) }
  }
  const titles = () => screen.getAllByRole('option').map(o => o.querySelector('span')!.textContent)

  it('filters by title (rankBy), ↑↓ + Enter picks, 「管理…」 calls onManage', () => {
    const { onPick, onManage, rerender } = setup('')
    expect(titles()).toEqual(['fix bug', 'review', 'explain'])
    rerender('fix 登录页')
    expect(titles()).toEqual(['fix bug'])
    rerender('e')
    expect(titles()).toEqual(['explain', 'review'])
    rerender('')
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'ArrowDown' })
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(document.body, { key: 'ArrowUp' })
    fireEvent.keyDown(document.body, { key: 'ArrowUp' })
    expect(screen.getAllByRole('option')[2]).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(document.body, { key: 'Enter' })
    expect(onPick).toHaveBeenCalledWith(PRESETS[2])
    fireEvent.click(screen.getByText('管理…'))
    expect(onManage).toHaveBeenCalledTimes(1)
  })

  it('Enter during IME composition does not pick', () => {
    const { onPick } = setup('')
    fireEvent.keyDown(document.body, { key: 'Enter', isComposing: true })
    fireEvent.keyDown(document.body, { key: 'Enter', keyCode: 229 })
    expect(onPick).not.toHaveBeenCalled()
    fireEvent.keyDown(document.body, { key: 'Enter' })
    expect(onPick).toHaveBeenCalledTimes(1)
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

  it('the old ListPlus presets button is gone (V7: / is the only entry)', () => {
    mount()
    expect(screen.queryByLabelText('prompt presets')).toBeNull()
  })
})
