# 前端重设计 S4「终端」(Plan B)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 先修 S2+S3 上线 review 的 Critical/Important(Task 0),再让终端会话接入新壳:WS 生命周期先锁住再抽出 `useTerminalSocket`,键栏可收起并去 emoji,「终端输出发给 agent」统一走 SendToMenu(桌面选中文字浮钮 + 手机 HistoryView 一击发给 ★),隐藏终端不再轮询状态,桌面底部状态栏收编进 FocusHeader。

**Architecture:** 与 S2+S3 同一套路 —— characterization 先对**现有** TerminalView 写(含 B14 验证),全绿后「只搬不改」抽出 hook;之后每个用户可见改动一个任务、一个提交。WebGL 预算按 V13 **不做**。

**Tech Stack:** React 19 + Vite 8 + Tailwind v4 + vitest/happy-dom;`@xterm/xterm` 6;S1/S2+S3 产物:`components/ui/*`、`SendToMenu`、`lib/sendTargets.ts`、`sessionControls`、`usePolling`、`useIsTouch`、`test/xtermMock.ts`、`test/fakeWs.ts`(`startConnecting` 选项)。

**Spec:** `docs/superpowers/specs/2026-09-27-focus-session-experience-design.md` —— **§0.3(V2/V4/V5/V6/V13/V16)优先于正文**,正文 §4.1–§4.3、§4.6;总 spec `2026-09-26-frontend-triage-focus-redesign-design.md` §0.5(M25:本期删除终端 `onAskAgent` 写死 claude)、§3.1 token 规则。不变量:审计 §7 I-1~I-19(尤其 I-4 退避、I-5 onopen reset、I-12 resize 门控、I-13 sendInput 返回值、I-14 WebGL context loss、I-15 触屏 16px / touch-action)。

## Global Constraints

- **零新增运行时依赖**;首屏 br ≤ 330KB(当前 313.3KB);每个 Task 跑 `npm run build`。
- `frontend/src/__tests__/App.characterization.test.tsx` 与 Task 1 写的 `terminalSocket.characterization.test.tsx` 在后续每个 Task **原样通过**(Task 1 之后不改断言)。
- **原样通过清单**:`TerminalView.mobileLayout`、`HistoryView`(发送用例按 Task 5 明确改写的除外)、`MobileKeyBar`(Task 4 明确改写的除外)、`TerminalNotices`、`terminalInput`、`terminalScroll`、`terminalSize`、`desktopHints`、`historyToAgent`。
- 所有 client→PTY 输入仍经 `sendInput`(I-13);键栏按钮仍 `onPointerDown + preventDefault` + `touchAction: manipulation`(I-15)。
- 只有 active 且非 0×0 的视图能发 resize(I-12);`keyboardOpen` refit 路径与 `wsStatus===open` refit 路径**不得删除**(P0 保留,iOS 唯一 refit 路径)。
- 不新开 WS;发给 agent 只经 `SendToMenu`(已挂载会话的 `sessionControls.sendPrompt`)或其「＋ 新开…」预填 ⌘K。
- 快捷键不新增(V2 删了 `⌘⇧Enter`)。
- 字号只用 `text-ui-*`、颜色只用语义 token、图标只用 lucide、**禁 emoji**(V16)、禁原生 `alert/confirm/prompt`;`npm run lint` 的 token 棘轮不增。
- 触控目标 ≥ 44px。用户可见文案中文,代码/注释英文。
- 每个 Task 结束 `npm test` 全绿、`npx tsc -b`、lint 不新增 error(基线 15 errors / 3 warnings)、`npm run build` 过门禁。
- **绝不**在 `frontend/node_modules` 里建指向其它目录的软链(2026-09-28 线上黑屏根因:两份 React);部署前 `find frontend/node_modules -maxdepth 3 -type l -lname '/tmp/*'` 必须为空。
- 部署只用 `./deploy.sh --build`,先 commit + push 再 deploy;冒烟实例 `--data-dir <mktemp -d>` + `--tmux-socket <专用名>` + 端口 ≥ 18090。

## Review Focus

1. **断线重连窗口里发字**:composer / 键栏在 WS 未 OPEN 时按发送 → 文字留在输入框、无字节发出,重连后能正常发(Task 1 `sendInput false when closed` + Task 4 键栏测试)。
2. **旧 socket 迟到的 onclose 清掉新 socket 引用(B14)**:ws1 断开→重连 ws2 已 open→ws1 的 onclose 才到 → 之后输入必须仍能发出(Task 1 B14 用例;若复现,Task 1 内修)。
3. **隐藏终端**:切到别的会话后,隐藏的 tmux 终端不发 resize、不轮询 status/health;切回时重新发真实尺寸(Task 1 I-12 用例 + Task 6 轮询用例)。
4. **键栏收起**:收起后终端 refit(行数变多)且只发一次 resize;刷新后保持收起(Task 4)。
5. **手机 HistoryView 一击发给 ★**:无选区时点「发给 ★ 〈名〉」直接发尾部 200 行给默认目标,不弹确认;长按才开菜单;无 agent 候选时退化为「＋ 新开…」(Task 5)。

