import { useEffect, useRef, useState } from 'react'
import { MoreHorizontal } from 'lucide-react'
import type { SessionInfo } from '../lib/api'
import { attachCommand, copyText } from '../lib/attachCommand'

interface Props { session: SessionInfo; onRename: () => void; onClose: () => void; onHistory?: () => void }

// Always-visible ⋯ (hover-only X was invisible on touch). No swipe-to-close: it
// fights the sidebar drawer and iOS back gestures.
export default function SessionRowMenu({ session, onRename, onClose, onHistory }: Props) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const off = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', off)
    return () => document.removeEventListener('pointerdown', off)
  }, [open])
  const item = 'block w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--bg-hover)]'
  return (
    <div ref={ref} className="relative shrink-0" onClick={e => e.stopPropagation()}>
      <button aria-label="会话菜单" onClick={() => setOpen(v => !v)}
        className="p-0.5 text-[var(--text-muted)] hover:text-[var(--text-primary)]">
        <MoreHorizontal size={13} />
      </button>
      {open && (
        <div className="absolute right-0 top-5 z-30 min-w-[9rem] py-1 rounded border border-[var(--border)] bg-[var(--bg-secondary)] shadow-lg">
          {session.tmux_name && (
            <button className={item} onClick={async () => { setCopied(await copyText(attachCommand(session.tmux_name!))); setTimeout(() => setOpen(false), 600) }}>
              {copied ? '已复制' : '复制接续命令'}
            </button>
          )}
          <button className={item} onClick={() => { setOpen(false); onRename() }}>重命名</button>
          {session.tmux_name && onHistory && <button className={item} onClick={() => { setOpen(false); onHistory() }}>查看历史</button>}
          <button className={`${item} text-[var(--accent-red)]`} onClick={() => { setOpen(false); onClose() }}>关闭</button>
        </div>
      )}
    </div>
  )
}
