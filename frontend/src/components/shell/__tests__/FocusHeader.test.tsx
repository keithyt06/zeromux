import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { FocusHeader } from '../FocusHeader'
import { mkSession } from '../../../test/appHarness'
import { sessionActions } from '../../../lib/sessionActions'

const NOW = 1_000_000
const env = { rename: vi.fn(), close: vi.fn(), openHistory: vi.fn() }

function setup(over: Partial<React.ComponentProps<typeof FocusHeader>> = {}) {
  const s = over.session ?? mkSession('a', { name: 'api-refactor', turn_state: 'running', turn_started_ms: NOW - 134_000, lifetime_cost_usd: 0.42 })
  const onBack = vi.fn(), onTogglePanel = vi.fn()
  render(<FocusHeader session={s} attention="running" now={NOW} narrow={false} needsYou={3} onBack={onBack}
    actions={sessionActions(s, env)} panelOpen={false} onTogglePanel={onTogglePanel} {...over} />)
  return { onBack, onTogglePanel, s }
}

describe('FocusHeader', () => {
  afterEach(() => vi.clearAllMocks())
  it('desktop: status dot + elapsed + short cost; no back button', () => {
    setup()
    expect(screen.getByRole('img', { name: '运行中' })).toBeInTheDocument()
    expect(screen.getByText('2m14s')).toBeInTheDocument()
    expect(screen.getByText('$0.42')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /返回分诊/ })).toBeNull()
  })
  it('phone: ‹ 分诊 (N) goes back to triage (select(null))', () => {
    const { onBack } = setup({ narrow: true })
    const back = screen.getByRole('button', { name: '返回分诊 (3)' })
    expect(back).toHaveTextContent('分诊(3)')
    fireEvent.click(back)
    expect(onBack).toHaveBeenCalled()
  })
  it('⋯ menu items are exactly the sessionActions registry', () => {
    const s = mkSession('t', { type: 'tmux', tmux_name: 'zmx-t', name: 'shell' })
    setup({ session: s, actions: sessionActions(s, env) })
    fireEvent.click(screen.getByRole('button', { name: '会话操作' }))
    expect(screen.getAllByRole('menuitem').map(m => m.textContent)).toEqual(sessionActions(s, env).map(a => a.label))
    fireEvent.click(screen.getByRole('menuitem', { name: '查看历史' }))
    expect(env.openHistory).toHaveBeenCalledWith('t')
  })
  it('面板 toggles the ContextPanel', () => {
    const { onTogglePanel } = setup()
    fireEvent.click(screen.getByRole('button', { name: '面板' }))
    expect(onTogglePanel).toHaveBeenCalled()
  })
  it('crew shows ctx % reported by the chat view; dormant peers get a hint', () => {
    setup({ session: mkSession('c', { type: 'crew', peer_name: 'zmx-ai-abc', running: false }), ctxUsage: { used: 30_000, total: 200_000 } })
    expect(screen.getByText('ctx 15%')).toBeInTheDocument()
    expect(screen.getByText(/休眠/)).toBeInTheDocument()
  })
})