---

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `frontend/src/lib/lazyWithReload.ts`、`components/ui/ErrorBoundary.tsx`、`src/web.rs` 缓存头 | Create/Modify | Task 0 A1 |
| `frontend/src/components/__tests__/terminalSocket.characterization.test.tsx` | Create | TerminalView WS 生命周期锁定(I-4/I-5/I-12/I-13、tmux_ended、B14、refit 路径) |
| `frontend/src/hooks/useTerminalSocket.ts` | Create | WS connect/backoff/onmessage/sendInput/sendScroll/resize 发送(原样搬迁) |
| `frontend/src/components/TerminalView.tsx` | Modify | 使用 hook;选区浮钮;状态栏移除;轮询门控 |
| `frontend/src/components/MobileKeyBar.tsx` | Modify | 收起/展开、第二页 `^R ^L Home End`、去 emoji |
| `frontend/src/lib/terminalInput.ts` | Modify | `ControlKey` 增 `ctrl-r`/`ctrl-l`/`home`/`end` |
| `frontend/src/components/HistoryView.tsx` | Modify | 「发给 ★」一击 + 长按菜单,删原生式确认 |
| `frontend/src/components/SendToMenu.tsx` | Modify(小) | 导出 `defaultTarget()` 供一击发送 |
| `frontend/src/components/shell/AppShell.tsx` | Modify | 终端接 SendToMenu,删写死 claude 的 `onAskAgent` |
| `frontend/src/components/shell/FocusHeader.tsx`、`lib/sessionActions.ts` | Modify | tmux 会话 ⋯ 首行 路径/分支/dirty + 鼠标开关 |

---

### Task 0: S2+S3 上线后修复(zmx-ai-02ca59 review A1–A11)

**依据:** `docs/superpowers/audits/2026-09-29-planb-terminal-analysis.md` §A(Critical A1/A2 已由 reviewer 复核)。本 Task 先于终端工作上线。每项一个小提交,可一次部署。

**Files / 改动:**
- **A1 部署后懒载 404 白屏(Critical)**:`frontend/src/components/shell/lazyPanels.ts` 改用 `lazyWithReload(() => import(...))`(新 `frontend/src/lib/lazyWithReload.ts`):import 失败时若 `sessionStorage['zmx_chunk_reload']` 距今 > 10s 则写入时间戳并 `location.reload()`,否则抛出;`main.tsx` 监听 `window.addEventListener('vite:preloadError', …)` 走同一逻辑。新增 `frontend/src/components/ui/ErrorBoundary.tsx`(类组件,fallback:「页面已更新,点此刷新」按钮 `location.reload()`),包住 AppShell 根与 ContextPanel/面板 Sheet 的 `<Suspense>`。后端 `src/web.rs` `try_serve_embedded`:`index.html` 与 SPA fallback 返回 `Cache-Control: no-cache`;`/assets/*`(带 hash)返回 `public, max-age=31536000, immutable`;`sw.js` 保持现状。测试:`lazyWithReload.test.ts`(失败→reload 一次;10s 内再失败→抛出);ErrorBoundary 组件测;Rust 测 index.html 头为 `no-cache`、`/assets/x.js` 头含 `immutable`。
- **A2 撤销/提交改动发到别的仓库(Critical)**:`lib/gitviewer.ts` 的 `COMMIT_PROMPT`/`DISCARD_PROMPT` 改为函数 `commitPrompt(workDir)`/`discardPrompt(workDir)`,文本写明绝对路径(「在 `${workDir}` 下…」);`GitViewer` 调 `SendToMenu` 时新增 prop `sameDirOnly`(SendToMenu 新可选 prop):候选只保留 `work_dir === workDir` 的 agent,无候选时只剩「＋ 新开…」;`confirmDanger` 标题附带目标「→ 〈会话名〉(〈shortDir〉)」(SendToMenu 在 confirm 时拼接)。测试:跨目录 agent 不出现在撤销/提交菜单;prompt 含路径;确认框标题含目标名。
- **A3 离线期间完成的定时任务不进「需要你」**:`lib/readState.ts` `reconcileLastViewed(prev, sids, now, firstRun)`:仅当 `firstRun`(localStorage 无 `zmx_read`)时新 sid 以 now 为基线;否则新 sid 基线为 0。`useShellState` 传 `firstRun`。测试更新:readState 新用例;triage 行为不变。
- **A4 ⌘K 目录名回车跳进无关会话**:`CommandPalette` 会话匹配 keys 改为 `[s.name, s.peer_name ?? '', lastSegments(s.work_dir, 2)]`;仅靠路径命中的会话排在目录结果之后且不抢默认高亮(默认高亮取「名称命中的会话」>「目录结果首项」>「路径命中的会话」)。测试:所有会话共享长前缀时输入 `eks` 回车 = 目录结果首项;输入会话名前缀仍选中该会话。
- **A5 摘要卡只剩标题**:`lib/steps.ts` `conclusion`:首段为 markdown 标题行(`^#{1,6}\s`)或少于 40 字符时继续拼接后续段落直到 ≥ 40 字符或到达 600 上限;「展开全文」显示最后一个 text step 全文。测试:`## 总结\n\n- a\n- b` → 结论含列表。
- **A7** `SessionControls.sendPrompt(text, opts?: { withAttachments?: boolean })`,默认 true;SendToMenu 与 TriageRow 调用传 `{ withAttachments: false }`(不带走目标 composer 的附件)。测试。
- **A9** `session_manager.rs`:turn 开始(`mark_turn(Running)` 所在 `apply_turn` Running 分支)时清 `posture.approval_ids`。Rust 测试。
- **A10** `settle_posture` 在 outcome 为 Errored/Timeout 时清 `last_snippet`。Rust 测试。
- **A11** `useSessionsPoll` 读取 `?session=` 后 `history.replaceState(null, '', location.pathname)`。App.characterization I-17 不改断言(仍能选中)。
- 不在本期:A6(Crew 中途重连改非边界,属后端协议,另起)、A8(轮询乱序,记入 deferred)。

