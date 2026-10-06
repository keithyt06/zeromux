import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { AwayCard } from '../AwayCard'
import type { AwaySummary } from '../../../lib/awaySummary'

const summary: AwaySummary = {
  awayMs: 7 * 3_600_000, costUsd: 3.1, costPartial: false,
  items: [
    { key: 'errored', label: '出错', count: 1, firstId: 'e1' },
    { key: 'completed', label: '完成', count: 5, firstId: 'c9' },
  ],
}

describe('AwayCard', () => {
  it('one line: away time, items, cost; an item jumps to its first session', () => {
    const onSelect = vi.fn()
    render(<AwayCard summary={summary} onSelect={onSelect} onDismiss={() => {}} />)
    const card = screen.getByRole('region', { name: '离开期间' })
    expect(card).toHaveTextContent('离开 7h')
    expect(card).toHaveTextContent('$3.10')
    fireEvent.click(screen.getByRole('button', { name: '出错 1' }))
    expect(onSelect).toHaveBeenCalledWith('e1')
  })
  it('partial cost says so', () => {
    render(<AwayCard summary={{ ...summary, costUsd: 0, costPartial: true }} onSelect={() => {}} onDismiss={() => {}} />)
    expect(screen.getByText('部分未计')).toBeInTheDocument()
    expect(screen.queryByText('$0.00')).toBeNull()
  })
  it('× calls onDismiss; a null summary renders nothing', () => {
    const onDismiss = vi.fn()
    const { rerender, container } = render(<AwayCard summary={summary} onSelect={() => {}} onDismiss={onDismiss} />)
    fireEvent.click(screen.getByRole('button', { name: '关闭离开摘要' }))
    expect(onDismiss).toHaveBeenCalled()
    rerender(<AwayCard summary={null} onSelect={() => {}} onDismiss={onDismiss} />)
    expect(container).toBeEmptyDOMElement()
  })
})
