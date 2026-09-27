import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { useState } from 'react'
import { Popover } from '../Popover'
import { Sheet } from '../Sheet'

function H({ narrow = false }: { narrow?: boolean }) {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: narrow && q.includes('max-width'), addEventListener() {}, removeEventListener() {} }))
  const [a, setA] = useState<HTMLButtonElement | null>(null)
  const [open, setOpen] = useState(true)
  return (<><button ref={setA}>anchor</button><button>outside</button>
    <Popover open={open} onClose={() => setOpen(false)} anchor={a} sheetTitle="操作"><button>item</button></Popover></>)
}

describe('Popover', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('portals into #overlay-root (never inside .xterm-container / .vault-reading-surface)', () => {
    const root = document.createElement('div'); root.id = 'overlay-root'; document.body.appendChild(root)
    render(<div className="xterm-container"><H /></div>)
    expect(root.contains(screen.getByText('item'))).toBe(true)
    root.remove()
  })
  it('closes on outside pointerdown and Esc', () => {
    render(<H />)
    fireEvent.pointerDown(screen.getByText('outside'))
    expect(screen.queryByText('item')).toBeNull()
  })
  it('narrow viewport renders as a bottom Sheet', () => {
    render(<H narrow />)
    const d = screen.getByRole('dialog', { hidden: true })
    expect(d.dataset.side).toBe('bottom')
  })
  it('anchored inside a modal Sheet: portals into that dialog and stays anchored even when narrow (no Sheet-in-Sheet, not inert)', () => {
    function InSheet() {
      vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('max-width'), addEventListener() {}, removeEventListener() {} }))
      const [a, setA] = useState<HTMLButtonElement | null>(null)
      return (<Sheet open side="full" onClose={() => {}} title="panel">
        <button ref={setA}>anchor</button>
        <Popover open onClose={() => {}} anchor={a}><button>inner</button></Popover>
      </Sheet>)
    }
    render(<InSheet />)
    expect(screen.getAllByRole('dialog', { hidden: true })).toHaveLength(1)
    expect(screen.getByRole('dialog', { hidden: true }).contains(screen.getByText('inner'))).toBe(true)
  })
  it('a press inside a nested (inner) layer does not close the outer one', () => {
    const outer = vi.fn(), inner = vi.fn()
    function Nested() {
      const [a, setA] = useState<HTMLButtonElement | null>(null)
      const [b, setB] = useState<HTMLButtonElement | null>(null)
      return (<><button ref={setA}>a</button>
        <Popover open onClose={outer} anchor={a}><button ref={setB}>open-inner</button></Popover>
        {b && <Popover open onClose={inner} anchor={b}><button>deep</button></Popover>}</>)
    }
    render(<Nested />)
    fireEvent.pointerDown(screen.getByText('deep'))
    expect(outer).not.toHaveBeenCalled()
    expect(inner).not.toHaveBeenCalled()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(inner).toHaveBeenCalledTimes(1)
    expect(outer).not.toHaveBeenCalled()
  })
})