- [ ] 每项:失败测试 → 实现 → `npm test`/`cargo test`/`tsc`/`lint`/`build` → commit。全部完成后 push + `./deploy.sh --build` + headless 打开 127.0.0.1:8090 无 pageerror。

---

### Task 1: TerminalView characterization(对现有代码写)+ B14 验证

**Files:**
- Create: `frontend/src/components/__tests__/terminalSocket.characterization.test.tsx`
- Modify(仅当 B14 复现): `frontend/src/components/TerminalView.tsx`(`ws.onclose` 首行)

**Interfaces:**
- Consumes: `installFakeWebSocket({ startConnecting: true })`(`test/fakeWs.ts`)、`test/xtermMock.ts` 的 `xtermModule` 等(测试文件内 `vi.mock(..., async () => (await import('../../test/xtermMock')).xtermModule)`)。若 xtermMock 的 Terminal 缺 `modes`/`onBinary`/`scrollLines`,在 **xtermMock.ts** 补齐(不影响既有用例)。
- Produces: 测试契约(之后原样通过)。测试只通过 `ws.sent`、`ws.all.length`、可见文本(ConnectionBar「连接断开,正在重连…」、EndedOverlay 文案)与 xterm mock 的调用记录断言。

- [ ] **Step 1: 扩展 xterm mock 以记录调用**

`frontend/src/test/xtermMock.ts` 的 Terminal 类增加(已有字段保留):

```ts
    modes = { bracketedPasteMode: false, applicationCursorKeysMode: false }
    calls = { reset: 0, write: 0, focus: 0 }
    dataHandlers: ((d: string) => void)[] = []
    reset() { this.calls.reset++ }
    write(_d: unknown, cb?: () => void) { this.calls.write++; cb?.() }
    focus() { this.calls.focus++ }
    onData(h: (d: string) => void) { this.dataHandlers.push(h); return disp }
    onBinary() { return disp }
    scrollLines() {}
```

另补:`hasSelection`/`getSelection` 可配置(`export const selection = { has: false, text: '' }`),`onSelectionChange(h)` 收集 handler 到 `selectionHandlers`。并 export `lastTerminal = () => xtermInstances[xtermInstances.length - 1] as { calls: {reset:number}; dataHandlers: ((d:string)=>void)[]; cols: number; rows: number }`。FitAddon 的 `proposeDimensions` 返回可配置值:`export const fitDims = { cols: 80, rows: 24 }`,`proposeDimensions() { return { ...fitDims } }`,`fit()` 时把最近 Terminal 的 cols/rows 设为 `fitDims`。

Run: `cd frontend && npm test 2>&1 | tail -3` → 既有用例全绿。

- [ ] **Step 2: 写 characterization 测试**

