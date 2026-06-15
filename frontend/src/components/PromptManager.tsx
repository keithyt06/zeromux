import { useState } from 'react'
import { Pencil, Trash2, Plus, X } from 'lucide-react'
import type { PromptPreset } from '../lib/api'

interface Props {
  presets: PromptPreset[]
  error: string | null
  onAdd: (title: string, body: string) => void
  onEdit: (id: string, fields: { title?: string; body?: string }) => void
  onRemove: (id: string) => void
  onClose: () => void
}

const inputCls =
  'w-full rounded bg-[var(--bg-secondary)] border border-[var(--border)] p-2 text-xs text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-blue)]'

export default function PromptManager({ presets, error, onAdd, onEdit, onRemove, onClose }: Props) {
  // editingId === null && formOpen === true => new; editingId set => editing that row.
  const [formOpen, setFormOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftTitle, setDraftTitle] = useState('')
  const [draftBody, setDraftBody] = useState('')

  const openNew = () => {
    setEditingId(null); setDraftTitle(''); setDraftBody(''); setFormOpen(true)
  }
  const openEdit = (p: PromptPreset) => {
    setEditingId(p.id); setDraftTitle(p.title); setDraftBody(p.body); setFormOpen(true)
  }
  const cancelForm = () => { setFormOpen(false); setEditingId(null); setDraftTitle(''); setDraftBody('') }
  const save = () => {
    const t = draftTitle.trim(), b = draftBody.trim()
    if (!t || !b) return
    if (editingId) onEdit(editingId, { title: t, body: b })
    else onAdd(t, b)
    cancelForm()
  }

  return (
    <div className="p-2 flex flex-col gap-2">
      {error && <div className="text-[10px] text-[var(--accent-red)]">{error}</div>}

      {!formOpen && (
        <div className="flex flex-col gap-1 max-h-60 overflow-y-auto">
          {presets.length === 0 && (
            <div className="text-[10px] text-[var(--text-muted)] px-1 py-2">还没有常用 prompt，点下面新建。</div>
          )}
          {presets.map(p => (
            <div key={p.id} className="flex items-center gap-1 rounded px-2 py-1 hover:bg-[var(--bg-secondary)]">
              <span className="flex-1 truncate text-xs text-[var(--text-primary)]" title={p.body}>{p.title}</span>
              <button onClick={() => openEdit(p)} aria-label="edit"
                className="p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)]"><Pencil size={12} /></button>
              <button onClick={() => onRemove(p.id)} aria-label="delete"
                className="p-1 text-[var(--text-muted)] hover:text-[var(--accent-red)]"><Trash2 size={12} /></button>
            </div>
          ))}
        </div>
      )}

      {formOpen ? (
        <div className="flex flex-col gap-2">
          <input value={draftTitle} onChange={e => setDraftTitle(e.target.value)}
            placeholder="标题，如「审查 PR」" autoFocus className={inputCls} />
          <textarea value={draftBody} onChange={e => setDraftBody(e.target.value)}
            placeholder="prompt 全文" className={`${inputCls} h-24 resize-none`} />
          <div className="flex justify-end gap-2">
            <button onClick={cancelForm}
              className="px-2 py-1 text-[10px] font-semibold text-[var(--text-secondary)] hover:text-[var(--text-primary)]">取消</button>
            <button onClick={save} disabled={!draftTitle.trim() || !draftBody.trim()}
              className="px-3 py-1 text-[10px] font-semibold bg-[var(--accent-blue)] hover:bg-[var(--accent-blue-hover)] disabled:opacity-40 text-white rounded">保存</button>
          </div>
        </div>
      ) : (
        <div className="flex justify-between">
          <button onClick={openNew}
            className="flex items-center gap-1 px-2 py-1 text-[10px] font-semibold text-[var(--accent-blue)] hover:opacity-80">
            <Plus size={12} /> 新建
          </button>
          <button onClick={onClose} aria-label="close manager"
            className="p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)]"><X size={12} /></button>
        </div>
      )}
    </div>
  )
}
