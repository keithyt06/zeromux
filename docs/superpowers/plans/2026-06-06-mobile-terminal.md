# 终端移动端适配 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让手机浏览器里的 ZeroMux 终端能用手指上下滑动看历史，并用一条虚拟方向键条在 claude 的 TUI 菜单里上下选择。

**Architecture:** 纯前端、后端零改动。把"手势/按键 → 终端动作"的三个纯函数抽到 `lib/terminalInput.ts`（可单测，承载 codex 评审的核心修正）；`MobileKeyBar.tsx` 是无状态键条组件；`TerminalView.tsx` 把真实 touch / pointer 事件接到这些纯函数上，并按光标键模式（DECCKM）生成方向键序列、点键前回到底部、键条出现后重新 fit。按键复用现有 `term.onData → WS {type:'input'}` 通道。

**Tech Stack:** React 19 + TypeScript + Vite + Tailwind v4，xterm.js v6（`scrollLines` / `scrollToBottom` / `element` / `rows` / `modes.applicationCursorKeysMode` 均为公开 API），vitest + happy-dom + @testing-library/react，lucide-react 图标。

参考 spec：`docs/superpowers/specs/2026-06-06-mobile-terminal-design.md`

---

## File Structure

- **Create** `frontend/src/lib/terminalInput.ts` — 三个纯函数 + `ArrowKey` 类型：`arrowSequence`（按 DECCKM 生成方向/Enter 序列）、`rowHeight`（公开 API 算行高 + 回落）、`linesFromDrag`（手指位移 → 滚动行数，锁定方向约定）。
- **Create** `frontend/src/lib/__tests__/terminalInput.test.ts` — 上述纯函数的单测。
- **Create** `frontend/src/components/MobileKeyBar.tsx` — 5 键无状态键条，`onPointerDown` 触发、传逻辑键名。
- **Create** `frontend/src/components/__tests__/MobileKeyBar.test.tsx` — 组件单测。
- **Modify** `frontend/src/components/TerminalView.tsx` — 抽 `sendInput`、加触摸滚动监听、触摸设备检测、渲染键条、键条出现后重新 fit。
- **Modify** `frontend/src/index.css` — 终端容器/screen/viewport 的 `touch-action: none` + `overscroll-behavior: contain`。

---

### Task 1: 纯函数 `lib/terminalInput.ts`（DECCKM 序列 + 行高 + 拖动换算）

**Files:**
- Create: `frontend/src/lib/terminalInput.ts`
- Test: `frontend/src/lib/__tests__/terminalInput.test.ts`

- [ ] **Step 1: 写失败测试**

Create `frontend/src/lib/__tests__/terminalInput.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { arrowSequence, rowHeight, linesFromDrag } from '../terminalInput'

describe('arrowSequence', () => {
  it('普通光标键模式用 CSI（\\x1b[）', () => {
    expect(arrowSequence('up', false)).toBe('\x1b[A')
    expect(arrowSequence('down', false)).toBe('\x1b[B')
    expect(arrowSequence('right', false)).toBe('\x1b[C')
    expect(arrowSequence('left', false)).toBe('\x1b[D')
  })
  it('应用光标键模式用 SS3（\\x1bO）—— claude TUI 菜单常用', () => {
    expect(arrowSequence('up', true)).toBe('\x1bOA')
    expect(arrowSequence('down', true)).toBe('\x1bOB')
    expect(arrowSequence('right', true)).toBe('\x1bOC')
    expect(arrowSequence('left', true)).toBe('\x1bOD')
  })
  it('Enter 恒为回车，与模式无关', () => {
    expect(arrowSequence('enter', false)).toBe('\r')
    expect(arrowSequence('enter', true)).toBe('\r')
  })
})

describe('rowHeight', () => {
  it('clientHeight / rows', () => {
    expect(rowHeight(480, 24, 14)).toBe(20)
  })
  it('clientHeight 为 0 时回落 fontSize*1.2', () => {
    expect(rowHeight(0, 24, 14)).toBeCloseTo(16.8)
  })
  it('rows 为 0 时回落 fontSize*1.2', () => {
    expect(rowHeight(480, 0, 14)).toBeCloseTo(16.8)
  })
})

describe('linesFromDrag', () => {
  it('手指上移（currentY < startY）→ 向下滚（正数，看更新内容）', () => {
    expect(linesFromDrag(200, 100, 20)).toBe(5)
  })
  it('手指下移（currentY > startY）→ 向上滚（负数，看历史）', () => {
    expect(linesFromDrag(100, 200, 20)).toBe(-5)
  })
  it('不足一行的微小移动返回 0', () => {
    expect(linesFromDrag(100, 95, 20)).toBe(0)
  })
  it('行高非正时返回 0（不崩）', () => {
    expect(linesFromDrag(200, 100, 0)).toBe(0)
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd frontend && npx vitest run src/lib/__tests__/terminalInput.test.ts`
Expected: FAIL，报 `Failed to resolve import "../terminalInput"` 或函数未定义。