```tsx
import { vi } from 'vitest'
vi.mock('@xterm/xterm', async () => (await import('../../test/xtermMock')).xtermModule)
vi.mock('@xterm/addon-fit', async () => (await import('../../test/xtermMock')).fitModule)
vi.mock('@xterm/addon-webgl', async () => (await import('../../test/xtermMock')).webglModule)
vi.mock('@xterm/addon-search', async () => (await import('../../test/xtermMock')).searchModule)
vi.mock('@xterm/addon-clipboard', async () => (await import('../../test/xtermMock')).clipboardModule)

import { render, screen, act } from '@testing-library/react'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import TerminalView from '../TerminalView'
import { installFakeWebSocket } from '../../test/fakeWs'
import { lastTerminal, fitDims } from '../../test/xtermMock'

// happy-dom reports 0×0 for every element; give the xterm container a real size.
function sizeContainers(w = 800, h = 600) {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return this.classList?.contains('xterm-container') ? w : 0 } })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return this.classList?.contains('xterm-container') ? h : 0 } })
}
const inputs = (s: { sent: string[] }) => s.sent.map(x => JSON.parse(x)).filter(m => m.type === 'input')
const resizes = (s: { sent: string[] }) => s.sent.map(x => JSON.parse(x)).filter(m => m.type === 'resize')

describe('TerminalView WS characterization', () => {
  const origWs = (globalThis as unknown as { WebSocket?: unknown }).WebSocket
  let ws: ReturnType<typeof installFakeWebSocket>
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.useFakeTimers({ shouldAdvanceTime: true })
    ws = installFakeWebSocket({ startConnecting: true })
    sizeContainers()
    fitDims.cols = 80; fitDims.rows = 24
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
  })
  afterEach(() => { vi.useRealTimers(); (globalThis as unknown as { WebSocket?: unknown }).WebSocket = origWs })

  const mount = (p: Partial<React.ComponentProps<typeof TerminalView>> = {}) =>
    render(<TerminalView sessionId="t1" active theme="dark" tmuxName="zmx-t1" tmuxOrigin="own" {...p} />)

  it('I-5: every open resets the terminal before replay', () => {
    mount()
    act(() => { ws.latest().fireOpen() })
    expect(lastTerminal().calls.reset).toBe(1)
    act(() => { ws.latest().fireClose() })
  })

  it('I-12: onopen sends exactly one resize when active; none when hidden', () => {
    mount()
    act(() => { ws.latest().fireOpen() })
    expect(resizes(ws.latest())).toEqual([{ type: 'resize', cols: 80, rows: 24 }])
    const h = mount({ sessionId: 't2', active: false })
    act(() => { ws.latest().fireOpen() })
    expect(resizes(ws.latest())).toEqual([])
    h.unmount()
  })

  it('I-12: becoming active re-sends the real size even if unchanged', async () => {
    const r = mount({ active: false })
    const s = ws.latest()
    act(() => { s.fireOpen() })
    r.rerender(<TerminalView sessionId="t1" active theme="dark" tmuxName="zmx-t1" tmuxOrigin="own" />)
    await act(async () => { vi.advanceTimersByTime(60) })
    expect(resizes(s)).toEqual([{ type: 'resize', cols: 80, rows: 24 }])
  })

  it('I-13: typed data is sent only while OPEN; closed returns nothing sent', () => {
    mount()
    const s = ws.latest()
    act(() => { lastTerminal().dataHandlers.forEach(h => h('a')) })
    expect(inputs(s)).toHaveLength(0)            // CONNECTING
    act(() => { s.fireOpen() })
    act(() => { lastTerminal().dataHandlers.forEach(h => h('b')) })
    expect(inputs(s)).toHaveLength(1)
  })

  it('I-4: backoff 1s,2s,4s,8s,10s,10s; resets after 3s stable', async () => {
    mount()
    for (const d of [1000, 2000, 4000, 8000, 10000, 10000]) {
      act(() => { ws.latest().fireClose() })
      const n = ws.all.length
      await act(async () => { vi.advanceTimersByTime(d - 10) })
      expect(ws.all.length).toBe(n)
      await act(async () => { vi.advanceTimersByTime(20) })
      expect(ws.all.length).toBe(n + 1)
    }
    act(() => { ws.latest().fireOpen() })
    await act(async () => { vi.advanceTimersByTime(3100) })
    act(() => { ws.latest().fireClose() })
    const n = ws.all.length
    await act(async () => { vi.advanceTimersByTime(1010) })
    expect(ws.all.length).toBe(n + 1)
  })

  it('tmux_ended: shows the ended overlay and never reconnects', async () => {
    mount()
    const s = ws.latest()
    act(() => { s.fireOpen() })
    act(() => { s.emit({ type: 'notice', kind: 'tmux_ended' }) })
    act(() => { s.fireClose() })
    const n = ws.all.length
    await act(async () => { vi.advanceTimersByTime(20000) })
    expect(ws.all.length).toBe(n)
  })

  it('B14: a late onclose from the old socket must not orphan the new one', async () => {
    mount()
    const s1 = ws.latest()
    act(() => { s1.fireOpen() })
    // s1 drops; its onclose schedules a reconnect and nulls wsRef.
    act(() => { s1.fireClose() })
    await act(async () => { vi.advanceTimersByTime(1010) })
    const s2 = ws.latest()
    expect(s2).not.toBe(s1)
    act(() => { s2.fireOpen() })
    // A duplicate/late close event for s1 arrives after s2 is live.
    act(() => { s1.onclose?.() })
    act(() => { lastTerminal().dataHandlers.forEach(h => h('x')) })
    expect(inputs(s2)).toHaveLength(1)
  })

  it('connection bar appears after a drop and the terminal refits once reopened', async () => {
    mount()
    const s = ws.latest()
    act(() => { s.fireOpen() })
    act(() => { s.fireClose() })
    await act(async () => { vi.advanceTimersByTime(1600) })
    expect(screen.getByText('连接断开,正在重连…')).toBeInTheDocument()
  })
})
```

