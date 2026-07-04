# Settings 聚合 + Obsidian 文档伪会话 + 重放落底 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 三个前端交互改进——侧边栏底部 Settings 聚合入口、Obsidian 文档做成可无缝切换的纯前端伪会话、会话重放结束后稳定落底（不打断正在翻历史的用户）。

**Architecture:** 纯前端改动，后端零改。把可单测的纯逻辑抽到 `lib/`（docTabs 持久化 + 类型、落底决策谓词），组件层做 wiring。文档伪会话用 App 层独立 `docTabs` 数组（不进后端 session 表 / SessionType），与真会话在同一列表按 id 前缀分派、CSS 显隐无缝切换。落底逻辑限定在"重放窗口"内且用户未上滚。

**Tech Stack:** React 19 + Vite + TypeScript + Tailwind v4；xterm.js（终端）；vitest + @testing-library/react；lucide-react 图标；localStorage 持久化。

## Global Constraints

- 后端零改动：不碰 Rust、不加 `SessionType`、不加后端 replay marker。（spec 非目标）
- 纯前端伪会话不占后端进程、不调 `deleteSession`。
- doc tab id 加前缀 `doc-` 与后端 UUID 会话 id 隔离。
- docTabs 持久化只存 `{ id, title, kind }[]`，不存浏览状态（cwd/openPath）。
- 落底判据用 boolean flag（重放期间是否发生向上滚动），**不用**"距底 N 像素"启发式阈值。
- 落底只发生在重放窗口内：终端自建窗口闸门（无 `replay_done`），agent 用现有 `replay_done`。
- 匹配双语规范：用户可见串多为中文，代码/注释英文。
- 每个任务跑 `npm run lint` 与 `npm test` 应保持绿（lint 以既存 baseline 为准，不引入**新**错误）。

---

## File Structure

- `frontend/src/lib/docTabs.ts` — **新建**。DocTab 类型 + localStorage 读写/增删纯函数。可单测。
- `frontend/src/lib/__tests__/docTabs.test.ts` — **新建**。docTabs 纯函数单测。
- `frontend/src/lib/scrollReplay.ts` — **新建**。落底决策纯谓词（重放窗口 + 未上滚 → 落底）。可单测。
- `frontend/src/lib/__tests__/scrollReplay.test.ts` — **新建**。谓词单测。
- `frontend/src/App.tsx` — **改**。引入 docTabs 状态/持久化、主区域渲染文档 tab、activeId 兜底与删除路径按 id 前缀分派。
- `frontend/src/components/Sidebar.tsx` — **改**。底部加 ⚙ Settings 面板（收主题/推送/PE/Admin），清理 header（移除主题/推送/Admin/Vault 按钮），New session 加「Obsidian 文档」项，会话列表渲染文档 tab（📓 图标区分）。
- `frontend/src/components/VaultReader.tsx` — **改**。从全屏 modal 改内嵌面板（去 `absolute inset-0 z-50` 外壳与关闭按钮；`onClose` 改为可选/删除交给列表）。
- `frontend/src/components/TerminalView.tsx` — **改**。重放窗口闸门 + debounce 落底（仅重放期 && 未上滚）。
- `frontend/src/components/AcpChatView.tsx` — **改**。`replay_done` 稳定落底 + ResizeObserver 补滚（可解除）+ 上滚监听。

---

## Task 1: docTabs 纯逻辑 + 持久化（lib）

**Files:**
- Create: `frontend/src/lib/docTabs.ts`
- Test: `frontend/src/lib/__tests__/docTabs.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces:
  - `type DocTab = { id: string; title: string; kind: 'vault' }`
  - `function newDocTab(title: string): DocTab` — 生成带 `doc-` 前缀 id 的新 tab（用 `crypto.randomUUID` 回退 `Math.random`）。
  - `function isDocTabId(id: string | null): boolean` — 判断某 id 是否属于文档 tab（前缀 `doc-`）。
  - `function loadDocTabs(): DocTab[]` — 从 localStorage 读回，容错（非数组/坏元素过滤）。
  - `function saveDocTabs(tabs: DocTab[]): void` — 只序列化 `{id,title,kind}`。

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/lib/__tests__/docTabs.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { newDocTab, isDocTabId, loadDocTabs, saveDocTabs, type DocTab } from '../docTabs'

describe('docTabs', () => {
  beforeEach(() => localStorage.clear())

  it('newDocTab produces a doc- prefixed id and kind vault', () => {
    const t = newDocTab('笔记')
    expect(t.id.startsWith('doc-')).toBe(true)
    expect(t.kind).toBe('vault')
    expect(t.title).toBe('笔记')
  })

  it('isDocTabId distinguishes doc tabs from backend uuids', () => {
    expect(isDocTabId('doc-abc')).toBe(true)
    expect(isDocTabId('550e8400-e29b-41d4-a716-446655440000')).toBe(false)
    expect(isDocTabId(null)).toBe(false)
  })

  it('save then load round-trips only id/title/kind', () => {
    const tabs: DocTab[] = [{ id: 'doc-1', title: 'A', kind: 'vault' }]
    saveDocTabs(tabs)
    expect(loadDocTabs()).toEqual(tabs)
  })

  it('loadDocTabs tolerates missing / corrupt storage', () => {
    expect(loadDocTabs()).toEqual([])
    localStorage.setItem('zeromux:doc-tabs', '"not-an-array"')
    expect(loadDocTabs()).toEqual([])
    localStorage.setItem('zeromux:doc-tabs', '[{"id":"doc-x","title":"X","kind":"vault"},{"bad":1}]')
    expect(loadDocTabs()).toEqual([{ id: 'doc-x', title: 'X', kind: 'vault' }])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/__tests__/docTabs.test.ts`
