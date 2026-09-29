import { useState } from 'react'
import { ArrowUp, ArrowDown, ChevronDown, CornerDownLeft, History, MoreHorizontal, Undo2, type LucideIcon } from 'lucide-react'
import { IconButton } from './ui'
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

// 第二页：第一页放不下的控制键，两行网格（每行 6 个），保证每键够宽。
const PAGE2: { key: BarKey; label: string }[] = [
  { key: 'esc', label: 'Esc' }, { key: 'tab', label: 'Tab' },
  { key: 'left', label: '←' }, { key: 'right', label: '→' },
  { key: 'ctrl-d', label: '^D' }, { key: 'ctrl-z', label: '^Z' },
  { key: 'pgup', label: 'PgUp' }, { key: 'pgdn', label: 'PgDn' },
  { key: 'ctrl-r', label: '^R' }, { key: 'ctrl-l', label: '^L' },
  { key: 'home', label: 'Home' }, { key: 'end', label: 'End' },
]

// 所有键 min-h 取 --hit（触屏 44px）。
const btnCls =
  'flex-1 flex items-center justify-center min-h-[var(--hit)] rounded-md bg-[var(--bg-primary)] border border-[var(--border)] text-[var(--text-secondary)] active:bg-[var(--bg-hover)] active:text-[var(--text-primary)]'

export default function MobileKeyBar({ onKey, onHistory, collapsed = false, onToggleCollapsed }: {
  onKey: (key: BarKey) => void; onHistory?: () => void
  /** 收起态只渲染一个「⌃ 键栏」入口（由调用方放在 composer 同一行）。 */
  collapsed?: boolean; onToggleCollapsed?: () => void
}) {
  const [page, setPage] = useState(0)
  // 切换键用 onClick（键盘可达）；pointerDown 只 preventDefault，不抢焦点 / 不弹软键盘。
  if (collapsed) {
    return (
      <button type="button" aria-expanded={false} onPointerDown={(e) => e.preventDefault()} onClick={onToggleCollapsed}
        style={{ touchAction: 'manipulation' }}
        className="shrink-0 flex items-center justify-center min-h-[var(--hit)] px-3 rounded-md bg-[var(--bg-primary)] border border-[var(--border)] text-ui-xs text-[var(--text-secondary)] active:bg-[var(--bg-hover)]">
        ⌃ 键栏
      </button>
    )
  }
  // onPointerDown + preventDefault：手机上避免按钮抢走终端焦点 / 触发软键盘。
  return (
    <div className="flex items-stretch gap-1 px-2 py-1.5 border-t border-[var(--border)] bg-[var(--bg-secondary)]">
      {onHistory && (
        <button aria-label="history" onPointerDown={(e) => { e.preventDefault(); onHistory() }}
          style={{ touchAction: 'manipulation' }} className={btnCls}><History size={18} /></button>
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
              className={`${btnCls} text-ui-xs font-mono`}
            >
              {label}
            </button>
          ))}
        </>
      ) : (
        <div data-testid="keybar-page2" className="flex-[6] grid grid-cols-6 gap-1">
          {PAGE2.map(({ key, label }) => (
            <button
              key={key}
              aria-label={key}
              onPointerDown={(e) => { e.preventDefault(); onKey(key) }}
              style={{ touchAction: 'manipulation' }}
              className={`${btnCls} text-ui-xs font-mono`}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      <button aria-label="more-keys" onPointerDown={(e) => { e.preventDefault(); setPage(p => 1 - p) }}
        style={{ touchAction: 'manipulation' }} className={btnCls}>
        {page === 0 ? <MoreHorizontal size={18} /> : <Undo2 size={18} />}
      </button>
      {onToggleCollapsed && (
        <IconButton label="收起键栏" icon={ChevronDown} aria-expanded={true} className="shrink-0"
          onPointerDown={(e) => e.preventDefault()} onClick={onToggleCollapsed} style={{ touchAction: 'manipulation' }} />
      )}
    </div>
  )
}