注:`ConnectionBar` 文案以 `components/ConnectionBar.tsx` 实际为准(`acpConnection.test` 用的是「连接断开,正在重连…」)。

- [ ] **Step 3: 运行并描述现状**

Run: `cd frontend && npx vitest run src/components/__tests__/terminalSocket.characterization.test.tsx`
Expected: 除 B14 外全部 PASS。若非 B14 的用例失败,**修测试**直到它准确描述现状(mock 细节、等待时序),不改 TerminalView。

- [ ] **Step 4: B14 防御性修复(浏览器语义下不可达,见分析 §B2)**

B14 用例靠手动二次 `s1.onclose?.()` 才红,真实浏览器每个 socket 只 close 一次。仍照加防御:`ws.onclose` 开头 `if (wsRef.current !== ws && wsRef.current !== null) return`,随后 `wsRef.current = null`;并在连接 effect cleanup 的 `close()` 之后 `wsRef.current = null`(修分析 §B2-4 的「effect 重跑后连不上」)。**两处必须同一提交**(cleanup 清空后迟到 onclose 才真可达)。commit message 注明「浏览器语义下不可达,防御性加固」。重跑全绿。

- [ ] **Step 5: 验红**

逐条临时破坏被测逻辑确认变红后恢复:`termRef.current?.reset()` 注释 → I-5 红;`shouldSendResize` 的 `active` 条件改 true → I-12 hidden 红;`stableTimer` 3000 改 0 → I-4 红;`!endedRef.current` 去掉 → tmux_ended 红。

- [ ] **Step 6: Commit**

```bash
git add frontend/src/test/xtermMock.ts frontend/src/components/__tests__/terminalSocket.characterization.test.tsx frontend/src/components/TerminalView.tsx
git commit -m "test(terminal): characterization for WS lifecycle (I-4/5/12/13, tmux_ended); fix B14 stale onclose"
```

---

### Task 2: 抽出 `useTerminalSocket`(只搬不改)

**Files:**
- Create: `frontend/src/hooks/useTerminalSocket.ts`
- Modify: `frontend/src/components/TerminalView.tsx`

**Interfaces:**
- Consumes: Task 1 测试(不改一行)。
- Produces:
  ```ts
  export interface TerminalSocketOptions {
    sessionId: string
    epoch: number                                   // wsEpoch (revive)
    termRef: RefObject<Terminal | null>
    fitRef: RefObject<FitAddon | null>
    containerRef: RefObject<HTMLDivElement | null>
    activeRef: RefObject<boolean>
    tmuxRef: RefObject<string | null | undefined>
    tmuxOriginRef: RefObject<'own' | 'external' | null | undefined>
    onOutputSettled: () => void                     // replay-window scroll logic stays in the view
    onScrollState: (msg: unknown) => void
    onNotice: (kind: 'tmux_lost' | 'tmux_ended' | 'tmux_down') => void
    onOpen: () => void                              // reconnect hint / replay arm stay in the view
  }
  export function useTerminalSocket(o: TerminalSocketOptions): {
    wsRef: RefObject<WebSocket | null>
    wsStatus: { status: WsStatus; since: number }
    endedRef: RefObject<boolean>
    lastDims: RefObject<{ cols: number; rows: number }>
    sendInput(data: string): boolean                // exitScroll stays in the view: view wraps this
    sendRaw(msg: object): boolean                   // scroll / scroll_watch / mouse / resize
  }
  ```
  `handleResize` 留在 view(它读 `lastDims`/`wsRef`)。

- [ ] **Step 1: 搬迁**

**硬约束(分析 §B1)**:① init effect 仍留在 TerminalView(本期不抽 `useXterm`,避免跨 hook 循环引用;S3 spec §4.1 的 useXterm 推迟),且 `useTerminalSocket(...)` 调用必须位于 init effect 声明**之后**——连接 effect 依赖同一次提交中 init 已设好 termRef;② `handleBarKey` 留在 TerminalView.tsx(`crewSessionType.test.tsx:89-101` 按源码行 grep `key === 'claude'`);③ `onBinary`/mouse/scroll/scroll_watch 本就绕过 sendInput,改走 hook 的 `sendRaw`,语义不变;④ init cleanup 中的 `wsRef.current?.close()` 删除(连接 effect cleanup 已做同样的事)。

把 TerminalView 的「Connect WebSocket」effect(`if (!termRef.current) return` … cleanup)、`wsStatus` state、`endedRef`、`lastDims` 原样移入 hook;onmessage 里对 `setLost`/`setEnded`/`setHealth`/scroll_state/output-settle 的调用改为调用对应回调(回调用 ref 保存,每渲染同步,与 `useAcpSocket` 的 `onOpenRef` 同构,effect deps 仍为 `[sessionId, epoch]`)。onopen 里 `termRef.current?.reset()`、resize 首发、mouse-off 首发保持在 hook 内**原样**;`replayingRef`/`setReconnected`/`openedOnceRef` 移到 view 的 `onOpen` 回调。`sendInput` 的 `exitScroll()` 前置保留在 view:`const sendInput = useCallback((d: string) => { exitScroll(); return sock.sendInput(d) }, [exitScroll, sock.sendInput])`。

