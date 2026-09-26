# 前端重设计 P0「止血」Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修掉 6 个高频缺陷、给 agent/终端加连接状态条、开启 HTTP 压缩、修复手机终端底部遮挡——全部可独立部署,不改信息架构。

**Architecture:** 纯增量修补。前端改 Composer / AcpChatView / App / Sidebar / ScheduledTasksPanel / FileBrowser / TerminalView,新增一个 `ConnectionBar` 小组件与 `lib/wsStatus.ts` 纯函数;后端只在 `build_router` 外包一层 `tower_http::compression::CompressionLayer`。不引入任何新 npm 依赖。

**Tech Stack:** React 19 + Vite + Tailwind v4 + vitest/happy-dom/@testing-library/react;Rust axum 0.8 + tower-http 0.6。

**Spec:** `docs/superpowers/specs/2026-09-26-frontend-triage-focus-redesign-design.md` §2(P0 止血)、§7.1(硬约束)。审计:`docs/superpowers/audits/2026-09-26-frontend-ux-audit.md`(§7 不变量 I-1~I-19、§8 缺陷 B1~B15)。

## Global Constraints

- 审计 §7 不变量 I-1 ~ I-19 全部保持;本计划触及 I-4(WS 退避)、I-6(队列模式后端权威)、I-13(终端输入单通道)、I-15(移动端输入细节)、I-18(撤销 toast)——每个触及点在对应 Task 中说明。
- 新 UI **不新开 WS、不在前端猜测后端状态**。
- 输入框字号保持 16px(`text-base`,防 iOS 聚焦缩放,I-15)。
- 不引入新 npm 依赖;不改 WS 协议;不改后端数据结构。
- 首屏传输(主 JS + CSS,压缩后)≤ 400KB。
- 用户可见文案中文;代码/注释英文(与仓库惯例一致,已有中文注释的文件可沿用中文)。
- 每个 Task 结束 `cd frontend && npm test` 全绿;涉及 Rust 的 Task `cargo test` 全绿。
- 部署只用 `./deploy.sh --build`,**先 commit + push 再 deploy**;冒烟实例必须 `--data-dir` + `--tmux-socket` 隔离,绝不指向线上数据目录。

## Review Focus

1. **中文输入法选词回车**:Safari 上 `compositionend` 先于 `keydown` 触发时 `isComposing` 已为 false,但 `keyCode === 229` 仍成立——两个条件都要判(Task 1 测试覆盖两种)。
2. **断线期间用户连续点发送**:文本必须一直留在输入框、附件不能被清空、不产生乐观气泡(Task 2 测试断言 `sent` 为空且无 user_prompt 气泡)。
3. **创建会话失败后用户再次点击**:弹层仍开、错误行可见,第二次成功后错误行消失、弹层关闭(Task 3 测试覆盖 reject→resolve 序列)。
4. **压缩层与 WebSocket**:`/ws/*` 升级请求带 `Accept-Encoding: gzip` 时仍须 101,不能被压缩层包坏(Task 7 冒烟用 curl 升级握手验证)。
5. **手机横屏/历史分屏时的滚动胶囊**:键栏隐藏(`historyOpen && !split`)时胶囊不应悬空在旧位置(Task 8 测试断言胶囊是输入区容器的子节点,随之隐藏/移动)。

---

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `frontend/src/components/Composer.tsx` | Modify | IME 守卫;`onSend` 返回值决定是否清空 |
| `frontend/src/lib/wsStatus.ts` | Create | `WsStatus` 类型 + `connectionBarText(status, sinceMs, now)` 纯函数 |
| `frontend/src/components/ConnectionBar.tsx` | Create | 细条 UI,1.5s 延迟显示 |
| `frontend/src/components/AcpChatView.tsx` | Modify | `sendPrompt` 返回 boolean、不自清输入;暴露 WS 状态;渲染 ConnectionBar |
| `frontend/src/components/TerminalView.tsx` | Modify | 暴露 WS 状态 + ConnectionBar;滚动胶囊改位置 + 图标;状态栏手机端收起 |
| `frontend/src/App.tsx` | Modify | `sessionControls` 类型改 boolean;`handleCreate` 失败抛出 |
| `frontend/src/components/Sidebar.tsx` | Modify | 所有 `onCreate` 调用 await,失败显示错误行不关弹层 |
| `frontend/src/components/ScheduledTasksPanel.tsx` | Modify | toggle 发送完整字段(含 `idle_timeout_min`) |
| `frontend/src/components/FileBrowser.tsx` | Modify | 切目录同步进入 loading、清旧列表 |
| `frontend/src/components/MarkdownViewer.tsx` + `__tests__/MarkdownViewer.stale.test.tsx` | Delete | 死代码 |
| `Cargo.toml`、`src/web.rs` | Modify | `compression-gzip`/`compression-br` + `CompressionLayer` |
| `frontend/src/test/fakeWs.ts` | Modify | 增加 `fireOpen()/fireClose()` 驱动器 |

---

### Task 1: Composer — IME 守卫 + 发送失败不清空契约

**Files:**
- Modify: `frontend/src/components/Composer.tsx:4-14,32-43`
- Test: `frontend/src/components/__tests__/Composer.test.tsx`

**Interfaces:**
- Produces: `ComposerProps.onSend: (text: string) => boolean | void` —— 返回 `false` 表示未送出(调用方负责不清空;Composer 本身是受控组件,不清空)。本 Task 只改类型与注释,Composer 本身不持有 value,所以"不清空"由调用方实现(Task 2、Task 8 依赖此契约)。

- [ ] **Step 1: 写失败测试**

在 `Composer.test.tsx` 的 `describe('Composer', …)` 末尾追加:

```tsx
  it('IME composing: Enter while isComposing does NOT send', () => {
    const { onSend } = setup({ value: '你好', submitOnEnter: true })
    fireEvent.keyDown(screen.getByPlaceholderText('type here'), { key: 'Enter', isComposing: true })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('IME composing: Enter with keyCode 229 (Safari post-compositionend) does NOT send', () => {
    const { onSend } = setup({ value: '你好', submitOnEnter: true })
    fireEvent.keyDown(screen.getByPlaceholderText('type here'), { key: 'Enter', keyCode: 229 })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('plain Enter after composition ends still sends', () => {
    const { onSend } = setup({ value: '你好', submitOnEnter: true })
    fireEvent.keyDown(screen.getByPlaceholderText('type here'), { key: 'Enter', keyCode: 13 })
    expect(onSend).toHaveBeenCalledWith('你好')
  })
```

- [ ] **Step 2: 运行确认失败**

Run: `cd frontend && npx vitest run src/components/__tests__/Composer.test.tsx`
Expected: 前两个新用例 FAIL(`onSend` 被调用),第三个 PASS。

- [ ] **Step 3: 实现**

`Composer.tsx` 接口注释与类型:

