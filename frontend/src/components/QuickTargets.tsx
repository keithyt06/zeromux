import { useState, useEffect, useCallback, useRef } from 'react'
import { MoreVertical, X, FileText, Folder, Terminal, Repeat, MessageSquarePlus } from 'lucide-react'
import type { SessionType, QuickTarget } from '../lib/api'
import { listQuickTargets, forgetQuickTarget } from '../lib/api'
import { coerceAgent } from '../lib/quickTargets'
import { subscribeQuickTargets } from '../lib/quickTargetsBus'
import { ClaudeCodeIcon, CrewIcon, CodexIcon } from './BrandIcons'

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
  const [openMenu, setOpenMenu] = useState<string | null>(null)   // path|agent 的 key

  // 单调请求令牌。本组件同时具备「慢 GET」（JueceFS/S3 上的 per-row 守卫）与
  // 「乐观 mutation」（forget 先改本地 state 再 refetch）两个条件，正是本 repo 修过
  // 12 次的 stale-response clobber 场景：一个乐观写之前发出的旧 GET 迟到，会把刚
  // 移除的条目复活成 ghost。fetch 顶部 bump，每个乐观写前也 bump，await 后守卫。
  const reqRef = useRef(0)

  const load = useCallback(async () => {
    const req = ++reqRef.current
    try {
      const data = await listQuickTargets(kind)
      if (reqRef.current !== req) return
      setItems(data?.top ?? [])
    } catch {
      if (reqRef.current !== req) return
      // 快速入口是加速器：失败就安静地不显示，让用户回落到目录浏览，而不是弹错误
      // 挡住新建会话。
      setItems([])
    }
    if (reqRef.current === req) setLoaded(true)
  }, [kind])

  useEffect(() => { load() }, [load])
  // 事件驱动刷新：没有它，列表就是挂载时的静态快照（VaultReader 常驻挂载，会一直
  // 显示几小时前的顺序）。发射点精确镜像后端两处 bump。
  useEffect(() => subscribeQuickTargets(load), [load])

  const forget = useCallback(async (it: QuickTarget) => {
    reqRef.current++      // 使任何在途 GET 失效，否则旧快照会让这条复活成 ghost
    setItems(prev => prev.filter(x => !(x.path === it.path && x.agent === it.agent)))
    setOpenMenu(null)
    try { await forgetQuickTarget(kind, it.path, it.agent) } catch { /* 下次 load 会纠正 */ }
    load()
  }, [kind, load])

  const pick = (it: QuickTarget) => {
    if (it.kind === 'note') { onPick(it.path, null); return }
    const agent = coerceAgent(it.agent)
    // agent 不合法（库里的旧类型已被移除）→ 交给调用方选类型，绝不把脏字符串当
    // SessionType 发出去。
    if (!agent) { onChangeAgent?.(it.path); return }
    onPick(it.path, agent)
  }

  if (!loaded || items.length === 0) return null

  return (
    <ul className="border-b border-[var(--border)] max-h-72 overflow-y-auto">
      {items.map(it => {
        const key = `${it.path}|${it.agent}`
        return (
          <li key={key} className="relative border-b border-[var(--border)] last:border-b-0">
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
                    <span className="truncate text-[10px] text-[var(--text-muted)]">{it.hint}</span>
                  )}
                </span>
              </button>
              {/* 行级操作单入口。刻意不用 opacity-0 group-hover:opacity-100 —— Tailwind v4
                  把它编译进 @media (hover:hover)，手机上整条规则不生效，元素会永久
                  opacity:0 但仍可点击（隐形按钮）。用户主设备是手机。 */}
              <button
                type="button"
                data-testid="qt-menu"
                onClick={() => setOpenMenu(cur => (cur === key ? null : key))}
                className="shrink-0 w-8 flex items-center justify-center text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                title="更多操作"
              >
                <MoreVertical size={14} />
              </button>
            </div>

            {/* 展开的操作单：每项 ≥44px 整行 + 文字标签。破坏性操作下沉一层，
                这一层本身即确认（故不再加 confirm 弹窗）。 */}
            {openMenu === key && (
              <div className="border-t border-[var(--border)] bg-[var(--bg-secondary)]">
                {it.kind === 'dir' && onChangeAgent && (
                  <button
                    type="button"
                    data-testid="qt-changeagent"
                    onClick={() => { setOpenMenu(null); onChangeAgent(it.path) }}
                    className="flex items-center gap-2 w-full px-3 py-2.5 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                  >
                    <Repeat size={13} className="shrink-0" />换 agent 类型
                  </button>
                )}
                {it.kind === 'dir' && onPickWithPrompt && (
                  <button
                    type="button"
                    data-testid="qt-withprompt"
                    onClick={() => { setOpenMenu(null); onPickWithPrompt(it.path, coerceAgent(it.agent)) }}
                    className="flex items-center gap-2 w-full px-3 py-2.5 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                  >
                    <MessageSquarePlus size={13} className="shrink-0" />带 prompt 打开
                  </button>
                )}
                <button
                  type="button"
                  data-testid="qt-forget"
                  onClick={() => forget(it)}
                  className="flex items-center gap-2 w-full px-3 py-2.5 text-[11px] text-[var(--text-secondary)] hover:text-[var(--accent-red)] hover:bg-[var(--bg-hover)]"
                >
                  <X size={13} className="shrink-0" />从列表移除
                </button>
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}