- [ ] **Step 2: 验证只搬不改**

Run: `cd frontend && npm test 2>&1 | tail -3 && npx tsc -b && npm run lint 2>&1 | tail -3 && npm run build 2>&1 | tail -2`
Expected: 全绿;`git diff --stat -- 'frontend/src/**/__tests__/**'` 为空。

- [ ] **Step 3: Commit**

```bash
git add frontend/src/hooks/useTerminalSocket.ts frontend/src/components/TerminalView.tsx
git commit -m "refactor(terminal): move WS lifecycle into useTerminalSocket (no behaviour change)"
```

---

### Task 3: 桌面状态栏收编进 FocusHeader;去 emoji(V16)

**Files:**
- Modify: `frontend/src/components/TerminalView.tsx`(删除桌面底部状态栏 JSX,约 `{!isTouch && (<div className="flex items-center gap-3 px-4 py-3 …`)、搜索框 ✕)
- Modify: `frontend/src/lib/sessionActions.ts`(tmux:鼠标开关动作)
- Modify: `frontend/src/components/shell/FocusHeader.tsx`(tmux:⋯ 菜单首行只读信息 路径 · 分支 · N 处改动)
- Test: `frontend/src/components/shell/__tests__/FocusHeader.test.tsx`(追加)、`frontend/src/lib/__tests__/sessionActions.test.ts`(追加)、`TerminalView.mobileLayout.test.tsx` 不改

**Interfaces:**
- Produces: `SessionAction.id` 增加 `'mouse'`;`ActionEnv` 增加可选 `toggleMouse?(id: string): void` 与 `mouseOn?(id: string): boolean`;FocusHeader 新 prop `statusLine?: string`(如 `~/…/zeromux · main · 3 处改动`)。TerminalView 通过新 prop `onStatus?(s: SessionStatus): void` 上报 status(AppShell 存 `statusBySid`),鼠标开关经 `sessionControls` 之外的 TerminalView 自有注册表:新增 `registerTermControls?(sid, { setMouse(on: boolean): boolean } | null)`(同 `useControlsRegistry` 形态,放 `lib/sessionControls.ts` 旁的 `termControls`)。

- [ ] **Step 1: 失败测试**
  - FocusHeader:tmux 会话传 `statusLine="…/zeromux · main · 3 处改动"` → 打开 ⋯ 后菜单顶部显示该行(非 menuitem,`role="note"`)。
  - sessionActions:tmux 且 `mouseOn` 返回 true → 有 `{ id: 'mouse', label: '鼠标交给浏览器' }`;false → `'鼠标交给 tmux'`;调用 `run` → `env.toggleMouse(id)`。External tmux(`tmux_origin === 'external'`)无此项(与 `mouseToggleApplies` 一致)。
  - TerminalView 桌面(非触屏)不再渲染 `⧉`/`🖱` 文本(`screen.queryByText(/🖱|⧉/)` 为 null),搜索框关闭按钮 `aria-label="关闭搜索"` 用 lucide `X`。
- [ ] **Step 2: 实现**:删除桌面状态栏(含 🖱×2、⧉ —— lint `emojiIcon` 基线 5 应降到 2,更新 `scripts/lint-tokens.baseline.json`;注释里的 `⤓`(TerminalView)与 `📎`(AcpChatView)也改为文字,基线降到 0);HistoryView `▲▼✕` 换 lucide `ChevronUp/ChevronDown/X`,TerminalView placeholder「点 ✈」改「点发送」;TerminalView 在 status 变化时调 `onStatus`;`setMouse` 逻辑原样来自状态栏按钮 onClick(写 localStorage `MOUSE_PREF_KEY` + 发 `{type:'mouse', on}`),返回是否送达;AppShell 生成 `statusLine`(`shortDir(work_dir)`、`git_branch`、`git_dirty>0 ? `${n} 处改动` : ''`,用 ` · ` 连接)。「复制接续命令」「查看历史」已在 sessionActions 中,无需新增。
- [ ] **Step 3: 验证 + 截图**(隔离实例 1440×900 tmux 会话 + ⋯ 菜单展开)+ **Commit** `feat(terminal): status line and mouse toggle move into FocusHeader ⋯; drop emoji`

---

### Task 4: 键栏收起 / 第二页补键 / 去 emoji(V4、V16)