Expected: FAIL — cannot resolve `../docTabs`.

- [ ] **Step 3: Write minimal implementation**

```ts
// frontend/src/lib/docTabs.ts
export type DocTab = { id: string; title: string; kind: 'vault' }

const KEY = 'zeromux:doc-tabs'

const uuid = () =>
  (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36)

export function newDocTab(title: string): DocTab {
  return { id: `doc-${uuid()}`, title, kind: 'vault' }
}

export function isDocTabId(id: string | null): boolean {
  return typeof id === 'string' && id.startsWith('doc-')
}

function isValid(t: unknown): t is DocTab {
  return !!t && typeof t === 'object'
    && typeof (t as DocTab).id === 'string'
    && typeof (t as DocTab).title === 'string'
    && (t as DocTab).kind === 'vault'
}

export function loadDocTabs(): DocTab[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]')
    return Array.isArray(v) ? v.filter(isValid).map(t => ({ id: t.id, title: t.title, kind: t.kind })) : []
  } catch { return [] }
}

export function saveDocTabs(tabs: DocTab[]): void {
  localStorage.setItem(KEY, JSON.stringify(tabs.map(t => ({ id: t.id, title: t.title, kind: t.kind }))))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/__tests__/docTabs.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/docTabs.ts frontend/src/lib/__tests__/docTabs.test.ts
git commit -m "feat(doctab): pure localStorage-backed doc-tab model + tests"
```

---

## Task 2: 落底决策谓词（lib）

**Files:**
- Create: `frontend/src/lib/scrollReplay.ts`
- Test: `frontend/src/lib/__tests__/scrollReplay.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces:
  - `function shouldStickToBottom(state: { replaying: boolean; userScrolledUp: boolean }): boolean` — 仅当处于重放窗口且用户未上滚时返回 true。两视图共用此判据。

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/lib/__tests__/scrollReplay.test.ts
import { describe, it, expect } from 'vitest'
import { shouldStickToBottom } from '../scrollReplay'

describe('shouldStickToBottom', () => {
  it('sticks during replay when user has not scrolled up', () => {
    expect(shouldStickToBottom({ replaying: true, userScrolledUp: false })).toBe(true)
  })
  it('does not stick if user scrolled up during replay (passive reconnect case)', () => {
    expect(shouldStickToBottom({ replaying: true, userScrolledUp: true })).toBe(false)
  })
  it('does not stick outside the replay window (live output)', () => {
    expect(shouldStickToBottom({ replaying: false, userScrolledUp: false })).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/__tests__/scrollReplay.test.ts`
Expected: FAIL — cannot resolve `../scrollReplay`.

- [ ] **Step 3: Write minimal implementation**

```ts
// frontend/src/lib/scrollReplay.ts
// Bottom-stick is allowed ONLY inside the replay window and ONLY when the user
// has not scrolled up during it. Live output (replaying=false) never auto-sticks
// so reading scrollback / history is never yanked. Used by both TerminalView
// (self-armed window, no replay_done) and AcpChatView (replay_done marker).
export function shouldStickToBottom(state: { replaying: boolean; userScrolledUp: boolean }): boolean {
  return state.replaying && !state.userScrolledUp
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/__tests__/scrollReplay.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/scrollReplay.ts frontend/src/lib/__tests__/scrollReplay.test.ts
git commit -m "feat(scroll): replay-window bottom-stick predicate + tests"
```

---

## Task 3: VaultReader 改为内嵌面板

**Files:**
- Modify: `frontend/src/components/VaultReader.tsx`
- Test: `frontend/src/components/__tests__/VaultReader.test.tsx` (既有)

