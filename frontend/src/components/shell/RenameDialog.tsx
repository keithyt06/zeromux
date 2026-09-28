import { useState } from 'react'
import type { SessionInfo } from '../../lib/api'
import { Dialog } from '../ui'

/** 重命名 / 描述 (one dialog, two fields — §0.5.4 session description row). */
export function RenameDialog({ session, onClose, onSave }: {
  session: SessionInfo | null
  onClose(): void
  onSave(id: string, name: string, description: string): void | Promise<void>
}) {
  return (
    <Dialog open={!!session} onClose={onClose} title="重命名 / 描述">
      {session && <RenameForm key={session.id} session={session} onClose={onClose} onSave={onSave} />}
    </Dialog>
  )
}

function RenameForm({ session, onClose, onSave }: { session: SessionInfo; onClose(): void; onSave(id: string, name: string, description: string): void | Promise<void> }) {
  const [name, setName] = useState(session.name)
  const [desc, setDesc] = useState(session.description)
  const input = 'w-full px-3 py-2 text-ui-input bg-[var(--surface-1)] border border-[var(--border)] rounded-[var(--r-md)] outline-none focus:border-[var(--accent)]'
  const btn = 'ctl px-3 rounded-[var(--r-md)] text-ui-sm'
  return (
    <form className="p-4 pt-2 space-y-3" onSubmit={e => { e.preventDefault(); if (!name.trim()) return; onSave(session.id, name, desc); onClose() }}>
      <label className="block space-y-1">
        <span className="text-ui-xs text-[var(--fg-muted)]">名称</span>
        <input autoFocus aria-label="名称" value={name} maxLength={128} onChange={e => setName(e.target.value)} className={input} />
      </label>
      <label className="block space-y-1">
        <span className="text-ui-xs text-[var(--fg-muted)]">描述</span>
        <input aria-label="描述" value={desc} maxLength={256} placeholder="这个会话在做什么?" onChange={e => setDesc(e.target.value)} className={input} />
      </label>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className={`${btn} text-[var(--fg-muted)] hover:bg-[var(--surface-hover)]`}>取消</button>
        <button type="submit" disabled={!name.trim()} className={`${btn} bg-[var(--accent)] text-[var(--on-accent)] disabled:opacity-50`}>保存</button>
      </div>
    </form>
  )
}
