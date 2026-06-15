import { useState } from 'react'
import { Pencil, Trash2, Plus, X } from 'lucide-react'
import type { PromptPreset } from '../lib/api'

interface Props {
  presets: PromptPreset[]
  error: string | null
  // add/edit resolve to whether the write succeeded — the form stays open on failure
  // so a rejected draft (e.g. too long, transient 5xx) isn't silently discarded.
  onAdd: (title: string, body: string) => Promise<boolean>
  onEdit: (id: string, fields: { title?: string; body?: string }) => Promise<boolean>
  onRemove: (id: string) => void
  onClose: () => void
}

const inputCls =
  'w-full rounded bg-[var(--bg-secondary)] border border-[var(--border)] p-2 text-xs text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-blue)]'

// Mirror the backend caps (src/prompts.rs TITLE_MAX / BODY_MAX) so an over-length
// draft is blocked client-side with inline feedback instead of round-tripping to a 400.
const TITLE_MAX = 200
const BODY_MAX = 20000

export default function PromptManager({ presets, error, onAdd, onEdit, onRemove, onClose }: Props) {
  // editingId === null && formOpen === true => new; editingId set => editing that row.
  const [formOpen, setFormOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftTitle, setDraftTitle] = useState('')
  const [draftBody, setDraftBody] = useState('')
  const [saving, setSaving] = useState(false)
  const [confirmId, setConfirmId] = useState<string | null>(null) // row awaiting delete confirm

  const openNew = () => {
    setConfirmId(null); setEditingId(null); setDraftTitle(''); setDraftBody(''); setFormOpen(true)
  }
  const openEdit = (p: PromptPreset) => {
    setConfirmId(null); setEditingId(p.id); setDraftTitle(p.title); setDraftBody(p.body); setFormOpen(true)
  }
  const cancelForm = () => { setFormOpen(false); setEditingId(null); setDraftTitle(''); setDraftBody('') }
  const tooLong = draftTitle.trim().length > TITLE_MAX || draftBody.trim().length > BODY_MAX
  const save = async () => {
    const t = draftTitle.trim(), b = draftBody.trim()
    if (!t || !b || tooLong || saving) return
    setSaving(true)
    // Only close on success — a rejected draft (too long / 5xx) stays editable.
    const ok = editingId ? await onEdit(editingId, { title: t, body: b }) : await onAdd(t, b)
    setSaving(false)
    if (ok) cancelForm()
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
              {confirmId === p.id ? (
                // Two-tap confirm (no window.confirm — bad on mobile); deleting from a
                // shared/global list shouldn't be a single stray tap.
                <>
                  <button onClick={() => { onRemove(p.id); setConfirmId(null) }} aria-label="confirm delete"
                    className="px-1.5 py-0.5 text-[10px] font-semibold text-white bg-[var(--accent-red)] rounded">删除</button>
                  <button onClick={() => setConfirmId(null)} aria-label="cancel delete"
                    className="px-1.5 py-0.5 text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]">取消</button>
                </>
              ) : (
                <>
                  <button onClick={() => openEdit(p)} aria-label="edit"
                    className="p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)]"><Pencil size={12} /></button>
                  <button onClick={() => setConfirmId(p.id)} aria-label="delete"
                    className="p-1 text-[var(--text-muted)] hover:text-[var(--accent-red)]"><Trash2 size={12} /></button>
                </>
              )}
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
          <div className="text-[10px] text-[var(--text-muted)] leading-snug">
            用 <code className="text-[var(--accent-blue)]">{'{{input}}'}</code> 插入当前输入框内容（点 chip 时替换为你已输入的文字）。
          </div>
          {tooLong && (
            <div className="text-[10px] text-[var(--accent-red)]">标题 ≤ {TITLE_MAX}、内容 ≤ {BODY_MAX} 字符。</div>
          )}
          <div className="flex justify-end gap-2">
            <button onClick={cancelForm}
              className="px-2 py-1 text-[10px] font-semibold text-[var(--text-secondary)] hover:text-[var(--text-primary)]">取消</button>
            <button onClick={save} disabled={!draftTitle.trim() || !draftBody.trim() || tooLong || saving}
              className="px-3 py-1 text-[10px] font-semibold bg-[var(--accent-blue)] hover:bg-[var(--accent-blue-hover)] disabled:opacity-40 text-white rounded">{saving ? '保存中…' : '保存'}</button>
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