**Interfaces:**
- Consumes: 无新增。
- Produces: `VaultReader` 的 `onClose` prop 变为可选（`onClose?: () => void`）；两处外层 `absolute inset-0 bg-[var(--bg-primary)] z-50` 改为 `h-full bg-[var(--bg-primary)]`（内嵌，不再全屏浮层）；read/list 模式右上角关闭 `X` 按钮仅当 `onClose` 存在时渲染。read 模式内部 list↔read 切换的层叠保持不变。

背景：`VaultReader` 现被 Sidebar 作为全屏 modal 打开（`onClose` 必填）。文档伪会话把它嵌进 App 主区域（无 onClose，关闭=删 tab），需要它能在没有 onClose 时正常渲染、且不再是覆盖全屏的浮层。

- [ ] **Step 1: Write the failing test**

在 `frontend/src/components/__tests__/VaultReader.test.tsx` 的 `describe('VaultReader', ...)` 末尾追加：

```ts
  it('renders embedded (no fixed/overlay wrapper) when onClose is omitted', async () => {
    const { container } = render(<VaultReader />)
    await waitFor(() => expect(screen.getByText('note.md')).toBeInTheDocument())
    // no full-screen overlay wrapper
    expect(container.querySelector('.z-50')).toBeNull()
    // embedded root fills height instead
    expect(container.querySelector('.h-full')).not.toBeNull()
    // no close button when onClose omitted (close = delete the tab at list level)
    expect(container.querySelector('button svg.lucide-x')).toBeNull()
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/__tests__/VaultReader.test.tsx`
Expected: FAIL — `<VaultReader />` requires `onClose`（TS/运行期），且当前根节点带 `z-50`。

- [ ] **Step 3: Write minimal implementation**

3a. 改签名（`VaultReader.tsx:8`）：

```tsx
export default function VaultReader({ onClose }: { onClose?: () => void }) {
```

3b. READ MODE 外层（`VaultReader.tsx:55`）：

```tsx
      <div className="absolute inset-0 bg-[var(--bg-primary)] z-50 flex flex-col">
```
改为：
```tsx
      <div className="h-full bg-[var(--bg-primary)] flex flex-col">
```

3c. READ MODE 关闭按钮（`VaultReader.tsx:59`）——仅当 onClose 存在时渲染：

```tsx
          <button onClick={onClose} className="p-1.5 text-[var(--text-secondary)] hover:text-[var(--accent-red)]"><X size={18} /></button>
```
改为：
```tsx
          {onClose && <button onClick={onClose} className="p-1.5 text-[var(--text-secondary)] hover:text-[var(--accent-red)]"><X size={18} /></button>}
```

3d. LIST MODE 外层（`VaultReader.tsx:82`）：

```tsx
    <div className="absolute inset-0 bg-[var(--bg-primary)] z-50 flex flex-col">
```
改为：
```tsx
    <div className="h-full bg-[var(--bg-primary)] flex flex-col">
```

3e. LIST MODE 关闭按钮（`VaultReader.tsx:85`）：

```tsx
        <button onClick={onClose} className="p-1.5 text-[var(--text-secondary)] hover:text-[var(--accent-red)]"><X size={18} /></button>
```
改为：
```tsx
        {onClose && <button onClick={onClose} className="p-1.5 text-[var(--text-secondary)] hover:text-[var(--accent-red)]"><X size={18} /></button>}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/__tests__/VaultReader.test.tsx`
Expected: PASS（既有 2 测 + 新 1 测）。

> 注：既有测试用 `<VaultReader onClose={() => {}} />` 仍应通过（此时关闭按钮渲染）。若某既有断言依赖 `.z-50` 请一并更新；当前既有断言只查文本与 `.vault-reading-surface`，不受影响。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/VaultReader.tsx frontend/src/components/__tests__/VaultReader.test.tsx
git commit -m "feat(vault): make VaultReader an embeddable panel (optional onClose)"
```

---

## Task 4: App 集成文档伪会话（状态/渲染/删除/兜底/持久化）

**Files:**
- Modify: `frontend/src/App.tsx`

**Interfaces:**
- Consumes: `DocTab`, `newDocTab`, `isDocTabId`, `loadDocTabs`, `saveDocTabs`（Task 1）；`VaultReader`（Task 3，内嵌形态）。
- Produces:
  - App 持有 `docTabs: DocTab[]` 状态，启动时 `loadDocTabs()` 初始化，变化时 `saveDocTabs`。
  - `handleCreate` 扩展：当 `type === 'vault'` 时不调后端，改为新建 doc tab。为此 `onCreate` 的 `type` 参数类型拓宽为 `SessionType | 'vault'`（Sidebar Task 5 消费此签名）。
  - `handleDelete` 与 activeId 兜底同时感知 `sessions` 与 `docTabs`。

本任务较大但不可再拆（状态、渲染、删除、兜底彼此耦合，拆开中间态不可编译/不自洽）。

- [ ] **Step 1（无独立单测，纯 wiring；靠编译 + 后续手动冒烟）：加 import 与状态**

`App.tsx` 顶部 import 区加：

```tsx
import VaultReader from './components/VaultReader'
import { type DocTab, newDocTab, isDocTabId, loadDocTabs, saveDocTabs } from './lib/docTabs'
```

在 `const [sessions, setSessions] = ...` 附近加状态与持久化：

```tsx
  const [docTabs, setDocTabs] = useState<DocTab[]>(() => loadDocTabs())
  useEffect(() => { saveDocTabs(docTabs) }, [docTabs])
