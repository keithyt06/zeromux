import type { ReactElement, RefObject } from 'react'
import type { SessionInfo, SessionType } from '../lib/api'
import type { SessionControls } from '../lib/sessionControls'
import { sendTargets } from '../lib/sendTargets'
import { copyText } from '../lib/attachCommand'
import { Menu, confirm, toast, type MenuItem } from './ui'
import { TypeIcon } from './shell/TypeIcon'

type IconProps = { size?: number; className?: string }
// Stable per-type components (Menu renders `icon` as a component; an inline
// closure would remount every render).
const ICON: Record<SessionType, (p: IconProps) => ReactElement> = {
  claude: p => <TypeIcon type="claude" {...p} />,
  codex: p => <TypeIcon type="codex" {...p} />,
  crew: p => <TypeIcon type="crew" {...p} />,
  tmux: p => <TypeIcon type="tmux" {...p} />,
}

/** Last two path segments: enough to tell repos apart in a narrow menu. */
function shortDir(p: string): string {
  const parts = p.split('/').filter(Boolean)
  return parts.length <= 2 ? p : `…/${parts.slice(-2).join('/')}`
}

/** The one 「发给 agent」 menu (S3 §2.4 / V6): Git 「让 agent 处理」 and note ⚡.
 *  Sends over the target's already-mounted socket (sessionControls) — never opens
 *  a WS, never moves focus unless the user taps the toast's 「查看」. */
export function SendToMenu(p: {
  open: boolean; anchor: HTMLElement | null; onClose(): void
  text: string
  workDir: string | null; excludeId?: string
  sessions: SessionInfo[]; controls: RefObject<Record<string, SessionControls>>
  queueModes: Record<string, string>
  onSelectSession(id: string): void
  onNew(prefill: { workDir: string | null; prompt: string }): void
  /** Menu title (defaults to 「发给…」). */
  title?: string
  /** Irreversible prompts: after a target is picked, ask before sending (cancel = nothing sent).
   *  The dialog title gets 「→ 〈name〉(〈dir〉)」 appended so the target is explicit. */
  confirmDanger?: { title: string }
  /** Only agents whose work_dir === workDir are offered (repo-scoped prompts: commit / discard). */
  sameDirOnly?: boolean
}) {
  const send = async (s: SessionInfo) => {
    const { text, controls, confirmDanger, onSelectSession } = p
    if (confirmDanger && !(await confirm({ title: `${confirmDanger.title} → ${s.name}(${shortDir(s.work_dir)})`, confirmLabel: '发送', danger: true }))) return
    if (controls.current?.[s.id]?.sendPrompt(text, { withAttachments: false })) {
      toast.push({ message: `已发给 ${s.name}`, action: { label: '查看', onClick: () => onSelectSession(s.id) } })
    } else {
      toast.push({ message: '未连接,未发送', action: { label: '复制', onClick: async () => {
        if (!(await copyText(text))) toast.push({ message: '复制失败' })
      } } })
    }
  }
  const targets = p.open ? sendTargets(p.sessions, p.workDir, p.excludeId, p.sameDirOnly) : []
  const items: MenuItem[] = targets.map((s, i) => {
    const busy = s.turn_state === 'running'
    const mode = p.queueModes[s.id] ?? 'collect'
    const note = busy ? (mode === 'interrupt' ? '将打断' : '将排队') : null
    return {
      key: s.id,
      label: i === 0 ? `★ ${s.name}` : s.name,
      ariaLabel: `发给 ${s.name}`,
      icon: ICON[s.type],
      hint: <>{note && <span className="text-[var(--fg-muted)]">{note}</span>}<span className="truncate max-w-[120px]">{shortDir(s.work_dir)}</span></>,
      onSelect: () => { void send(s) },
    }
  })
  items.push({ key: '__new', label: '＋ 新开…', separatorBefore: items.length > 0, onSelect: () => p.onNew({ workDir: p.workDir, prompt: p.text }) })
  return (
    <Menu open={p.open} onClose={p.onClose} anchor={p.anchor} items={items} title={p.title ?? '发给…'}
      footer={<p className="px-3 py-1.5 border-t border-[var(--border-subtle)] text-ui-2xs text-[var(--fg-subtle)]">发送前请确认内容不含密钥</p>} />
  )
}
