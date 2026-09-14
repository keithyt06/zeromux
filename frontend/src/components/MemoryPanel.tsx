import { useState, useEffect, useCallback, useRef } from 'react'
import { Brain, X, RefreshCw, AlertCircle } from 'lucide-react'
import type { CrewMemory } from '../lib/api'
import { getCrewMemory, putCrewSemantic, deleteCrewSemantic, putCrewMemoryDoc } from '../lib/api'
import { normalizeMemoryKey, parseSemanticValue, mdLines, dropMdLine } from '../lib/crewMemory'

/** 第 5 个 overlay view。记忆在 Crew 侧是全局的（一份 Gateway 一份记忆），所以
 *  本组件不接 sessionId —— 从任意 Crew 会话打开看到的是同一份数据。 */
export default function MemoryPanel() {
  const [mem, setMem] = useState<CrewMemory | null>(null)
  const [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // 待确认删除的行 key（semantic 用 entry.key，markdown 行用 `doc:行号`）。
  // 二段确认：点 ✕ → 该行下沉展开「确认移除」，不用 window.confirm（手机体验差）。
  const [confirming, setConfirming] = useState<string | null>(null)

  // 单调请求令牌。本面板同时具备「慢 GET」（后端要并发四个上游请求 + 可能 re-mint
  // token）与「乐观 mutation」（写入/删除先改本地 state 再 refetch）两个条件，正是
  // 本 repo 修过十余次的 stale-response clobber 场景。fetch 顶部 bump，每个乐观写
  // 前也 bump，await 后守卫。
  const reqRef = useRef(0)

  const load = useCallback(async () => {
    const req = ++reqRef.current
    setLoading(true)
    try {
      const data = await getCrewMemory()
      if (reqRef.current !== req) return
      setMem(data)
      setErr(null)
    } catch (e) {
      if (reqRef.current !== req) return
      setErr(e instanceof Error ? e.message : String(e))
    }
    if (reqRef.current === req) setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const remember = useCallback(async () => {
    const text = draft.trim()
    if (!text || saving) return
    setSaving(true)
    setErr(null)
    try {
      const { key, value } = normalizeMemoryKey(text)
      await putCrewSemantic(key, value)
      reqRef.current++   // 使任何在途 GET 失效，否则写入前的快照会盖掉新行
      setMem(prev => prev && ({
        ...prev,
        semantic: [{
          key, value_json: JSON.stringify(value), confidence: 1.0,
          source: 'user_explicit', created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(), is_deleted: 0,
        }, ...prev.semantic],
      }))
      setDraft('')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
    setSaving(false)
  }, [draft, saving])

  const removeSemantic = useCallback(async (key: string) => {
    setConfirming(null)
    reqRef.current++
    setMem(prev => prev && ({ ...prev, semantic: prev.semantic.filter(e => e.key !== key) }))
    try { await deleteCrewSemantic(key) } catch { /* 下次 load 会纠正 */ }
    load()
  }, [load])

  // markdown 层（preferences / projects）没有 per-line DELETE：Gateway 的 PUT 是
  // 整文件。所以「删一行」= 本地重组 markdown 后整体 PUT。这也是为什么「让它记住」
  // 写 semantic 而非 preferences —— semantic 有真正的 DELETE /{key}，长期可纠正性更好。
  const removeDocLine = useCallback(async (doc: 'preferences' | 'projects', idx: number) => {
    setConfirming(null)
    const cur = mem?.[doc] ?? ''
    const next = dropMdLine(cur, idx)
    reqRef.current++
    setMem(prev => prev && ({ ...prev, [doc]: next }))
    try { await putCrewMemoryDoc(doc, next) } catch { /* 下次 load 会纠正 */ }
    load()
  }, [mem, load])

  const semantic = mem?.semantic ?? []
  const prefLines = mdLines(mem?.preferences ?? '')
  const projLines = mdLines(mem?.projects ?? '')
  const lessons = mem?.lessons ?? []
  // 读不到（gateway_ok:false）与真的空是**两种完全不同的含义**。降级时后端把四个
  // 分区都回空，所以「全空」这个判据在降级下必然成立 —— 若不先排除它，用户看到的
  // 是黄条底下压着「它还什么都没记住」，会以为记忆被清空；而且此刻那个写入表单必然
  // 失败（Gateway 就是不可达），等于一个点了没反应的死控件。
  const degraded = !!mem && !mem.gateway_ok
  const isEmpty = !degraded && semantic.length === 0 && prefLines.length === 0
    && projLines.length === 0 && lessons.length === 0

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 h-9 border-b border-[var(--border)] bg-[var(--bg-secondary)] shrink-0">
        <span className="flex items-center gap-1.5 text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">
          <Brain size={12} className="text-[var(--accent-purple)]" />
          Agent 记忆
        </span>
        <button
          onClick={load}
          aria-label="refresh memory"
          className="p-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)] rounded transition-colors"
          title="刷新"
        >
          <RefreshCw size={12} />
        </button>
      </div>

      {mem && !mem.gateway_ok && (
        <div className="flex items-start gap-1.5 px-3 py-2 text-[11px] text-[var(--accent-yellow)] border-b border-[var(--border)]">
          <AlertCircle size={13} className="shrink-0 mt-0.5" />
          <span>Gateway 未响应，暂时读不到记忆。会话仍可用，稍后点右上角刷新。</span>
        </div>
      )}
      {err && (
        <div className="flex items-start gap-1.5 px-3 py-2 text-[11px] text-[var(--accent-red)] border-b border-[var(--border)]">
          <AlertCircle size={13} className="shrink-0 mt-0.5" />
          <span className="break-words">{err}</span>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {loading && !mem ? (
          <div className="p-4 text-center text-[10px] text-[var(--text-muted)]">Loading…</div>
        ) : degraded ? (
          /* 降级：上方黄条已说明原因，正文不再摆任何控件 —— 写入必然失败。 */
          null
        ) : isEmpty ? (
          /* 空状态是本设计最重要的一屏：今天记忆必然是空的，只做「查看」的面板
             打开是空的，用户会直接判定这个功能是假的。所以空态本身就是写入表单。 */
          <div className="flex flex-col items-center justify-center h-full px-6 gap-3">
            <Brain size={28} className="text-[var(--text-muted)]" />
            <p className="text-sm text-[var(--text-primary)] text-center">它还什么都没记住</p>
            <p className="text-[11px] text-[var(--text-muted)] text-center leading-relaxed">
              写一条你不想再重复说的事。下一轮起它会自动带上。
            </p>
            <input
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); remember() } }}
              placeholder="例：提交前必须先跑 npm test"
              /* text-base = 16px：低于 16px 时 iOS Safari 聚焦会自动放大整页。 */
              className="w-full text-base bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg px-3 py-2 min-h-[44px] text-[var(--text-primary)] outline-none focus:border-[var(--accent-purple)] placeholder-[var(--text-muted)]"
            />
            <button
              onClick={remember}
              disabled={!draft.trim() || saving}
              className="w-full min-h-[44px] rounded-lg bg-[var(--accent-purple)] disabled:bg-[var(--btn-disabled-bg)] disabled:text-[var(--btn-disabled-text)] text-white text-sm font-medium transition-colors"
            >
              {saving ? '写入中…' : '记住这条'}
            </button>
          </div>
        ) : (
          <>
            {/* 常驻写入行：非空态也要能就地加，不必回对话页。 */}
            <div className="flex gap-2 px-3 py-2 border-b border-[var(--border)]">
              <input
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); remember() } }}
                placeholder="让它记住…"
                className="flex-1 min-w-0 text-base bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg px-3 py-2 min-h-[44px] text-[var(--text-primary)] outline-none focus:border-[var(--accent-purple)] placeholder-[var(--text-muted)]"
              />
              <button
                onClick={remember}
                disabled={!draft.trim() || saving}
                className="shrink-0 px-3 min-h-[44px] rounded-lg bg-[var(--accent-purple)] disabled:bg-[var(--btn-disabled-bg)] disabled:text-[var(--btn-disabled-text)] text-white text-xs font-medium transition-colors"
              >
                记住
              </button>
            </div>

            <Section title="语义记忆" count={semantic.length}>
              {semantic.map(e => (
                <MemoryRow
                  key={e.key}
                  label={e.key.replace(/^(pref|project|user|lesson)\./, '')}
                  value={parseSemanticValue(e.value_json)}
                  meta={`信度 ${e.confidence.toFixed(1)} · ${e.source}`}
                  confirming={confirming === e.key}
                  onAsk={() => setConfirming(cur => cur === e.key ? null : e.key)}
                  onConfirm={() => removeSemantic(e.key)}
                />
              ))}
            </Section>

            <Section title="偏好（markdown）" count={prefLines.length}>
              {prefLines.map((line, i) => {
                const k = `preferences:${i}`
                return (
                  <MemoryRow
                    key={k}
                    label={line}
                    meta="preferences.md"
                    confirming={confirming === k}
                    onAsk={() => setConfirming(cur => cur === k ? null : k)}
                    onConfirm={() => removeDocLine('preferences', i)}
                  />
                )
              })}
            </Section>

            <Section title="项目上下文（markdown）" count={projLines.length}>
              {projLines.map((line, i) => {
                const k = `projects:${i}`
                return (
                  <MemoryRow
                    key={k}
                    label={line}
                    meta="projects.md"
                    confirming={confirming === k}
                    onAsk={() => setConfirming(cur => cur === k ? null : k)}
                    onConfirm={() => removeDocLine('projects', i)}
                  />
                )
              })}
            </Section>

            {/* 教训只读：Crew 侧无 per-lesson DELETE 端点，别给一个点了没反应的 ✕。 */}
            <Section title="教训（只读）" count={lessons.length}>
              {lessons.map(l => (
                <div key={l.id} className="px-3 py-2 min-h-[44px] border-b border-[var(--border)] last:border-b-0">
                  <p className="text-[11px] text-[var(--text-primary)] break-words leading-snug">{l.text}</p>
                  <p className="text-[9px] text-[var(--text-muted)] mt-0.5">{l.created_at.slice(0, 16)}</p>
                </div>
              ))}
            </Section>
          </>
        )}
      </div>
    </div>
  )
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  if (count === 0) return null
  return (
    <div>
      <div className="px-3 py-1.5 bg-[var(--bg-secondary)] border-b border-[var(--border)]">
        <span className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">
          {title} ({count})
        </span>
      </div>
      {children}
    </div>
  )
}

