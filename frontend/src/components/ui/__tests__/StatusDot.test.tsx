import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { StatusDot } from '../StatusDot'

describe('StatusDot', () => {
  it('exposes an accessible label and tone', () => {
    render(<StatusDot tone="danger" label="出错" />)
    const el = screen.getByRole('img', { name: '出错' })
    expect(el.dataset.tone).toBe('danger')
  })
  it('attention defaults to diamond; others are dots', () => {
    const { rerender } = render(<StatusDot tone="attention" label="待审批" />)
    expect(screen.getByRole('img').dataset.shape).toBe('diamond')
    rerender(<StatusDot tone="running" label="运行中" />)
    expect(screen.getByRole('img').dataset.shape).toBe('dot')
    expect(screen.getByRole('img').className).toMatch(/dot-breathe/)
  })
  it('muted is a hollow ring (no fill)', () => {
    render(<StatusDot tone="muted" label="空闲" />)
    expect(screen.getByRole('img').className).toMatch(/border/)
    expect(screen.getByRole('img').className).not.toMatch(/bg-\[var\(--fg-subtle\)\]/)
  })
})
