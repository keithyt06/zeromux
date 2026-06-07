// 手势 / 虚拟按键 → 终端动作的纯函数。集中放在这里以便单测，
// 也把 codex 评审的两处约定（DECCKM 序列、滚动方向）锁在测试里。

export type ArrowKey = 'up' | 'down' | 'left' | 'right' | 'enter'

// 普通光标键模式（DECCKM off）：CSI 序列。
const CSI: Record<Exclude<ArrowKey, 'enter'>, string> = {
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
}

// 应用光标键模式（DECCKM on，多数全屏 TUI 菜单启用）：SS3 序列。
const SS3: Record<Exclude<ArrowKey, 'enter'>, string> = {
  up: '\x1bOA',
  down: '\x1bOB',
  right: '\x1bOC',
  left: '\x1bOD',
}

/**
 * 按光标键模式生成方向键转义序列。
 * appCursorKeys 取自 xterm 公开 API `term.modes.applicationCursorKeysMode`。
 */
export function arrowSequence(key: ArrowKey, appCursorKeys: boolean): string {
  if (key === 'enter') return '\r'
  return (appCursorKeys ? SS3 : CSI)[key]
}

/** 行高 = clientHeight / rows（公开 API）；任一非正时回落 fontSize*1.2。 */
export function rowHeight(clientHeight: number, rows: number, fontSize: number): number {
  if (clientHeight > 0 && rows > 0) return clientHeight / rows
  return fontSize * 1.2
}

/**
 * 触摸拖动 → xterm 滚动行数。
 * dy = startY - currentY：手指上移为正 → scrollLines 正数 → 向下滚（看更新内容）。
 * rowHeight 非正时返回 0。
 */
export function linesFromDrag(startY: number, currentY: number, rh: number): number {
  if (rh <= 0) return 0
  return Math.round((startY - currentY) / rh)
}

// 整段提交：bracketed paste（DECSET 2004）。内部 \n 原样保留，
// 支持的 TUI（Claude Code / Codex / bash readline）把整段当粘贴内容，
// 不会逐行提交。调用方负责非空判断。
export function bracketedPaste(text: string): string {
  return `\x1b[200~${text}\x1b[201~`
}

// paste 后是否发回车，取决于对端 bracketed paste 模式
// （xterm 公开 API term.modes.bracketedPasteMode）。
// 开（TUI 输入框）→ 发 \r 提交；关（裸 shell）→ 不发，避免多行命令被误执行。
export function submitSequence(bracketedPasteMode: boolean): string {
  return bracketedPasteMode ? '\r' : ''
}

// 单键 / 控制键 → 直发字节。与方向键分开：这些走 MobileKeyBar，不经 composer。
export type ControlKey = 'esc' | 'ctrl-c' | 'y' | 'n'

const CONTROL: Record<ControlKey, string> = {
  esc: '\x1b',
  'ctrl-c': '\x03',
  y: 'y',
  n: 'n',
}

export function controlSequence(key: ControlKey): string {
  return CONTROL[key]
}