/** 一行记忆 + 常驻 ✕（绝不用 group-hover：Tailwind v4 把它编译进
 *  `@media (hover:hover)`，手机上元素永久 opacity:0 但仍可点击 = 隐形按钮。
 *  SessionInfoBar 的旧 NoteItem 和 AgentDashboard 的 EventRow 都犯了这个错）。 */
function MemoryRow({ label, value, meta, confirming, onAsk, onConfirm }: {
  label: string
  value?: string
  meta: string
  confirming: boolean
  onAsk: () => void
  onConfirm: () => void
}) {
  return (
    <div className="border-b border-[var(--border)] last:border-b-0">
      <div className="flex items-start gap-2 px-3 py-2 min-h-[44px]">
        <div className="flex-1 min-w-0">
          <p className="text-[11px] text-[var(--text-primary)] break-words leading-snug">
            {label}{value != null && <span className="text-[var(--accent-purple)]"> = {value}</span>}
          </p>
          <p className="text-[9px] text-[var(--text-muted)] mt-0.5">{meta}</p>
        </div>
        <button
          onClick={onAsk}
          data-testid="mem-remove"
          aria-label={`remove ${label}`}
          className="shrink-0 w-8 min-h-[44px] -my-2 flex items-center justify-center text-[var(--text-secondary)] hover:text-[var(--accent-red)] transition-colors"
          title="移除这条记忆"
        >
          <X size={14} />
        </button>
      </div>
      {/* 二段确认：破坏性操作下沉一层，这一层本身即确认（照 QuickTargets 行级操作单）。 */}
      {confirming && (
        <div className="border-t border-[var(--border)] bg-[var(--bg-secondary)]">
          <button
            data-testid="mem-remove-confirm"
            onClick={onConfirm}
            className="flex items-center gap-2 w-full px-3 py-2.5 min-h-[44px] text-[11px] text-[var(--text-secondary)] hover:text-[var(--accent-red)] hover:bg-[var(--bg-hover)]"
          >
            <X size={13} className="shrink-0" />确认移除，让它忘掉
          </button>
        </div>
      )}
    </div>
  )
}
