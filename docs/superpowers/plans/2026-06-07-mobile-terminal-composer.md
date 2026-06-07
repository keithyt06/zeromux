# Mobile Terminal Composer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the connect-terminal view a default-collapsed mobile composer that submits whole prompts via bracketed paste (no per-char IME loss/latency) and stops the soft keyboard from occluding agent output.

**Architecture:** Add pure input-sequence helpers (bracketed paste, submit, control keys) to `terminalInput.ts` with unit tests. Extract the chat view's input block into a shared `<Composer>` whose submit semantics are injected via props. Wire the composer into `TerminalView` for touch devices, fix keyboard occlusion with VisualViewport (container-height only, no cols/rows churn), and extend `MobileKeyBar` with control keys (Esc/Ctrl-C/y/n) so single-key TUI interaction never needs the composer.

**Tech Stack:** React + TypeScript, xterm.js, Vitest + @testing-library/react. Spec: `docs/superpowers/specs/2026-06-07-mobile-terminal-composer-design.md`.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `frontend/src/lib/terminalInput.ts` | Pure fns: existing arrow/scroll + new `bracketedPaste`, `submitSequence`, widen control-key type + `controlSequence` |
| `frontend/src/lib/__tests__/terminalInput.test.ts` | Unit tests for the new pure fns |
| `frontend/src/components/Composer.tsx` | NEW. Shared input shell: autoResize textarea + send button; submit semantics via props |
| `frontend/src/components/AcpChatView.tsx` | Replace inline input block with `<Composer submitOnEnter>`, keep voice/busy/interrupt here |
| `frontend/src/components/MobileKeyBar.tsx` | Add Esc / Ctrl-C / y / n keys (direct byte send) |
| `frontend/src/components/__tests__/MobileKeyBar.test.tsx` | Cover new keys |
| `frontend/src/components/TerminalView.tsx` | Touch-only collapsible composer; VisualViewport container compensation; fit debounce + dims-skip; `if(!active)` guards; scrollToBottom on send |

Build/verify commands (run from `frontend/`): `npx vitest run`, `npx tsc -b`.

---

## Task 1: Pure input-sequence helpers

**Files:**
- Modify: `frontend/src/lib/terminalInput.ts`
- Test: `frontend/src/lib/__tests__/terminalInput.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/lib/__tests__/terminalInput.test.ts`:

```ts
import { bracketedPaste, submitSequence, controlSequence } from '../terminalInput'

describe('bracketedPaste', () => {
  it('wraps text in DECSET 2004 paste markers', () => {
    expect(bracketedPaste('hello')).toBe('\x1b[200~hello\x1b[201~')
  })
  it('preserves internal newlines (multi-line prompt stays one paste)', () => {
    expect(bracketedPaste('a\nb\nc')).toBe('\x1b[200~a\nb\nc\x1b[201~')
  })
  it('empty string still wrapped (caller guards emptiness)', () => {
    expect(bracketedPaste('')).toBe('\x1b[200~\x1b[201~')
  })
})

describe('submitSequence', () => {
  it('bracketed-paste mode ON → CR (TUI input box, e.g. Claude Code)', () => {
    expect(submitSequence(true)).toBe('\r')
  })
  it('bracketed-paste mode OFF → empty (bare shell: do not auto-execute multi-line)', () => {
    expect(submitSequence(false)).toBe('')
  })
})

describe('controlSequence', () => {
  it('esc → ESC byte', () => { expect(controlSequence('esc')).toBe('\x1b') })
  it('ctrl-c → ETX (0x03)', () => { expect(controlSequence('ctrl-c')).toBe('\x03') })
  it('y / n → literal chars', () => {
    expect(controlSequence('y')).toBe('y')
    expect(controlSequence('n')).toBe('n')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/lib/__tests__/terminalInput.test.ts`
Expected: FAIL — `bracketedPaste`/`submitSequence`/`controlSequence` not exported.

- [ ] **Step 3: Implement the helpers**

Append to `frontend/src/lib/terminalInput.ts`:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/lib/__tests__/terminalInput.test.ts`
Expected: PASS (all describe blocks, old + new).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/terminalInput.ts frontend/src/lib/__tests__/terminalInput.test.ts
git commit -m "feat(term): pure helpers for bracketed paste + submit + control keys"
```

---

## Task 2: Shared `<Composer>` component

