import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { TmuxHealthBar, LostBanner, EndedOverlay } from '../TerminalNotices'

describe('TmuxHealthBar', () => {
  it('healthy → nothing', () => {
    const { container } = render(<TmuxHealthBar health={{ server: true, in_unit: true }} />)
    expect(container.firstChild).toBeNull()
  })
  it('server down → restart hint', () => {
    render(<TmuxHealthBar health={{ server: false, in_unit: false }} />)
    expect(screen.getByRole('alert').textContent).toContain('systemctl restart zeromux-tmux')
  })
  it('wrong cgroup → kill-server hint', () => {
    render(<TmuxHealthBar health={{ server: true, in_unit: false }} />)
    expect(screen.getByRole('alert').textContent).toContain('kill-server')
  })
})

describe('LostBanner / EndedOverlay', () => {
  it('lost banner stays until closed', () => {
    const onClose = vi.fn()
    render(<LostBanner onClose={onClose} />)
    expect(screen.getByRole('status').textContent).toContain('之前的输出不可恢复')
    fireEvent.click(screen.getByLabelText('关闭提示'))
    expect(onClose).toHaveBeenCalled()
  })
  it('ended overlay offers revive + close', () => {
    const onRevive = vi.fn(), onClose = vi.fn()
    render(<EndedOverlay name="vscode-dev" origin="external" onRevive={onRevive} onClose={onClose} />)
    expect(screen.getByText(/vscode-dev 已在其他终端结束/)).toBeInTheDocument()
    fireEvent.click(screen.getByText('新建同名会话'))
    fireEvent.click(screen.getByText('关闭'))
    expect(onRevive).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })
  it('own session ended → generic copy, not "other terminal"', () => {
    render(<EndedOverlay name="zmx-abcd1234" origin="own" onRevive={() => {}} onClose={() => {}} />)
    expect(screen.getByText('tmux 会话已结束')).toBeInTheDocument()
    expect(screen.queryByText(/其他终端/)).toBeNull()
  })
})
