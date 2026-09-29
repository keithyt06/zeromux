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

  it('more-keys toggle is an icon, not an emoji glyph (V16)', () => {
    render(<MobileKeyBar onKey={() => {}} />)
    const btn = screen.getByLabelText('more-keys')
    expect(btn.textContent).toBe('')
    expect(btn.querySelector('svg')).not.toBeNull()
    fireEvent.pointerDown(btn)
    expect(btn.textContent).toBe('')
    expect(btn.querySelector('svg')).not.toBeNull()
  })

  it('page 2 is 12 keys incl. ^R ^L Home End, every key (both pages) ≥ --hit tall', () => {
    const onKey = vi.fn()
    render(<MobileKeyBar onKey={onKey} onHistory={() => {}} />)
    for (const k of ['history', 'up', 'down', 'enter', 'ctrl-c', 'claude', 'codex', 'crew', 'more-keys']) {
      expect(screen.getByLabelText(k).className).toContain('min-h-[var(--hit)]')
    }
    fireEvent.pointerDown(screen.getByLabelText('more-keys'))
    const page2 = ['esc', 'tab', 'left', 'right', 'ctrl-d', 'ctrl-z', 'pgup', 'pgdn', 'ctrl-r', 'ctrl-l', 'home', 'end']
    for (const k of page2) {
      const b = screen.getByLabelText(k)
      expect(b.className).toContain('min-h-[var(--hit)]')
      expect(b.style.touchAction).toBe('manipulation')
    }
    expect(screen.getByTestId('keybar-page2').querySelectorAll('button')).toHaveLength(12)
    fireEvent.pointerDown(screen.getByLabelText('home'))
    expect(onKey).toHaveBeenCalledWith('home')
  })

  it('expanded: 收起键栏 toggle has aria-expanded=true and calls onToggleCollapsed', () => {
    const onToggle = vi.fn()
    render(<MobileKeyBar onKey={() => {}} collapsed={false} onToggleCollapsed={onToggle} />)
    const btn = screen.getByLabelText('收起键栏')
    expect(btn.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(btn)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('collapsed: only a 「⌃ 键栏」 button (aria-expanded=false, ≥44px), no keys', () => {
    const onToggle = vi.fn()
    render(<MobileKeyBar onKey={() => {}} onHistory={() => {}} collapsed onToggleCollapsed={onToggle} />)
    expect(screen.queryByLabelText('up')).toBeNull()
    expect(screen.queryByLabelText('history')).toBeNull()
    const btn = screen.getByRole('button', { name: /键栏/ })
    expect(btn.textContent).toBe('⌃ 键栏')
    expect(btn.getAttribute('aria-expanded')).toBe('false')
    expect(btn.className).toContain('min-h-[var(--hit)]')
    fireEvent.click(btn)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })
})