- [ ] **Step 3: 写最小实现**

Create `frontend/src/lib/terminalInput.ts`:

```ts
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
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd frontend && npx vitest run src/lib/__tests__/terminalInput.test.ts`
Expected: PASS（13 个断言全绿）。

- [ ] **Step 5: 提交**

```bash
cd /home/ubuntu/s3-workspace/keith-space/github-search/ai/zeromux
git add frontend/src/lib/terminalInput.ts frontend/src/lib/__tests__/terminalInput.test.ts
git commit -m "feat(term): pure helpers for DECCKM arrow sequences + touch-scroll math"
```

---

### Task 2: `MobileKeyBar.tsx` 虚拟方向键条组件

**Files:**
- Create: `frontend/src/components/MobileKeyBar.tsx`
- Test: `frontend/src/components/__tests__/MobileKeyBar.test.tsx`

- [ ] **Step 1: 写失败测试**

Create `frontend/src/components/__tests__/MobileKeyBar.test.tsx`:

```tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import MobileKeyBar from '../MobileKeyBar'

describe('MobileKeyBar', () => {
  it('渲染全部 5 个键', () => {
    render(<MobileKeyBar onKey={() => {}} />)
    for (const k of ['left', 'up', 'down', 'right', 'enter']) {
      expect(screen.getByLabelText(k)).toBeInTheDocument()
    }
  })

  it('pointerDown 时用逻辑键名触发 onKey', () => {
    const onKey = vi.fn()
    render(<MobileKeyBar onKey={onKey} />)
    fireEvent.pointerDown(screen.getByLabelText('up'))
    expect(onKey).toHaveBeenCalledWith('up')
    fireEvent.pointerDown(screen.getByLabelText('enter'))
    expect(onKey).toHaveBeenCalledWith('enter')
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd frontend && npx vitest run src/components/__tests__/MobileKeyBar.test.tsx`
Expected: FAIL，报无法解析 `../MobileKeyBar`。

- [ ] **Step 3: 写最小实现**

Create `frontend/src/components/MobileKeyBar.tsx`:

```tsx
import { ArrowUp, ArrowDown, ArrowLeft, ArrowRight, CornerDownLeft, type LucideIcon } from 'lucide-react'
import type { ArrowKey } from '../lib/terminalInput'

// 顺序：← ↑ ↓ → Enter（与 spec 一致）。aria-label 用逻辑键名，便于测试与无障碍。
const KEYS: { key: ArrowKey; Icon: LucideIcon }[] = [
  { key: 'left', Icon: ArrowLeft },
  { key: 'up', Icon: ArrowUp },
  { key: 'down', Icon: ArrowDown },
  { key: 'right', Icon: ArrowRight },
  { key: 'enter', Icon: CornerDownLeft },
]

export default function MobileKeyBar({ onKey }: { onKey: (key: ArrowKey) => void }) {
  return (
    <div className="flex items-stretch gap-1 px-2 py-1.5 border-t border-[var(--border)] bg-[var(--bg-secondary)]">
      {KEYS.map(({ key, Icon }) => (
        <button
          key={key}
          aria-label={key}
          // onPointerDown + preventDefault：手机上避免按钮抢走终端焦点 / 触发软键盘。
          onPointerDown={(e) => {
            e.preventDefault()
            onKey(key)
          }}
          style={{ touchAction: 'manipulation' }}
          className="flex-1 flex items-center justify-center py-2 rounded-md bg-[var(--bg-primary)] border border-[var(--border)] text-[var(--text-secondary)] active:bg-[var(--bg-hover)] active:text-[var(--text-primary)]"
        >
          <Icon size={18} />
        </button>
      ))}
    </div>
  )
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd frontend && npx vitest run src/components/__tests__/MobileKeyBar.test.tsx`
Expected: PASS。

