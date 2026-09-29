import { useEffect, useRef, useCallback, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { ClipboardAddon } from '@xterm/addon-clipboard'
import { writeOnlyClipboard } from '../lib/clipboard'
import { SearchAddon } from '@xterm/addon-search'
import { getSessionStatus, getTmuxHealth, reviveSession } from '../lib/api'
import type { SessionStatus, TmuxHealth } from '../lib/api'
import type { Theme } from '../lib/theme'
import { readTerminalTheme } from '../lib/terminalTheme'
import { b64encode } from '../lib/base64'
import { GitBranch, Folder, Circle, ArrowUpToLine, ArrowDownToLine } from 'lucide-react'
import { attachCommand, copyText } from '../lib/attachCommand'
import { useIsTouch } from '../lib/useMediaQuery'
import MobileKeyBar, { type BarKey } from './MobileKeyBar'
import Composer from './Composer'
import ConnectionBar from './ConnectionBar'
import HistoryView from './HistoryView'
import { TmuxHealthBar, LostBanner, EndedOverlay, ReconnectHint } from './TerminalNotices'
import { arrowSequence, rowHeight, linesFromDrag, bracketedPaste, submitSequence, controlSequence, launchSequence } from '../lib/terminalInput'
import { shouldStickToBottom } from '../lib/scrollReplay'
import { ScrollBatcher, inertiaLines, pillFromScrollState, scheduleInertia, shouldCancelBeforeInput, type ScrollMsg } from '../lib/terminalScroll'
import { shouldShowShiftHint, mousePref, MOUSE_PREF_KEY, mouseToggleApplies } from '../lib/desktopHints'
import { historyPrompt } from '../lib/historyToAgent'
import { shouldSendResize } from '../lib/terminalSize'
import { useTerminalSocket } from '../hooks/useTerminalSocket'

const FONT_SIZE = 14

const LANDSCAPE_MQ = '(orientation: landscape) and (max-height: 500px)'

interface Props {
  sessionId: string
  active: boolean
  theme: Theme
  tmuxName?: string | null
  tmuxOrigin?: 'own' | 'external' | null
  onClose?: () => void
  /** Bumped (nonce) by the sidebar's ⋯ 查看历史 to open the history drawer. */
  historyRequest?: number
  /** "发给 agent": open a new Claude session pre-filled with a history prompt. */
  onAskAgent?: (prompt: string) => void
}

export default function TerminalView({ sessionId, active, theme, tmuxName, tmuxOrigin, onClose, historyRequest, onAskAgent }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
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
  const [health, setHealth] = useState<TmuxHealth | null>(null)
  const [lost, setLost] = useState(false)
  const [ended, setEnded] = useState(false)
  // Ref twin of `ended` for the WS onclose closure: an Ended session must not
  // auto-reconnect (each reconnect would just get tmux_ended again).
  const endedRef = useRef(false)
  // Bumped after revive to re-run the Connect WebSocket effect.
  const [wsEpoch, setWsEpoch] = useState(0)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [chipCopied, setChipCopied] = useState(false)
  const [reconnected, setReconnected] = useState(false)
  // True once the WS has opened at least once; a later open is a reconnect (→ ReconnectHint).
  const openedOnceRef = useRef(false)
  // Ref twin of `tmuxName` for long-lived closures (WS handlers, touch listeners).
  const tmuxRef = useRef(tmuxName)
  useEffect(() => { tmuxRef.current = tmuxName }, [tmuxName])
  // Read by the WS onopen / window-resize callbacks, which outlive renders.
  const activeRef = useRef(active)
  useEffect(() => { activeRef.current = active }, [active])
  const tmuxOriginRef = useRef(tmuxOrigin)
  useEffect(() => { tmuxOriginRef.current = tmuxOrigin }, [tmuxOrigin])
  // Sidebar ⋯ 查看历史: a nonce bump (even while already open) should (re)open the drawer.
  // Consuming an external one-shot request is exactly an effect's job.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { if (historyRequest) setHistoryOpen(true) }, [historyRequest])
  // 触摸设备检测：any-pointer:coarse 或 maxTouchPoints>0，少漏触屏笔记本/iPad。
  // Now live (useSyncExternalStore): only flips if an external touch device is
  // attached/detached mid-session. The xterm/WS effect below doesn't depend on it.
  const isTouch = useIsTouch()
  // Phone held sideways: history opens as a right half-pane beside the live terminal.
  const [landscape, setLandscape] = useState(() => typeof matchMedia !== 'undefined' && matchMedia(LANDSCAPE_MQ).matches)
  useEffect(() => {
    if (typeof matchMedia === 'undefined') return
    const mq = matchMedia(LANDSCAPE_MQ)
    const on = () => setLandscape(mq.matches)
    mq.addEventListener?.('change', on)
    return () => mq.removeEventListener?.('change', on)
  }, [])
  const split = isTouch && landscape
  const historySplit = historyOpen && split
  const [composerText, setComposerText] = useState('')
  // 软键盘是否弹起：仅触摸端用 VisualViewport 判断（见下方 effect）。只作为重新 fit
  // 的触发器——键盘弹起/收起时 paddingBottom 改变终端可用高度，而 iOS 不发 window.resize。
  const [keyboardOpen, setKeyboardOpen] = useState(false)
  // 桌面 Ctrl/Cmd+F：非 tmux 会话本地搜索当前屏；tmux 会话改开历史抽屉
  // （xterm 只保留当前屏，搜索历史要走服务端 capture-pane）。
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQ, setSearchQ] = useState('')
  // 桌面 Shift 拖选提示：tmux mouse=on 时首次鼠标按下提示一次（见 onMouseDownHint）。
  const [shiftHint, setShiftHint] = useState(false)
  // tmux 鼠标交给谁：true=tmux（滚轮/点选窗格），false=浏览器（原生拖选文字）。
  const [mouseOn, setMouseOn] = useState(() => mousePref(localStorage))

  // Fetch status
  useEffect(() => {
    let cancelled = false
    const fetchStatus = () => {
      getSessionStatus(sessionId).then(s => {
        if (!cancelled) setStatus(s)
      }).catch(() => {})
      if (tmuxName) getTmuxHealth().then(h => { if (!cancelled) setHealth(h) }).catch(() => {})
    }
    fetchStatus()
    const interval = setInterval(fetchStatus, 10000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [sessionId, tmuxName])

  // tmux copy-mode state (server-authoritative via scroll_state); drives the pill.
  const [scrolling, setScrolling] = useState(false)
  const scrollingRef = useRef(false)
  // True while scrolling is routed as wheel events into a fullscreen app
  // (server `app_scroll`, e.g. Claude Code) rather than tmux copy-mode.
  const appScrollRef = useRef(false)
  // Last op sent, so a late app_scroll reply can't reopen a pill we just closed.
  const lastScrollOpRef = useRef<ScrollMsg['op']>('cancel')
  // "↓ N 行新输出": server diffs history_size every 1s while in copy-mode
  // (scroll_watch), since a frozen copy-mode pane can't show new output.
  const [newLines, setNewLines] = useState(0)
  const sendScroll = useCallback((m: ScrollMsg) => {
    const ws = wsRef.current
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'scroll', ...m }))
    lastScrollOpRef.current = m.op
    if (m.op === 'up' || m.op === 'top') { scrollingRef.current = true; setScrolling(true) }
  }, [])
  // Ref twin so the once-only init effect's touch batcher always calls the latest sendScroll.
  const sendScrollRef = useRef(sendScroll)
  useEffect(() => { sendScrollRef.current = sendScroll }, [sendScroll])
  // Arm/disarm the server-side history_size watch as copy-mode is entered/left.
  useEffect(() => {
    const ws = wsRef.current
    if (!tmuxName || ws?.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: 'scroll_watch', on: scrolling }))
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!scrolling) setNewLines(0)
  }, [scrolling, tmuxName])
  // Set by the init effect: stops in-flight inertia + drops batched lines, so a
  // keystroke right after a flick can't be followed by a stale `up` that
  // re-enters copy-mode.
  const cancelInertiaRef = useRef<() => void>(() => {})
  // Set by the init effect's `wheel` listener on the container; cleared here.
  // Desktop mouse-wheel over a tmux pane goes straight to tmux (mouse on) and
  // can enter copy-mode without ever calling sendScroll, so scrollingRef stays
  // stale (false) even though the pane really is in copy-mode — the next
  // keystroke would then get eaten by tmux's copy-mode key table instead of
  // reaching the shell. So on desktop tmux sessions any wheel event since the
  // last exitScroll forces a cancel on the next keystroke regardless of
  // scrollingRef; this is safe because the server-side cancel is a no-op
  // outside copy-mode (T2's in_mode guard).
  const wheelSinceInputRef = useRef(false)
  // Leave copy-mode before any keystroke so input isn't swallowed by tmux.
  const exitScroll = useCallback(() => {
    cancelInertiaRef.current()
    const cancel = shouldCancelBeforeInput({
      scrolling: scrollingRef.current,
      isTouch,
      hasTmux: !!tmuxRef.current,
      wheelSinceInput: wheelSinceInputRef.current,
    })
    wheelSinceInputRef.current = false
    if (!cancel) return
    scrollingRef.current = false
    setScrolling(false)
    if (appScrollRef.current) {
      // No copy-mode to leave; typing into the app jumps it to the bottom itself.
      appScrollRef.current = false
      lastScrollOpRef.current = 'cancel'
      return
    }
    sendScroll({ op: 'cancel', n: 1 })
  }, [sendScroll, isTouch])
  // ⤓ pill button: copy-mode → cancel (exitScroll); fullscreen app → wheel to bottom.
  const scrollToBottom = useCallback(() => {
    if (!appScrollRef.current) { exitScroll(); return }
    cancelInertiaRef.current()
    appScrollRef.current = false
    scrollingRef.current = false
    setScrolling(false)
    sendScroll({ op: 'bottom', n: 1 })
  }, [exitScroll, sendScroll])

  // 桌面 Shift 拖选提示：tmux mouse=on 时普通拖动交给 tmux（复制模式/选窗格），
  // 只有 Shift+拖动才是浏览器原生选区。首次左键按下（非 Shift）提示一次。
  const onMouseDownHint = useCallback((e: React.MouseEvent) => {
    if (isTouch || !tmuxRef.current || e.shiftKey || e.button !== 0) return
    if (shouldShowShiftHint(localStorage)) { setShiftHint(true); setTimeout(() => setShiftHint(false), 4000) }
  }, [isTouch])

  // 所有 client→PTY 输入走这一条；term.onData 与 MobileKeyBar 共用。
  // 返回是否真正送出：重连窗口里 WS 未 OPEN 时为 false，调用方据此决定是否清空输入。
  const sendInput = useCallback((data: string) => {
    exitScroll()
    const ws = wsRef.current
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', data: b64encode(new TextEncoder().encode(data)) }))
      return true
    }
    return false
  }, [exitScroll])

  // 虚拟键：先回到底部（否则在 scrollback 里点键看不到反馈），再发对应字节。
  // 方向键/Enter 按 DECCKM 模式；控制键直发。
  const handleBarKey = useCallback((key: BarKey) => {
    const term = termRef.current
    if (!term) return
    term.scrollToBottom()
    if (key === 'claude' || key === 'codex' || key === 'crew') {
      sendInput(launchSequence(key))
    } else if (key === 'up' || key === 'down' || key === 'left' || key === 'right' || key === 'enter') {
      sendInput(arrowSequence(key, term.modes.applicationCursorKeysMode))
    } else {
      sendInput(controlSequence(key))
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
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() || 'ui-monospace, Menlo, monospace',
      theme: readTerminalTheme(),
      allowProposedApi: true,
      scrollback: 10000,
      macOptionClickForcesSelection: true,
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(containerRef.current)
    // OSC52 from tmux copy-mode → system clipboard; reads refused (see lib/clipboard).
    term.loadAddon(new ClipboardAddon(undefined, writeOnlyClipboard()))
    const search = new SearchAddon()
    term.loadAddon(search)
    searchRef.current = search

    try {
      const webgl = new WebglAddon()
      // Dispose on GPU context loss so xterm falls back to the canvas/DOM
      // renderer. Views are kept mounted-but-hidden (display:none) rather than
      // unmounted, so an offscreen terminal's WebGL context is routinely
      // reclaimed under memory pressure (common on mobile). Without this the
      // addon keeps rendering against a dead context → the terminal paints
      // blank/frozen on return with no recovery short of a page reload, even
      // though PTY data is still flowing. onContextLoss fires asynchronously,
      // so the constructor try/catch alone cannot cover it.
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
    } catch {
      // fallback to canvas
    }

    // Ctrl/Cmd+F: tmux sessions open the history drawer (xterm only holds the
    // current screen, not tmux's scrollback); bare-shell PTYs get in-terminal
    // search. Returning false suppresses the browser's own find-in-page.
    term.attachCustomKeyEventHandler(e => {
      if (e.type === 'keydown' && (e.ctrlKey || e.metaKey) && e.key === 'f') {
        if (tmuxRef.current) setHistoryOpen(true)
        else setSearchOpen(true)
        return false
      }
      return true
    })

    // A view mounted hidden (display:none) has no size; fitting it would
    // collapse cols/rows to FitAddon's tiny fallback.
    if (containerRef.current.clientWidth > 0 && containerRef.current.clientHeight > 0) fit.fit()
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
      exitScroll()
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
    // tmux terminals: drag → batched copy-mode scroll ops over the WS (+ inertia).
    const batcher = new ScrollBatcher(m => sendScrollRef.current(m))
    let lastY = 0, lastT = 0, vel = 0
    let stopInertia = () => {}
    const cancelInertia = () => { stopInertia(); stopInertia = () => {}; batcher.cancel() }
    cancelInertiaRef.current = cancelInertia

    const onTouchStart = (e: TouchEvent) => {
      // 仅单指进入滚动逻辑；多指（pinch）忽略。
      if (e.touches.length !== 1) { touchId = null; return }
      cancelInertia()  // a new touch stops the previous flick
      startY = e.touches[0].clientY
      touchId = e.touches[0].identifier
      lastY = e.touches[0].clientY; lastT = performance.now(); vel = 0
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
        if (tmuxRef.current) batcher.add(lines)
        else term.scrollLines(lines)
        startY = t.clientY
      }
      const now = performance.now()
      if (lastT) vel = (lastY - t.clientY) / Math.max(1, now - lastT)
      lastY = t.clientY; lastT = now
    }

    const onTouchEnd = () => {
      touchId = null
      if (tmuxRef.current) {
        batcher.flush()
        const rh = rowHeight(term.element?.clientHeight ?? 0, term.rows, FONT_SIZE)
        stopInertia()
        stopInertia = scheduleInertia(inertiaLines(vel, rh), l => batcher.add(l))
      }
      vel = 0; lastT = 0
    }

    container?.addEventListener('touchstart', onTouchStart, { passive: true })
    container?.addEventListener('touchmove', onTouchMove, { passive: false })
    container?.addEventListener('touchend', onTouchEnd, { passive: true })
    container?.addEventListener('touchcancel', onTouchEnd, { passive: true })

    // 桌面鼠标滚轮：tmux mouse=on 时滚轮直接喂给 tmux，可能不经 sendScroll
    // 就进入 copy-mode（见 wheelSinceInputRef 注释）。只需记一个标记，真正
    // 的 cancel 由下一次 exitScroll（keystroke/onData/onBinary）发出。
    const onWheel = () => { wheelSinceInputRef.current = true }
    container?.addEventListener('wheel', onWheel, { passive: true })

    return () => {
      container?.removeEventListener('touchstart', onTouchStart)
      container?.removeEventListener('touchmove', onTouchMove)
      container?.removeEventListener('touchend', onTouchEnd)
      container?.removeEventListener('wheel', onWheel)
      container?.removeEventListener('touchcancel', onTouchEnd)
      cancelInertia()
      cancelInertiaRef.current = () => {}
      batcher.dispose()
      if (scrollDebounceRef.current) clearTimeout(scrollDebounceRef.current)
      term.dispose()
    }
  }, [sessionId])

  // Update terminal theme when it changes
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = readTerminalTheme()
    }
  }, [theme])

  // 上一次发给 PTY 的 cols/rows。handleResize 据此跳过冗余 resize；onopen
  // 重连首发也要同步它，否则下一次「真实尺寸变回这个旧值」会被误判为冗余而漏发。
  const lastDims = useRef<{ cols: number; rows: number }>({ cols: 0, rows: 0 })

  const onOpen = useCallback((send: (msg: object) => void) => {
    // Arm the replay window: the server is about to replay full scrollback.
    // Only bare-shell PTYs replay scrollback; tmux repaints via refresh-client.
    replayingRef.current = !tmuxRef.current
    userScrolledUpRef.current = false
    // Only a tmux terminal keeps history server-side across a reconnect —
    // a bare-shell PTY reconnect just gets the same replay it always got.
    if (openedOnceRef.current && tmuxRef.current) setReconnected(true)
    openedOnceRef.current = true
    // A new socket starts outside copy-mode as far as the UI knows: clear the
    // pill. If we were reading history, the pane may still be in copy-mode
    // server-side, so cancel it (a no-op outside copy-mode). scroll_watch
    // is per-connection server-side; the [scrolling] effect disarms it.
    const wasScrolling = scrollingRef.current || appScrollRef.current
    scrollingRef.current = false
    appScrollRef.current = false
    lastScrollOpRef.current = 'cancel'
    setScrolling(false)
    setNewLines(0)
    if (wasScrolling && tmuxRef.current) send({ type: 'scroll', op: 'cancel', n: 1 })
  }, [])

  const onNotice = useCallback((kind: 'tmux_lost' | 'tmux_ended' | 'tmux_down') => {
    if (kind === 'tmux_lost') setLost(true)
    if (kind === 'tmux_ended') setEnded(true)
    if (kind === 'tmux_down') setHealth({ server: false, in_unit: false })
  }, [])

  const onScrollState = useCallback((msg: { in_mode?: boolean; app_scroll?: boolean; new_lines?: unknown }) => {
    const p = pillFromScrollState(msg, lastScrollOpRef.current, scrollingRef.current)
    appScrollRef.current = p.appScroll
    scrollingRef.current = p.scrolling
    setScrolling(p.scrolling)
    if (typeof msg.new_lines === 'number') setNewLines(msg.new_lines)
  }, [])

  const onOutputSettled = useCallback(() => {
    if (scrollDebounceRef.current) clearTimeout(scrollDebounceRef.current)
    scrollDebounceRef.current = setTimeout(() => {
      if (shouldStickToBottom({ replaying: replayingRef.current, userScrolledUp: userScrolledUpRef.current })) {
        termRef.current?.scrollToBottom()
      }
      // First settle after the replay burst closes the window: live
      // output afterwards must not auto-scroll (user may read scrollback).
      replayingRef.current = false
    }, 120)
  }, [])

  // Connect WebSocket. Must stay AFTER the init effect: it relies on termRef
  // having been set in the same commit (termRef isn't a dep).
  const { wsStatus, sendRaw } = useTerminalSocket({
    sessionId, epoch: wsEpoch, wsRef, endedRef, lastDims, termRef, fitRef, containerRef, activeRef, tmuxRef, tmuxOriginRef,
    onOutputSettled, onScrollState, onNotice, onOpen,
  })

  // Stable identity so ReconnectHint's 3s auto-dismiss timer isn't reset by every
  // parent re-render (a new inline arrow each render would restart the setTimeout).
  const hideReconnect = useCallback(() => setReconnected(false), [])

  const handleRevive = useCallback(async () => {
    try {
      await reviveSession(sessionId)
    } catch {
      return // stay on the overlay; user can retry or close
    }
    endedRef.current = false
    setEnded(false)
    setWsEpoch(e => e + 1)
  }, [sessionId])

  const handleResize = useCallback(() => {
    const fit = fitRef.current
    const term = termRef.current
    const ws = wsRef.current
    const el = containerRef.current
    if (!fit || !term || !el) return
    // Every mounted view gets window resize events; a hidden one has a 0x0
    // container and fitting it would corrupt its cols/rows.
    if (el.clientWidth === 0 || el.clientHeight === 0) return
    fit.fit()
    // Skip redundant resize sends (Android fires window.resize on soft-keyboard
    // open → SIGWINCH spam) and anything from an inactive view or with
    // below-minimum dims (see lib/terminalSize).
    if (ws?.readyState === WebSocket.OPEN && shouldSendResize({
      active: activeRef.current,
      containerWidth: el.clientWidth,
      containerHeight: el.clientHeight,
      cols: term.cols,
      rows: term.rows,
      last: lastDims.current,
    })) {
      lastDims.current = { cols: term.cols, rows: term.rows }
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
    }
  }, [])

  useEffect(() => {
    if (active) {
      // Re-shown view always reclaims the window size: another client may have
      // resized it (window-size latest) while this view was hidden.
      lastDims.current = { cols: 0, rows: 0 }
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

  // 键条 / composer 占用高度，改变终端可用区；渲染后重新 fit，
  // 避免底部行被遮 / canvas 尺寸过期。软键盘弹起/收起时 VisualViewport effect 改了
  // paddingBottom（iOS 不发 window.resize），这里是唯一的重算路径：每次切换 fit 一次。
  useEffect(() => {
    if (!isTouch) return
    const t = setTimeout(handleResize, 50)
    return () => clearTimeout(t)
  }, [isTouch, keyboardOpen, handleResize])

  // ConnectionBar is rendered while not open and removed on open, changing the
  // terminal's height after onopen already measured (rows N-1). Refit once the
  // bar is gone. handleResize skips hidden views and redundant sizes (I-12).
  useEffect(() => {
    if (wsStatus.status !== 'open') return
    const t = setTimeout(handleResize, 50)
    return () => clearTimeout(t)
  }, [wsStatus.status, handleResize])

  // Split history halves the terminal width; refit so tmux reflows to the new cols.
  useEffect(() => {
    if (!split) return
    const t = setTimeout(handleResize, 50)
    return () => clearTimeout(t)
  }, [split, historyOpen, handleResize])

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

  const scrollPill = tmuxName && scrolling ? (
    <div className={`absolute right-3 z-10 flex gap-1 text-xs ${isTouch ? 'bottom-full mb-2' : 'bottom-28'}`}>
      <button aria-label="scroll-top" onPointerDown={e => { e.preventDefault(); sendScroll({ op: 'top', n: 1 }) }}
        className="flex items-center px-2.5 py-1.5 rounded-full bg-[var(--bg-tertiary)] border border-[var(--border)] shadow">
        <ArrowUpToLine size={14} />
      </button>
      <button aria-label="scroll-bottom" onPointerDown={e => { e.preventDefault(); scrollToBottom() }}
        className="flex items-center gap-1 px-3 py-1.5 rounded-full bg-[var(--accent-blue)] text-white shadow">
        <ArrowDownToLine size={14} />{newLines > 0 ? `${newLines} 行新输出` : '回到底部'}
      </button>
    </div>
  ) : null

  return (
    <div className="relative flex flex-col h-full">
      {tmuxName && <TmuxHealthBar health={health} />}
      {lost && <LostBanner onClose={() => setLost(false)} />}
      <div ref={containerRef} onMouseDown={onMouseDownHint} className={`xterm-container ${historySplit ? 'w-1/2' : 'w-full'} flex-1 min-h-0`} />
      {searchOpen && (
        <div className="absolute top-2 right-3 z-10 flex items-center gap-1 px-2 py-1 rounded border border-[var(--border)] bg-[var(--bg-secondary)] text-xs">
          <input autoFocus value={searchQ} onChange={e => { setSearchQ(e.target.value); searchRef.current?.findNext(e.target.value) }}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                if (e.shiftKey) searchRef.current?.findPrevious(searchQ)
                else searchRef.current?.findNext(searchQ)
              }
              if (e.key === 'Escape') { setSearchOpen(false); termRef.current?.focus() }
            }}
            placeholder="搜索" className="w-40 bg-transparent outline-none text-[var(--text-primary)]" />
          <button onClick={() => { setSearchOpen(false); termRef.current?.focus() }}>✕</button>
        </div>
      )}
      {shiftHint && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 z-10 px-3 py-1 rounded-full text-xs bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
          按住 Shift 拖动可选择文字（{navigator.platform.includes('Mac') ? 'Mac 也可按 Option' : '或在历史中长按'}）
        </div>
      )}
      {ended && <EndedOverlay name={tmuxName ?? ''} origin={tmuxOrigin} onRevive={handleRevive} onClose={() => onClose?.()} />}
      {reconnected && (
        <ReconnectHint
          onOpenHistory={() => { setReconnected(false); setHistoryOpen(true) }}
          onDone={hideReconnect}
        />
      )}
      {historyOpen && <HistoryView sessionId={sessionId} title={tmuxName ?? ''} split={split} onClose={() => setHistoryOpen(false)}
        onSendToAgent={onAskAgent ? (t) => {
          setHistoryOpen(false)
          onAskAgent(historyPrompt({ name: tmuxName ?? '', workDir: status?.work_dir ?? '', text: t }))
        } : undefined} />}
      {!isTouch && scrollPill}
      {!isTouch && <ConnectionBar status={wsStatus.status} sinceMs={wsStatus.since} />}
      {/* 触摸端：一个底部容器装 胶囊(浮于键栏之上) + 连接条 + 键栏 + 常驻输入框(贴底，最靠近软键盘)。
          历史抽屉全屏打开时隐藏；横屏分屏时左侧终端仍可用。 */}
      {isTouch && !(historyOpen && !split) && (
        <div data-testid="term-bottom" className="relative">
          {scrollPill}
          <ConnectionBar status={wsStatus.status} sinceMs={wsStatus.since} />
          <MobileKeyBar onKey={handleBarKey} onHistory={tmuxName ? () => setHistoryOpen(true) : undefined} />
          <div className="px-2 py-1.5 border-t border-[var(--border)] bg-[var(--bg-secondary)]">
            <Composer
              value={composerText}
              onChange={setComposerText}
              onSend={sendComposer}
              submitOnEnter={false}
              placeholder="输入文字，点 ✈ 发送…"
            />
          </div>
        </div>
      )}
      {/* 状态栏：仅桌面。触屏上路径本就被截断，顶栏已显示会话名，把高度让给终端。 */}
      {!isTouch && (
      <div className="flex items-center gap-3 px-4 py-3 border-t border-[var(--border)] bg-[var(--bg-secondary)] min-h-[40px]">
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
        {tmuxName && mouseToggleApplies(tmuxOrigin) && (
          <button onClick={() => {
              const on = !mouseOn
              setMouseOn(on)
              localStorage.setItem(MOUSE_PREF_KEY, on ? '1' : '0')
              sendRaw({ type: 'mouse', on })
            }}
            title={mouseOn ? '鼠标交给 tmux（滚轮滚动、点选窗格）' : '鼠标交给浏览器（直接拖选文字）'}
            className="ml-auto text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
            {mouseOn ? '🖱 tmux' : '🖱 浏览器'}
          </button>
        )}
        {tmuxName && (
          <button
            onClick={async () => { if (await copyText(attachCommand(tmuxName))) { setChipCopied(true); setTimeout(() => setChipCopied(false), 1500) } }}
            title={attachCommand(tmuxName)}
            className={`flex items-center gap-1 px-1.5 py-0.5 rounded border border-[var(--border)] text-[11px] font-mono text-[var(--text-secondary)] hover:text-[var(--text-primary)]`}
          >
            {chipCopied ? '已复制' : `⧉ ${tmuxName}`}
          </button>
        )}
        {tmuxName && (
          <button onClick={() => setHistoryOpen(true)} className="text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]">历史</button>
        )}
      </div>
      )}
    </div>
  )
}