**Files:**
- Modify: `frontend/src/lib/terminalInput.ts`(`ControlKey` += `'ctrl-r' | 'ctrl-l'`,`CONTROL` 增 `'\x12'`、`'\x0c'`;Home/End **按 DECCKM 分派**:新增 `homeEndSequence(key: 'home'|'end', appCursor: boolean)` → 普通 `\x1b[H`/`\x1b[F`,application 模式 `\x1bOH`/`\x1bOF`,`handleBarKey` 像方向键一样传 `term.modes.applicationCursorKeysMode`)
- Modify: `frontend/src/components/MobileKeyBar.tsx`
- Modify: `frontend/src/components/TerminalView.tsx`(键栏收起时 refit)
- Test: `frontend/src/components/__tests__/MobileKeyBar.test.tsx`(追加;`more-keys flips to page 2 and back` 用例里第二页返回键的可见文本若断言了 `↩︎`,改为断言 `aria-label`——在 commit message 注明)、`frontend/src/lib/__tests__/terminalInput.test.ts`(追加)

**Interfaces:**
- Produces: `MobileKeyBar` 新 props `collapsed: boolean; onToggleCollapsed(): void`;localStorage key `zmx_keytray`(`'1'` = 收起)。收起形态:一个 44px `IconButton label="展开键栏" icon={ChevronUp}`(与 composer 同一行,放在 Composer 左侧);展开形态末尾加 `IconButton label="收起键栏" icon={ChevronDown}`。`⋯`/`↩︎` 换 lucide `MoreHorizontal` / `Undo2`,aria-label 保持 `more-keys`。

- [ ] **Step 1: 失败测试**
  - terminalInput:`controlSequence('ctrl-r') === '\x12'`、`'ctrl-l' → '\x0c'`;`homeEndSequence('home', false) === '\x1b[H'`、`('end', true) === '\x1bOF'`。
  - 第二页 12 个键在 390px 下不足 44px:第二页改为**两行**(6+6)或横向滚动(`overflow-x-auto`,每键 `min-w-[44px]`);测试断言每个按钮类含 `min-w-[44px]` 或 `min-h-[44px]`。
  - MobileKeyBar:第二页包含 `ctrl-r`、`ctrl-l`、`home`、`end` 四个 aria-label 按钮且 pointerDown 触发 `onKey`;按钮文本不含 emoji(对所有按钮 `textContent` 断言不匹配 `/[\u{1F300}-\u{1FAFF}←-⇿⋯↩]/u`,箭头用 lucide 图标)。
  - TerminalView(触屏):点「收起键栏」→ 键栏按钮消失、出现「展开键栏」;`localStorage.zmx_keytray === '1'`;50ms 后触发一次 refit 且最多发一次 resize;重新挂载后仍收起。
- [ ] **Step 2: 实现**(TerminalView 持有 `collapsed` state,初值读 localStorage;`[isTouch, keyboardOpen, collapsed]` 合入现有 refit effect 的 deps,不新增 effect)
- [ ] **Step 3: 验证 + 截图**(390×844 展开/收起两张)+ **Commit** `feat(terminal): collapsible key tray, ^R ^L Home End, lucide icons`

---

### Task 5: 「发给 agent」统一走 SendToMenu(M25、V5、V6)

**Files:**
- Modify: `frontend/src/components/SendToMenu.tsx`(导出 `export function defaultTarget(sessions, workDir, excludeId?): SessionInfo | null` = `sendTargets(...)[0] ?? null`,供一击发送;组件内部改用它)
- Modify: `frontend/src/components/HistoryView.tsx`(删除 `confirm` 调用;底部按钮改为「发给 ★ 〈名〉」一击 + 长按 500ms 或右侧小 ▾ 打开 SendToMenu;无候选时按钮文案「发给 agent…」直接开菜单)
- Modify: `frontend/src/components/TerminalView.tsx`(`onAskAgent` prop → `sendTo?: SendToProps`;桌面选区浮钮)
- Modify: `frontend/src/components/shell/AppShell.tsx`(删写死 `shell.create('claude', …)`,改传 `sendTo(s.work_dir)` 同款 props)
- Test: `HistoryView.test.tsx`(`send to agent asks for confirmation and sends the tail` 与 `strips ANSI` 两条按新交互改写:断言不再弹确认、payload 相同——commit message 注明)、新增 `TerminalView.sendTo.test.tsx`、`SendToMenu.test.tsx`(追加 `defaultTarget`)

**Interfaces:**
- Consumes: `SendToMenu` props(`text, workDir, excludeId, sessions, controls, queueModes, onSelectSession, onNew`)、`historyPrompt`(不变,仍负责包装与 32KB 截断)。
- Produces: `type SendToProps = Omit<React.ComponentProps<typeof SendToMenu>, 'open' | 'anchor' | 'onClose' | 'text'>`(export 自 SendToMenu.tsx)。HistoryView 新 props `sendTo?: SendToProps; wrap(text: string): string`(由 TerminalView 传 `t => historyPrompt({ name: tmuxName ?? '', workDir: status?.work_dir ?? '', text: t })`)。一击发送:`const t = defaultTarget(...)`;`controls.current[t.id]?.sendPrompt(wrap(payload))` → true 则 toast「已发给 〈名〉」+「查看」,false 则 toast「未连接,未发送」+「复制」(与 SendToMenu 同文案,复用其内部 `notify` —— 从 SendToMenu.tsx 导出 `sendToSession(target, text, deps): Promise<void>` 供两处共用,避免重复逻辑)。

