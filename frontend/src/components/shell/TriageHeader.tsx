import { useState } from 'react'
import { Search, Settings, Bell, Pencil, Clock, Users, LogOut, Check, Sun, Moon, Monitor, ClipboardCheck } from 'lucide-react'
import type { UserInfo } from '../../lib/api'
import type { ThemePref } from '../../lib/theme'
import { IconButton, Menu, StatusDot, Kbd, type MenuItem } from '../ui'

export type ShellPanel = 'admin' | 'scheduled' | 'push' | 'prompts'

/** Top of the triage queue: ⌘K entry, orphan confirmations (M11), scheduler
 *  health, and ⚙ — the only visible settings entry on phones (§0.5.4). */
export function TriageHeader({ user, narrow, orphanConfirms, schedulerHealthy, themePref, onSetThemePref, onOpenPalette, onOpenPanel, onLogout }: {
  user: UserInfo | null
  narrow: boolean
  orphanConfirms: number
  schedulerHealthy: boolean
  themePref: ThemePref
  onSetThemePref(p: ThemePref): void
  onOpenPalette(): void
  onOpenPanel(p: ShellPanel): void
  onLogout(): void
}) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const [open, setOpen] = useState(false)
  const theme = (p: ThemePref, label: string, icon: MenuItem['icon']): MenuItem =>
    ({ label: `主题:${label}`, icon: themePref === p ? Check : icon, onSelect: () => onSetThemePref(p) })
  const items: MenuItem[] = [
    { label: '推送设置', icon: Bell, onSelect: () => onOpenPanel('push') },
    { label: '常用 prompt', icon: Pencil, onSelect: () => onOpenPanel('prompts') },
    { label: '定时任务', icon: Clock, onSelect: () => onOpenPanel('scheduled') },
    ...(user?.role === 'admin' ? [{ label: '用户管理', icon: Users, onSelect: () => onOpenPanel('admin') }] : []),
    theme('system', '跟随系统', Monitor), theme('dark', '深色', Moon), theme('light', '浅色', Sun),
    { label: '退出登录', icon: LogOut, danger: true, onSelect: onLogout },
  ]
  return (
    <div className="shrink-0 border-b border-[var(--border-subtle)]">
      <div className="flex items-center gap-1 px-2 py-2">
        <button type="button" onClick={onOpenPalette}
          className={`flex-1 min-w-0 flex items-center gap-2 px-3 rounded-[var(--r-md)] border border-[var(--border)] bg-[var(--surface-2)] text-left text-[var(--fg-subtle)] hover:border-[var(--accent)] ${narrow ? 'min-h-[44px] text-ui-input' : 'ctl text-ui-sm'}`}>
          <Search size={14} className="shrink-0" />
          <span className="flex-1 truncate">搜索或命令…</span>
          {!narrow && <Kbd>⌘K</Kbd>}
        </button>
        {!schedulerHealthy && (
          <button type="button" onClick={() => onOpenPanel('scheduled')} aria-label="调度器异常"
            className="min-w-[var(--hit)] min-h-[var(--hit)] inline-flex items-center justify-center rounded-[var(--r-md)] hover:bg-[var(--surface-hover)]">
            <StatusDot tone="danger" label="调度器异常" />
          </button>
        )}
        <IconButton ref={setAnchor} label="设置" icon={Settings} onClick={() => setOpen(v => !v)} aria-haspopup="menu" aria-expanded={open} />
        <Menu open={open} onClose={() => setOpen(false)} anchor={anchor} items={items} title="设置" />
      </div>
      {orphanConfirms > 0 && (
        <button type="button" onClick={() => onOpenPanel('scheduled')}
          className="row w-full flex items-center gap-2 px-3 text-left text-ui-sm text-[var(--attention)] hover:bg-[var(--surface-hover)]">
          <ClipboardCheck size={14} className="shrink-0" />
          <span className="flex-1">{`定时待确认 (${orphanConfirms})`}</span>
        </button>
      )}
    </div>
  )
}
