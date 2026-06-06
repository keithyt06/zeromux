import { useState, useEffect, useCallback } from 'react'
import { Clock, X, Play, Pencil, Trash2, Plus, History, ChevronLeft } from 'lucide-react'
import type { ScheduledTask, TaskRun, ScheduleInput, ScheduledTaskReq } from '../lib/api'
import {
  listScheduledTasks,
  createScheduledTask,
  updateScheduledTask,
  deleteScheduledTask,
  runScheduledTaskNow,
  listTaskRuns,
} from '../lib/api'

interface Props {
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
  claimed: 'text-[var(--text-secondary)]',
  running: 'text-[var(--accent-blue)]',
  succeeded: 'text-[var(--accent-green-text)]',
  failed: 'text-[var(--accent-red)]',
  skipped: 'text-[var(--text-muted)]',
  aborted: 'text-[var(--accent-yellow)]',
}

export default function ScheduledTasksPanel({ onClose }: Props) {
  const [tasks, setTasks] = useState<ScheduledTask[]>([])
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState<View>('list')
  const [editing, setEditing] = useState<ScheduledTask | null>(null)
  const [historyTask, setHistoryTask] = useState<ScheduledTask | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setTasks(await listScheduledTasks())
    } catch { /* ignore */ }
    setLoading(false)
  }, [])

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
    if (!confirm(`确定删除定时任务「${t.name}」？`)) return
    try {
      await deleteScheduledTask(t.id)
      load()
    } catch { /* ignore */ }
  }

  const openCreate = () => { setEditing(null); setView('form') }
  const openEdit = (t: ScheduledTask) => { setEditing(t); setView('form') }
  const openHistory = (t: ScheduledTask) => { setHistoryTask(t); setView('history') }

  return (
    <div className="absolute inset-0 bg-[var(--bg-primary)] z-50 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 h-10 border-b border-[var(--border)] bg-[var(--bg-secondary)]">
        <div className="flex items-center gap-2 text-xs font-bold text-[var(--text-primary)]">
          {view !== 'list' ? (
            <button
              onClick={() => setView('list')}
              className="p-0.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] rounded transition-colors"
              title="返回"
            >
              <ChevronLeft size={14} />
            </button>
          ) : (
            <Clock size={14} />
          )}
          {view === 'list' ? '定时任务' : view === 'form' ? (editing ? '编辑任务' : '新建任务') : `运行历史 · ${historyTask?.name}`}
        </div>
        <button
          onClick={onClose}
          className="p-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)] rounded transition-colors"
        >
          <X size={14} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {view === 'list' && (
          <>
            {note && (
              <div className="text-xs text-[var(--text-secondary)] bg-[var(--bg-secondary)] border border-[var(--border)] rounded px-3 py-2">
                {note}
              </div>
            )}
            <button
              onClick={openCreate}
              className="flex items-center gap-2 px-3 py-2 text-xs font-medium text-[var(--accent-blue)] hover:bg-[var(--bg-tertiary)] rounded-lg transition-colors"
            >
              <Plus size={14} />
              新建任务
            </button>

            {loading ? (
              <div className="text-sm text-[var(--text-muted)]">加载中...</div>
            ) : tasks.length === 0 ? (
              <div className="text-sm text-[var(--text-muted)]">还没有定时任务</div>
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
    <div className="flex items-center gap-3 px-3 py-2 bg-[var(--bg-secondary)] rounded-lg border border-[var(--border)]">
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium text-[var(--text-primary)] truncate flex items-center gap-1.5">
          {task.name}
          {!task.enabled && (
            <span className="text-[10px] text-[var(--text-muted)] font-normal">已暂停</span>
          )}
        </div>
        <div className="text-[10px] text-[var(--text-muted)] truncate font-mono">{task.trigger_spec}</div>
        <div className="text-[10px] text-[var(--text-muted)] truncate" title={task.work_dir}>{task.work_dir}</div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <label className="flex items-center cursor-pointer" title={task.enabled ? '点击暂停' : '点击启用'}>
          <input
            type="checkbox"
            checked={task.enabled}
            onChange={() => onToggle(task)}
            className="accent-[var(--accent-blue)]"
          />
        </label>
        <button
          onClick={() => onRun(task)}
          className="p-1 text-[var(--accent-green-text)] hover:bg-[var(--bg-tertiary)] rounded transition-colors"
          title="立即运行"
        >
          <Play size={13} />
        </button>
        <button
          onClick={() => onHistory(task)}
          className="p-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] rounded transition-colors"
          title="运行历史"
        >
          <History size={13} />
        </button>
        <button
          onClick={() => onEdit(task)}
          className="p-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] rounded transition-colors"
          title="编辑"
        >
          <Pencil size={13} />
        </button>
        <button
          onClick={() => onDelete(task)}
          className="p-1 text-[var(--text-secondary)] hover:text-[var(--accent-red)] hover:bg-[var(--bg-tertiary)] rounded transition-colors"
          title="删除"
        >
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  )
}

type Kind = ScheduleInput['kind']

function TaskForm({ task, onCancel, onSaved }: {
  task: ScheduledTask | null
  onCancel: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState(task?.name ?? '')
  const [workDir, setWorkDir] = useState(task?.work_dir ?? '')
  const [prompt, setPrompt] = useState(task?.prompt ?? '')
  const [enabled, setEnabled] = useState(task?.enabled ?? true)
  const [kind, setKind] = useState<Kind>(task ? 'cron' : 'daily')
  const [hour, setHour] = useState(9)
  const [minute, setMinute] = useState(0)
  const [weekdays, setWeekdays] = useState<number[]>([1, 2, 3, 4, 5])
  const [cronExpr, setCronExpr] = useState(task?.trigger_spec ?? '')
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

  const inputCls = 'w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded px-2 py-1.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent-blue)]'
  const labelCls = 'block text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-1'

  return (
    <div className="space-y-3 max-w-md">
      {error && (
        <div className="text-xs text-[var(--accent-red)] bg-[var(--bg-secondary)] border border-[var(--border)] rounded px-3 py-2">
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
          <option value="weekly">每工作日</option>
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
                className={`w-8 h-8 rounded text-xs transition-colors ${
                  weekdays.includes(d.value)
                    ? 'bg-[var(--accent-blue)] text-white'
                    : 'bg-[var(--bg-secondary)] border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'
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
        <input value={workDir} onChange={e => setWorkDir(e.target.value)} className={`${inputCls} font-mono`} placeholder="/home/ubuntu/project" />
      </div>

      <div>
        <label className={labelCls}>Prompt</label>
        <textarea value={prompt} onChange={e => setPrompt(e.target.value)} rows={4} className={`${inputCls} resize-y`} placeholder="要执行的任务..." />
      </div>

      <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)] cursor-pointer">
        <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} className="accent-[var(--accent-blue)]" />
        启用
      </label>

      <div className="flex gap-2 pt-1">
        <button
          onClick={submit}
          disabled={saving}
          className="px-4 py-1.5 text-xs font-semibold bg-[var(--accent-blue)] hover:bg-[var(--accent-blue-hover)] text-white rounded transition-colors disabled:opacity-50"
        >
          {saving ? '保存中...' : '保存'}
        </button>
        <button
          onClick={onCancel}
          className="px-4 py-1.5 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] rounded transition-colors"
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

  useEffect(() => {
    let cancelled = false
    listTaskRuns(task.id)
      .then(r => { if (!cancelled) setRuns(r) })
      .catch(() => { /* ignore */ })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [task.id])

  if (loading) return <div className="text-sm text-[var(--text-muted)]">加载中...</div>
  if (runs.length === 0) return <div className="text-sm text-[var(--text-muted)]">还没有运行记录</div>

  return (
    <div className="space-y-1">
      {runs.map(r => (
        <div key={r.id} className="px-3 py-2 bg-[var(--bg-secondary)] rounded-lg border border-[var(--border)]">
          <div className="flex items-center justify-between gap-2">
            <span className={`text-xs font-medium ${STATE_COLORS[r.state]}`}>{STATE_LABELS[r.state]}</span>
            <span className="text-[10px] text-[var(--text-muted)]">{new Date(r.scheduled_for_ms).toLocaleString()}</span>
          </div>
          {(r.verdict || r.failure_kind) && (
            <div className="text-[10px] text-[var(--text-secondary)] mt-1 break-words">
              {r.verdict || r.failure_kind}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