- [ ] **Step 1: 失败测试**
  - HistoryView:有候选时按钮文本「发给 ★ s-a」;无选区点击 → `sendPrompt` 收到 `wrap(尾部200行)`,无 `dialog[open]`;选中文字时发选区;长按 → 出现 SendToMenu(`role="menu"`);无候选 → 按钮「发给 agent…」点击开菜单;彩色模式 payload 去 ANSI。
  - TerminalView 桌面:mock `term.hasSelection() → true`、`getSelection() → 'err line'`,触发 onSelectionChange → 出现 `button[aria-label="发给…"]`;点击 → 菜单出现,★ Enter → `sendPrompt(historyPrompt({..., text: 'err line'}))`;选区清空(onSelectionChange + hasSelection false)→ 浮钮消失。
  - AppShell:tmux 会话的 TerminalView 不再收到写死 claude 的回调(grep 断言:`src('components/shell/AppShell.tsx')` 不含 `shell.create('claude'`)。
- [ ] **Step 2: 实现**:
  - **「＋ 新开」不得走 ⌘K 预填**(分析 §B7a:单行 input 会剥换行、`parseNew` 压空白,多行终端输出与 ``` 围栏被压成一行)。终端入口传给 SendToMenu 的 `onNew` 直接 `shell.create(loadLastType() 若为 tmux 则 'claude', workDir, undefined, prompt)`(保留全文),失败 toast「创建会话失败」;测试断言多行 prompt 原样传入 `create`。
  - HistoryView 的 `wrap` 用 **SessionInfo.work_dir**(经 `sendTo.workDir`),不用 `status?.work_dir`(Task 6 收紧轮询后可能为空)。
  - 长按按钮加 `select-none` 与 `[-webkit-touch-callout:none]`;选区在 pointerdown 时读取缓存。
  - 浮钮 `<Popover>` 锚定为容器右下角的一个绝对定位 span(不追踪单元格坐标——V2 精简;浮钮 44px,`aria-label="发给…"`);`onSelectionChange` 注册在 init effect 内(xterm 已有该 API)。
- [ ] **Step 3: 验证**(`grep -rn "shell.create('claude'" frontend/src` 为空;nativeDialog 棘轮不增)+ **Commit** `feat(terminal): send terminal output to an agent via SendToMenu (one tap to ★ on phones)`

---

### Task 6: 隐藏终端不轮询(§4.6)

**Files:**
- Modify: `frontend/src/components/TerminalView.tsx`(「Fetch status」effect 现为裸 `setInterval`,**不看 active 与页面可见性**——spec §4.6 的前提不成立(分析 §B5);改 `usePolling(fetchStatus, 10_000, { enabled: active })`,切为 active 时立即拉一次)
- Modify: `frontend/src/components/shell/AppShell.tsx`(tmux health 为全局端点:上提到 AppShell 每 30s 拉一份,经 prop 传给 TerminalView 的 `TmuxHealthBar`;TerminalView 不再各自拉 `getTmuxHealth`)
- Test: `TerminalView.sendTo.test.tsx` 或新 `TerminalView.polling.test.tsx`

- [ ] **Step 1: 失败测试**:`active={false}` 挂载 → 推进 30s,`getSessionStatus`/`getTmuxHealth` 调用 0 次;rerender `active` → 立即 1 次,之后每 10s 一次;文档 hidden 时不拉(usePolling 已有语义)。
- [ ] **Step 2: 实现 + 验证 + Commit** `perf(terminal): hidden terminals stop polling status/health`

---

### Task 7: 验收 + 部署

- [ ] **Step 1:** 隔离实例(端口 18095,`--data-dir $(mktemp -d)`,`--tmux-socket zmx-smoke-s4`)headless 截图:390×844 键栏展开/收起、HistoryView 底部「发给 ★」、1440×900 tmux 会话 FocusHeader ⋯ 菜单、选区浮钮;存 `docs/superpowers/screens/s4/`。关实例、kill tmux socket、删临时目录。
- [ ] **Step 2:** 写 `docs/superpowers/screens/s4/acceptance.md`:S3 spec §5.2 中终端相关指标(手机终端可视高度:键栏收起时 390×844 ≥ 82%,用 `getBoundingClientRect` 实测;「终端报错交给 agent」手机 ≤ 2 击(V5)、桌面选中 → 浮钮 → Enter ≤ 2 击)逐条给证据;未验证项(真机 iOS 键盘、WebGL V13 推迟)写明。
- [ ] **Step 3:** `find frontend/node_modules -maxdepth 3 -type l -lname '/tmp/*'` 为空;`npm test`、`cargo test`、`npm run build` 通过;commit + push;`./deploy.sh --build`;headless 打开 127.0.0.1:8090 无 pageerror。
