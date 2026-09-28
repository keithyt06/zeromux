import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { useState } from 'react'
import { RenameDialog } from '../RenameDialog'
import { Menu } from '../../ui'
import { mkSession } from '../../../test/appHarness'

describe('RenameDialog', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('edits name + description in one dialog and saves both', () => {
    const onSave = vi.fn(), onClose = vi.fn()
    render(<RenameDialog session={mkSession('a', { name: 'api', description: 'old' })} onClose={onClose} onSave={onSave} />)
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'api-2' } })
    fireEvent.change(screen.getByLabelText('描述'), { target: { value: '重构中' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(onSave).toHaveBeenCalledWith('a', 'api-2', '重构中')
    expect(onClose).toHaveBeenCalled()
  })
  it('inputs are 16px (I-15)', () => {
    render(<RenameDialog session={mkSession('a')} onClose={vi.fn()} onSave={vi.fn()} />)
    expect(screen.getByLabelText('名称').className).toContain('text-ui-input')
    expect(screen.getByLabelText('描述').className).toContain('text-ui-input')
  })
  // Ported from SessionRowMenu.test:36 (T12 fix): choosing 重命名 from the row
  // menu's bottom Sheet on a phone must leave focus in the name input.
  it('narrow: choosing 重命名 from the ⋯ Sheet leaves focus in the name input', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('max-width'), addEventListener() {}, removeEventListener() {} }))
    function Row() {
      const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
      const [open, setOpen] = useState(false)
      const [renaming, setRenaming] = useState(false)
      return (<>
        <button ref={setAnchor} onClick={() => setOpen(true)}>会话菜单</button>
        <Menu open={open} onClose={() => setOpen(false)} anchor={anchor} items={[{ label: '重命名 / 描述…', onSelect: () => setRenaming(true) }]} />
        <RenameDialog session={renaming ? mkSession('a', { name: 'api' }) : null} onClose={() => setRenaming(false)} onSave={vi.fn()} />
      </>)
    }
    render(<Row />)
    fireEvent.click(screen.getByText('会话菜单'))
    expect(screen.getByRole('dialog', { hidden: true }).dataset.side).toBe('bottom')
    fireEvent.click(screen.getByText('重命名 / 描述…'))
    await new Promise(r => requestAnimationFrame(() => r(null)))
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('名称')))
  })
})
