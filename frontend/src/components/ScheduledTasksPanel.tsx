import { useState, useEffect, useCallback } from 'react'
import { X, Play, Pencil, Trash2, Plus, History, ChevronLeft, Folder } from 'lucide-react'
import DirectoryPicker from './DirectoryPicker'
import type { ScheduledTask, TaskRun, ScheduleInput, ScheduledTaskReq } from '../lib/api'
import {
  listScheduledTasks,
  createScheduledTask,
  updateScheduledTask,
  deleteScheduledTask,
  runScheduledTaskNow,
  listTaskRuns,
  listConfirmations,
  confirmRunDone,
  replayRun,
} from '../lib/api'
import { useLatestRequest } from '../lib/useLatestRequest'
import { Sheet, confirm } from './ui'

interface Props {
  open: boolean
  onClose: () => void
}

type View = 'list' | 'form' | 'history'

// Mon..Sun mapped to cron weekday numbers (0=Sun..6=Sat)
const WEEKDAYS: { label: string; value: number }[] = [
  { label: '一', value: 1 },
  { label: '二', value: 2 },
  { label: '三', value: 3 },
  { label: '四', value: 4 },
  { label: '五', value: 5 },
  { label: '六', value: 6 },
  { label: '日', value: 0 },
]

const STATE_LABELS: Record<TaskRun['state'], string> = {
  claimed: '已认领',
  running: '运行中',
  succeeded: '成功',
  failed: '失败',
  skipped: '跳过',
  aborted: '中止',
}

const STATE_COLORS: Record<TaskRun['state'], string> = {
  claimed: 'text-[var(--fg-muted)]',
  running: 'text-[var(--accent)]',
  succeeded: 'text-[var(--success)]',
  failed: 'text-[var(--danger)]',
  skipped: 'text-[var(--fg-subtle)]',
  aborted: 'text-[var(--attention)]',
}

// eslint-disable-next-line react-refresh/only-export-components -- pure helper exported for unit tests
export function runReason(r: TaskRun): { label: string; color: string } {
  if (r.state === 'aborted') {
    if (r.failure_kind === 'idle_timeout') return { label: '静默超时(无输出)', color: 'text-[var(--danger)]' }
    if (r.failure_kind === 'watchdog_timeout') return { label: '超过最长运行时长', color: 'text-[var(--danger)]' }
    if (r.failure_kind === 'orphaned_restart') return { label: '重启中断', color: 'text-[var(--danger)]' }
  }
  return { label: STATE_LABELS[r.state], color: STATE_COLORS[r.state] }
}

