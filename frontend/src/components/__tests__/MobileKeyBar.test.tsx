import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import MobileKeyBar from '../MobileKeyBar'

describe('MobileKeyBar', () => {
  it('渲染 ↑↓↩ + ^C + 三个 agent 启动键', () => {
    render(<MobileKeyBar onKey={() => {}} />)
    for (const k of ['up', 'down', 'enter', 'ctrl-c', 'claude', 'codex', 'crew']) {
      expect(screen.getByLabelText(k)).toBeInTheDocument()
    }
  })

  it('第一页不显示 esc/left/right（已删/挪到第二页）', () => {
    render(<MobileKeyBar onKey={() => {}} />)
    for (const k of ['esc', 'left', 'right', 'y', 'n']) {
      expect(screen.queryByLabelText(k)).toBeNull()
    }
  })

  it('pointerDown 时用逻辑键名触发 onKey', () => {
    const onKey = vi.fn()
    render(<MobileKeyBar onKey={onKey} />)
    fireEvent.pointerDown(screen.getByLabelText('up'))
    expect(onKey).toHaveBeenCalledWith('up')
    fireEvent.pointerDown(screen.getByLabelText('ctrl-c'))
    expect(onKey).toHaveBeenCalledWith('ctrl-c')
    fireEvent.pointerDown(screen.getByLabelText('claude'))
    expect(onKey).toHaveBeenCalledWith('claude')
  })

  it('history key only when onHistory given', () => {
    const { rerender } = render(<MobileKeyBar onKey={() => {}} />)
    expect(screen.queryByLabelText('history')).toBeNull()
    const onHistory = vi.fn()
    rerender(<MobileKeyBar onKey={() => {}} onHistory={onHistory} />)
    fireEvent.pointerDown(screen.getByLabelText('history'))
    expect(onHistory).toHaveBeenCalled()
  })

  it('more-keys flips to page 2 and back', () => {
    const onKey = vi.fn()
    render(<MobileKeyBar onKey={onKey} />)
    fireEvent.pointerDown(screen.getByLabelText('more-keys'))
    for (const k of ['esc', 'tab', 'left', 'right', 'ctrl-d', 'ctrl-z', 'pgup', 'pgdn']) {
      expect(screen.getByLabelText(k)).toBeInTheDocument()
    }
    expect(screen.queryByLabelText('claude')).toBeNull()
    fireEvent.pointerDown(screen.getByLabelText('esc'))
    expect(onKey).toHaveBeenCalledWith('esc')
    fireEvent.pointerDown(screen.getByLabelText('more-keys'))
    expect(screen.getByLabelText('claude')).toBeInTheDocument()
  })
})
