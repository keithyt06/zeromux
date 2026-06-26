import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { SessionLifetimeBadge } from '../SessionLifetimeBadge'

describe('SessionLifetimeBadge', () => {
  it('renders turns, duration, cost for claude', () => {
    render(<SessionLifetimeBadge agentType="claude" lifetime={{ turns: 3, duration_ms: 125000, cost_usd: 0.42 }} />)
    expect(screen.getByText(/3\s*轮/)).toBeInTheDocument()
    expect(screen.getByText(/2m05s/)).toBeInTheDocument()
    expect(screen.getByText(/\$0\.42/)).toBeInTheDocument()
  })

  it('shows dash for non-claude cost', () => {
    render(<SessionLifetimeBadge agentType="codex" lifetime={{ turns: 2, duration_ms: 60000, cost_usd: 0 }} />)
    expect(screen.getByText(/2\s*轮/)).toBeInTheDocument()
    expect(screen.getByText('—')).toBeInTheDocument()
  })
})