若 happy-dom 不支持 `fireEvent.pointerDown`（报 PointerEvent 未定义），把组件的 `onPointerDown` 与测试的 `fireEvent.pointerDown` 同时改为 `onMouseDown` / `fireEvent.mouseDown`——但优先保留 pointer（真机需要）；happy-dom 当前版本支持 pointer 事件。

- [ ] **Step 5: 提交**

```bash
cd /home/ubuntu/s3-workspace/keith-space/github-search/ai/zeromux
git add frontend/src/components/MobileKeyBar.tsx frontend/src/components/__tests__/MobileKeyBar.test.tsx
git commit -m "feat(term): MobileKeyBar virtual arrow-key bar component"
```

---

### Task 3: `index.css` 禁止原生触摸滚动（完全接管手势）

**Files:**
- Modify: `frontend/src/index.css:60-68`（`/* ── xterm ── */` 段）

- [ ] **Step 1: 修改 CSS**

把 `frontend/src/index.css` 末尾的 xterm 段：

```css
/* ── xterm ── */

.xterm-container {
  width: 100%;
  height: 100%;
}
.xterm-container .xterm {
  height: 100%;
}
```

改为（追加触摸策略；容器 + screen + viewport 统一禁止浏览器原生滚动 / 橡皮筋，滚动完全由 JS 的 `scrollLines()` 驱动）：

```css
/* ── xterm ── */

.xterm-container {
  width: 100%;
  height: 100%;
}
.xterm-container .xterm {
  height: 100%;
}
/* 移动端：完全接管触摸手势，禁止浏览器原生滚动与 overscroll 橡皮筋。
   实际触点可能落在 screen 画布或 viewport 上，三处都要声明。 */
.xterm-container,
.xterm-container .xterm-screen,
.xterm-container .xterm-viewport {
  touch-action: none;
  overscroll-behavior: contain;
}
```

- [ ] **Step 2: 验证构建不报错**

Run: `cd frontend && npx tsc -b`
Expected: 无类型错误（CSS 不参与 tsc，但确认没碰坏其它东西）。CSS 的真实效果在 Task 4 集成后真机验证。

- [ ] **Step 3: 提交**

```bash
cd /home/ubuntu/s3-workspace/keith-space/github-search/ai/zeromux
git add frontend/src/index.css
git commit -m "feat(term): disable native touch scroll on xterm so JS owns the gesture"
```

---

### Task 4: 接入 `TerminalView.tsx`（检测 + 触摸滚动 + sendInput + 键条 + refit）

**Files:**
- Modify: `frontend/src/components/TerminalView.tsx`

这一步把前几个 Task 的纯函数 / 组件接到真实事件上。触摸手势依赖真实浏览器，单测价值低 —— 逻辑正确性已由 Task 1/2 的单测保证，本 Task 用 `tsc` + 真机手测验收。

- [ ] **Step 1: 加导入**

在 `TerminalView.tsx` 顶部 import 区（现有第 1-9 行附近），现有：

```ts
import { useEffect, useRef, useCallback, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { wsUrl, getSessionStatus } from '../lib/api'
import type { SessionStatus } from '../lib/api'
import type { Theme } from '../lib/theme'
import { b64encode, b64decode } from '../lib/base64'
import { GitBranch, Folder, Circle } from 'lucide-react'
```

