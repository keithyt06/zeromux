import { ArrowUp, ArrowDown, type LucideIcon } from 'lucide-react'
import type { AgentKey } from '../lib/terminalInput'

export type BarKey = 'up' | 'down' | 'ctrl-c' | AgentKey

// 方向键用图标；^C 与 agent 启动键用文字标签。aria-label 用逻辑键名，便于测试与无障碍。
// 不放 Enter：手机端文字走常驻 composer 的发送键，KeyBar 的 Enter 会与之重复。
const ARROW_KEYS: { key: 'up' | 'down'; Icon: LucideIcon }[] = [
  { key: 'up', Icon: ArrowUp },
  { key: 'down', Icon: ArrowDown },
]

const CONTROL_KEYS: { key: 'ctrl-c'; label: string }[] = [
  { key: 'ctrl-c', label: '^C' },
]

const AGENT_KEYS: { key: AgentKey; label: string }[] = [
  { key: 'claude', label: 'claude' },
  { key: 'codex', label: 'codex' },
  { key: 'kiro', label: 'kiro' },
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
      {[...CONTROL_KEYS, ...AGENT_KEYS].map(({ key, label }) => (
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
