import { useEffect, useRef, useCallback, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { wsUrl, getSessionStatus } from '../lib/api'
import type { SessionStatus } from '../lib/api'
import type { Theme } from '../lib/theme'
import { b64encode, b64decode } from '../lib/base64'
import { GitBranch, Folder, Circle } from 'lucide-react'
import MobileKeyBar, { type BarKey } from './MobileKeyBar'
import Composer from './Composer'
import { arrowSequence, rowHeight, linesFromDrag, bracketedPaste, submitSequence, controlSequence, launchSequence, type ArrowKey } from '../lib/terminalInput'
import { shouldStickToBottom } from '../lib/scrollReplay'

const FONT_SIZE = 14

const THEMES = {
  dark: {
    background: '#0d1117',
    foreground: '#c9d1d9',
    cursor: '#58a6ff',
    selectionBackground: '#264f78',
    black: '#484f58',
    red: '#ff7b72',
    green: '#3fb950',
    yellow: '#d29922',
    blue: '#58a6ff',
    magenta: '#bc8cff',
    cyan: '#39c5cf',
    white: '#b1bac4',
    brightBlack: '#6e7681',
    brightRed: '#ffa198',
    brightGreen: '#56d364',
    brightYellow: '#e3b341',
    brightBlue: '#79c0ff',
    brightMagenta: '#d2a8ff',
    brightCyan: '#56d4dd',
    brightWhite: '#f0f6fc',
  },
  light: {
    background: '#ffffff',
    foreground: '#1f2328',
    cursor: '#0969da',
    selectionBackground: '#b6d4fe',
    black: '#24292f',
    red: '#cf222e',
    green: '#1a7f37',
    yellow: '#9a6700',
    blue: '#0969da',
    magenta: '#8250df',
    cyan: '#1b7c83',
    white: '#6e7781',
    brightBlack: '#57606a',
    brightRed: '#a40e26',
    brightGreen: '#116329',
    brightYellow: '#7d4e00',
    brightBlue: '#0550ae',
    brightMagenta: '#6639ba',
    brightCyan: '#136061',
    brightWhite: '#8c959f',
  },
}

interface Props {
  sessionId: string
  active: boolean
  theme: Theme
}

export default function TerminalView({ sessionId, active, theme }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const initRef = useRef(false)
  // Terminal has no replay_done marker: self-arm a replay window on (re)connect
  // and disarm it after the first settled write burst (or on user scroll/input).
  // Auto bottom-stick fires ONLY inside this window and only if the user hasn't
  // scrolled up, so reading scrollback while live output arrives is never yanked.
  const replayingRef = useRef(false)
  const userScrolledUpRef = useRef(false)
  const scrollDebounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [status, setStatus] = useState<SessionStatus | null>(null)
  // 触摸设备检测：any-pointer:coarse 或 maxTouchPoints>0，少漏触屏笔记本/iPad。
  // 触摸能力在页面生命周期内不变，用惰性初始化在挂载时算一次即可（避免 effect 内 setState）。
  const [isTouch] = useState(
    () =>
      (typeof matchMedia !== 'undefined' && matchMedia('(any-pointer: coarse)').matches) ||
      (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0)
  )
  const [composerText, setComposerText] = useState('')
  // 软键盘是否弹起：仅触摸端用 VisualViewport 判断（见下方 effect）。
  // 弹起时隐藏底部状态栏，把空间让给常驻 composer + 终端。
  const [keyboardOpen, setKeyboardOpen] = useState(false)

  // Fetch status
  useEffect(() => {
    let cancelled = false
    const fetchStatus = () => {
      getSessionStatus(sessionId).then(s => {
        if (!cancelled) setStatus(s)
      }).catch(() => {})
    }
    fetchStatus()
    const interval = setInterval(fetchStatus, 10000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [sessionId])

  // 所有 client→PTY 输入走这一条；term.onData 与 MobileKeyBar 共用。
  // 返回是否真正送出：重连窗口里 WS 未 OPEN 时为 false，调用方据此决定是否清空输入。
  const sendInput = useCallback((data: string) => {
    const ws = wsRef.current
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', data: b64encode(new TextEncoder().encode(data)) }))
      return true
    }
    return false
  }, [])

  // 虚拟键：先回到底部（否则在 scrollback 里点键看不到反馈），再发对应字节。
  // 方向键/Enter 按 DECCKM 模式；控制键直发。
  const handleBarKey = useCallback((key: BarKey) => {
    const term = termRef.current
    if (!term) return
    term.scrollToBottom()
    if (key === 'ctrl-c') {
      sendInput(controlSequence(key))
    } else if (key === 'claude' || key === 'codex' || key === 'kiro') {
      sendInput(launchSequence(key))
    } else {
      sendInput(arrowSequence(key as ArrowKey, term.modes.applicationCursorKeysMode))
    }
  }, [sendInput])

  // Composer 发送：整段走 bracketed paste，再按对端 bracketed paste 模式决定回车。
  // 发送后滚到底，确保看到 agent 反应（用户可能正在 scrollback 里翻）。
  const sendComposer = useCallback((text: string) => {
    const term = termRef.current
    if (!term) return
    // 只有真正送出才清空，否则重连窗口里用户辛苦打的整段会被静默丢掉。
    const sent = sendInput(bracketedPaste(text) + submitSequence(term.modes.bracketedPasteMode))
    if (!sent) return
    setComposerText('')
    term.scrollToBottom()
  }, [sendInput])

  // Initialize terminal once
  useEffect(() => {
    if (initRef.current || !containerRef.current) return
    initRef.current = true

    const term = new Terminal({
      cursorBlink: true,
      fontSize: FONT_SIZE,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
      theme: THEMES[theme],
      allowProposedApi: true,
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(containerRef.current)

    try {
      term.loadAddon(new WebglAddon())
    } catch {
      // fallback to canvas
    }

    fit.fit()
    termRef.current = term
    fitRef.current = fit

    term.onData(data => {
      // User input closes the replay window (append to the existing sendInput
      // registration — do NOT add a second onData or input would double-send).
      replayingRef.current = false
      sendInput(data)
    })

    term.onScroll(() => {
      // User scrolling up during replay (not pinned to bottom) → treat as reading
      // history and stop auto bottom-stick.
      const buf = term.buffer.active
      const atBottom = buf.viewportY >= buf.baseY
      if (replayingRef.current && !atBottom) userScrolledUpRef.current = true
    })

    term.onBinary(data => {
      const ws = wsRef.current
      if (ws?.readyState === WebSocket.OPEN) {
        const bytes = new Uint8Array(data.length)
        for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i)
        ws.send(JSON.stringify({ type: 'input', data: b64encode(bytes) }))
      }
    })

    // 移动端触摸滚动：完全接管手势（CSS 已禁原生滚动），位移换算成 scrollLines。
    const container = containerRef.current
    let startY = 0
    let touchId: number | null = null

    const onTouchStart = (e: TouchEvent) => {
      // 仅单指进入滚动逻辑；多指（pinch）忽略。
      if (e.touches.length !== 1) { touchId = null; return }
      startY = e.touches[0].clientY
      touchId = e.touches[0].identifier
    }
    const onTouchMove = (e: TouchEvent) => {
      if (touchId === null) return
      let t: Touch | undefined
      for (let i = 0; i < e.touches.length; i++) {
        if (e.touches[i].identifier === touchId) { t = e.touches[i]; break }
      }
      if (!t) return
      e.preventDefault()  // 全程阻止，防止浏览器抢手势 / 橡皮筋
      const rh = rowHeight(term.element?.clientHeight ?? 0, term.rows, FONT_SIZE)
      const lines = linesFromDrag(startY, t.clientY, rh)
      if (lines !== 0) {
        term.scrollLines(lines)
        startY = t.clientY
      }
    }

    const onTouchEnd = () => { touchId = null }

    container?.addEventListener('touchstart', onTouchStart, { passive: true })
    container?.addEventListener('touchmove', onTouchMove, { passive: false })
    container?.addEventListener('touchend', onTouchEnd, { passive: true })
    container?.addEventListener('touchcancel', onTouchEnd, { passive: true })

    return () => {
      container?.removeEventListener('touchstart', onTouchStart)
      container?.removeEventListener('touchmove', onTouchMove)
      container?.removeEventListener('touchend', onTouchEnd)
      container?.removeEventListener('touchcancel', onTouchEnd)
      if (scrollDebounceRef.current) clearTimeout(scrollDebounceRef.current)
      wsRef.current?.close()
      term.dispose()
    }
  }, [sessionId])

  // Update terminal theme when it changes
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = THEMES[theme]
    }
  }, [theme])

  // 上一次发给 PTY 的 cols/rows。handleResize 据此跳过冗余 resize；onopen
  // 重连首发也要同步它，否则下一次「真实尺寸变回这个旧值」会被误判为冗余而漏发。
  const lastDims = useRef<{ cols: number; rows: number }>({ cols: 0, rows: 0 })

  // Connect WebSocket
  useEffect(() => {
    if (!termRef.current) return
    if (wsRef.current) return

    let disposed = false
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let attempt = 0

    const connect = () => {
      if (disposed) return
      const ws = new WebSocket(wsUrl(`/ws/term/${sessionId}`))
      wsRef.current = ws

      ws.onopen = () => {
        attempt = 0
        // The server replays full scrollback on (re)connect; reset the terminal
        // first so a reconnect doesn't double-paint the buffer.
        termRef.current?.reset()
        // Arm the replay window: the server is about to replay full scrollback.
        replayingRef.current = true
        userScrolledUpRef.current = false
        const fit = fitRef.current
        if (fit) {
          const dims = fit.proposeDimensions()
          if (dims) {
            ws.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }))
            lastDims.current = { cols: dims.cols, rows: dims.rows }
          }
        }
      }

      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data)
          if (msg.type === 'output') {
            termRef.current?.write(b64decode(msg.data), () => {
              if (scrollDebounceRef.current) clearTimeout(scrollDebounceRef.current)
              scrollDebounceRef.current = setTimeout(() => {
                if (shouldStickToBottom({ replaying: replayingRef.current, userScrolledUp: userScrolledUpRef.current })) {
                  termRef.current?.scrollToBottom()
                }
                // First settle after the replay burst closes the window: live
                // output afterwards must not auto-scroll (user may read scrollback).
                replayingRef.current = false
              }, 120)
            })
          }
        } catch { /* ignore */ }
      }

      ws.onclose = () => {
        wsRef.current = null
        // Auto-reconnect through idle-timeout proxy drops / transient closes so
        // the terminal never freezes silently. Exponential backoff, capped at 10s.
        if (!disposed) {
          const delay = Math.min(1000 * 2 ** attempt, 10000)
          attempt += 1
          retryTimer = setTimeout(connect, delay)
        }
      }
      ws.onerror = () => { ws.close() }
    }

    connect()

    return () => {
      disposed = true
      if (retryTimer) clearTimeout(retryTimer)
      wsRef.current?.close()
    }
  }, [sessionId])

  const handleResize = useCallback(() => {
    const fit = fitRef.current
    const term = termRef.current
    const ws = wsRef.current
    if (!fit || !term) return
    fit.fit()
    // Skip redundant resize sends: Android fires window.resize on soft-keyboard
    // open, which would otherwise spam PTY SIGWINCH and thrash the TUI even
    // though cols/rows didn't change.
    if (ws?.readyState === WebSocket.OPEN
        && (term.cols !== lastDims.current.cols || term.rows !== lastDims.current.rows)) {
      lastDims.current = { cols: term.cols, rows: term.rows }
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
    }
  }, [])

  useEffect(() => {
    if (active) {
      const t = setTimeout(() => {
        handleResize()
        // 触摸端不自动聚焦：避免一进会话就弹软键盘（正是用户烦的）。
        // 桌面端保持聚焦，键盘直接可用。
        if (!isTouch) termRef.current?.focus()
      }, 50)
      return () => clearTimeout(t)
    }
  }, [active, handleResize, isTouch])

  useEffect(() => {
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [handleResize])

  // 键条 / composer / 状态栏占用高度，改变终端可用区；渲染后重新 fit，
  // 避免底部行被遮 / canvas 尺寸过期。键盘弹起隐藏状态栏也会改变高度，需重算。
  useEffect(() => {
    if (!isTouch) return
    const t = setTimeout(handleResize, 50)
    return () => clearTimeout(t)
  }, [isTouch, keyboardOpen, handleResize])

  // 软键盘遮挡补偿：仅触摸端 + active。用 VisualViewport 把容器底部内边距顶起
  // 键盘高度，使 composer 和终端区不被遮。只改 CSS（paddingBottom），不动
  // xterm 的 cols/rows（避免 PTY SIGWINCH 抖动 / TUI 重绘风暴）。
  useEffect(() => {
    if (!isTouch || !active) return
    const vv = window.visualViewport
    if (!vv) return
    // 每次都读实时 parentElement，不在 effect 顶部捕获一份：父节点若被重挂，
    // 捕获的旧引用会让 padding 改在错节点上、新节点又清不掉（残留遮挡）。
    const apply = () => {
      const root = containerRef.current?.parentElement
      const overlap = Math.max(0, window.innerHeight - vv.height - vv.offsetTop)
      if (root) root.style.paddingBottom = `${overlap}px`
      // overlap > 阈值 ≈ 软键盘弹起。阈值避开地址栏收合等小幅变化。
      setKeyboardOpen(overlap > 120)
    }
    apply()
    vv.addEventListener('resize', apply)
    vv.addEventListener('scroll', apply)
    return () => {
      vv.removeEventListener('resize', apply)
      vv.removeEventListener('scroll', apply)
      const root = containerRef.current?.parentElement
      if (root) root.style.paddingBottom = ''
      setKeyboardOpen(false)
    }
  }, [isTouch, active])

  return (
    <div className="flex flex-col h-full">
      <div ref={containerRef} className="xterm-container w-full flex-1 min-h-0" />
      {/* 触摸端：方向/启动键栏在上，常驻输入框贴底（最靠近软键盘）。 */}
      {isTouch && <MobileKeyBar onKey={handleBarKey} />}
      {isTouch && (
        <div className="px-2 py-1.5 border-t border-[var(--border)] bg-[var(--bg-secondary)]">
          <Composer
            value={composerText}
            onChange={setComposerText}
            onSend={sendComposer}
            submitOnEnter={false}
            placeholder="输入文字，点 ✈ 发送…"
          />
        </div>
      )}
      {/* 状态栏：软键盘弹起时隐藏，把空间让给终端 + 常驻输入框。 */}
      <div
        className={`${isTouch && keyboardOpen ? 'hidden' : 'flex'} items-center gap-3 px-4 py-3 border-t border-[var(--border)] bg-[var(--bg-secondary)] min-h-[40px]`}
      >
        {status ? (
          <>
            <div className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
              <Folder size={13} className="shrink-0" />
              <span className="truncate max-w-[200px]" title={status.work_dir}>{status.work_dir}</span>
            </div>
            {status.is_git && (
              <>
                <div className="flex items-center gap-1.5 text-xs text-[var(--accent-purple)]">
                  <GitBranch size={13} className="shrink-0" />
                  <span>{status.git_branch}</span>
                </div>
                {status.git_dirty > 0 && (
                  <div className="flex items-center gap-1 text-xs text-[var(--accent-yellow)]">
                    <Circle size={8} className="fill-current shrink-0" />
                    <span>{status.git_dirty} changed</span>
                  </div>
                )}
              </>
            )}
          </>
        ) : (
          <span className="text-xs text-[var(--text-muted)]">Loading...</span>
        )}
      </div>
    </div>
  )
}
