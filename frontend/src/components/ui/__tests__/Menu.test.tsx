import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useState } from 'react'
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

describe('Menu a11y polish (T12 fix)', () => {
  const raf = () => new Promise(r => requestAnimationFrame(() => r(null)))
  it('arrow keys skip disabled items (both directions, wrapping)', () => {
    const a = document.createElement('button'); document.body.appendChild(a)
    render(<Menu open anchor={a} onClose={() => {}} items={[{ label: 'A', onSelect() {} }, { label: 'B', disabled: true, onSelect() {} }, { label: 'C', onSelect() {} }]} />)
    const items = screen.getAllByRole('menuitem')
    fireEvent.keyDown(items[0], { key: 'ArrowDown' })
    expect(document.activeElement).toBe(items[2])
    fireEvent.keyDown(items[2], { key: 'ArrowUp' })
    expect(document.activeElement).toBe(items[0])
    fireEvent.keyDown(items[0], { key: 'ArrowUp' })
    expect(document.activeElement).toBe(items[2])
  })
  // Earlier tests' deferred focus restores must not land mid-test.
  beforeEach(async () => { await raf(); await raf() })
  it('Enter pick returns focus to the anchor', async () => {
    const a = document.createElement('button'); a.textContent = 'anchor'; document.body.appendChild(a)
    function H() {
      const [open, setOpen] = useState(true)
      return <Menu open={open} anchor={a} onClose={() => setOpen(false)} items={[{ label: 'X', onSelect() {} }]} />
    }
    render(<H />)
    fireEvent.keyDown(screen.getByRole('menuitem'), { key: 'Enter' })
    await raf()
    expect(document.activeElement).toBe(a)
  })
  it('Enter pick leaves focus where the action put it', async () => {
    const a = document.createElement('button'); document.body.appendChild(a)
    const input = document.createElement('input'); document.body.appendChild(input)
    function H() {
      const [open, setOpen] = useState(true)
      return <Menu open={open} anchor={a} onClose={() => setOpen(false)} items={[{ label: 'R', onSelect() { input.focus() } }]} />
    }
    render(<H />)
    fireEvent.keyDown(screen.getByRole('menuitem'), { key: 'Enter' })
    await raf()
    expect(document.activeElement).toBe(input)
  })
})
