import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { Menu } from '../Menu'

describe('Menu', () => {
  it('keyboard: arrows move, Enter selects and closes; danger styled', () => {
    const a = document.createElement('button'); document.body.appendChild(a)
    const rename = vi.fn(), del = vi.fn(), onClose = vi.fn()
    render(<Menu open anchor={a} onClose={onClose} items={[{ label: '重命名', onSelect: rename }, { label: '删除', danger: true, onSelect: del }]} />)
    const items = screen.getAllByRole('menuitem')
    expect(document.activeElement).toBe(items[0])
    fireEvent.keyDown(items[0], { key: 'ArrowDown' })
    expect(document.activeElement).toBe(items[1])
    fireEvent.keyDown(items[1], { key: 'Enter' })
    expect(del).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
    expect(items[1].className).toMatch(/danger/)
  })
  it('first-letter jump', () => {
    const a = document.createElement('button'); document.body.appendChild(a)
    render(<Menu open anchor={a} onClose={() => {}} items={[{ label: 'Alpha', onSelect() {} }, { label: 'Beta', onSelect() {} }]} />)
    fireEvent.keyDown(screen.getAllByRole('menuitem')[0], { key: 'b' })
    expect(document.activeElement).toBe(screen.getAllByRole('menuitem')[1])
  })
})
