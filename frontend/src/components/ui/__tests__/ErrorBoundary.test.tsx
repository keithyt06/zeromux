import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { ErrorBoundary } from '../ErrorBoundary'

function Boom(): never { throw new Error('chunk 404') }

describe('ErrorBoundary (A1)', () => {
  afterEach(() => vi.restoreAllMocks())

  it('renders children when nothing throws', () => {
    render(<ErrorBoundary><p>ok</p></ErrorBoundary>)
    expect(screen.getByText('ok')).toBeTruthy()
  })

  it('a throwing child shows a refresh button instead of unmounting the root', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const reload = vi.fn()
    render(<div><span>shell</span><ErrorBoundary onReload={reload}><Boom /></ErrorBoundary></div>)
    expect(screen.getByText('shell')).toBeTruthy()
    const btn = screen.getByRole('button', { name: '页面已更新,点此刷新' })
    fireEvent.click(btn)
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