```

- [ ] **Step 2: 扩展 handleCreate 支持 vault 伪会话**

把 `handleCreate`（`App.tsx:193`）签名与体改为：

```tsx
  const handleCreate = useCallback(async (type: SessionType | 'vault', workDir?: string, tmuxTarget?: string, initialPrompt?: string) => {
    if (type === 'vault') {
      const tab = newDocTab('Obsidian')
      setDocTabs(prev => [...prev, tab])
      setActiveId(tab.id)
      return
    }
    const s = await createSession(type, undefined, workDir, tmuxTarget, initialPrompt)
    setSessions(prev => [...prev, s])
    setActiveId(s.id)
  }, [])
```

- [ ] **Step 3: 删除路径按 id 前缀分派 + activeId 兜底感知两个数组**

3a. 加 doc tab 删除函数（放在 `handleDelete` 附近）：

```tsx
  const handleDeleteDocTab = useCallback((id: string) => {
    setDocTabs(prev => {
      const next = prev.filter(t => t.id !== id)
      setActiveId(cur => cur === id
        ? (next[0]?.id ?? null)   // fall back within doc tabs; else null → sessions row shows
        : cur)
      return next
    })
  }, [])
```

3b. 改 `handleDelete`（`App.tsx:207`）末尾兜底，删最后一个真会话时回退到仍存在的 doc tab：

```tsx
  const handleDelete = useCallback(async (id: string) => {
    await deleteSession(id)
    setSessions(prev => {
      const next = prev.filter(s => s.id !== id)
      if (activeId === id) {
        setActiveId(next[0]?.id ?? docTabs[0]?.id ?? null)
      }
      return next
    })
  }, [activeId, docTabs])
```

3c. 改 `loadSessions` 的 activeId 兜底（`App.tsx:65-66`）——prev 若是 doc tab 视为有效不要跳走：

```tsx
      if (list.length > 0) {
        setActiveId(prev =>
          prev && (list.some(s => s.id === prev) || isDocTabId(prev)) ? prev : list[0].id)
      }
```

- [ ] **Step 4: 主区域渲染 doc tabs（内嵌 VaultReader，CSS 显隐）**

在主内容区 `sessions.map(...)` 的**闭合之后**、`{sessions.length === 0 && ...}` 之前，插入：

```tsx
          {docTabs.map(t => {
            const isActive = t.id === activeId
            return (
              <div key={t.id} className={`absolute inset-0 ${isActive ? '' : 'hidden'}`}>
                <VaultReader />
              </div>
            )
          })}
