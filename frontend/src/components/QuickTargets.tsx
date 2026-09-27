import { useState, useEffect, useCallback } from 'react'
import { MoreHorizontal, X, FileText, Folder, Terminal, Repeat, MessageSquarePlus } from 'lucide-react'
import type { SessionType, QuickTarget } from '../lib/api'
import { listQuickTargets, forgetQuickTarget } from '../lib/api'
import { coerceAgent } from '../lib/quickTargets'
import { subscribeQuickTargets } from '../lib/quickTargetsBus'
import { useLatestRequest } from '../lib/useLatestRequest'
import { ClaudeCodeIcon, CrewIcon, CodexIcon } from './BrandIcons'
import { IconButton, Menu, type MenuItem } from './ui'

/** 行首图标 = 这一行会开出什么。比行尾一个小写标签的信息量更高，且省下约 44px 宽度
 *  给目录名和 hint（224px 弹层里这是决定性的）。 */
export function RowIcon({ kind, agent, size = 15 }: { kind: 'dir' | 'note' | 'folder'; agent: string; size?: number }) {
  if (kind === 'folder') return <Folder size={size} className="text-[var(--accent-blue)] shrink-0" />
  if (kind === 'note') return <FileText size={size} className="text-[var(--accent-blue)] shrink-0" />
  switch (coerceAgent(agent)) {
    case 'claude': return <ClaudeCodeIcon size={size} className="shrink-0" />
    case 'crew':   return <CrewIcon size={size} className="shrink-0" />
    case 'codex':  return <CodexIcon size={size} className="shrink-0" />
    case 'tmux':   return <Terminal size={size} className="text-[var(--accent-green-text)] shrink-0" />
    default:       return <Terminal size={size} className="text-[var(--text-muted)] shrink-0" />
  }
}

/** 常用目录/笔记快速入口。一份实现服务三处：New Session 首屏、DirectoryPicker 顶部、
 *  VaultReader 的「最近打开」。kind 决定数据源与图标，其余行为一致。 */
export default function QuickTargets({ kind, onPick, onChangeAgent, onPickWithPrompt }: {
  kind: 'dir' | 'note'
  onPick: (path: string, agent: SessionType | null) => void
  onChangeAgent?: (path: string) => void
  onPickWithPrompt?: (path: string, agent: SessionType | null) => void
}) {
  const [items, setItems] = useState<QuickTarget[]>([])
  const [loaded, setLoaded] = useState(false)
  const [menu, setMenu] = useState<{ it: QuickTarget; anchor: HTMLElement } | null>(null)

  // 单调请求令牌。本组件同时具备「慢 GET」（JueceFS/S3 上的 per-row 守卫）与
  // 「乐观 mutation」（forget 先改本地 state 再 refetch）两个条件，正是本 repo 修过
  // 12 次的 stale-response clobber 场景：一个乐观写之前发出的旧 GET 迟到，会把刚
  // 移除的条目复活成 ghost。fetch 顶部 bump，每个乐观写前也 bump，await 后守卫。
  const req = useLatestRequest()

  const load = useCallback(async () => {
    const r = req.begin()
    try {
      const data = await listQuickTargets(kind)
      if (!req.isCurrent(r)) return
      setItems(data?.top ?? [])
    } catch {
      if (!req.isCurrent(r)) return
      // 快速入口是加速器：失败就安静地不显示，让用户回落到目录浏览，而不是弹错误
      // 挡住新建会话。
      setItems([])
    }
    if (req.isCurrent(r)) setLoaded(true)
  }, [kind, req])

  useEffect(() => { load() }, [load])
  // 事件驱动刷新：没有它，列表就是挂载时的静态快照（VaultReader 常驻挂载，会一直
  // 显示几小时前的顺序）。发射点精确镜像后端两处 bump。
  useEffect(() => subscribeQuickTargets(load), [load])

  const forget = useCallback(async (it: QuickTarget) => {
    req.bump()      // 使任何在途 GET 失效，否则旧快照会让这条复活成 ghost
    setItems(prev => prev.filter(x => !(x.path === it.path && x.agent === it.agent)))
    setMenu(null)
    try { await forgetQuickTarget(kind, it.path, it.agent) } catch { /* 下次 load 会纠正 */ }
    load()
  }, [kind, load, req])

  const pick = (it: QuickTarget) => {
    if (it.kind === 'note') { onPick(it.path, null); return }
    const agent = coerceAgent(it.agent)
    // agent 不合法（库里的旧类型已被移除）→ 交给调用方选类型，绝不把脏字符串当
    // SessionType 发出去。
    if (!agent) { onChangeAgent?.(it.path); return }
    onPick(it.path, agent)
  }

  // 操作单：破坏性操作下沉一层，这一层本身即确认（故不再加 confirm 弹窗）。
  const menuItems = (it: QuickTarget): MenuItem[] => [
    ...(it.kind === 'dir' && onChangeAgent ? [{ label: '换 agent 类型', icon: Repeat, onSelect: () => onChangeAgent(it.path) }] : []),
    ...(it.kind === 'dir' && onPickWithPrompt ? [{ label: '带 prompt 打开', icon: MessageSquarePlus, onSelect: () => onPickWithPrompt(it.path, coerceAgent(it.agent)) }] : []),
    { label: '从列表移除', icon: X, danger: true, onSelect: () => { forget(it) } },
  ]

  if (!loaded || items.length === 0) return null

  return (
    <>
    <ul className="border-b border-[var(--border)] max-h-72 overflow-y-auto">
      {items.map(it => {
        const key = `${it.path}|${it.agent}`
        return (
          <li key={key} className="border-b border-[var(--border)] last:border-b-0">
            <div className="flex items-stretch">
              {/* 整行 = 唯一主目标。min-h-[48px] 满足触控最小尺寸（v1 的 py-1.5 只有约 28px）。 */}
              <button
                type="button"
                onClick={() => pick(it)}
                className="flex items-start gap-2 flex-1 min-w-0 px-3 py-2 min-h-[48px] text-left hover:bg-[var(--bg-hover)] transition-colors"
                title={it.path}
              >
                <span className="mt-0.5"><RowIcon kind={it.kind} agent={it.agent} /></span>
                <span className="flex flex-col min-w-0 flex-1">
                  <span className="truncate text-xs text-[var(--text-primary)]">{it.display}</span>
                  {/* hint 独占第 2 行：内联时在 224px 下必被截成 "…"，而它唯一的作用
                      就是区分同名（vault 里多个 _index.md）。 */}
                  {it.hint && (
                    <span className="truncate text-ui-2xs text-[var(--text-muted)]">{it.hint}</span>
                  )}
                </span>
              </button>
              {/* 行级操作单入口，常显。刻意不用 opacity-0 group-hover:opacity-100 —— Tailwind v4
                  把它编译进 @media (hover:hover)，手机上整条规则不生效，元素会永久
                  opacity:0 但仍可点击（隐形按钮）。用户主设备是手机。 */}
              <span className="shrink-0 flex items-center pr-1">
                <IconButton
                  label="更多"
                  icon={MoreHorizontal}
                  size="sm"
                  data-testid="qt-menu"
                  aria-haspopup="menu"
                  aria-expanded={menu?.it === it}
                  onClick={e => { const anchor = e.currentTarget; setMenu(cur => (cur?.it === it ? null : { it, anchor })) }}
                />
              </span>
            </div>
          </li>
        )
      })}
    </ul>
    <Menu open={!!menu} onClose={() => setMenu(null)} anchor={menu?.anchor ?? null} items={menu ? menuItems(menu.it) : []} title={menu?.it.display} />
    </>
  )
}
