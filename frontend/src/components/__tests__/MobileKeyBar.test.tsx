import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import MobileKeyBar from '../MobileKeyBar'

describe('MobileKeyBar', () => {
  it('渲染 ↑↓ + ^C + 三个 agent 启动键', () => {
    render(<MobileKeyBar onKey={() => {}} />)
    for (const k of ['up', 'down', 'ctrl-c', 'claude', 'codex', 'kiro']) {
      expect(screen.getByLabelText(k)).toBeInTheDocument()
    }
  })

  it('终端模式不渲染 Enter（与常驻 composer 的发送键重复）及其它已删键', () => {
    render(<MobileKeyBar onKey={() => {}} />)
    for (const k of ['enter', 'esc', 'left', 'right', 'y', 'n']) {
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
})
