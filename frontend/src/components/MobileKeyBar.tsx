import { ArrowUp, ArrowDown, ArrowLeft, ArrowRight, CornerDownLeft, type LucideIcon } from 'lucide-react'
import type { ArrowKey } from '../lib/terminalInput'

// 顺序：← ↑ ↓ → Enter（与 spec 一致）。aria-label 用逻辑键名，便于测试与无障碍。
const KEYS: { key: ArrowKey; Icon: LucideIcon }[] = [
  { key: 'left', Icon: ArrowLeft },
  { key: 'up', Icon: ArrowUp },
  { key: 'down', Icon: ArrowDown },
  { key: 'right', Icon: ArrowRight },
  { key: 'enter', Icon: CornerDownLeft },
]

export default function MobileKeyBar({ onKey }: { onKey: (key: ArrowKey) => void }) {
  return (
    <div className="flex items-stretch gap-1 px-2 py-1.5 border-t border-[var(--border)] bg-[var(--bg-secondary)]">
      {KEYS.map(({ key, Icon }) => (
        <button
          key={key}
          aria-label={key}
          // onPointerDown + preventDefault：手机上避免按钮抢走终端焦点 / 触发软键盘。
          onPointerDown={(e) => {
            e.preventDefault()
            onKey(key)
          }}
          style={{ touchAction: 'manipulation' }}
          className="flex-1 flex items-center justify-center py-2 rounded-md bg-[var(--bg-primary)] border border-[var(--border)] text-[var(--text-secondary)] active:bg-[var(--bg-hover)] active:text-[var(--text-primary)]"
        >
          <Icon size={18} />
        </button>
      ))}
    </div>
  )
}