```

同时把空态判断从 `sessions.length === 0` 改为两者皆空：

```tsx
          {sessions.length === 0 && docTabs.length === 0 && (
```

- [ ] **Step 5: 传删除分派给 Sidebar**

Sidebar 的 `onDelete` 现在只处理真会话。改为在 App 层按 id 前缀分派——把传给 `<Sidebar onDelete={...}>` 的值改为：

```tsx
        onDelete={(id) => isDocTabId(id) ? handleDeleteDocTab(id) : handleDelete(id)}
```

（`handleSessionUpdate`、`hasUnread` 等只对真会话调用；doc tab 不经过这些路径——见 Task 5 列表渲染分流。）

- [ ] **Step 6: 编译校验**

Run: `cd frontend && npx tsc -b`
Expected: 无**新增**类型错误（`onCreate`/`onDelete` 签名与 Sidebar 在 Task 5 对齐前，Sidebar 侧可能暂报错——若单独跑本任务，允许 Sidebar 处 `type`/`onDelete` 类型不匹配，将在 Task 5 消解；本任务只保证 App.tsx 自身语法/类型自洽）。

> 执行建议：Task 4 与 Task 5 是一对（App 产出签名、Sidebar 消费），可在同一 review 周期连续执行后再跑整体 `tsc -b`。

- [ ] **Step 7: Commit**

```bash
git add frontend/src/App.tsx
git commit -m "feat(doctab): App integration — state, persistence, render, delete dispatch, activeId fallback"
```

---

## Task 5: Sidebar — Settings 面板 + header 清理 + New session 加 Obsidian + 列表渲染 doc tab

**Files:**
- Modify: `frontend/src/components/Sidebar.tsx`

**Interfaces:**
- Consumes: `onCreate(type: SessionType | 'vault', ...)`（Task 4）；App 传入的 `docTabs`、`activeId`、`onSelect`、`onDelete`（按前缀分派，Task 4）。
- Produces: 新 props `docTabs: DocTab[]`。Settings 面板聚合主题/推送/PE/Admin；header 去除主题/推送/Admin/Vault 按钮。

前置：本任务需要 App 把 `docTabs` 传进 Sidebar。先在 App `<Sidebar ...>` 加 `docTabs={docTabs}`，并在 Sidebar `Props` 加 `docTabs: DocTab[]`。

- [ ] **Step 1: 扩展 Props 与 import**

1a. `Sidebar.tsx` import 区：`onCreate` 类型拓宽、引入 `DocTab` 与图标 `Settings`：

```tsx
import { Terminal, Plus, X, PanelLeftClose, PanelLeft, Sun, Moon, Folder, FolderGit2, ChevronLeft, Home, LogOut, Users, MonitorUp, Link, Clock, Bell, BookOpen, Settings } from 'lucide-react'
import { type DocTab } from '../lib/docTabs'
```

1b. `interface Props` 改动：

```tsx
  onCreate: (type: SessionType | 'vault', workDir?: string, tmuxTarget?: string, initialPrompt?: string) => void
```
新增：
```tsx
  docTabs: DocTab[]
```

1c. 解构参数加 `docTabs`：函数签名 `export default function Sidebar({ ..., confirmCount = 0 })` 里加入 `docTabs`。

1d. App 侧 `<Sidebar ...>` 传入 `docTabs={docTabs}`（`App.tsx`）。

- [ ] **Step 2: New session 类型菜单加「Obsidian 文档」（vaultEnabled 门控）**

在 `step === 'pick-type'` 的 Codex 按钮之后（`Sidebar.tsx:504` 附近，`</>` 之前）插入：

```tsx
                  {vaultEnabled && (
                    <button
                      onClick={() => { onCreate('vault'); setStep('closed') }}
                      className="flex items-center gap-2.5 w-full px-3 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                    >
                      <BookOpen size={14} className="text-[var(--accent-blue)] shrink-0" />
                      <div className="text-left">
                        <div className="font-medium">Obsidian 文档</div>
                        <div className="text-[10px] text-[var(--text-secondary)]">笔记库(与会话无缝切换)</div>
                      </div>
                    </button>
                  )}
```

（`vaultEnabled` state 与 `getVaultMeta` 门控已存在，无需新增。）

- [ ] **Step 3: 会话列表渲染 doc tabs（📓 图标，无 TurnDot/时间/红点）**

在展开态 sessions 列表 `.map` 的容器（`Sidebar.tsx:389` 的 `<div className="flex-1 overflow-y-auto py-1">`）内、`sessions.map(...)` **之后**追加 doc tab 渲染：

```tsx
        {docTabs.map(t => (
          <div
            key={t.id}
            onClick={() => handleSelect(t.id)}
            className={`group flex items-center gap-2 px-3 py-1.5 mx-1 rounded cursor-pointer text-xs transition-colors ${
              t.id === activeId
                ? 'bg-[var(--bg-tertiary)] text-[var(--text-bright)] shadow-[inset_2px_0_0_var(--accent-brand)]'
                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
            }`}
          >
            <BookOpen size={13} className="shrink-0 text-[var(--accent-blue)]" />
            <span className="flex-1 min-w-0 truncate">{t.title}</span>
            <button
              onClick={e => { e.stopPropagation(); onDelete(t.id) }}
              className="p-0.5 opacity-0 group-hover:opacity-100 text-[var(--text-secondary)] hover:text-[var(--accent-red)] transition-all"
              title="关闭文档"
            >
              <X size={12} />
            </button>
          </div>
        ))}
```

也在折叠态 rail（`Sidebar.tsx:244` 的 `sessions.map` 之后）追加最小图标条目：

```tsx
        {docTabs.map(t => (
          <button
            key={t.id}
            onClick={() => handleSelect(t.id)}
            className={`relative p-1.5 rounded transition-colors ${
              t.id === activeId
                ? 'bg-[var(--bg-tertiary)] text-[var(--text-bright)] shadow-[inset_2px_0_0_var(--accent-brand)]'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]'
            }`}
            title={t.title}
          >
            <BookOpen size={14} />
          </button>
        ))}
```

- [ ] **Step 4: 加 Settings state 与底部按钮**

4a. state（与其它 `useState` 并列）：

```tsx
  const [showSettings, setShowSettings] = useState(false)
```

4b. 底部「New session」按钮所在的 `<div className="relative px-2 py-3 border-t border-[var(--border)]">`（`Sidebar.tsx:449`）内、`New session` 按钮**之前**插入 Settings 按钮：

```tsx
        <button
          onClick={() => setShowSettings(true)}
          className="flex items-center gap-2 w-full px-3 py-2 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] rounded-lg transition-colors min-h-[40px]"
        >
          <Settings size={14} />
          <span>Settings</span>
        </button>
```

- [ ] **Step 5: 渲染 Settings 面板（popover）+ 内部各入口**

在同一底部容器里、Settings 按钮之后加面板（复用 `absolute bottom-full` popover 样式；主题即时 toggle，推送/PE/Admin 打开各自组件）：

```tsx
        {showSettings && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setShowSettings(false)} />
            <div className="absolute bottom-full left-2 mb-1 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded-lg py-1 w-56 z-20 shadow-xl">
              <div className="px-3 py-1.5 text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">Settings</div>
              <button
                onClick={onToggleTheme}
                className="flex items-center gap-2.5 w-full px-3 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
              >
                <ThemeIcon size={14} className="shrink-0" />
                <span className="flex-1 text-left">{theme === 'dark' ? '浅色模式' : '深色模式'}</span>
              </button>
              <button
                onClick={() => { setShowSettings(false); setShowPushSettings(true) }}
                className="flex items-center gap-2.5 w-full px-3 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
              >
                <Bell size={14} className="shrink-0" />
                <span className="flex-1 text-left">推送通知</span>
              </button>
              <button
                onClick={() => { setShowSettings(false); setStep('manage-prompts') }}
                className="flex items-center gap-2.5 w-full px-3 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
              >
                <Pencil size={14} className="shrink-0" />
                <span className="flex-1 text-left">常用 prompt 管理</span>
              </button>
              {isAdmin && (
                <button
                  onClick={() => { setShowSettings(false); setShowAdmin(true) }}
                  className="flex items-center gap-2.5 w-full px-3 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                >
                  <Users size={14} className="shrink-0" />
                  <span className="flex-1 text-left">用户管理</span>
                </button>
              )}
            </div>
          </>
        )}
