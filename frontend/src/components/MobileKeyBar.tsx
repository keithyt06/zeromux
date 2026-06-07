import { ArrowUp, ArrowDown, ArrowLeft, ArrowRight, CornerDownLeft, type LucideIcon } from 'lucide-react'
import type { ArrowKey, ControlKey } from '../lib/terminalInput'

export type BarKey = ArrowKey | ControlKey

// 方向键/Enter 用图标；控制键用文字标签。aria-label 用逻辑键名，便于测试与无障碍。
const ARROW_KEYS: { key: ArrowKey; Icon: LucideIcon }[] = [
  { key: 'left', Icon: ArrowLeft },
  { key: 'up', Icon: ArrowUp },
  { key: 'down', Icon: ArrowDown },
  { key: 'right', Icon: ArrowRight },
  { key: 'enter', Icon: CornerDownLeft },
]

const CONTROL_KEYS: { key: ControlKey; label: string }[] = [
  { key: 'esc', label: 'Esc' },
  { key: 'ctrl-c', label: '^C' },
  { key: 'y', label: 'y' },
  { key: 'n', label: 'n' },
]

export default function MobileKeyBar({ onKey }: { onKey: (key: BarKey) => void }) {
  // onPointerDown + preventDefault：手机上避免按钮抢走终端焦点 / 触发软键盘。
  const btnCls =
    'flex-1 flex items-center justify-center py-2 rounded-md bg-[var(--bg-primary)] border border-[var(--border)] text-[var(--text-secondary)] active:bg-[var(--bg-hover)] active:text-[var(--text-primary)]'
  return (
    <div className="flex items-stretch gap-1 px-2 py-1.5 border-t border-[var(--border)] bg-[var(--bg-secondary)]">
      {ARROW_KEYS.map(({ key, Icon }) => (
        <button
          key={key}
          aria-label={key}
          onPointerDown={(e) => { e.preventDefault(); onKey(key) }}
          style={{ touchAction: 'manipulation' }}
          className={btnCls}
        >
          <Icon size={18} />
        </button>
      ))}
      {CONTROL_KEYS.map(({ key, label }) => (
        <button
          key={key}
          aria-label={key}
          onPointerDown={(e) => { e.preventDefault(); onKey(key) }}
          style={{ touchAction: 'manipulation' }}
          className={`${btnCls} text-xs font-mono`}
        >
          {label}
        </button>
      ))}
    </div>
  )
}
