import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { Dialog } from '../Dialog'

function Harness({ onClose = () => {} }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false)
  return (<>
    <button onClick={() => setOpen(true)}>open</button>
    <Dialog open={open} onClose={() => { setOpen(false); onClose() }} title="标题"><button>inside</button></Dialog>
  </>)
}

describe('Dialog', () => {
  it('opens as a modal and exposes an accessible name', () => {
    render(<Harness />)
    fireEvent.click(screen.getByText('open'))
    const d = screen.getByRole('dialog', { hidden: true })
    expect((d as HTMLDialogElement).open).toBe(true)
    expect(d).toHaveAccessibleName('标题')
  })
  it('Esc (cancel event) closes via onClose', () => {
    const onClose = vi.fn()
    render(<Harness onClose={onClose} />)
    fireEvent.click(screen.getByText('open'))
    fireEvent(screen.getByRole('dialog', { hidden: true }), new Event('cancel', { cancelable: true }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
  it('backdrop click closes, inner click does not', () => {
    const onClose = vi.fn()
    render(<Harness onClose={onClose} />)
    fireEvent.click(screen.getByText('open'))
    fireEvent.click(screen.getByText('inside'))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('dialog', { hidden: true }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
  it('restores focus to the opener on close', () => {
    render(<Harness />)
    const opener = screen.getByText('open')
    opener.focus()
    fireEvent.click(opener)
    screen.getByText('inside').focus()   // real browsers move focus into the modal
    fireEvent(screen.getByRole('dialog', { hidden: true }), new Event('cancel', { cancelable: true }))
    expect(document.activeElement).toBe(opener)
  })
  it('StrictMode double effects do not throw on showModal', async () => {
    const { StrictMode } = await import('react')
    render(<StrictMode><Dialog open onClose={() => {}}>x</Dialog></StrictMode>)
    expect((screen.getByRole('dialog', { hidden: true }) as HTMLDialogElement).open).toBe(true)
  })
})