```

补 import：把 `Pencil` 加进 lucide 引入行。

> 说明：`setStep('manage-prompts')` 会打开已有的 New-session popover 的「管理常用 prompt」步骤（PromptManager）。这是复用现成入口的最小改动；它会展开 New session 的 popover。若执行时发现 `manage-prompts` 步骤依赖 `pendingType`/`pendingDir` 才自洽，则改为在 Settings 内直接内联渲染 `<PromptManager .../>`（props 见 Task 起始的 Interfaces：presets/error/onAdd/onEdit/onRemove/onClose，全部来自已有的 `presetStore`）。二者取其一，以真机 popover 不串味为准。

- [ ] **Step 6: 清理 header（移除主题/推送/Admin/Vault 按钮及 Vault state）**

在 header `<div className="flex items-center gap-0.5">`（`Sidebar.tsx:308`）中删除以下按钮：
- 推送 `Bell`（`onClick={() => setShowPushSettings(true)}`，310-315）
- Vault `BookOpen`（`vaultEnabled && (...)`，316-324）
- Admin `Users`（`isAdmin && (...)`，343-351）
- 主题 `ThemeIcon`（352-358）

**保留**：定时任务 `Clock`（含红点/confirmCount）、登出 `LogOut`、折叠 `PanelLeftClose`。

同时删除现在无引用的 `showVault`/`setShowVault` state 与其 `<VaultReader>` 渲染（`Sidebar.tsx:87`、`386` 的 `{showVault && <VaultReader onClose=.../>}`），以及 `VaultReader` 的 import（Vault 现由 App 渲染）。`getVaultMeta`/`vaultEnabled`/`shouldShowVault` **保留**（Step 2 的 New session 项要用它门控）。

折叠态 rail（`!open && !mobile`）里的主题 toggle 按钮（`Sidebar.tsx:262-268`）**保留**——rail 无 Settings 入口，主题 toggle 是那里唯一的快捷开关，移除会让折叠态没法切主题。

- [ ] **Step 7: 编译 + lint + 全量测试**

Run:
```bash
cd frontend && npx tsc -b && npm run lint && npm test
```
Expected: `tsc -b` 通过（App+Sidebar 签名对齐）；lint 无**新增**错误；vitest 全绿（既有 + Task1/2/3 新增）。

> 若 lint 报 `VaultReader`/`Bell`/`Users` 等 import 未使用，按 Step 6 一并删除对应 import。

- [ ] **Step 8: Commit**

```bash
git add frontend/src/components/Sidebar.tsx frontend/src/App.tsx
git commit -m "feat(sidebar): bottom Settings panel + header cleanup + Obsidian new-session + doc-tab list rows"
```

---

## Task 6: AcpChatView 重放落底（replay_done + ResizeObserver + 上滚监听）

**Files:**
- Modify: `frontend/src/components/AcpChatView.tsx`

**Interfaces:**
- Consumes: `shouldStickToBottom`（Task 2）。
- Produces: 无对外接口变化（内部滚动行为改进）。

无 WS 单测基建（现无 WebSocket mock），本任务靠 `tsc`/`lint`/手动冒烟；落底谓词的分支逻辑已由 Task 2 单测覆盖。

- [ ] **Step 1: 引入谓词与滚动窗口 refs**

`AcpChatView.tsx` import 区加：

```tsx
import { shouldStickToBottom } from '../lib/scrollReplay'
```

在组件内（`scrollRef` 附近）加 refs：

```tsx
  const replayingRef = useRef(false)
  const userScrolledUpRef = useRef(false)
  const roRef = useRef<ResizeObserver | null>(null)
  const roTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
