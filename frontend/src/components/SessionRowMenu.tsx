import { useState } from 'react'
import { MoreHorizontal } from 'lucide-react'
import type { SessionInfo } from '../lib/api'
import { attachCommand, copyText } from '../lib/attachCommand'
import { IconButton, Menu, toast, type MenuItem } from './ui'

interface Props { session: SessionInfo; onRename: () => void; onClose: () => void; onHistory?: () => void }

// Always-visible ⋯ (hover-only X was invisible on touch). No swipe-to-close: it
// fights the sidebar drawer and iOS back gestures.
export default function SessionRowMenu({ session, onRename, onClose, onHistory }: Props) {
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const items: MenuItem[] = [
    ...(session.tmux_name ? [{ label: '复制接续命令', onSelect: async () => {
      toast.push({ message: (await copyText(attachCommand(session.tmux_name!))) ? '已复制接续命令' : '复制失败' })
    } }] : []),
    { label: '重命名', onSelect: onRename },
    ...(session.tmux_name && onHistory ? [{ label: '查看历史', onSelect: onHistory }] : []),
    { label: '关闭', danger: true, onSelect: onClose },
  ]
  return (
    <div className="shrink-0" onClick={e => e.stopPropagation()}>
      <IconButton ref={setAnchor} label="会话菜单" icon={MoreHorizontal} size="sm" onClick={() => setOpen(v => !v)}
        aria-haspopup="menu" aria-expanded={open} />
      <Menu open={open} onClose={() => setOpen(false)} anchor={anchor} items={items} title={session.name} />
    </div>
  )
}
