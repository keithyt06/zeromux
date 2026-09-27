import { render, screen, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { useState } from 'react'
import { Toaster, toast } from '../toast'
import { Sheet } from '../Sheet'

describe('toast', () => {
  afterEach(() => { vi.useRealTimers(); act(() => { document.querySelectorAll('[data-toast-id]').forEach(el => toast.dismiss(el.getAttribute('data-toast-id')!)) }) })
  it('auto-dismisses after duration', async () => {
    vi.useFakeTimers()
    render(<Toaster />)
    act(() => { toast.push({ message: 'hello', durationMs: 1000 }) })
    expect(screen.getByText('hello')).toBeInTheDocument()
    await act(async () => { await vi.advanceTimersByTimeAsync(1001) })
    expect(screen.queryByText('hello')).toBeNull()
  })
  it('same key replaces; at most 3 on screen', () => {
    render(<Toaster />)
    act(() => { toast.push({ message: 'a', key: 'k' }); toast.push({ message: 'b', key: 'k' }) })
    expect(screen.queryByText('a')).toBeNull()
    act(() => { ['1', '2', '3', '4'].forEach(m => toast.push({ message: m })) })
    expect(screen.queryByText('b')).toBeNull()
    expect(screen.queryByText('1')).toBeNull()
    expect(screen.getByText('4')).toBeInTheDocument()
  })
  it('action runs then dismisses', async () => {
    render(<Toaster />)
    const onClick = vi.fn()
    act(() => { toast.push({ message: '已关闭 api', action: { label: '撤销', onClick } }) })
    await act(async () => { fireEvent.click(screen.getByText('撤销')) })
    expect(onClick).toHaveBeenCalled()
    expect(screen.queryByText('已关闭 api')).toBeNull()
  })
  it('undo + failure toasts coexist (Review Focus #5)', () => {
    render(<Toaster />)
    act(() => { toast.push({ message: '已关闭 api', action: { label: '撤销', onClick() {} }, durationMs: 4500 }); toast.push({ message: '创建会话失败' }) })
    expect(screen.getByText('已关闭 api')).toBeInTheDocument()
    expect(screen.getByText('创建会话失败')).toBeInTheDocument()
  })
  it('double-tapping the action runs it once', async () => {
    render(<Toaster />)
    const onClick = vi.fn(() => new Promise<void>(r => setTimeout(r, 10)))
    act(() => { toast.push({ message: '已关闭 api', action: { label: '撤销', onClick } }) })
    const btn = screen.getByText('撤销')
    await act(async () => { fireEvent.click(btn); fireEvent.click(btn) })
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('已关闭 api')).toBeNull()
  })
  it('renders inside the top open modal so it is not inert; toast clicks do not close it', async () => {
    const onClose = vi.fn()
    render(<><Toaster /><Sheet open side="bottom" onClose={onClose}>body</Sheet></>)
    const onUndo = vi.fn()
    act(() => { toast.push({ message: 'in-modal', action: { label: '撤销', onClick: onUndo } }) })
    const sheet = screen.getByRole('dialog', { hidden: true })
    expect(screen.getByText('in-modal').closest('dialog[open]')).toBe(sheet)
    const btn = screen.getByText('撤销')
    fireEvent.pointerDown(btn)
    await act(async () => { fireEvent.click(btn) })
    expect(onUndo).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
  })
  it('re-portalling when a Sheet opens keeps the original deadline (I-18)', async () => {
    vi.useFakeTimers()
    let openSheet!: () => void
    function H() {
      const [open, setOpen] = useState(false)
      openSheet = () => setOpen(true)
      return <><Toaster /><Sheet open={open} side="bottom" onClose={() => setOpen(false)}>s</Sheet></>
    }
    render(<H />)
    act(() => { toast.push({ message: 'undo', durationMs: 1000 }) })
    await act(async () => { await vi.advanceTimersByTimeAsync(600) })
    act(() => openSheet())
    expect(screen.getByText('undo').closest('dialog[open]')).not.toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(401) })
    expect(screen.queryByText('undo')).toBeNull()
  })
})
