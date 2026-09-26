import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { TmuxHealthBar } from '../TerminalNotices'

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