**Files:**
- Create: `frontend/src/components/Composer.tsx`
- Test: `frontend/src/components/__tests__/Composer.test.tsx`

The composer is the input shell only: an auto-resizing textarea + a send button. Submit semantics differ by host (chat submits on Enter; terminal uses Enter for newline and submits by button), so they are injected via props. Voice is NOT in this MVP but the prop shape leaves room (`rightSlot`) for adding MicButton later without changing call sites' core wiring.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/__tests__/Composer.test.tsx`:

```tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import Composer from '../Composer'

function setup(props: Partial<React.ComponentProps<typeof Composer>> = {}) {
  const onSend = vi.fn()
  const onChange = vi.fn()
  render(
    <Composer
      value={props.value ?? ''}
      onChange={props.onChange ?? onChange}
      onSend={props.onSend ?? onSend}
      submitOnEnter={props.submitOnEnter ?? true}
      placeholder="type here"
    />
  )
  return { onSend, onChange }
}

describe('Composer', () => {
  it('renders the textarea with placeholder', () => {
    setup()
    expect(screen.getByPlaceholderText('type here')).toBeInTheDocument()
  })

  it('send button is disabled when value is empty/whitespace', () => {
    setup({ value: '   ' })
    expect(screen.getByLabelText('send')).toBeDisabled()
  })

  it('clicking send calls onSend with trimmed value', () => {
    const { onSend } = setup({ value: '  hello  ' })
    fireEvent.click(screen.getByLabelText('send'))
    expect(onSend).toHaveBeenCalledWith('hello')
  })

  it('submitOnEnter=true: Enter (no shift) sends', () => {
    const { onSend } = setup({ value: 'hi', submitOnEnter: true })
    fireEvent.keyDown(screen.getByPlaceholderText('type here'), { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('hi')
  })

  it('submitOnEnter=false: Enter does NOT send (newline behavior)', () => {
    const { onSend } = setup({ value: 'hi', submitOnEnter: false })
    fireEvent.keyDown(screen.getByPlaceholderText('type here'), { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/__tests__/Composer.test.tsx`
Expected: FAIL — `Composer` module not found.

- [ ] **Step 3: Implement `Composer.tsx`**

Create `frontend/src/components/Composer.tsx`:

```tsx
import { useRef, type KeyboardEvent, type ReactNode } from 'react'
import { Send } from 'lucide-react'

interface ComposerProps {
  value: string
  onChange: (v: string) => void
  /** Called with the trimmed text. Caller decides what bytes to send. */
  onSend: (text: string) => void
  /** Chat: true (Enter submits). Terminal: false (Enter = newline, button submits). */
  submitOnEnter: boolean
  placeholder?: string
  /** Optional extra control rendered between textarea and send (e.g. a second
   *  "insert only" button, or a future MicButton). */
  rightSlot?: ReactNode
}

function autoResize(t: HTMLTextAreaElement) {
  t.style.height = 'auto'
  t.style.height = Math.min(t.scrollHeight, 120) + 'px'
}

export default function Composer({
  value, onChange, onSend, submitOnEnter, placeholder, rightSlot,
}: ComposerProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const send = () => {
    const text = value.trim()
    if (!text) return
    onSend(text)
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (submitOnEnter && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  return (
    <div className="flex gap-2">
      <textarea
        ref={inputRef}
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        rows={1}
        className="flex-1 px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--accent-blue)] resize-none min-h-[40px] max-h-[120px]"
        style={{ height: 'auto', overflow: 'hidden' }}
        onInput={e => autoResize(e.target as HTMLTextAreaElement)}
      />
      {rightSlot}
      <button
        onClick={send}
        disabled={!value.trim()}
        aria-label="send"
        className="self-end p-2 bg-[var(--accent-green)] hover:bg-[var(--accent-green-hover)] disabled:bg-[var(--btn-disabled-bg)] disabled:text-[var(--btn-disabled-text)] text-white rounded-lg transition-colors"
        title="Send"
      >
        <Send size={16} />
      </button>
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/__tests__/Composer.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/Composer.tsx frontend/src/components/__tests__/Composer.test.tsx
git commit -m "feat(ui): shared Composer input shell (submit semantics via props)"
```

---

## Task 3: Adopt `<Composer>` in AcpChatView (no behavior change)

This refactor must preserve current chat behavior exactly: Enter sends, voice (MicButton) still works, busy/elapsed/interrupt unchanged. The composer's textarea replaces the inline one; the MicButton moves into the composer's `rightSlot`.

