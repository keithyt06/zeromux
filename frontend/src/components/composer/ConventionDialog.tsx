import { useState } from 'react'
import { Dialog, Sheet } from '../ui'
import { useIsNarrow } from '../../lib/useMediaQuery'

/** 「记为约定…」 editor (F4). `onSend` false = not sent (socket closed): stay open, keep text. */
export function ConventionDialog({ open, initial, onClose, onSend }: {
  open: boolean; initial: string; onClose(): void; onSend(text: string): boolean
}) {
  const narrow = useIsNarrow()
  if (!open) return null
  const body = <ConventionForm initial={initial} onClose={onClose} onSend={onSend} />
  return narrow
    ? <Sheet open side="bottom" onClose={onClose} title="记为约定">{body}</Sheet>
    : <Dialog open onClose={onClose} title="记为约定">{body}</Dialog>
}

function ConventionForm({ initial, onClose, onSend }: { initial: string; onClose(): void; onSend(text: string): boolean }) {
  const [text, setText] = useState(initial)
  const btn = 'min-h-[var(--hit)] px-3 rounded-[var(--r-md)] text-ui-sm'
  return (
    <form className="p-4 pt-2 space-y-3" onSubmit={e => { e.preventDefault(); if (text.trim() && onSend(text.trim())) onClose() }}>
      <textarea aria-label="约定内容" value={text} rows={4} onChange={e => setText(e.target.value)}
        className="w-full px-3 py-2 text-ui-input bg-[var(--surface-1)] border border-[var(--border)] rounded-[var(--r-md)] outline-none focus:border-[var(--accent)] resize-y" />
      <p className="text-ui-2xs text-[var(--fg-subtle)]">会让当前 agent 把这条约定追加到仓库根的 CLAUDE.md（若有 AGENTS.md 同步写入）。隔离会话写入的是 worktree，合并后生效。</p>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className={`${btn} text-[var(--fg-muted)] hover:bg-[var(--surface-hover)]`}>取消</button>
        <button type="submit" disabled={!text.trim()} className={`${btn} bg-[var(--accent)] text-[var(--on-accent)] disabled:opacity-50`}>发送给 agent</button>
      </div>
    </form>
  )
}
