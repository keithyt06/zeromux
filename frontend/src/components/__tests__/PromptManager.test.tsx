import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import PromptManager from '../PromptManager'
import type { PromptPreset } from '../../lib/api'

const preset = (id: string, title = 't', body = 'b'): PromptPreset => ({
  id, title, body, created_at: '1', updated_at: '1', sort_order: 1,
})

function setup(over: Partial<React.ComponentProps<typeof PromptManager>> = {}) {
  const onAdd = vi.fn().mockResolvedValue(true)
  const onEdit = vi.fn().mockResolvedValue(true)
  const onRemove = vi.fn()
  const onClose = vi.fn()
  render(
    <PromptManager
      presets={over.presets ?? []}
      error={over.error ?? null}
      onAdd={over.onAdd ?? onAdd}
      onEdit={over.onEdit ?? onEdit}
      onRemove={over.onRemove ?? onRemove}
      onClose={over.onClose ?? onClose}
    />
  )
  return { onAdd, onEdit, onRemove, onClose }
}

describe('PromptManager', () => {
  it('new form: save calls onAdd with trimmed title/body', async () => {
    const { onAdd } = setup()
    fireEvent.click(screen.getByText('新建'))
    fireEvent.change(screen.getByPlaceholderText('标题，如「审查 PR」'), { target: { value: '  审查 PR ' } })
    fireEvent.change(screen.getByPlaceholderText('prompt 全文'), { target: { value: ' 审查这个 PR ' } })
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => expect(onAdd).toHaveBeenCalledWith('审查 PR', '审查这个 PR'))
  })

  it('editing existing row calls onEdit, not onAdd', async () => {
    const { onEdit, onAdd } = setup({ presets: [preset('p1', 'old')] })
    fireEvent.click(screen.getByLabelText('edit'))
    fireEvent.change(screen.getByPlaceholderText('prompt 全文'), { target: { value: 'new body' } })
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => expect(onEdit).toHaveBeenCalledWith('p1', { title: 'old', body: 'new body' }))
    expect(onAdd).not.toHaveBeenCalled()
  })

  it('save failure keeps the form open with the draft intact (no data loss)', async () => {
    const onAdd = vi.fn().mockResolvedValue(false) // backend rejected
    setup({ onAdd })
    fireEvent.click(screen.getByText('新建'))
    fireEvent.change(screen.getByPlaceholderText('标题，如「审查 PR」'), { target: { value: 'x' } })
    const bodyEl = screen.getByPlaceholderText('prompt 全文') as HTMLTextAreaElement
    fireEvent.change(bodyEl, { target: { value: 'precious draft' } })
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => expect(onAdd).toHaveBeenCalled())
    // form still open, draft preserved
    expect(screen.getByPlaceholderText('prompt 全文')).toBeInTheDocument()
    expect((screen.getByPlaceholderText('prompt 全文') as HTMLTextAreaElement).value).toBe('precious draft')
  })

  it('delete requires a second confirming tap', () => {
    const { onRemove } = setup({ presets: [preset('p1')] })
    fireEvent.click(screen.getByLabelText('delete'))
    expect(onRemove).not.toHaveBeenCalled() // first tap only arms confirm
    fireEvent.click(screen.getByLabelText('confirm delete'))
    expect(onRemove).toHaveBeenCalledWith('p1')
  })

  it('over-length body disables save and shows the cap hint (no round-trip)', () => {
    const { onAdd } = setup()
    fireEvent.click(screen.getByText('新建'))
    fireEvent.change(screen.getByPlaceholderText('标题，如「审查 PR」'), { target: { value: 'ok' } })
    fireEvent.change(screen.getByPlaceholderText('prompt 全文'), { target: { value: 'y'.repeat(20001) } })
    expect(screen.getByText('保存')).toBeDisabled()
    expect(screen.getByText(/≤ 20000/)).toBeInTheDocument()
    fireEvent.click(screen.getByText('保存'))
    expect(onAdd).not.toHaveBeenCalled()
  })

  it('delete confirm can be cancelled', () => {
    const { onRemove } = setup({ presets: [preset('p1')] })
    fireEvent.click(screen.getByLabelText('delete'))
    fireEvent.click(screen.getByLabelText('cancel delete'))
    expect(onRemove).not.toHaveBeenCalled()
    expect(screen.getByLabelText('delete')).toBeInTheDocument() // back to normal row
  })
})