**Files:**
- Modify: `frontend/src/components/AcpChatView.tsx` (input block at lines 355–381; `autoResize` at 70–73; `inputRef` at 67; focus effect at 300–302)

- [ ] **Step 1: Add the Composer import**

In `frontend/src/components/AcpChatView.tsx`, add to the imports near line 4:

```tsx
import Composer from './Composer'
```

- [ ] **Step 2: Replace the inline textarea + send button with `<Composer>`**

Replace the `<div className="flex gap-2">…</div>` block (currently lines 355–381, containing the textarea, MicButton, and send button) with:

```tsx
        <Composer
          value={input}
          onChange={setInput}
          onSend={(text) => {
            if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return
            pushMessage({ id: newId(), kind: 'user', text })
            wsRef.current.send(JSON.stringify({ type: 'prompt', text }))
            setInput('')
            setBusy(true)
            setTurnStartedMs(Date.now())
          }}
          submitOnEnter={true}
          placeholder={`Send a message to ${agentType === 'kiro' ? 'Kiro' : agentType === 'codex' ? 'Codex' : 'Claude'}...`}
          rightSlot={
            <MicButton
              isRecording={transcribe.isRecording}
              supported={transcribe.supported}
              onPressStart={transcribe.start}
              onPressEnd={transcribe.stop}
            />
          }
        />
```

- [ ] **Step 3: Remove now-dead code in AcpChatView**

Delete these now-unused members (the Composer owns them):
- The `sendPrompt` useCallback (lines ~280–291).
- The `handleKeyDown` function (lines ~293–298).
- The `autoResize` function (lines ~70–73).
- The `inputRef` declaration (line ~67) AND the focus effect that uses it (lines ~300–302: `useEffect(() => { if (active) inputRef.current?.focus() }, [active])`).

Keep `input`/`setInput`, `transcribe`, `pushMessage`, `busy`/`turnStartedMs`, `interrupt`, and the busy/stuck UI block (lines 338–354) — those stay in AcpChatView.

- [ ] **Step 4: Verify type-check and tests pass**

Run: `cd frontend && npx tsc -b && npx vitest run`
Expected: tsc clean (no unused-variable errors — confirms Step 3 removed all dead refs), all existing tests PASS.

If tsc reports `'KeyboardEvent' is declared but never used` (was imported for the deleted `handleKeyDown`), remove `type KeyboardEvent` from the line-1 import.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/AcpChatView.tsx
git commit -m "refactor(chat): use shared Composer (behavior unchanged)"
```

---

## Task 4: Extend MobileKeyBar with control keys

Widen the key union so the bar can emit Esc / Ctrl-C / y / n in addition to arrows + Enter. `TerminalView` will map each to the right bytes (arrows via `arrowSequence`, controls via `controlSequence`).

**Files:**
- Modify: `frontend/src/components/MobileKeyBar.tsx`
- Test: `frontend/src/components/__tests__/MobileKeyBar.test.tsx`

- [ ] **Step 1: Update the failing test**

Replace the first test in `frontend/src/components/__tests__/MobileKeyBar.test.tsx` ("渲染全部 5 个键") with:

```tsx
  it('渲染方向键/Enter + 控制键', () => {
    render(<MobileKeyBar onKey={() => {}} />)
    for (const k of ['left', 'up', 'down', 'right', 'enter', 'esc', 'ctrl-c', 'y', 'n']) {
      expect(screen.getByLabelText(k)).toBeInTheDocument()
    }
  })
```

Add a second assertion to the existing pointerDown test:

```tsx
    fireEvent.pointerDown(screen.getByLabelText('esc'))
    expect(onKey).toHaveBeenCalledWith('esc')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/__tests__/MobileKeyBar.test.tsx`
Expected: FAIL — no element labeled `esc`.

- [ ] **Step 3: Implement the extended bar**

Replace `frontend/src/components/MobileKeyBar.tsx` with:

```tsx
import {
  ArrowUp, ArrowDown, ArrowLeft, ArrowRight, CornerDownLeft, type LucideIcon,
} from 'lucide-react'
import type { ArrowKey, ControlKey } from '../lib/terminalInput'

export type BarKey = ArrowKey | ControlKey

