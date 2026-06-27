import { useState, useEffect } from 'react'
import { X, Bell, BellOff, BellRing } from 'lucide-react'
import { getPushState, enablePush, disablePush, getLevels, setLevels } from '../lib/push'
import type { PushState, PushLevels } from '../lib/push'

interface Props {
  onClose: () => void
}

export default function PushSettings({ onClose }: Props) {
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
      if (state === 'enabled') {
        await disablePush()
      } else {
        await enablePush()
      }
      setState(await getPushState())
    } finally {
      setBusy(false)
    }
  }

  const updateLevel = async (key: keyof PushLevels, value: boolean) => {
    const next = { ...levels, [key]: value }
    setLevelsState(next)
    await setLevels(next)
  }

  return (
    <div className="absolute inset-0 z-30 bg-[var(--bg-secondary)] flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-3 h-10 border-b border-[var(--border)] shrink-0">
        <div className="flex items-center gap-1.5">
          <Bell size={14} className="text-[var(--text-secondary)]" />
          <span className="text-xs font-semibold text-[var(--text-primary)]">推送通知</span>
        </div>
        <button
          onClick={onClose}
          aria-label="close"
          className="p-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)] rounded transition-colors"
        >
          <X size={14} />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-4">

        {/* Main toggle */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {state === 'enabled'
                ? <BellRing size={14} className="text-[var(--accent-blue)]" />
                : <BellOff size={14} className="text-[var(--text-muted)]" />
              }
              <span className="text-xs text-[var(--text-primary)]">
                {state === 'loading' ? '检测中…'
                  : state === 'unsupported' ? '不支持推送'
                  : state === 'denied' ? '通知已被拒绝'
                  : state === 'enabled' ? '推送已开启'
                  : '推送未开启'}
              </span>
            </div>
            <button
              onClick={toggle}
              disabled={busy || state === 'loading' || state === 'unsupported' || state === 'denied'}
              className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${
                state === 'enabled'
                  ? 'bg-[var(--accent-blue)]'
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
            <p className="text-[10px] text-[var(--accent-red)]">
              浏览器已拒绝通知权限，请在浏览器设置中手动开启。
            </p>
          )}
          {state === 'unsupported' && (
            <p className="text-[10px] text-[var(--text-muted)]">
              当前浏览器不支持 Web Push。
            </p>
          )}
        </div>

        {/* Two-tier level toggles — only shown when enabled */}
        {state === 'enabled' && (
          <div className="flex flex-col gap-2 border-t border-[var(--border)] pt-3">
            <p className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">通知级别</p>
            <LevelRow
              label="重要通知"
              hint="任务失败、需确认"
              checked={levels.important}
              onChange={v => updateLevel('important', v)}
            />
            <LevelRow
              label="常规通知"
              hint="每轮完成"
              checked={levels.routine}
              onChange={v => updateLevel('routine', v)}
            />
          </div>
        )}

        {/* iOS install hint */}
        {showIOSHint && (
          <div className="border border-[var(--border)] rounded-lg p-3 flex flex-col gap-1.5 bg-[var(--bg-tertiary)]">
            <p className="text-[10px] font-semibold text-[var(--text-primary)]">iOS 使用提示</p>
            <p className="text-[10px] text-[var(--text-secondary)]">
              Safari 推送需先将页面添加到主屏幕：
            </p>
            <ol className="flex flex-col gap-1">
              <li className="text-[10px] text-[var(--text-secondary)]">
                ① 点击 Safari 底栏<span className="font-medium text-[var(--text-primary)]">「分享」</span>按钮
              </li>
              <li className="text-[10px] text-[var(--text-secondary)]">
                ② 选择<span className="font-medium text-[var(--text-primary)]">「添加到主屏幕」</span>，再从主屏幕打开
              </li>
            </ol>
          </div>
        )}
      </div>
    </div>
  )
}

function LevelRow({ label, hint, checked, onChange }: {
  label: string; hint: string; checked: boolean; onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between">
      <div>
        <div className="text-xs text-[var(--text-primary)]">{label}</div>
        <div className="text-[10px] text-[var(--text-muted)]">{hint}</div>
      </div>
      <button
        onClick={() => onChange(!checked)}
        className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${
          checked ? 'bg-[var(--accent-blue)]' : 'bg-[var(--border)]'
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