```

- [ ] **Step 2: onopen 武装重放窗口**

在 WS `ws.onopen`（`AcpChatView.tsx:149`）里，`setEvents([])` 附近加：

```tsx
        replayingRef.current = true
        userScrolledUpRef.current = false
```

- [ ] **Step 3: 监听用户上滚（重放窗口内置 flag）**

在滚动容器 `<div ref={scrollRef} ...>`（`AcpChatView.tsx:395`）加 `onWheel`/`onTouchMove`/`onScroll` 侦测。最稳的是 `onScroll` 里按"离底距离"判断（一次性，非阈值启发式——只要不在最底部就算用户上滚）：

```tsx
      <div
        ref={scrollRef}
        onScroll={() => {
          const el = scrollRef.current
          if (!el || !replayingRef.current) return
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 4
          if (!atBottom) userScrolledUpRef.current = true
        }}
        className="flex-1 overflow-y-auto px-5 py-4 space-y-4"
      >
```

> `< 4` 是"是否贴底"的容差（滚动条像素抖动），非"距底 N 像素才算上滚"的启发式；语义是"只要离开了底部就记为用户在看历史"。

- [ ] **Step 4: replay_done 稳定落底 + ResizeObserver 补滚（可解除）**

改 `handleEvent` 的 `case 'replay_done'`（`AcpChatView.tsx:272`）：

```tsx
      case 'replay_done': {
        setBusy(false)
        setTurnStartedMs(null)
        setQueuedCount(0)
        // Stable bottom-stick: only inside the replay window and only if the user
        // hasn't scrolled up (passive reconnect must not yank a reader to the end).
        const el = scrollRef.current
        if (el && shouldStickToBottom({ replaying: replayingRef.current, userScrolledUp: userScrolledUpRef.current })) {
          el.scrollTop = el.scrollHeight
          // Async content (markdown/mermaid/katex/images) grows height after this
          // tick; follow those growths for a short window via ResizeObserver.
          roRef.current?.disconnect()
          const ro = new ResizeObserver(() => {
            if (userScrolledUpRef.current) { ro.disconnect(); return }
            el.scrollTop = el.scrollHeight
          })
          ro.observe(el)
          roRef.current = ro
          if (roTimerRef.current) clearTimeout(roTimerRef.current)
          roTimerRef.current = setTimeout(() => { ro.disconnect(); roRef.current = null }, 2000)
        }
        // Replay window closes here — live output no longer auto-sticks.
        replayingRef.current = false
        break
      }
```

- [ ] **Step 5: 卸载时清理 ResizeObserver/timer**

在已有的卸载清理 effect（`AcpChatView.tsx:378` 的 metricsDebounce 清理）旁，追加：

```tsx
  useEffect(() => () => {
    roRef.current?.disconnect()
    if (roTimerRef.current) clearTimeout(roTimerRef.current)
  }, [])
```

- [ ] **Step 6: 编译 + lint + 测试**

Run:
```bash
cd frontend && npx tsc -b && npm run lint && npm test
```
Expected: 通过；无新增 lint 错误；vitest 全绿。

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/AcpChatView.tsx
git commit -m "feat(acp): stable bottom-stick on replay_done, respect user scroll, ResizeObserver follow"
```

---

## Task 7: TerminalView 重放窗口闸门 + debounce 落底

**Files:**
- Modify: `frontend/src/components/TerminalView.tsx`

**Interfaces:**
- Consumes: `shouldStickToBottom`（Task 2）。
- Produces: 无对外接口变化。

终端**无** `replay_done`，自建重放窗口：`onopen` 武装、首帧 debounce 落底触发后解除；用户主动滚动/输入也解除。落底谓词分支已由 Task 2 覆盖；WS/xterm 路径靠手动冒烟。

- [ ] **Step 1: 引入谓词与 refs**

`TerminalView.tsx` import 区加：

```tsx
import { shouldStickToBottom } from '../lib/scrollReplay'
```

组件内（`wsRef` 附近）加：

```tsx
  const replayingRef = useRef(false)
  const userScrolledUpRef = useRef(false)
  const scrollDebounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
```