// 方向键/Enter 用图标；控制键用文字标签。aria-label 用逻辑键名，便于测试与无障碍。
const ARROW_KEYS: { key: ArrowKey; Icon: LucideIcon }[] = [
  { key: 'left', Icon: ArrowLeft },
  { key: 'up', Icon: ArrowUp },
  { key: 'down', Icon: ArrowDown },
  { key: 'right', Icon: ArrowRight },
  { key: 'enter', Icon: CornerDownLeft },
]

const CONTROL_KEYS: { key: ControlKey; label: string }[] = [
  { key: 'esc', label: 'Esc' },
  { key: 'ctrl-c', label: '^C' },
  { key: 'y', label: 'y' },
  { key: 'n', label: 'n' },
]

export default function MobileKeyBar({ onKey }: { onKey: (key: BarKey) => void }) {
  const btnCls =
    'flex-1 flex items-center justify-center py-2 rounded-md bg-[var(--bg-primary)] border border-[var(--border)] text-[var(--text-secondary)] active:bg-[var(--bg-hover)] active:text-[var(--text-primary)]'
  return (
    <div className="flex items-stretch gap-1 px-2 py-1.5 border-t border-[var(--border)] bg-[var(--bg-secondary)]">
      {ARROW_KEYS.map(({ key, Icon }) => (
        <button
          key={key}
          aria-label={key}
          // onPointerDown + preventDefault：避免按钮抢走终端焦点 / 触发软键盘。
          onPointerDown={(e) => { e.preventDefault(); onKey(key) }}
          style={{ touchAction: 'manipulation' }}
          className={btnCls}
        >
          <Icon size={18} />
        </button>
      ))}
      {CONTROL_KEYS.map(({ key, label }) => (
        <button
          key={key}
          aria-label={key}
          onPointerDown={(e) => { e.preventDefault(); onKey(key) }}
          style={{ touchAction: 'manipulation' }}
          className={`${btnCls} text-xs font-mono`}
        >
          {label}
        </button>
      ))}
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/__tests__/MobileKeyBar.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/MobileKeyBar.tsx frontend/src/components/__tests__/MobileKeyBar.test.tsx
git commit -m "feat(term): add Esc/Ctrl-C/y/n control keys to MobileKeyBar"
```

---

## Task 5: Wire composer + control keys + keyboard-occlusion fix into TerminalView

This is the integration task. It has no new unit test (TerminalView is integration-heavy with xterm/WS); correctness is verified by the pure-fn tests (Tasks 1, 4), tsc, and manual mobile verification at the end. Each step is mechanical and individually reversible.

**Files:**
- Modify: `frontend/src/components/TerminalView.tsx`

- [ ] **Step 1: Update imports**

In `frontend/src/components/TerminalView.tsx`, lines 10–11 currently:

```tsx
import MobileKeyBar from './MobileKeyBar'
import { arrowSequence, rowHeight, linesFromDrag, type ArrowKey } from '../lib/terminalInput'
```

Replace those two lines with:

```tsx
import MobileKeyBar, { type BarKey } from './MobileKeyBar'
import Composer from './Composer'
import { arrowSequence, rowHeight, linesFromDrag, bracketedPaste, submitSequence, controlSequence, type ArrowKey } from '../lib/terminalInput'
```

`useState`, `useEffect`, `useRef`, `useCallback` are already imported on line 1 — no change needed there.

- [ ] **Step 2: Add composer UI state**

After the `isTouch` state (line 77–81), add:

```tsx
  const [composerOpen, setComposerOpen] = useState(false)
  const [composerText, setComposerText] = useState('')
```

- [ ] **Step 3: Generalize the key handler to BarKey + add a send handler**

Replace `handleArrowKey` (lines 106–111) with a handler that routes arrows vs control keys, and add the composer send handler right after it:

```tsx
  // 虚拟键：先回到底部（否则在 scrollback 里点键看不到反馈），再发对应字节。
  // 方向键/Enter 按 DECCKM 模式；控制键直发。
  const handleBarKey = useCallback((key: BarKey) => {
    const term = termRef.current
    if (!term) return
    term.scrollToBottom()
    if (key === 'esc' || key === 'ctrl-c' || key === 'y' || key === 'n') {
      sendInput(controlSequence(key))
    } else {
      sendInput(arrowSequence(key as ArrowKey, term.modes.applicationCursorKeysMode))
    }
  }, [sendInput])

  // Composer 发送：整段走 bracketed paste，再按对端 bracketed paste 模式决定回车。
  // 发送后滚到底，确保用户看到 agent 反应（用户可能正在 scrollback 里翻）。
  const sendComposer = useCallback((text: string) => {
    const term = termRef.current
    if (!term) return
    sendInput(bracketedPaste(text) + submitSequence(term.modes.bracketedPasteMode))
    setComposerText('')
    term.scrollToBottom()
  }, [sendInput])
```

- [ ] **Step 4: Add VisualViewport keyboard-occlusion compensation**

Add this effect after the existing `isTouch` fit effect (after line 294). It shrinks the outer container by the keyboard overlap using VisualViewport, touching only container height — never cols/rows:

```tsx
  // 软键盘遮挡补偿：仅触摸端 + active。用 VisualViewport 把容器底部内边距顶起
  // 键盘高度，使 composer 和终端区不被遮。只改 CSS（paddingBottom），不动
  // xterm 的 cols/rows（避免 PTY SIGWINCH 抖动 / TUI 重绘风暴）。
  useEffect(() => {
    if (!isTouch || !active) return
    const vv = window.visualViewport
    if (!vv) return
    const apply = () => {
      const overlap = Math.max(0, window.innerHeight - vv.height - vv.offsetTop)
      const root = containerRef.current?.parentElement
      if (root) root.style.paddingBottom = `${overlap}px`
    }
    apply()
    vv.addEventListener('resize', apply)
    vv.addEventListener('scroll', apply)
    return () => {
      vv.removeEventListener('resize', apply)
      vv.removeEventListener('scroll', apply)
      const root = containerRef.current?.parentElement
      if (root) root.style.paddingBottom = ''
    }
  }, [isTouch, active])
```

- [ ] **Step 5: Make handleResize skip redundant WS resizes (anti-churn)**

The VisualViewport fix avoids fit on keyboard, but Android also fires `window.resize`. Guard the WS send so unchanged dims don't spam PTY. Replace `handleResize` (lines 263–272) with:

```tsx
  const lastDims = useRef<{ cols: number; rows: number }>({ cols: 0, rows: 0 })
  const handleResize = useCallback(() => {
    const fit = fitRef.current
    const term = termRef.current
    const ws = wsRef.current
    if (!fit || !term) return
    fit.fit()
    if (ws?.readyState === WebSocket.OPEN
        && (term.cols !== lastDims.current.cols || term.rows !== lastDims.current.rows)) {
      lastDims.current = { cols: term.cols, rows: term.rows }
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
    }
  }, [])
```

Note: `useRef` is already imported (line 1).

- [ ] **Step 6: Do not auto-focus the terminal on touch (avoid auto-popping keyboard)**

Replace the active-focus effect (lines 274–282):

```tsx
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
```

- [ ] **Step 7: Render the composer (collapsed by default) above MobileKeyBar**

Replace the render tail (lines 296–299, the `<div className="flex flex-col h-full">` opening through the `MobileKeyBar` line):

Current:
```tsx
  return (
    <div className="flex flex-col h-full">
      <div ref={containerRef} className="xterm-container w-full flex-1 min-h-0" />
      {isTouch && <MobileKeyBar onKey={handleArrowKey} />}
```

Replace with:
```tsx
  return (
    <div className="flex flex-col h-full">
      <div ref={containerRef} className="xterm-container w-full flex-1 min-h-0" />
      {isTouch && composerOpen && (
        <div className="px-2 py-1.5 border-t border-[var(--border)] bg-[var(--bg-secondary)]">
          <Composer
            value={composerText}
            onChange={setComposerText}
            onSend={sendComposer}
            submitOnEnter={false}
            placeholder="输入整段文字发送…（Enter 换行，点发送提交）"
          />
        </div>
      )}
      {isTouch && (
        <div className="flex items-stretch gap-1 px-2 pt-1.5 bg-[var(--bg-secondary)]">
          <button
            onPointerDown={(e) => { e.preventDefault(); setComposerOpen(v => !v) }}
            aria-label="toggle-composer"
            style={{ touchAction: 'manipulation' }}
            className="flex items-center justify-center gap-1 px-3 py-1 rounded-md bg-[var(--bg-primary)] border border-[var(--border)] text-xs text-[var(--text-secondary)] active:text-[var(--text-primary)]"
          >
            <Keyboard size={14} />
            {composerOpen ? '收起' : '打字'}
          </button>
        </div>
      )}
      {isTouch && <MobileKeyBar onKey={handleBarKey} />}
```

- [ ] **Step 8: Add the Keyboard icon import**

Line 9 currently: `import { GitBranch, Folder, Circle } from 'lucide-react'`

Replace with: `import { GitBranch, Folder, Circle, Keyboard } from 'lucide-react'`

- [ ] **Step 9: Type-check and run full test suite**

Run: `cd frontend && npx tsc -b && npx vitest run`
Expected: tsc clean (no unused `handleArrowKey`, no missing symbols); all tests PASS.

If tsc flags `handleArrowKey` as undefined anywhere, confirm Step 3 fully replaced it and the MobileKeyBar `onKey` prop now references `handleBarKey`.

- [ ] **Step 10: Commit**

```bash
git add frontend/src/components/TerminalView.tsx
git commit -m "feat(term): mobile composer + control keys + VisualViewport keyboard fix"
```

---

## Task 6: Build, full verification, deploy, push, prune

**Files:** none (verification + ship)

- [ ] **Step 1: Full frontend gate**

Run: `cd frontend && npx tsc -b && npx vitest run && npm run build`
Expected: tsc clean, all vitest PASS, vite build writes `frontend/dist/` (rust-embed needs it).

- [ ] **Step 2: Rust build gate (frontend is embedded at compile time)**

Run: `cd .. && cargo build --release 2>&1 | tail -5`
Expected: `Finished release` with no errors.

- [ ] **Step 3: Manual mobile verification (the success criteria from the spec)**

Using the live deploy or a phone pointed at the dev server, confirm:
- Multi-line prompt (with newlines) sent to Claude Code lands as ONE block in its input box, not line-by-line submitted.
- Chinese/pinyin/punctuation types without dropped chars or lag (native textarea).
- Soft keyboard does not occlude agent output; no visible thrash on keyboard open.
- Claude Code y/n confirm answered via MobileKeyBar without opening composer.
- In a bare shell, "insert" of multi-line text does not auto-execute.
- Desktop unchanged: composer absent, terminal still focuses on activate.

- [ ] **Step 4: Deploy to the live server**

Run: `cd .. && ./deploy.sh --build`
Expected: `OK: HTTP 200, deploy complete.` (atomic swap with rollback on failure).

- [ ] **Step 5: Push main and confirm sync**

```bash
git push origin main
git status -sb | head -1
```
Expected: `## main...origin/main` (in sync, not ahead).

- [ ] **Step 6: Confirm only main remains**

Run: `git branch -a`
Expected: local `main` only (plus `remotes/origin/main`, `remotes/origin/HEAD`, `remotes/upstream/main`). No feature branches. If any exist and are merged, delete them: `git branch -d <name>` and `git push origin --delete <name>`.

---

## Self-Review notes

- **Spec coverage:** bracketed paste +探测回车 (Task 1) · 收起/展开 composer + 双行为 (Tasks 2,5) · 单键 Esc/Ctrl-C/y/n on MobileKeyBar (Tasks 1,4,5) · VisualViewport 容器补偿 + fit debounce/dims-skip + `if(!active)` guard (Task 5 steps 4–6) · 共享 Composer 抽取 (Tasks 2,3) · 发送后 scrollToBottom (Task 5 step 3) · 多行粘贴一次提交 (textarea native + bracketedPaste, Tasks 1,2) · 触摸端不自动聚焦 (Task 5 step 6) · 桌面端不变 (Task 5 step 6, render gated on isTouch). Voice deferred — Composer leaves `rightSlot` for it.
- **Note on debounce:** the spec calls for debounce on viewport resize. The chosen design avoids the need for debounce on the *keyboard* path entirely by using VisualViewport for CSS-only compensation (Step 4, no fit) and a dims-skip guard on the fit path (Step 5). This is simpler and meets the "no thrash" success criterion without a timer. If Android still thrashes in manual verification (Step 3 of Task 6), add a 150ms debounce around `handleResize`'s body as a follow-up.
- **Type consistency:** `BarKey = ArrowKey | ControlKey`; `controlSequence(ControlKey)`; `arrowSequence(ArrowKey, bool)`; `bracketedPaste(string)`; `submitSequence(bool)`; `term.modes.bracketedPasteMode` (xterm public API, same family as `applicationCursorKeysMode` already used at line 110).
- **Placeholder scan:** clean — every code step shows complete code; no TBD/TODO.