export default function ScheduledTasksPanel({ open, onClose }: Props) {
  const [tasks, setTasks] = useState<ScheduledTask[]>([])
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState<View>('list')
  const [editing, setEditing] = useState<ScheduledTask | null>(null)
  const [historyTask, setHistoryTask] = useState<ScheduledTask | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const req = useLatestRequest()

  const load = useCallback(async () => {
    const t = req.begin()
    try {
      const data = await listScheduledTasks()
      if (!req.isCurrent(t)) return
      setTasks(data)
    } catch { /* ignore */ }
    if (!req.isCurrent(t)) return
    setLoading(false)
  }, [req])

  useEffect(() => { load() }, [load])

  const handleToggle = async (t: ScheduledTask) => {
    try {
      await updateScheduledTask(t.id, {
        name: t.name,
        schedule: { kind: 'cron', expr: t.trigger_spec },
        work_dir: t.work_dir,
        prompt: t.prompt,
        enabled: !t.enabled,
        retention_n: t.retention_n,
        side_effects: t.side_effects,
        max_runtime_min: t.max_runtime_min,
        // PUT is a full upsert (scheduled_tasks.rs upsert SETs every column):
        // omitting this would silently NULL the task's idle timeout. (B1)
        idle_timeout_min: t.idle_timeout_min,
      })
      load()
    } catch { /* ignore */ }
  }

  const handleRun = async (t: ScheduledTask) => {
    setNote(null)
    try {
      const r = await runScheduledTaskNow(t.id)
      if (r.skipped) setNote(`「${t.name}」已跳过：${r.reason || '重叠'}`)
      else setNote(`「${t.name}」已启动`)
    } catch (e) {
      setNote(`运行失败：${(e as Error).message}`)
    }
  }

  const handleDelete = async (t: ScheduledTask) => {
    if (!await confirm({ title: `删除定时任务「${t.name}」？`, confirmLabel: '删除', danger: true })) return
    try {
      await deleteScheduledTask(t.id)
      load()
    } catch { /* ignore */ }
  }

  const openCreate = () => { setEditing(null); setView('form') }
  const openEdit = (t: ScheduledTask) => { setEditing(t); setView('form') }
  const openHistory = (t: ScheduledTask) => { setHistoryTask(t); setView('history') }

  const title = view === 'list' ? '定时任务' : view === 'form' ? (editing ? '编辑任务' : '新建任务') : `运行历史 · ${historyTask?.name}`

  return (
    <Sheet
      open={open}
      side="full"
      onClose={onClose}
      title={title}
      actions={
        <>
          {view !== 'list' && (
            <button
              onClick={() => setView('list')}
              aria-label="返回"
              className="p-1 text-[var(--fg-muted)] hover:text-[var(--fg)] rounded transition-colors"
              title="返回"
            >
              <ChevronLeft size={18} />
            </button>
          )}
          <button onClick={onClose} aria-label="关闭"
            className="p-1 text-[var(--fg-muted)] hover:text-[var(--fg)] rounded transition-colors">
            <X size={18} />
          </button>
        </>
      }
    >
      <div className="p-4 space-y-3">
        {view === 'list' && (
          <>
            <ConfirmationQueue onResolved={load} />
            {note && (
              <div className="text-ui-xs text-[var(--fg-muted)] bg-[var(--surface-2)] border border-[var(--border)] rounded px-3 py-2">
                {note}
              </div>
            )}
            <button
              onClick={openCreate}
              className="flex items-center gap-2 px-3 py-2 text-ui-xs font-medium text-[var(--accent)] hover:bg-[var(--surface-3)] rounded-lg transition-colors"
            >
              <Plus size={14} />
              新建任务
            </button>

            {loading ? (
              <div className="text-ui-sm text-[var(--fg-subtle)]">加载中...</div>
            ) : tasks.length === 0 ? (
              <div className="text-ui-sm text-[var(--fg-subtle)]">还没有定时任务</div>
            ) : (
              <div className="space-y-1">
                {tasks.map(t => (
                  <TaskRow
                    key={t.id}
                    task={t}
                    onToggle={handleToggle}
                    onRun={handleRun}
                    onEdit={openEdit}
                    onDelete={handleDelete}
                    onHistory={openHistory}
                  />
                ))}
              </div>
            )}
          </>
        )}

        {view === 'form' && (
          <TaskForm
            task={editing}
            onCancel={() => setView('list')}
            onSaved={() => { setView('list'); load() }}
          />
        )}

        {view === 'history' && historyTask && (
          <RunHistory task={historyTask} />
        )}
      </div>
    </Sheet>
  )
}