追加两行：

```ts
import MobileKeyBar from './MobileKeyBar'
import { arrowSequence, rowHeight, linesFromDrag, type ArrowKey } from '../lib/terminalInput'
```

- [ ] **Step 2: 加触摸设备检测 state**

在组件体内（现有 `const [status, setStatus] = useState<SessionStatus | null>(null)` 之后，约第 70 行）追加：

```ts
  const [isTouch, setIsTouch] = useState(false)

  // 触摸设备检测：any-pointer:coarse 或 maxTouchPoints>0，少漏触屏笔记本/iPad。
  useEffect(() => {
    const touch =
      (typeof matchMedia !== 'undefined' && matchMedia('(any-pointer: coarse)').matches) ||
      (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0)
    setIsTouch(touch)
  }, [])
```

- [ ] **Step 3: 抽出 `sendInput`，并加 `handleArrowKey`**

在组件体内、init effect（现有 `// Initialize terminal once` 那个 useEffect，约第 86 行）**之前**插入：

```ts
  // 所有 client→PTY 输入走这一条；term.onData 与 MobileKeyBar 共用。
  const sendInput = useCallback((data: string) => {
    const ws = wsRef.current
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', data: b64encode(new TextEncoder().encode(data)) }))
    }
  }, [])

  // 虚拟方向键：先回到底部（否则用户在 scrollback 里点键看不到反馈），
  // 再按当前光标键模式（DECCKM）生成序列发送。
  const handleArrowKey = useCallback((key: ArrowKey) => {
    const term = termRef.current
    if (!term) return
    term.scrollToBottom()
    sendInput(arrowSequence(key, term.modes.applicationCursorKeysMode))
  }, [sendInput])
```

- [ ] **Step 4: 用 `sendInput` 替换 `onData` 的内联实现**

把现有 `term.onData`（约第 112-117 行）：

```ts
    term.onData(data => {
      const ws = wsRef.current
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data: b64encode(new TextEncoder().encode(data)) }))
      }
    })
```

改为：

```ts
    term.onData(data => {
      sendInput(data)
    })
```

（`onBinary` 保持不变——它走的是 charCode→bytes 的不同路径。）

- [ ] **Step 5: 在 init effect 内、`term.onData`/`onBinary` 之后加触摸滚动监听**

在 `term.onBinary(...)` 块结束之后、init effect 的 `return () => { ... }` cleanup（约第 128 行）**之前**插入：

```ts
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
      const rh = rowHeight(term.element?.clientHeight ?? 0, term.rows, 14)
      const lines = linesFromDrag(startY, t.clientY, rh)
      if (lines !== 0) {
        term.scrollLines(lines)
        startY = t.clientY
      }
    }

    container?.addEventListener('touchstart', onTouchStart, { passive: true })
    container?.addEventListener('touchmove', onTouchMove, { passive: false })
```

然后把现有 cleanup：

```ts
    return () => {
      wsRef.current?.close()
      term.dispose()
    }
```

改为：

```ts
    return () => {
      container?.removeEventListener('touchstart', onTouchStart)
      container?.removeEventListener('touchmove', onTouchMove)
      wsRef.current?.close()
      term.dispose()
    }
```

- [ ] **Step 6: 键条出现后重新 fit**

在现有 `useEffect(() => { window.addEventListener('resize', handleResize) ... })`（约第 221 行）**之后**追加一个 effect：

```ts
  // 键条占用约 40px 高度，改变终端可用区；渲染后重新 fit，避免底部行被遮 / canvas 尺寸过期。
  useEffect(() => {
    if (!isTouch) return
    const t = setTimeout(handleResize, 50)
    return () => clearTimeout(t)
  }, [isTouch, handleResize])
```

- [ ] **Step 7: 在 JSX 里渲染键条**

把现有 return 的开头（约第 226-228 行）：

