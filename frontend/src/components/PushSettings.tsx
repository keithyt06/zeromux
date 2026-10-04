import { useState, useEffect } from 'react'
import { X, BellOff, BellRing } from 'lucide-react'
import { getPushState, enablePush, disablePush, getLevels, setLevels, sendTestPush } from '../lib/push'
import type { PushState, PushLevels } from '../lib/push'
import { Sheet, toast, IconButton } from './ui'

interface Props {
  open: boolean
  onClose: () => void
}

export default function PushSettings({ open, onClose }: Props) {
  const [state, setState] = useState<PushState | 'loading'>('loading')
  const [levels, setLevelsState] = useState<PushLevels>(getLevels())
  const [busy, setBusy] = useState(false)

  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent)
  const standalone = (navigator as { standalone?: boolean }).standalone === true
    || window.matchMedia('(display-mode: standalone)').matches
  const showIOSHint = isIOS && !standalone

  useEffect(() => {
    getPushState().then(setState)
  }, [])

  const toggle = async () => {
    if (busy || state === 'loading' || state === 'unsupported' || state === 'denied') return
    setBusy(true)
    try {
      if (state === 'enabled') await disablePush()
      else await enablePush()
    } catch (e) {
      toast.push({ message: `${state === 'enabled' ? '关闭' : '开启'}失败:${e instanceof Error ? e.message : '未知错误'}` })
    } finally {
      setState(await getPushState().catch(() => state))
      setBusy(false)
    }
  }

  const updateLevel = async (key: keyof PushLevels, value: boolean) => {
    const next = { ...levels, [key]: value }
    setLevelsState(next)
    await setLevels(next)
  }

  return (
    <Sheet
      open={open}
      side="full"
      onClose={onClose}
      title="推送通知"
      actions={
        <IconButton label="关闭" icon={X} onClick={onClose} />
      }
    >
      <div className="p-3 flex flex-col gap-4">

        {/* Main toggle */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {state === 'enabled'
                ? <BellRing size={14} className="text-[var(--accent)]" />
                : <BellOff size={14} className="text-[var(--fg-subtle)]" />
              }
              <span className="text-ui-xs text-[var(--fg)]">
                {state === 'loading' ? '检测中…'
                  : state === 'unsupported' ? '不支持推送'
                  : state === 'denied' ? '通知已被拒绝'
                  : state === 'enabled' ? '推送已开启'
                  : '推送未开启'}
              </span>
            </div>
            <button
              role="switch"
              aria-checked={state === 'enabled'}
              onClick={toggle}
              disabled={busy || state === 'loading' || state === 'unsupported' || state === 'denied'}
              className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${
                state === 'enabled'
                  ? 'bg-[var(--accent)]'
                  : 'bg-[var(--border)]'
              } disabled:opacity-40 disabled:cursor-not-allowed`}
              aria-label={state === 'enabled' ? '关闭推送' : '开启推送'}
            >
              <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
                state === 'enabled' ? 'translate-x-4' : 'translate-x-0'
              }`} />
            </button>
          </div>
          {state === 'denied' && (
            <p className="text-ui-xs text-[var(--danger)]">
              浏览器已拒绝通知权限，请在浏览器设置中手动开启。
            </p>
          )}
          {state === 'unsupported' && (
            <p className="text-ui-xs text-[var(--fg-subtle)]">
              当前浏览器不支持 Web Push。
            </p>
          )}
        </div>

        {/* Two-tier level toggles — only shown when enabled */}
        {state === 'enabled' && (
          <div className="flex flex-col gap-2 border-t border-[var(--border)] pt-3">
            <p className="text-ui-2xs font-semibold text-[var(--fg-subtle)] uppercase tracking-wider">通知级别</p>
            <LevelRow
              label="重要通知"
              hint="任务失败、需确认"
              checked={levels.important}
              onChange={v => updateLevel('important', v)}
            />
            <LevelRow
              label="常规通知"
              hint="每轮完成、定时任务完成"
              checked={levels.routine}
              onChange={v => updateLevel('routine', v)}
            />
          </div>
        )}

        {/* Test push button — only shown when enabled */}
        {state === 'enabled' && (
          <div className="border-t border-[var(--border)] pt-3">
            <TestPushButton />
          </div>
        )}

        {/* iOS install hint */}
        {showIOSHint && (
          <div className="border border-[var(--border)] rounded-lg p-3 flex flex-col gap-1.5 bg-[var(--surface-3)]">
            <p className="text-ui-xs font-semibold text-[var(--fg)]">iOS 使用提示</p>
            <p className="text-ui-xs text-[var(--fg-muted)]">
              Safari 推送需先将页面添加到主屏幕：
            </p>
            <ol className="flex flex-col gap-1">
              <li className="text-ui-xs text-[var(--fg-muted)]">
                ① 点击 Safari 底栏<span className="font-medium text-[var(--fg)]">「分享」</span>按钮
              </li>
              <li className="text-ui-xs text-[var(--fg-muted)]">
                ② 选择<span className="font-medium text-[var(--fg)]">「添加到主屏幕」</span>，再从主屏幕打开
              </li>
            </ol>
          </div>
        )}
      </div>
    </Sheet>
  )
}

function LevelRow({ label, hint, checked, onChange }: {
  label: string; hint: string; checked: boolean; onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between">
      <div>
        <div className="text-ui-xs text-[var(--fg)]">{label}</div>
        <div className="text-ui-2xs text-[var(--fg-subtle)]">{hint}</div>
      </div>
      <button
        onClick={() => onChange(!checked)}
        className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${
          checked ? 'bg-[var(--accent)]' : 'bg-[var(--border)]'
        }`}
        aria-label={`${checked ? '关闭' : '开启'} ${label}`}
      >
        <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-4' : 'translate-x-0'
        }`} />
      </button>
    </div>
  )
}

function TestPushButton() {
  const [sent, setSent] = useState(false)
  return (
    <button
      onClick={async () => { try { await sendTestPush(); setSent(true); setTimeout(() => setSent(false), 2000) } catch { toast.push({ message: '测试推送发送失败' }) } }}
      className="text-ui-xs px-2 py-1 rounded bg-[var(--surface-3)] text-[var(--fg)] hover:opacity-80"
    >
      {sent ? '已发送 ✓' : '发送测试推送'}
    </button>
  )
}
