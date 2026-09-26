import { useState } from 'react'
import { ArrowUp, ArrowDown, CornerDownLeft, type LucideIcon } from 'lucide-react'
import type { AgentKey, ControlKey } from '../lib/terminalInput'

export type BarKey = 'up' | 'down' | 'left' | 'right' | 'enter' | ControlKey | AgentKey

// 方向键 + Enter 用图标；^C 与 agent 启动键用文字标签。aria-label 用逻辑键名，便于测试与无障碍。
// Enter 直发 \r，供 CLI 菜单（如 claude code 的 ↑↓ 选项）确认选择——这类场景无正文可走 composer 发送键。
const ARROW_KEYS: { key: 'up' | 'down' | 'enter'; Icon: LucideIcon }[] = [
  { key: 'up', Icon: ArrowUp },
  { key: 'down', Icon: ArrowDown },
  { key: 'enter', Icon: CornerDownLeft },
]

const CONTROL_KEYS: { key: 'ctrl-c'; label: string }[] = [
  { key: 'ctrl-c', label: '^C' },
]

const AGENT_KEYS: { key: AgentKey; label: string }[] = [
  { key: 'claude', label: 'claude' },
  { key: 'codex', label: 'codex' },
  { key: 'crew', label: 'crew' },
]

// 第二页：Esc/Tab/←→/^D/^Z/PgUp/PgDn —— 第一页放不下的控制键。
const PAGE2: { key: BarKey; label: string }[] = [
  { key: 'esc', label: 'Esc' }, { key: 'tab', label: 'Tab' },
  { key: 'left', label: '←' }, { key: 'right', label: '→' },
  { key: 'ctrl-d', label: '^D' }, { key: 'ctrl-z', label: '^Z' },
  { key: 'pgup', label: 'PgUp' }, { key: 'pgdn', label: 'PgDn' },
]

export default function MobileKeyBar({ onKey, onHistory }: { onKey: (key: BarKey) => void; onHistory?: () => void }) {
  const [page, setPage] = useState(0)
  // onPointerDown + preventDefault：手机上避免按钮抢走终端焦点 / 触发软键盘。
  const btnCls =
    'flex-1 flex items-center justify-center py-2 rounded-md bg-[var(--bg-primary)] border border-[var(--border)] text-[var(--text-secondary)] active:bg-[var(--bg-hover)] active:text-[var(--text-primary)]'
  return (
    <div className="flex items-stretch gap-1 px-2 py-1.5 border-t border-[var(--border)] bg-[var(--bg-secondary)]">
      {onHistory && (
        <button aria-label="history" onPointerDown={(e) => { e.preventDefault(); onHistory() }}
          style={{ touchAction: 'manipulation' }} className={`${btnCls} text-base`}>📜</button>
      )}
      {page === 0 ? (
        <>
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
        </>
      ) : (
        PAGE2.map(({ key, label }) => (
          <button
            key={key}
            aria-label={key}
            onPointerDown={(e) => { e.preventDefault(); onKey(key) }}
            style={{ touchAction: 'manipulation' }}
            className={`${btnCls} text-xs font-mono`}
          >
            {label}
          </button>
        ))
      )}
      <button aria-label="more-keys" onPointerDown={(e) => { e.preventDefault(); setPage(p => 1 - p) }}
        style={{ touchAction: 'manipulation' }} className={`${btnCls} text-xs`}>{page === 0 ? '⋯' : '↩︎'}</button>
    </div>
  )
}
