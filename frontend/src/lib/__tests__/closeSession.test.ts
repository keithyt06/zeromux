import { describe, it, expect } from 'vitest'
import { closeConfirmMessage } from '../closeSession'

describe('closeConfirmMessage', () => {
  it('own, alone, idle → no confirm', () => {
    expect(closeConfirmMessage('api', { external: false, other_clients: 0, busy_command: null })).toBeNull()
  })
  it('non-tmux (null check) → no confirm', () => {
    expect(closeConfirmMessage('x', null)).toBeNull()
  })
  it('other clients → names the count', () => {
    expect(closeConfirmMessage('vscode-dev', { external: false, other_clients: 1, busy_command: null }))
      .toBe('vscode-dev 正在 1 个其他终端中使用，关闭将终止整个 tmux 会话。')
  })
  it('external → warns it was not created here', () => {
    expect(closeConfirmMessage('ext', { external: true, other_clients: 0, busy_command: null }))
      .toContain('不是在 zeromux 中创建的')
  })
  it('busy command → names it', () => {
    expect(closeConfirmMessage('a', { external: false, other_clients: 0, busy_command: 'vim' }))
      .toContain('vim')
  })
})