```tsx
  return (
    <div className="flex flex-col h-full">
      <div ref={containerRef} className="xterm-container w-full flex-1 min-h-0" />
      <div className="flex items-center gap-3 px-4 py-3 border-t border-[var(--border)] bg-[var(--bg-secondary)] min-h-[40px]">
```

改为（在终端容器与底部状态栏之间插入键条，仅触摸设备渲染）：

```tsx
  return (
    <div className="flex flex-col h-full">
      <div ref={containerRef} className="xterm-container w-full flex-1 min-h-0" />
      {isTouch && <MobileKeyBar onKey={handleArrowKey} />}
      <div className="flex items-center gap-3 px-4 py-3 border-t border-[var(--border)] bg-[var(--bg-secondary)] min-h-[40px]">
```

- [ ] **Step 8: 类型检查 + lint + 全量单测**

Run:
```bash
cd frontend && npx tsc -b && npm run lint && npx vitest run
```
Expected: tsc 无错；lint 通过；所有 vitest（含 Task 1/2 新增）PASS。

常见坑：`term.element` 类型是 `HTMLElement | undefined`，已用 `?.` 和 `?? 0` 兜底；`term.modes` 是公开只读属性，类型自带。

- [ ] **Step 9: 提交**

```bash
cd /home/ubuntu/s3-workspace/keith-space/github-search/ai/zeromux
git add frontend/src/components/TerminalView.tsx
git commit -m "feat(term): wire mobile touch-scroll + virtual arrow keys into TerminalView"
```

---

### Task 5: 构建产物 + 真机验收

**Files:** 无（验证步骤）

- [ ] **Step 1: 全量前端构建**

Run: `cd frontend && npm run build`
Expected: `tsc -b && vite build` 成功，产出 `frontend/dist/`（rust-embed 编译期需要）。

- [ ] **Step 2: 真机手测（验收标准，对照 spec）**

部署后用手机浏览器打开一个 **Tmux/终端会话**（参考 memory 的 zeromux-deploy 流程），验证：

1. **验收 1（划看历史）**：在普通 shell 输出（如 `ls -la` 多屏或 `seq 200`）下，手指上下滑动 → 终端内容跟随滚动，能看到屏幕外的历史；松手停住不回弹；整页不跟着橡皮筋滚动。
2. **验收 2（菜单上下选）**：在终端里跑 `claude`，触发一次权限菜单，点虚拟 `↑/↓` → 高亮在选项间移动，点 `Enter` → 确认选择，全程不弹出软键盘。
3. **回归**：桌面浏览器打开同一终端 —— 键条不出现，物理键盘方向键、滚轮、输入一切照旧。

若验收 2 中方向键无反应：确认 `term.modes.applicationCursorKeysMode` 在该菜单下的取值，核对 `arrowSequence` 分支（这正是 Task 1 单测覆盖的逻辑）。

- [ ] **Step 3: 标记完成**

真机两条验收通过后，此计划完成。无需额外提交（前 4 个 Task 已分别提交）。

---

## 验收标准映射（spec → task）

| spec 要求 | 对应 Task |
|---|---|
| 触摸滑动看历史 | Task 1（`linesFromDrag`/`rowHeight`）+ Task 3（CSS）+ Task 4 Step 5 |
| DECCKM 动态方向键序列 | Task 1（`arrowSequence`）+ Task 4 Step 3 |
| 5 键键条、`onPointerDown`、忽略软键盘 | Task 2 |
| 点键前 `scrollToBottom` | Task 4 Step 3（`handleArrowKey`） |
| 仅触摸设备渲染（any-pointer/maxTouchPoints） | Task 4 Step 2 + Step 7 |
| 键条出现后重新 fit | Task 4 Step 6 |
| 完全接管手势 / 忽略多指 | Task 3（CSS）+ Task 4 Step 5 |
| 后端零改动、复用 WS 通道 | Task 4 Step 3/4（`sendInput`） |
| 纯函数单测（DECCKM 映射） | Task 1 测试 |
| tmux copy-mode 不做 | 不在任何 Task —— spec“不做”明确排除 |