```tsx
  /** Called with the trimmed text. Caller decides what bytes to send.
   *  Return `false` when the text was NOT delivered (e.g. socket not open):
   *  the caller must then leave `value` untouched so nothing typed is lost. */
  onSend: (text: string) => boolean | void
```

`handleKeyDown` 替换为:

```tsx
  const handleKeyDown = (e: KeyboardEvent) => {
    // IME guard: while a CJK candidate is being chosen, Enter confirms the
    // candidate — it must never submit. Safari fires keydown with keyCode 229
    // after compositionend, when isComposing is already false, so check both.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (submitOnEnter && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }
```

- [ ] **Step 4: 运行确认通过**

Run: `cd frontend && npx vitest run src/components/__tests__/Composer.test.tsx`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/Composer.tsx frontend/src/components/__tests__/Composer.test.tsx
git commit -m "fix(composer): ignore Enter during IME composition (B7)"
```

---

### Task 2: AcpChatView — 断线发送不丢 + 连接状态条

**Files:**
- Create: `frontend/src/lib/wsStatus.ts`
- Create: `frontend/src/lib/__tests__/wsStatus.test.ts`
- Create: `frontend/src/components/ConnectionBar.tsx`
- Modify: `frontend/src/test/fakeWs.ts`
- Modify: `frontend/src/components/AcpChatView.tsx:73,94-100(state 区),326-399(connect effect),686-723(sendPrompt),770,1038-1041(Composer)`
- Modify: `frontend/src/App.tsx:55-58`
- Modify: `frontend/src/components/GitViewer.tsx:9,267-279`
- Test: `frontend/src/components/__tests__/acpConnection.test.tsx`(新建)

**Interfaces:**
- Consumes: Task 1 的 `onSend: (text) => boolean | void`。
- Produces:
  - `lib/wsStatus.ts`:
    ```ts
    export type WsStatus = 'connecting' | 'open' | 'reconnecting' | 'ended'
    export const CONNECTION_BAR_DELAY_MS = 1500
    export function connectionBarText(status: WsStatus, sinceMs: number, now: number): string | null
    ```
  - `components/ConnectionBar.tsx`:`export default function ConnectionBar({ status, sinceMs }: { status: WsStatus; sinceMs: number })`
  - `sessionControls` 类型:`{ setQueueMode: (mode: string) => void; sendPrompt: (text: string) => boolean }`
  - `fakeWs` 新增:`FakeSocket.fireOpen(): void`、`FakeSocket.fireClose(): void`

**不变量:** I-4 —— 退避计算、`stableTimer`、`attempt` 逻辑原样不动,只在已有的 `onopen/onclose` 里**额外** `setWsStatus`。I-10 —— 只有真正 `ws.send` 后才插乐观气泡(未 OPEN 时根本不进入)。

- [ ] **Step 1: 写 wsStatus 纯函数失败测试**

`frontend/src/lib/__tests__/wsStatus.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { connectionBarText, CONNECTION_BAR_DELAY_MS } from '../wsStatus'

