import { render, screen, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Toaster, toast } from '../toast'

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
})
