import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import HistoryView, { chunkLines } from '../HistoryView'
import * as api from '../../lib/api'

describe('chunkLines', () => {
  it('splits into fixed-size line blocks', () => {
    const text = Array.from({ length: 1201 }, (_, i) => `${i + 1}`).join('\n')
    const c = chunkLines(text, 500)
    expect(c.length).toBe(3)
    expect(c[0].split('\n').length).toBe(500)
    expect(c[2].split('\n')[0]).toBe('1001')
    expect(c[2].split('\n').length).toBe(201)
  })
})

describe('HistoryView', () => {
  beforeEach(() => { vi.restoreAllMocks() })
  it('loads history, shows truncation note, copy-all and close', async () => {
    vi.spyOn(api, 'getHistory').mockResolvedValue({ text: 'line-1\nline-2', truncated: true })
    const writeText = vi.fn().mockResolvedValue(undefined)
    // happy-dom's navigator.clipboard is a getter-only accessor (Clipboard API is
    // spec'd read-only), so a plain Object.assign throws in strict-mode ESM;
    // defineProperty replaces the accessor outright.
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const onClose = vi.fn()
    render(<HistoryView sessionId="s" title="api" onClose={onClose} />)
    await waitFor(() => expect(screen.getByText(/line-2/)).toBeInTheDocument())
    expect(screen.getByText(/仅显示最近/)).toBeInTheDocument()
    fireEvent.click(screen.getByText('复制全部'))
    expect(writeText).toHaveBeenCalledWith('line-1\nline-2')
    fireEvent.click(screen.getByLabelText('关闭历史'))
    expect(onClose).toHaveBeenCalled()
  })
  it('shows error text when fetch fails', async () => {
    vi.spyOn(api, 'getHistory').mockRejectedValue(new Error('tmux 服务未运行'))
    render(<HistoryView sessionId="s" title="api" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText(/tmux 服务未运行/)).toBeInTheDocument())
  })
})