- [ ] **Step 2: onopen 武装重放窗口**

在 `ws.onopen`（`TerminalView.tsx:248`）里 `termRef.current?.reset()` 之后加：

```tsx
        replayingRef.current = true
        userScrolledUpRef.current = false
```

- [ ] **Step 3: 监听用户主动滚动/输入解除窗口**

xterm 有 `onScroll`（滚动到某行）与 `onData`（输入）。在初始化 term 的 effect 里（term 创建后、`sessionId` effect 内，`TerminalView.tsx:180` 之前的 term setup 处）注册：

```tsx
    term.onScroll(() => {
      // 用户在重放期间往上翻（未贴底）→ 记为看历史，停止自动落底
      const buf = term.buffer.active
      const atBottom = buf.viewportY >= buf.baseY
      if (replayingRef.current && !atBottom) userScrolledUpRef.current = true
    })
    term.onData(() => { replayingRef.current = false })
```

> 若 term setup 不在便于插入的位置，改在 `onData` 已有的 `sendInput` 注册点（`term.onData(...)`，搜索现有 `onData`）里追加 `replayingRef.current = false` 一行即可，勿重复注册。

- [ ] **Step 4: onmessage 写入后 debounce 落底（仅重放期 && 未上滚）**

改 `ws.onmessage`（`TerminalView.tsx:263`）的 output 分支，用 `write` 的 callback + debounce：

```tsx
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
```

- [ ] **Step 5: 卸载清理 debounce timer**

在既有卸载清理（`TerminalView.tsx:213` 的 return，或 WS effect 的 return）里加：

```tsx
      if (scrollDebounceRef.current) clearTimeout(scrollDebounceRef.current)
```

- [ ] **Step 6: 编译 + lint + 测试**

Run:
```bash
cd frontend && npx tsc -b && npm run lint && npm test
```
Expected: 通过；无新增 lint 错误；vitest 全绿。

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/TerminalView.tsx
git commit -m "feat(term): self-armed replay window + debounced bottom-stick, respect scrollback"
```

---

## Task 8: 整体校验 + 手动冒烟 + 构建

**Files:** 无代码改动（验证任务）。

- [ ] **Step 1: 全量检查**

```bash
cd frontend && npx tsc -b && npm run lint && npm test
```
Expected: tsc 通过；lint 无新增错误（对照 baseline）；vitest 全绿（含 Task 1/2/3 新测）。

- [ ] **Step 2: 生产构建（rust-embed 前置）**

```bash
cd frontend && npm run build
```
Expected: `tsc -b && vite build` 成功产出 `frontend/dist/`。

- [ ] **Step 3: 手动冒烟清单（无法单测的 WS/xterm/交互路径）**

逐条走查（本地 `npm run dev` 或部署后）：

需求 1（Settings）：
- 侧边栏底部有 ⚙ Settings；点开含 主题 / 推送 / 常用 prompt 管理 /(admin)用户管理。
- 主题项即时切换深浅色。
- header 只剩 定时任务(红点)/登出/折叠；主题、推送、Admin、Vault 按钮已从 header 消失。
- 折叠态 rail 仍能切主题。

需求 2（文档伪会话）：
- New session → 有「Obsidian 文档」项（仅 vault 启用时）；点击在列表新增一个 📓 tab 并激活。
- 在 Claude 会话与 📓 文档 tab 间来回点：**互不丢状态**（文档浏览位置、聊天滚动位置都在）。
- 文档 tab 用 × 关闭；关闭当前激活的文档 tab 后 activeId 正确回退（到另一 tab 或真会话）。
- 刷新页面：文档 tab **还原**（回到 list 模式，不还原浏览路径）。
- 删最后一个真会话时不误伤仍在的文档 tab。

需求 3（落底）：
- 打开/切到一个有历史的 **agent 聊天**：重放结束停在最后一句（不是顶部）。
- 打开/切到一个有 scrollback 的 **终端**：停在底部最新输出。
- **回归**：终端里手动往上翻 scrollback，此时来了实时输出 → 视口**不被拽到底**。
- **回归**：agent 聊天里往上翻历史时触发一次重连（可切后台再回来）→ 重放**不把你拽到底**。
- 含 mermaid/KaTeX/图片的长对话：重放后仍稳定贴底（ResizeObserver 补滚生效），2s 后加载的图片不会永久钉底。

- [ ] **Step 4: Commit（若冒烟中发现并修了小问题）**

```bash
git add -A
git commit -m "fix: smoke-test adjustments for settings/doctab/replay-scroll"
```

（若无问题则跳过本步。）

---

## 部署

冒烟通过后按 `CLAUDE.md` 用 `./deploy.sh --build` 部署到 live（切勿手工 systemctl stop+cp）。部署非本计划强制步骤，按用户指示执行。