describe('connectionBarText', () => {
  it('open → null', () => {
    expect(connectionBarText('open', 0, 10_000)).toBeNull()
  })
  it('reconnecting within delay → null (avoid flicker on fast reconnect)', () => {
    expect(connectionBarText('reconnecting', 1000, 1000 + CONNECTION_BAR_DELAY_MS - 1)).toBeNull()
  })
  it('reconnecting past delay → 重连中', () => {
    expect(connectionBarText('reconnecting', 1000, 1000 + CONNECTION_BAR_DELAY_MS)).toBe('连接断开,正在重连…')
  })
  it('connecting past delay → 连接中', () => {
    expect(connectionBarText('connecting', 0, CONNECTION_BAR_DELAY_MS)).toBe('正在连接…')
  })
  it('ended → shown immediately', () => {
    expect(connectionBarText('ended', 5000, 5000)).toBe('会话已结束')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd frontend && npx vitest run src/lib/__tests__/wsStatus.test.ts`
Expected: FAIL("Failed to resolve import ../wsStatus")。

- [ ] **Step 3: 实现 wsStatus.ts 与 ConnectionBar.tsx**

`frontend/src/lib/wsStatus.ts`:

```ts
// Connection state of a session's WebSocket, surfaced to the user so a send
// during a drop is never silent (audit B8). `sinceMs` = when this status began.
export type WsStatus = 'connecting' | 'open' | 'reconnecting' | 'ended'

// A healthy reconnect finishes well under this; showing the bar sooner would
// flash on every transient proxy drop.
export const CONNECTION_BAR_DELAY_MS = 1500

export function connectionBarText(status: WsStatus, sinceMs: number, now: number): string | null {
  if (status === 'open') return null
  if (status === 'ended') return '会话已结束'
  if (now - sinceMs < CONNECTION_BAR_DELAY_MS) return null
  return status === 'reconnecting' ? '连接断开,正在重连…' : '正在连接…'
}
```

`frontend/src/components/ConnectionBar.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { connectionBarText, CONNECTION_BAR_DELAY_MS, type WsStatus } from '../lib/wsStatus'

// Thin status strip above the composer. Re-renders once after the delay so a
// long outage becomes visible without a 1s ticker (busy sessions already tick).
export default function ConnectionBar({ status, sinceMs }: { status: WsStatus; sinceMs: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (status === 'open' || status === 'ended') return
    const t = setTimeout(() => setNow(Date.now()), CONNECTION_BAR_DELAY_MS - (Date.now() - sinceMs) + 10)
    return () => clearTimeout(t)
  }, [status, sinceMs])
  const text = connectionBarText(status, sinceMs, Math.max(now, Date.now()))
  if (!text) return null
  return (
    <div role="status" aria-live="polite"
      className={`px-3 py-1 text-xs text-center border-t border-[var(--border)] ${
        status === 'ended' ? 'text-[var(--text-secondary)] bg-[var(--bg-tertiary)]' : 'text-[var(--accent-yellow)] bg-[var(--bg-secondary)]'
      }`}>
      {text}
    </div>
  )
}
```

- [ ] **Step 4: 运行 wsStatus 测试确认通过**

Run: `cd frontend && npx vitest run src/lib/__tests__/wsStatus.test.ts`
Expected: PASS。

- [ ] **Step 5: 扩展 fakeWs 驱动器**

`frontend/src/test/fakeWs.ts` 的 `FakeSocket` 接口加:

```ts
  /** 模拟握手完成:readyState→OPEN 并调用 onopen。 */
  fireOpen(): void
  /** 模拟断线:readyState→CLOSED 并调用 onclose。 */
  fireClose(): void
```

`class Fake` 内加:

```ts
    fireOpen() { this.readyState = 1; this.onopen?.() }
    fireClose() { this.readyState = 3; this.onclose?.() }
```

- [ ] **Step 6: 写 AcpChatView 断线发送失败测试**

`frontend/src/components/__tests__/acpConnection.test.tsx`:

```tsx
import { render, screen, act, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import AcpChatView from '../AcpChatView'
import { installFakeWebSocket } from '../../test/fakeWs'

describe('AcpChatView — send while disconnected (B8)', () => {
  const origWs = (globalThis as unknown as { WebSocket?: unknown }).WebSocket
  let ws: ReturnType<typeof installFakeWebSocket>
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.useFakeTimers({ shouldAdvanceTime: true })
    ws = installFakeWebSocket()
    globalThis.fetch = vi.fn(async () => new Response('[]', { status: 200 })) as unknown as typeof fetch
  })
  afterEach(() => {
    vi.useRealTimers()
    ;(globalThis as unknown as { WebSocket?: unknown }).WebSocket = origWs
  })

  it('keeps the typed text, sends nothing, and shows the reconnect bar', async () => {
    render(<AcpChatView sessionId="s1" active agentType="claude" />)
    const sock = ws.latest()
    act(() => { sock.fireOpen() })
    act(() => { sock.fireClose() })       // drop → component schedules a reconnect
    const box = screen.getByPlaceholderText(/Send a message/)
    fireEvent.change(box, { target: { value: 'hello' } })
    fireEvent.keyDown(box, { key: 'Enter', keyCode: 13 })
    expect(sock.sent.filter(s => s.includes('"prompt"'))).toHaveLength(0)
    expect((box as HTMLTextAreaElement).value).toBe('hello')
    expect(screen.queryByText('You')).toBeNull()        // no optimistic user bubble (label at AcpChatView.tsx:1107)
    await act(async () => { vi.advanceTimersByTime(1600) })
    expect(screen.getByText('连接断开,正在重连…')).toBeInTheDocument()
  })

  it('open socket: send clears the box and emits one prompt frame', () => {
    render(<AcpChatView sessionId="s1" active agentType="claude" />)
    const sock = ws.latest()
    act(() => { sock.fireOpen() })
    const box = screen.getByPlaceholderText(/Send a message/)
    fireEvent.change(box, { target: { value: 'hi' } })
    fireEvent.keyDown(box, { key: 'Enter', keyCode: 13 })
    expect(sock.sent.filter(s => s.includes('"prompt"'))).toHaveLength(1)
    expect((box as HTMLTextAreaElement).value).toBe('')
  })
})
```

> 注:用户气泡以 `'You'` 标签识别(`AcpChatView.tsx:1106-1107`);open 时发送后该标签应出现,可在第二个用例追加 `expect(screen.getByText('You')).toBeInTheDocument()` 作为对照。

- [ ] **Step 7: 运行确认失败**

Run: `cd frontend && npx vitest run src/components/__tests__/acpConnection.test.tsx`
Expected: 第一个用例 FAIL(当前 `sendPrompt` 静默 return 后 Composer 行为虽保留文本,但不显示「连接断开,正在重连…」)。第二个 PASS(基线)。

- [ ] **Step 8: 实现 AcpChatView 改动**

(a) Props 类型(`:73`)改为:

```tsx
  onRegisterControls?: (sessionId: string, api: { setQueueMode: (mode: string) => void; sendPrompt: (text: string) => boolean } | null) => void
```

(b) 在 state 区(`:99` 附近,与 `busy` 同处)加:

```tsx
  // WS connection state for the ConnectionBar (B8). Mirrors onopen/onclose only;
  // backoff/attempt logic is untouched (I-4).
  const [wsStatus, setWsStatus] = useState<{ status: WsStatus; since: number }>(() => ({ status: 'connecting', since: Date.now() }))
```

并 `import ConnectionBar from './ConnectionBar'`、`import type { WsStatus } from '../lib/wsStatus'`。

(c) connect effect:`ws.onopen = () => {` 的函数体**第一行**加 `setWsStatus({ status: 'open', since: Date.now() })`;`ws.onclose = () => {` 函数体内,`wsRef.current = null` 之后加:

```tsx
        if (!disposed) setWsStatus({ status: 'reconnecting', since: Date.now() })
```

(d) `sendPrompt`(`:686`)改为返回 boolean 并去掉自清输入:

```tsx
  const sendPrompt = useCallback((text: string): boolean => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return false
    // … 原有 buildPromptWithAttachments / appendEvent / ws.send 不变 …
    setPending([])
    // … 原有 busy / clock seeding 不变 …
    return true
  }, [appendEvent, pending])
```

即:删除原 `:698` 的 `setInput('')`,在函数末尾 `return true`。

(e) Composer(`:1038-1041`)改为调用方清空:

```tsx
        <Composer
          value={input}
          onChange={setInput}
          onSend={(t) => { const ok = sendPrompt(t); if (ok) setInput(''); return ok }}
```

附件发送按钮(`:903`)`onClick={() => sendPrompt('')}` 保持不变(返回值忽略;未连接时附件留在 tray,由 ConnectionBar 解释原因)。

(f) 在 `<Composer` 所在容器**上方**(紧挨 Composer 外层 div 之前)渲染:

```tsx
        <ConnectionBar status={wsStatus.status} sinceMs={wsStatus.since} />
```

- [ ] **Step 9: 更新 App 与 GitViewer 类型**

`App.tsx:55-56` 两处类型中的 `sendPrompt: (text: string) => void` 改为 `sendPrompt: (text: string) => boolean`。

`App.tsx:460`:

```tsx
{view === 'git' && <GitViewer sessionId={s.id} onForward={(t) => sessionControls.current[s.id]?.sendPrompt(t) ?? false} />}
```

`GitViewer.tsx:9` 与 `:267`:`onForward?: (text: string) => boolean`。`forward`(`:273-279`)改为:

```tsx
  const forward = useCallback((text: string, confirmMsg?: string) => {
    if (!onForward) return
    if (confirmMsg && !window.confirm(confirmMsg)) return
    if (!onForward(text)) { setFailed(true); setTimeout(() => setFailed(false), 4000); return }
    setSent(true)
    setTimeout(() => setSent(false), 4000)
  }, [onForward])
```

并在 `const [sent, setSent] = useState(false)` 下加 `const [failed, setFailed] = useState(false)`;在渲染 `sent` 提示的同一位置(`grep -n "sent &&\|{sent" src/components/GitViewer.tsx` 定位)旁加:

```tsx
{failed && <span className="text-xs text-[var(--accent-red)]">未连接,未发送</span>}
```

- [ ] **Step 10: 运行测试确认通过**

Run: `cd frontend && npx vitest run src/components/__tests__/acpConnection.test.tsx src/components/__tests__/GitViewer.worktree.test.tsx && npm test`
Expected: 全部 PASS;`npx tsc -b` 无类型错误(`cd frontend && npx tsc -b`)。

- [ ] **Step 11: Commit**

```bash
git add frontend/src/lib/wsStatus.ts frontend/src/lib/__tests__/wsStatus.test.ts frontend/src/components/ConnectionBar.tsx frontend/src/test/fakeWs.ts frontend/src/components/AcpChatView.tsx frontend/src/components/__tests__/acpConnection.test.tsx frontend/src/App.tsx frontend/src/components/GitViewer.tsx
git commit -m "fix(acp): never drop a send while disconnected; show connection bar (B8)"
```

---

### Task 3: 创建会话失败可见(B3)

**Files:**
- Modify: `frontend/src/App.tsx:261-274`
- Modify: `frontend/src/components/Sidebar.tsx:27,225-305,573,611,636-653`(所有 `onCreate(` 调用点)
- Test: `frontend/src/components/__tests__/Sidebar.newflow.test.tsx`

**Interfaces:**
- Produces: `Sidebar Props.onCreate: (type, workDir?, tmuxTarget?, initialPrompt?) => Promise<void>`(reject = 失败,Error.message 为用户可读原因)。
- Sidebar 内部新增:`const [createError, setCreateError] = useState<string | null>(null)`、`const runCreate = async (fn: () => Promise<void>, after: () => void) => {...}`。

- [ ] **Step 1: 写失败测试**

`Sidebar.newflow.test.tsx` 末尾(同一 `describe` 内)追加:

```tsx
  it('create failure keeps the popover open and shows the error; retry success closes it', async () => {
    vi.spyOn(api, 'listQuickTargets').mockResolvedValue({ top: [
      { kind: 'dir', path: '/w/p', agent: 'claude', display: 'p', hint: '/w/p' },
    ] })
    const onCreate = vi.fn()
      .mockRejectedValueOnce(new Error('work_dir not allowed'))
      .mockResolvedValueOnce(undefined)
    setup({ onCreate })
    fireEvent.click(screen.getByText('New session'))
    fireEvent.click(await screen.findByText('p'))
    expect(await screen.findByText(/创建失败:work_dir not allowed/)).toBeInTheDocument()
    expect(screen.getByText('其他目录…')).toBeInTheDocument()     // popover still open
    fireEvent.click(screen.getByText('p'))
    await waitFor(() => expect(screen.queryByText('其他目录…')).toBeNull())
    expect(screen.queryByText(/创建失败/)).toBeNull()
  })
```

并把 `setup` 里 `const onCreate = vi.fn()` 改为 `const onCreate = over.onCreate ?? vi.fn().mockResolvedValue(undefined)`,`props` 中 `onCreate` 保持引用该变量(`...over` 仍在最后,不影响)。

- [ ] **Step 2: 运行确认失败**

Run: `cd frontend && npx vitest run src/components/__tests__/Sidebar.newflow.test.tsx`
Expected: 新用例 FAIL(找不到「创建失败」;弹层已关闭)。

- [ ] **Step 3: 实现 App.handleCreate 抛出**

`App.tsx:261` 的 `handleCreate` 保持 `async`,**不加 catch**(让 reject 冒泡给 Sidebar);唯一改动是 vault 分支 `return` 保持,API 分支不变。确认其类型为 `Promise<void>`(当前已是 async,无需改代码,仅确认 Sidebar 能 await)。

`onAskAgent`(`App.tsx:454`)是 fire-and-forget,改为吞错并提示:

```tsx
onAskAgent={(prompt) => { handleCreate('claude', s.work_dir, undefined, prompt).catch(() => setFailToast(true)) }}
```

同时把 `failToast` 从 boolean 改为消息字符串,以区分用途:

```tsx
  const [failToast, setFailToast] = useState<string | null>(null)
```

`handleDelete` 中原 `setFailToast(true)`(`grep -n "setFailToast(true)" src/App.tsx` 定位)改为 `setFailToast('撤销失败，会话已关闭')`;`onAskAgent` 用 `setFailToast('创建会话失败')`;渲染处:

```tsx
        {failToast && (
          <Toast message={failToast} durationMs={3000} onDone={() => setFailToast(null)} />
        )}
```

- [ ] **Step 4: 实现 Sidebar**

(a) Props(`:27`):

```tsx
  onCreate: (type: SessionType | 'vault', workDir?: string, tmuxTarget?: string, initialPrompt?: string) => Promise<void>
```

(b) state 区加 `const [createError, setCreateError] = useState<string | null>(null)`;`close()`(`:276`)内加 `setCreateError(null)`。

(c) 在 `closeAfterCreate` 定义之后加:

```tsx
  // Await creation; only tear the popover down on success. On failure keep the
  // user where they are with a visible reason (audit B3) — never close silently.
  const runCreate = async (create: () => Promise<void>, after: () => void = closeAfterCreate) => {
    setCreateError(null)
    try {
      await create()
      after()
    } catch (e) {
      setCreateError(`创建失败:${(e as Error).message || '未知错误'}`)
    }
  }
```

(d) 逐个替换调用点(每处"`onCreate(...)` + 关闭"改为 `runCreate`):

| 位置 | 原 | 新 |
|---|---|---|
| `:230` | `onCreate('tmux', pendingDir); closeAfterCreate(); return` | `runCreate(() => onCreate('tmux', pendingDir)); return` |
| `:234-235` | `onCreate(type, pendingDir)` + `closeAfterCreate()` | `runCreate(() => onCreate(type, pendingDir))` |
| `:251-252` | `onCreate('tmux', path)` + `closeAfterCreate()` | `runCreate(() => onCreate('tmux', path))` |
| `:262` | `onCreate(h.agent, h.path); closeAfterCreate(); return` | `runCreate(() => onCreate(h.agent!, h.path)); return` |
| `:297-300` submitWithPrompt | `onCreate(...)` 后清 draft + close | `runCreate(() => onCreate(pendingType, pendingDir, undefined, trimmed ? promptDraft : undefined), () => { setPromptDraft(''); setPendingDir(null); closeAfterCreate() })` |
| `:304-307` submitSkip | 同上 | `runCreate(() => onCreate(pendingType, pendingDir), () => { setPromptDraft(''); setPendingDir(null); closeAfterCreate() })` |
| `:573` 本机 tmux | `onCreate('tmux', undefined, h.name); if (mobile) onToggle()` | `runCreate(() => onCreate('tmux', undefined, h.name), () => { if (mobile) onToggle() })` |
| `:611` | `onCreate('tmux', undefined, h.name); closeAfterCreate()` | `runCreate(() => onCreate('tmux', undefined, h.name))` |
| `:643-644` QuickTargets onPick | `onCreate(agent, path)` + `closeAfterCreate()` | `runCreate(() => onCreate(agent as SessionType, path))` |
| `:671` vault | `onCreate('vault'); closeAfterCreate()` | `runCreate(() => onCreate('vault'))` |
| `:773` vault(B10) | `onCreate('vault'); setStep('closed')` | `runCreate(() => onCreate('vault'))`(顺带修 B10:走 closeAfterCreate,手机侧栏收起) |

实现者用 `grep -n "onCreate(" src/components/Sidebar.tsx` 确认**没有遗漏**(除 Props 定义外每一处都应在 `runCreate(() => …)` 内)。`:573` 在弹层外(会话列表),错误行也要可见:见 (e)。

(e) 错误行渲染:在新建弹层内容容器的最顶部(`grep -n "step !== 'closed'" src/components/Sidebar.tsx` 找弹层根,放在其第一个子元素之前),以及会话列表「本机 tmux」组标题下方各渲染一次:

```tsx
{createError && (
  <div role="alert" className="mx-2 my-1 px-2 py-1.5 rounded text-xs text-[var(--accent-red)] bg-[var(--bg-tertiary)] border border-[var(--accent-red)]/40">
    {createError}
  </div>
)}
```

- [ ] **Step 5: 运行确认通过**

Run: `cd frontend && npx vitest run src/components/__tests__/Sidebar.newflow.test.tsx src/components/__tests__/Sidebar.search.test.tsx && npx tsc -b && npm test`
Expected: 全 PASS。若既有用例因 `onCreate` 变 async 而断言时机失败,改为 `await waitFor(() => expect(onCreate).toHaveBeenCalledWith(...))`(只改断言时机,不改期望值)。

- [ ] **Step 6: Commit**

```bash
git add frontend/src/App.tsx frontend/src/components/Sidebar.tsx frontend/src/components/__tests__/Sidebar.newflow.test.tsx
git commit -m "fix(sidebar): surface create-session failures instead of closing silently (B3, B10)"
```

---

### Task 4: 定时任务启停不丢字段(B1)

**Files:**
- Modify: `frontend/src/components/ScheduledTasksPanel.tsx:79-93`
- Test: `frontend/src/components/__tests__/ScheduledTasksPanel.toggle.test.tsx`(新建;既有测试文件用了模块级 `vi.mock`,新文件隔离更干净)

**背景(已核对):** 后端 `upsert`(`src/scheduled_tasks.rs:451`)`ON CONFLICT DO UPDATE SET … idle_timeout_min=?15` —— 请求体缺字段即写 NULL,**会清掉空闲超时**。`trigger_spec` 是 cron 表达式(`trigger_type` 恒为 `"cron"`,`:354`),所以 `schedule: {kind:'cron', expr: trigger_spec}` 本身是无损的;问题只在漏 `idle_timeout_min`。选前端修(spec §2.1 优先前端)。

- [ ] **Step 1: 写失败测试**

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import ScheduledTasksPanel from '../ScheduledTasksPanel'
import * as api from '../../lib/api'

const task: api.ScheduledTask = {
  id: 't1', owner_id: 'u', name: '夜间任务', trigger_type: 'cron', trigger_spec: '0 0 9 * * 1-5',
  tz: 'Asia/Shanghai', agent_type: 'claude', work_dir: '/w', prompt: 'p', enabled: true,
  retention_n: 20, created_ms: 1, side_effects: true, max_runtime_min: 30, idle_timeout_min: 15,
}

describe('ScheduledTasksPanel toggle (B1)', () => {
  it('toggle preserves idle_timeout_min and every other field', async () => {
    vi.spyOn(api, 'listScheduledTasks').mockResolvedValue([task])
    vi.spyOn(api, 'listConfirmations').mockResolvedValue({ count: 0, runs: [] })
    const upd = vi.spyOn(api, 'updateScheduledTask').mockResolvedValue({ ...task, enabled: false })
    render(<ScheduledTasksPanel onClose={() => {}} />)
    fireEvent.click(await screen.findByTitle('点击暂停'))
    await waitFor(() => expect(upd).toHaveBeenCalled())
    expect(upd).toHaveBeenCalledWith('t1', {
      name: '夜间任务',
      schedule: { kind: 'cron', expr: '0 0 9 * * 1-5' },
      work_dir: '/w', prompt: 'p', enabled: false, retention_n: 20,
      side_effects: true, max_runtime_min: 30, idle_timeout_min: 15,
    })
  })
})
```

> `fireEvent.click` 作用在 `<label title="点击暂停">` 上会转发到内部 checkbox 触发 onChange;若 happy-dom 不转发,改为 `fireEvent.click(screen.getByTitle('点击暂停').querySelector('input')!)`。

- [ ] **Step 2: 运行确认失败**

Run: `cd frontend && npx vitest run src/components/__tests__/ScheduledTasksPanel.toggle.test.tsx`
Expected: FAIL —— 实际调用缺 `idle_timeout_min: 15`。

- [ ] **Step 3: 实现**

`handleToggle` 的请求体加一行(紧跟 `max_runtime_min`):

```tsx
        max_runtime_min: t.max_runtime_min,
        // PUT is a full upsert (scheduled_tasks.rs upsert SETs every column):
        // omitting this would silently NULL the task's idle timeout. (B1)
        idle_timeout_min: t.idle_timeout_min,
```

- [ ] **Step 4: 运行确认通过**

Run: `cd frontend && npx vitest run src/components/__tests__/ScheduledTasksPanel.toggle.test.tsx src/components/__tests__/ScheduledTasksPanel.test.tsx`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/ScheduledTasksPanel.tsx frontend/src/components/__tests__/ScheduledTasksPanel.toggle.test.tsx
git commit -m "fix(scheduled): toggle must not wipe idle_timeout_min (B1)"
```

---

### Task 5: FileBrowser 切目录进入 loading(B4)

**Files:**
- Modify: `frontend/src/components/FileBrowser.tsx:109-127`
- Test: `frontend/src/components/__tests__/FileBrowser.test.tsx`

- [ ] **Step 1: 写失败测试**

在 `describe('FileBrowser', …)` 内追加:

```tsx
  it('navigating clears the old listing immediately (no stale clickable rows)', async () => {
    let resolveSub: (v: { entries: api.DirListEntry[]; truncated: boolean }) => void = () => {}
    vi.spyOn(api, 'listDir').mockImplementation((_s, cwd) => {
      if (cwd === '') return Promise.resolve({ entries: [
        { name: 'sub', type: 'dir', size: 0, mtime: 0, writable: true },
        { name: 'old.txt', type: 'file', size: 1, mtime: 0, writable: true },
      ], truncated: false })
      return new Promise(r => { resolveSub = r })
    })
    render(<FileBrowser sessionId="s1" />)
    ;(await screen.findByText('sub')).click()
    await waitFor(() => expect(screen.queryByText('old.txt')).toBeNull())
    expect(screen.getByText('Loading...')).toBeInTheDocument()
    resolveSub({ entries: [{ name: 'inner.txt', type: 'file', size: 1, mtime: 0, writable: true }], truncated: false })
    expect(await screen.findByText('inner.txt')).toBeInTheDocument()
  })
```

- [ ] **Step 2: 运行确认失败**

Run: `cd frontend && npx vitest run src/components/__tests__/FileBrowser.test.tsx`
Expected: 新用例 FAIL(`old.txt` 仍在)。

- [ ] **Step 3: 实现**

effect(`:109`)改为在发起请求前同步进入 loading。eslint `react-hooks` v7 不允许 effect 体内同步 setState,因此用「渲染期按 key 重置」模式:

```tsx
  // Listing identity. When it changes, drop the old entries DURING render (React's
  // "reset state on prop change" pattern) so a slow listing never leaves the
  // previous directory's rows clickable against the new cwd. (B4)
  const listKey = `${sessionId}\u0000${cwd}\u0000${effectiveBase ?? ''}\u0000${reloadKey}`
  const [shownKey, setShownKey] = useState(listKey)
  if (shownKey !== listKey) {
    setShownKey(listKey)
    setLoading(true)
    setEntries([])
    setError(null)
  }
```

放在 `const reload = …`(`:104`)之后、effect 之前。effect 本体不变。

- [ ] **Step 4: 运行确认通过**

Run: `cd frontend && npx vitest run src/components/__tests__/FileBrowser.test.tsx && npm run lint`
Expected: PASS;lint 无新增错误。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/FileBrowser.tsx frontend/src/components/__tests__/FileBrowser.test.tsx
git commit -m "fix(files): clear stale listing while navigating (B4)"
```

---

### Task 6: 删除死代码与过时注释(B15)

**Files:**
- Delete: `frontend/src/components/MarkdownViewer.tsx`、`frontend/src/components/__tests__/MarkdownViewer.stale.test.tsx`
- Modify: `frontend/src/components/RunMetricsPanel.tsx:93-94`
- Modify: `frontend/src/lib/collectHint.ts:45` 附近

- [ ] **Step 1: 确认零生产引用**

Run: `cd frontend && grep -rn "MarkdownViewer" src --include=*.ts --include=*.tsx | grep -v "components/MarkdownViewer.tsx\|__tests__/MarkdownViewer.stale"`
Expected: 无输出。有输出则停止本 Task 并报告。

- [ ] **Step 2: 删除**

```bash
git rm frontend/src/components/MarkdownViewer.tsx frontend/src/components/__tests__/MarkdownViewer.stale.test.tsx
```

- [ ] **Step 3: 修正过时注释**

`RunMetricsPanel.tsx:93-94` 当前为:

```
    // Same reqRef discipline the sibling optimistic mutations use (AgentDashboard
    // handleDelete, SessionInfoBar handleAddNote/handleDeleteNote).
```

改为(SessionInfoBar notes 已于 `e2beea5` 删除):

```
    // Same reqRef discipline the sibling optimistic mutation uses (AgentDashboard
    // handleDelete).
```

`collectHint.ts`:`grep -n "仅 stuck\|only.*stuck\|stuck 时" src/lib/collectHint.ts`,把声称「中断按钮只在 stuck 时渲染」的句子改为「中断按钮在 busy 时即渲染(跨会话 CLI turn 也需可中断),stuck 时变红强调」——与 `AcpChatView.tsx` 当前行为(`:874` 附近注释 "Always available while busy")一致。只改注释,不改代码。

- [ ] **Step 4: 运行**

Run: `cd frontend && npx tsc -b && npm test`
Expected: 全 PASS(测试文件数少 1)。

- [ ] **Step 5: Commit**

```bash
git add -A frontend/src/components/RunMetricsPanel.tsx frontend/src/lib/collectHint.ts
git commit -m "chore(frontend): remove dead MarkdownViewer and stale comments (B15)"
```

---

### Task 7: HTTP 压缩(gzip + br)

**Files:**
- Modify: `Cargo.toml:9`
- Modify: `src/web.rs:127-136`(`build_router` 尾部)
- Test: `src/web.rs` 内新增 `#[cfg(test)] mod compression_tests`

**不变量:** WS 升级不受影响——`CompressionLayer` 只在响应体可压缩且客户端 `Accept-Encoding` 匹配时生效;101 Switching Protocols 无 body,tower-http 对非 2xx/无 body 不压缩。仍以冒烟实测为准(Step 6)。

- [ ] **Step 1: 加 feature**

`Cargo.toml:9`:

```toml
tower-http = { version = "0.6", features = ["cors", "set-header", "compression-gzip", "compression-br"] }
```

检查是否已有 `tower` 直接依赖用于测试的 `ServiceExt::oneshot`:`grep -n "^tower " Cargo.toml`。若无,在 `[dev-dependencies]`(无则新建该段)加:

```toml
[dev-dependencies]
tower = { version = "0.5", features = ["util"] }
```

- [ ] **Step 2: 写失败测试**

`src/web.rs` 文件末尾追加:

```rust
#[cfg(test)]
mod compression_tests {
    use axum::{body::Body, http::Request, routing::get, Router};
    use tower::ServiceExt;

    // Mirrors build_router's outer layering so the test pins the SAME layer
    // config (with_compression) rather than a hand-rolled copy.
    fn app() -> Router {
        super::with_compression(Router::new().route("/big", get(|| async { "x".repeat(4096) })))
    }

    #[tokio::test]
    async fn gzip_when_accepted() {
        let res = app()
            .oneshot(Request::get("/big").header("accept-encoding", "gzip").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(res.headers().get("content-encoding").unwrap(), "gzip");
    }

    #[tokio::test]
    async fn identity_when_not_accepted() {
        let res = app()
            .oneshot(Request::get("/big").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert!(res.headers().get("content-encoding").is_none());
    }
}
```

- [ ] **Step 3: 运行确认失败**

Run: `cargo test compression_tests`
Expected: 编译失败 "cannot find function `with_compression` in module `super`"。

- [ ] **Step 4: 实现**

`src/web.rs`,`build_router` 之上加:

```rust
/// Compress HTTP responses (gzip/br) when the client accepts it. The embedded
/// frontend bundle is ~1.4MB raw; mobile first load is dominated by it.
/// WebSocket upgrades are unaffected: 101 responses carry no body.
fn with_compression(router: Router) -> Router {
    router.layer(tower_http::compression::CompressionLayer::new().gzip(true).br(true))
}
```

`build_router` 尾部:

```rust
    with_compression(
        Router::new()
            .merge(api)
            .merge(me_api)
            .merge(events_ingest)
            .merge(auth_routes)
            .merge(ws)
            .route("/assets/{*path}", get(serve_asset))
            .fallback(get(spa_fallback))
            .with_state(state),
    )
```

- [ ] **Step 5: 运行测试**

Run: `cargo test compression_tests && cargo test`
Expected: 全 PASS。

- [ ] **Step 6: 隔离冒烟(WS 升级 + 体积)**

```bash
cd frontend && npm run build && cd ..
cargo build
SMOKE=$(mktemp -d)
./target/debug/zeromux --port 18091 --password smoke --data-dir "$SMOKE" --tmux-socket zmx-smoke-p0 > "$SMOKE/log" 2>&1 &
PID=$!; sleep 3
JS=$(curl -s http://127.0.0.1:18091/ | grep -o '/assets/index-[^"]*\.js' | head -1)
curl -s -H 'Accept-Encoding: br' -o /dev/null -w 'br=%{size_download}\n' "http://127.0.0.1:18091$JS"
curl -s -H 'Accept-Encoding: gzip' -o /dev/null -w 'gzip=%{size_download}\n' "http://127.0.0.1:18091$JS"
# WS upgrade with Accept-Encoding must still be 101 (auth by ?token=)
curl -s -o /dev/null -w 'ws=%{http_code}\n' --http1.1 -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H 'Accept-Encoding: gzip, br' \
  --max-time 2 "http://127.0.0.1:18091/ws/term/nonexistent?token=smoke"
kill $PID; tmux -L zmx-smoke-p0 kill-server 2>/dev/null; rm -rf "$SMOKE"
```

Expected:`br` ≤ 400000;`gzip` ≤ 450000;`ws` 为 `101` 或会话不存在时的 4xx(**不能**是 5xx,且响应不带 content-encoding——若为 101 即证明未被压缩层破坏)。若 `ws=000` 是 `--max-time` 超时(升级成功后 curl 挂住),也视为升级成功。

> 若 `--tmux-socket` 的参数语义与此不符,先 `./target/debug/zeromux --help | grep -A1 tmux-socket` 核对再跑。

- [ ] **Step 7: Commit**

```bash
git add Cargo.toml Cargo.lock src/web.rs
git commit -m "perf(web): gzip/br compress HTTP responses (mobile first load ~1.4MB → <400KB)"
```

---

### Task 8: 手机终端底部 + 终端连接条

**Files:**
- Modify: `frontend/src/components/TerminalView.tsx:1-20(imports),100-110(state),550-575(WS onopen/onclose),686-799(render)`
- Test: `frontend/src/components/__tests__/TerminalView.mobileLayout.test.tsx`(新建)

**Interfaces:**
- Consumes: Task 2 的 `ConnectionBar`、`WsStatus`。

**不变量:** I-12(resize 只在 active 且容器非 0×0)——本 Task 不碰 resize 路径;胶囊移入输入区容器只改 DOM 位置。I-13 —— `sendComposer` 已经「未送出不清空」,不改。I-15 —— Composer 仍 16px;按钮仍 `onPointerDown + preventDefault`。

**设计:**
1. 触屏且未全屏历史时,把「滚动胶囊 + MobileKeyBar + Composer」包进**一个**底部容器 `<div data-testid="term-bottom" className="relative">`;胶囊改为 `absolute right-3 bottom-full mb-2`(相对该容器顶部浮起),永远在键栏**之上**,不遮挡。非触屏保持原 `absolute right-3 bottom-28` 行为不变(桌面无键栏)。
2. `⤒顶` 文本换成 `<ArrowUpToLine size={14} />`,`aria-label="scroll-top"` 保留。`⏸ 已暂停跟随 · ⤓` 改为 `<ArrowDownToLine size={14} /> 回到底部`。
3. 触屏时隐藏底部状态栏(路径/分支/attach chip):状态栏整体只在 `!isTouch` 时渲染;attach chip 在触屏下移到 MobileKeyBar 所在容器右上角的小按钮?——**不做**(YAGNI,P0 只收起;S4 把它收进顶栏 ⋯)。路径信息手机上本来就被截断,SessionInfoBar 顶栏已显示会话名。
4. 终端 WS 状态接 ConnectionBar,放在 term-bottom 容器最上方(触屏)或 xterm 容器之后(桌面)。

- [ ] **Step 1: 写失败测试**

```tsx
import { render, screen, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import TerminalView from '../TerminalView'
import { installFakeWebSocket } from '../../test/fakeWs'

// Force touch environment: TerminalView decides isTouch via matchMedia('(any-pointer: coarse)')
// / maxTouchPoints (TerminalView.tsx:131-135).
function forceTouch() {
  Object.defineProperty(navigator, 'maxTouchPoints', { value: 5, configurable: true })
  window.matchMedia = ((q: string) => ({
    matches: q.includes('coarse'), media: q, addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

describe('TerminalView mobile bottom layout', () => {
  const origWs = (globalThis as unknown as { WebSocket?: unknown }).WebSocket
  beforeEach(() => {
    vi.restoreAllMocks()
    installFakeWebSocket()
    forceTouch()
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
  })
  afterEach(() => { (globalThis as unknown as { WebSocket?: unknown }).WebSocket = origWs })

  it('touch: status bar (work_dir/attach chip) is not rendered', () => {
    render(<TerminalView sessionId="s1" active theme="dark" tmuxName="zmx-abc" tmuxOrigin="own" />)
    expect(screen.queryByText(/⧉ zmx-abc/)).toBeNull()
  })

  it('touch: key bar and composer live in one bottom container', () => {
    render(<TerminalView sessionId="s1" active theme="dark" tmuxName="zmx-abc" tmuxOrigin="own" />)
    const bottom = screen.getByTestId('term-bottom')
    expect(bottom.contains(screen.getByLabelText('up'))).toBe(true)
    expect(bottom.contains(screen.getByPlaceholderText(/输入文字/))).toBe(true)
  })
})
```

> 全仓**没有** xterm mock 先例(已核对 `grep -rln "vi.mock('@xterm"` 为空),本测试首创。在文件顶部(import 之前)加:
>
> ```tsx
> vi.mock('@xterm/xterm', () => ({ Terminal: class {
>   cols = 80; rows = 24; options: Record<string, unknown> = {}; modes = { bracketedPasteMode: false }
>   buffer = { active: { viewportY: 0, baseY: 0, length: 0 } }
>   open() {} loadAddon() {} write() {} reset() {} dispose() {} focus() {} scrollToBottom() {}
>   onData() { return { dispose() {} } } onResize() { return { dispose() {} } }
>   onScroll() { return { dispose() {} } } onSelectionChange() { return { dispose() {} } }
>   attachCustomKeyEventHandler() {} hasSelection() { return false } getSelection() { return '' }
> } }))
> vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} proposeDimensions() { return { cols: 80, rows: 24 } } dispose() {} } }))
> vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class { onContextLoss() { return { dispose() {} } } dispose() {} } }))
> vi.mock('@xterm/addon-search', () => ({ SearchAddon: class { findNext() {} findPrevious() {} dispose() {} } }))
> vi.mock('@xterm/addon-clipboard', () => ({ ClipboardAddon: class { dispose() {} } }))
> ```
>
> 若 TerminalView 调用了上面未列出的 xterm 方法(运行时报 `is not a function`),按报错补一个空实现即可——mock 只需让组件挂载,不验证 xterm 行为。滚动胶囊需 `scrolling` 状态为真才出现,不在本测试断言(由 Step 5 截图验证)。

- [ ] **Step 2: 运行确认失败**

Run: `cd frontend && npx vitest run src/components/__tests__/TerminalView.mobileLayout.test.tsx`
Expected: FAIL(找到 `⧉ zmx-abc`;无 `term-bottom`)。

- [ ] **Step 3: 实现**

(a) imports:lucide 增加 `ArrowUpToLine, ArrowDownToLine`;`import ConnectionBar from './ConnectionBar'`;`import type { WsStatus } from '../lib/wsStatus'`。

(b) state:`const [wsStatus, setWsStatus] = useState<{ status: WsStatus; since: number }>(() => ({ status: 'connecting', since: Date.now() }))`。

(c) WS effect:`ws.onopen` 函数体首行 `setWsStatus({ status: 'open', since: Date.now() })`;`ws.onclose` 内 `wsRef.current = null` 之后:

```tsx
        if (!disposed) setWsStatus({ status: endedRef.current ? 'ended' : 'reconnecting', since: Date.now() })
```

(退避逻辑原样,I-4。)

(d) 抽出胶囊为局部 JSX 变量(在 `return` 前):

```tsx
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
```

(e) 渲染:删除原 `{tmuxName && scrolling && (…)}` 块;原 `{isTouch && … MobileKeyBar}` 与 `{isTouch && … Composer}` 两块替换为:

```tsx
      {!isTouch && scrollPill}
      {!isTouch && <ConnectionBar status={wsStatus.status} sinceMs={wsStatus.since} />}
      {isTouch && !(historyOpen && !split) && (
        <div data-testid="term-bottom" className="relative">
          {scrollPill}
          <ConnectionBar status={wsStatus.status} sinceMs={wsStatus.since} />
          <MobileKeyBar onKey={handleBarKey} onHistory={tmuxName ? () => setHistoryOpen(true) : undefined} />
          <div className="px-2 py-1.5 border-t border-[var(--border)] bg-[var(--bg-secondary)]">
            <Composer value={composerText} onChange={setComposerText} onSend={sendComposer}
              submitOnEnter={false} placeholder="输入文字，点 ✈ 发送…" />
          </div>
        </div>
      )}
      {isTouch && historyOpen && !split && scrollPill}
```

(f) 状态栏:外层 `<div className={`${isTouch && keyboardOpen ? 'hidden' : 'flex'} …`}>` 改为只在桌面渲染:`{!isTouch && (<div className="flex items-center gap-3 …">…</div>)}`,内部三处 `isTouch` 分支随之可简化:`${isTouch ? 'ml-auto' : ''}` → `''`,`!isTouch &&` 条件去掉(恒真)。`keyboardOpen` 若因此不再被读取,检查它是否仍被其它地方使用(`grep -n keyboardOpen`);若无其它读者,保留 `setKeyboardOpen` 调用但删除 state 会触发 lint 未使用——按 CLAUDE.md「移除你的改动造成的未使用变量」,把 `keyboardOpen` state 与 `setKeyboardOpen` 两处调用一并删除,VisualViewport 的 paddingBottom 逻辑保留(I-15)。

- [ ] **Step 4: 运行测试**

Run: `cd frontend && npx vitest run src/components/__tests__/TerminalView.mobileLayout.test.tsx src/components/__tests__/MobileKeyBar.test.tsx && npx tsc -b && npm run lint && npm test`
Expected: 全 PASS。

- [ ] **Step 5: 截图验收(隔离实例)**

按 Task 7 Step 6 的方式起隔离实例(端口 18091),用 gstack browse 以 390×844 视口、触屏 UA 登录(密码 smoke),新建 tmux 会话,执行 `seq 1 500` 后在终端区上滑触发滚动模式,截图到 `docs/superpowers/screens/p0/terminal-mobile.png`。
Expected:
- 胶囊位于键栏**上方**,不覆盖任何键;顶部按钮为图标而非「不」;
- 底部只有 键栏 + 输入框 两层(无路径/tmux 状态栏);
- 终端可视区高度 ≥ 视口 75%(截图目测 + 记录 xterm 容器 `getBoundingClientRect().height / innerHeight`)。
结束后关闭实例、`tmux -L zmx-smoke-p0 kill-server`、删除临时 data-dir。

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/TerminalView.tsx frontend/src/components/__tests__/TerminalView.mobileLayout.test.tsx docs/superpowers/screens/p0/
git commit -m "fix(terminal/mobile): pill above key bar, icon labels, drop status bar on touch; connection bar"
```

---

### Task 9: 全量验证 + 部署

**Files:** 无代码改动。

- [ ] **Step 1: 全量测试**

Run:
```bash
cd frontend && npm run lint && npx tsc -b && npm test && cd .. && cargo test
```
Expected: 全绿。记录测试文件数(应为 69 − 1 + 5 = 73 个前端测试文件:删 MarkdownViewer.stale,新增 wsStatus、acpConnection、ScheduledTasksPanel.toggle、TerminalView.mobileLayout,Composer/FileBrowser/Sidebar.newflow 为既有文件)。

- [ ] **Step 2: 不变量回归抽查**

Run: `cd frontend && npx vitest run src/components/__tests__/SessionInfoBar.queuemode.test.tsx src/lib/__tests__/scrollReplay.test.ts src/lib/__tests__/stuck.test.ts src/lib/__tests__/terminalSize.test.ts src/lib/__tests__/terminalInput.test.ts`
Expected: PASS(I-6 / I-11 / I-7 / I-12 / I-13 的纯函数层保护)。

- [ ] **Step 3: push 再部署**

```bash
git push origin main
./deploy.sh --build
```
Expected: deploy.sh 输出健康检查通过。若本会话在 zeromux 终端内运行,`systemctl stop` 时本终端掉线属预期(deploy.sh 会 systemd-run 逃逸完成切换),重连后执行 Step 4。

- [ ] **Step 4: 线上验证**

```bash
JS=$(curl -s https://zeromux.keithyu.cloud/ | grep -o '/assets/index-[^"]*\.js' | head -1)
curl -s -H 'Accept-Encoding: br' -o /dev/null -w 'br=%{size_download} code=%{http_code}\n' "https://zeromux.keithyu.cloud$JS"
systemctl is-active zeromux
```
Expected: `code=200`,`br` ≤ 400000,`active`。手机实测:中文输入法回车选词不发送;飞行模式下发送文本保留且出现「连接断开,正在重连…」,恢复网络后可正常发送。