function ConfirmationQueue({ onResolved }: { onResolved: () => void }) {
  const [runs, setRuns] = useState<TaskRun[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const req = useLatestRequest()

  const reload = useCallback(async () => {
    const t = req.begin()
    try {
      const r = await listConfirmations()
      if (!req.isCurrent(t)) return
      setRuns(r.runs)
    } catch { /* ignore */ }
  }, [req])

  useEffect(() => {
    const t = req.begin()
    listConfirmations()
      .then(r => { if (req.isCurrent(t)) setRuns(r.runs) })
      .catch(() => { /* ignore */ })
    return () => { req.bump() }
  }, [req])

  const onDone = async (run: TaskRun) => {
    setBusy(run.id)
    try {
      await confirmRunDone(run.id)
      await reload()
      onResolved()
    } catch { /* ignore */ } finally { setBusy(null) }
  }

  const onReplay = async (run: TaskRun) => {
    setBusy(run.id)
    try {
      await replayRun(run.id, true)
      await reload()
      onResolved()
    } catch { /* ignore */ } finally { setBusy(null) }
  }

  if (runs.length === 0) return null

  return (
    <div className="space-y-1 mb-3">
      <div className="flex items-center gap-2 text-ui-2xs font-semibold text-[var(--fg-subtle)] uppercase tracking-wider">
        待确认
        <span className="inline-flex items-center justify-center min-w-[16px] h-4 px-1 text-ui-2xs font-bold text-white bg-[var(--danger)] rounded-full">
          {runs.length}
        </span>
      </div>
      {runs.map(run => {
        const reason = runReason(run)
        return (
          <div key={run.id} className="px-3 py-2 bg-[var(--surface-2)] rounded-lg border border-[var(--border)]">
            <div className="flex items-center justify-between gap-2">
              <span className="text-ui-xs font-medium text-[var(--fg)] truncate" title={run.task_name}>
                {run.task_name ?? run.task_id}
              </span>
              {run.ended_ms != null && (
                <span className="text-ui-2xs text-[var(--fg-subtle)] shrink-0">{new Date(run.ended_ms).toLocaleString()}</span>
              )}
            </div>
            <div className={`text-ui-2xs font-medium mt-0.5 ${reason.color}`}>{reason.label}</div>
            {run.verdict && (
              <div className="text-ui-2xs text-[var(--fg-muted)] mt-1 break-words">{run.verdict}</div>
            )}
            {run.output_tail && run.output_tail.length > 0 && (
              <div className="mt-1.5 max-h-24 overflow-y-auto bg-[var(--surface-3)] rounded px-2 py-1 text-ui-2xs font-mono text-[var(--fg-muted)] whitespace-pre-wrap break-words">
                {run.output_tail.join('\n')}
              </div>
            )}
            <div className="flex gap-2 mt-2">
              <button
                onClick={() => onDone(run)}
                disabled={busy === run.id}
                className="px-2 py-1 text-ui-xs font-medium text-[var(--success)] hover:bg-[var(--surface-3)] rounded transition-colors disabled:opacity-50"
              >
                确认已完成
              </button>
              <button
                onClick={() => onReplay(run)}
                disabled={busy === run.id}
                className="px-2 py-1 text-ui-xs font-medium text-[var(--accent)] hover:bg-[var(--surface-3)] rounded transition-colors disabled:opacity-50"
              >
                确认未完成 → 重放
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function TaskRow({ task, onToggle, onRun, onEdit, onDelete, onHistory }: {
  task: ScheduledTask
  onToggle: (t: ScheduledTask) => void
  onRun: (t: ScheduledTask) => void
  onEdit: (t: ScheduledTask) => void
  onDelete: (t: ScheduledTask) => void
  onHistory: (t: ScheduledTask) => void
}) {
  return (
    <div className="flex items-center gap-3 px-3 py-2 bg-[var(--surface-2)] rounded-lg border border-[var(--border)]">
      <div className="flex-1 min-w-0">
        <div className="text-ui-xs font-medium text-[var(--fg)] truncate flex items-center gap-1.5">
          {task.name}
          {!task.enabled && (
            <span className="text-ui-2xs text-[var(--fg-subtle)] font-normal">已暂停</span>
          )}
        </div>
        <div className="text-ui-2xs text-[var(--fg-subtle)] truncate font-mono">{task.trigger_spec}</div>
        <div className="text-ui-2xs text-[var(--fg-subtle)] truncate" title={task.work_dir}>{task.work_dir}</div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <label className="flex items-center cursor-pointer" title={task.enabled ? '点击暂停' : '点击启用'}>
          <input
            type="checkbox"
            checked={task.enabled}
            onChange={() => onToggle(task)}
            className="accent-[var(--accent)]"
          />
        </label>
        <button
          onClick={() => onRun(task)}
          className="p-1 text-[var(--success)] hover:bg-[var(--surface-3)] rounded transition-colors"
          title="立即运行"
        >
          <Play size={13} />
        </button>
        <button
          onClick={() => onHistory(task)}
          className="p-1 text-[var(--fg-muted)] hover:text-[var(--fg)] hover:bg-[var(--surface-3)] rounded transition-colors"
          title="运行历史"
        >
          <History size={13} />
        </button>
        <button
          onClick={() => onEdit(task)}
          className="p-1 text-[var(--fg-muted)] hover:text-[var(--fg)] hover:bg-[var(--surface-3)] rounded transition-colors"
          title="编辑"
        >
          <Pencil size={13} />
        </button>
        <button
          onClick={() => onDelete(task)}
          className="p-1 text-[var(--fg-muted)] hover:text-[var(--danger)] hover:bg-[var(--surface-3)] rounded transition-colors"
          title="删除"
        >
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  )
}

type Kind = ScheduleInput['kind']

// Index = UI weekday number (0=Sun..6=Sat); must match weekday_name in src/scheduled_tasks.rs.
const DOW_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']

// eslint-disable-next-line react-refresh/only-export-components -- pure helper exported for unit tests
export function parseCronToForm(spec: string): { kind: Kind; hour: number; minute: number; weekdays: number[] } | null {
  // 6-field seconds-first cron as produced by the backend schedule_to_cron
  // (src/scheduled_tasks.rs): "0 M H * * *" (daily) or "0 M H * * MON,FRI"
  // (weekly, day NAMES). Numeric day-of-week is deliberately NOT mapped: the
  // cron crate numbers 1=Sun..7=Sat (legacy specs were written with the UI's
  // 0=Sun numbers and fire a day early), so those stay in cron mode verbatim.
  const f = spec.trim().split(/\s+/)
  if (f.length !== 6 || f[0] !== '0' || f[3] !== '*' || f[4] !== '*') return null
  const minute = Number(f[1]), hour = Number(f[2])
  if (!Number.isInteger(minute) || !Number.isInteger(hour)) return null
  if (f[5] === '*') return { kind: 'daily', hour, minute, weekdays: [1, 2, 3, 4, 5] }
  const days = f[5].toUpperCase().split(',').map(n => DOW_NAMES.indexOf(n))
  if (days.some(d => d < 0)) return null
  return { kind: 'weekly', hour, minute, weekdays: days }
}

export function TaskForm({ task, onCancel, onSaved }: {
  task: ScheduledTask | null
  onCancel: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState(task?.name ?? '')
  const [workDir, setWorkDir] = useState(task?.work_dir ?? '')
  const [prompt, setPrompt] = useState(task?.prompt ?? '')
  const [enabled, setEnabled] = useState(task?.enabled ?? true)
  // B2: re-derive the friendly schedule from the stored cron so editing a
  // daily/weekly task doesn't silently reopen as a raw cron at the 09:00 default.
  const [parsed] = useState(() => (task ? parseCronToForm(task.trigger_spec) : null))
  const [kind, setKind] = useState<Kind>(parsed?.kind ?? (task ? 'cron' : 'daily'))
  const [hour, setHour] = useState(parsed?.hour ?? 9)
  const [minute, setMinute] = useState(parsed?.minute ?? 0)
  const [weekdays, setWeekdays] = useState<number[]>(parsed?.weekdays ?? [1, 2, 3, 4, 5])
  const [cronExpr, setCronExpr] = useState(task?.trigger_spec ?? '')
  const [sideEffects, setSideEffects] = useState(task?.side_effects ?? false)
  const [maxRuntime, setMaxRuntime] = useState<number | null>(task?.max_runtime_min ?? null)
  const [idleTimeout, setIdleTimeout] = useState<number | null>(task?.idle_timeout_min ?? null)
  const [pickingDir, setPickingDir] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggleWeekday = (v: number) => {
    setWeekdays(prev => prev.includes(v) ? prev.filter(x => x !== v) : [...prev, v])
  }

  const buildSchedule = (): ScheduleInput => {
    if (kind === 'daily') return { kind: 'daily', hour, minute }
    if (kind === 'weekly') return { kind: 'weekly', weekdays, hour, minute }
    return { kind: 'cron', expr: cronExpr }
  }

  const submit = async () => {
    setError(null)
    if (!name.trim()) { setError('请填写任务名称'); return }
    if (!workDir.trim()) { setError('请填写工作目录'); return }
    if (!prompt.trim()) { setError('请填写 prompt'); return }
    if (kind === 'cron' && !cronExpr.trim()) { setError('请填写 cron 表达式'); return }
    if (kind === 'weekly' && weekdays.length === 0) { setError('请至少选择一天'); return }

    const body: ScheduledTaskReq = {
      name: name.trim(),
      schedule: buildSchedule(),
      work_dir: workDir.trim(),
      prompt: prompt.trim(),
      enabled,
      side_effects: sideEffects,
      max_runtime_min: maxRuntime,
      idle_timeout_min: idleTimeout,
    }
    setSaving(true)
    try {
      if (task) await updateScheduledTask(task.id, body)
      else await createScheduledTask(body)
      onSaved()
    } catch (e) {
      setError((e as Error).message)
      setSaving(false)
    }
  }

  // text-ui-input (16px): anything smaller makes iOS Safari zoom on focus (I-15).
  const inputCls = 'w-full bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 text-ui-input text-[var(--fg)] outline-none focus:border-[var(--accent)]'
  const labelCls = 'block text-ui-2xs font-semibold text-[var(--fg-subtle)] uppercase tracking-wider mb-1'

  return (
    <div className="space-y-3 max-w-md">
      {error && (
        <div className="text-ui-xs text-[var(--danger)] bg-[var(--surface-2)] border border-[var(--border)] rounded px-3 py-2">
          {error}
        </div>
      )}

      <div>
        <label className={labelCls}>名称</label>
        <input value={name} onChange={e => setName(e.target.value)} className={inputCls} placeholder="每日构建" />
      </div>

      <div>
        <label className={labelCls}>调度类型</label>
        <select value={kind} onChange={e => setKind(e.target.value as Kind)} className={inputCls}>
          <option value="daily">每天</option>
          <option value="weekly">每周</option>
          <option value="cron">自定义 cron</option>
        </select>
      </div>

      {kind === 'weekly' && (
        <div>
          <label className={labelCls}>星期</label>
          <div className="flex gap-1">
            {WEEKDAYS.map(d => (
              <button
                key={d.value}
                type="button"
                onClick={() => toggleWeekday(d.value)}
                className={`w-8 h-8 rounded text-ui-xs transition-colors ${
                  weekdays.includes(d.value)
                    ? 'bg-[var(--accent)] text-white'
                    : 'bg-[var(--surface-2)] border border-[var(--border)] text-[var(--fg-muted)] hover:bg-[var(--surface-3)]'
                }`}
              >
                {d.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {(kind === 'daily' || kind === 'weekly') && (
        <div className="flex gap-2">
          <div className="flex-1">
            <label className={labelCls}>小时 (0-23)</label>
            <input type="number" min={0} max={23} value={hour} onChange={e => setHour(Number(e.target.value))} className={inputCls} />
          </div>
          <div className="flex-1">
            <label className={labelCls}>分钟 (0-59)</label>
            <input type="number" min={0} max={59} value={minute} onChange={e => setMinute(Number(e.target.value))} className={inputCls} />
          </div>
        </div>
      )}

      {kind === 'cron' && (
        <div>
          <label className={labelCls}>cron 表达式</label>
          <input value={cronExpr} onChange={e => setCronExpr(e.target.value)} className={`${inputCls} font-mono`} placeholder="0 9 * * *" />
        </div>
      )}

      <div>
        <label className={labelCls}>工作目录</label>
        {pickingDir ? (
          <DirectoryPicker
            initialPath={workDir.trim() || undefined}
            onSelect={p => { setWorkDir(p); setPickingDir(false) }}
            onCancel={() => setPickingDir(false)}
          />
        ) : (
          <div className="flex gap-2">
            <input value={workDir} onChange={e => setWorkDir(e.target.value)} className={`${inputCls} font-mono`} placeholder="/home/ubuntu/project" />
            <button
              type="button"
              onClick={() => setPickingDir(true)}
              className="shrink-0 flex items-center gap-1 px-2 py-1.5 text-ui-xs text-[var(--fg-muted)] hover:text-[var(--fg)] bg-[var(--surface-2)] border border-[var(--border)] rounded hover:bg-[var(--surface-3)] transition-colors"
              title="浏览选择目录"
            >
              <Folder size={13} />
              选择
            </button>
          </div>
        )}
      </div>

      <div>
        <label className={labelCls}>Prompt</label>
        <textarea value={prompt} onChange={e => setPrompt(e.target.value)} rows={4} className={`${inputCls} resize-y`} placeholder="要执行的任务..." />
      </div>

      <div>
        <label className={labelCls}>最长运行(分钟,留空=300)</label>
        <input
          type="number"
          min={1}
          max={1440}
          value={maxRuntime ?? ''}
          onChange={e => setMaxRuntime(e.target.value === '' ? null : Number(e.target.value))}
          className={inputCls}
          placeholder="300"
        />
      </div>

      <div>
        <label className={labelCls} title="若任务会运行长时间无输出的命令(全量测试/CI/大型 build),请把空闲超时设得高于该命令的预期时长,否则会被误判为卡死">
          空闲超时(分钟,留空=60)
        </label>
        <input
          type="number"
          min={1}
          max={1440}
          value={idleTimeout ?? ''}
          onChange={e => setIdleTimeout(e.target.value === '' ? null : Number(e.target.value))}
          className={inputCls}
          placeholder="60"
        />
      </div>

      <label className="flex items-center gap-2 text-ui-xs text-[var(--fg-muted)] cursor-pointer">
        <input type="checkbox" checked={sideEffects} onChange={e => setSideEffects(e.target.checked)} className="accent-[var(--accent)]" />
        有外部副作用(提 PR / push / 改文件)
      </label>

      <label className="flex items-center gap-2 text-ui-xs text-[var(--fg-muted)] cursor-pointer">
        <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} className="accent-[var(--accent)]" />
        启用
      </label>

      <div className="flex gap-2 pt-1">
        <button
          onClick={submit}
          disabled={saving}
          className="px-4 py-1.5 text-ui-xs font-semibold bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white rounded transition-colors disabled:opacity-50"
        >
          {saving ? '保存中...' : '保存'}
        </button>
        <button
          onClick={onCancel}
          className="px-4 py-1.5 text-ui-xs text-[var(--fg-muted)] hover:text-[var(--fg)] rounded transition-colors"
        >
          取消
        </button>
      </div>
    </div>
  )
}

function RunHistory({ task }: { task: ScheduledTask }) {
  const [runs, setRuns] = useState<TaskRun[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    listTaskRuns(task.id)
      .then(r => { if (!cancelled) setRuns(r) })
      .catch(() => { /* ignore */ })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [task.id])

  if (loading) return <div className="text-ui-sm text-[var(--fg-subtle)]">加载中...</div>
  if (runs.length === 0) return <div className="text-ui-sm text-[var(--fg-subtle)]">还没有运行记录</div>

  const onReplay = async (run: TaskRun) => {
    setBusy(run.id)
    try {
      await replayRun(run.id, false)
    } catch { /* ignore */ } finally { setBusy(null) }
  }

  return (
    <div className="space-y-1">
      {runs.map(r => {
        const reason = runReason(r)
        const noSnapshot = r.input_snapshot === null
        const sideEffectUnknown =
          task.side_effects &&
          r.state === 'aborted' &&
          (r.failure_kind === 'watchdog_timeout' || r.failure_kind === 'orphaned_restart' || r.failure_kind === 'idle_timeout') &&
          r.confirm_status === null
        const disabled = noSnapshot || sideEffectUnknown
        const title = noSnapshot
          ? '无输入快照,无法重放'
          : sideEffectUnknown
            ? '请经待确认队列处理'
            : undefined
        return (
          <div key={r.id} className="px-3 py-2 bg-[var(--surface-2)] rounded-lg border border-[var(--border)]">
            <div className="flex items-center justify-between gap-2">
              <span className={`text-ui-xs font-medium ${reason.color}`}>{reason.label}</span>
              <span className="text-ui-2xs text-[var(--fg-subtle)]">{new Date(r.scheduled_for_ms).toLocaleString()}</span>
            </div>
            {(r.verdict || r.failure_kind) && (
              <div className="text-ui-2xs text-[var(--fg-muted)] mt-1 break-words">
                {r.verdict || r.failure_kind}
              </div>
            )}
            <div className="mt-2">
              <button
                onClick={() => onReplay(r)}
                disabled={disabled || busy === r.id}
                title={title}
                className="px-2 py-1 text-ui-xs font-medium text-[var(--accent)] hover:bg-[var(--surface-3)] rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                重放
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
