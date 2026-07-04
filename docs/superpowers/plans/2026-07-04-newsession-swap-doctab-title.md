# New session/Settings 对调 + 文档 tab 显示笔记标题 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 底部 New session 上移并强调、Settings 下移；文档伪会话在左侧实时显示当前打开的笔记标题（不持久化浏览状态）。

**Architecture:** 纯前端改动。文档 tab 标题通过 `VaultReader` 新增 `onTitleChange` 回调实时上报给 `App`；`App` 更新对应 doc tab 的内存 `title`；localStorage 落盘时 vault tab 统一写通用标签「文档」，刷新后回 list 模式即回落。Sidebar 底部两个按钮对调渲染顺序，New session 加 brand 强调样式。

**Tech Stack:** React 19 + TypeScript + Vite + Tailwind v4 + Vitest。

## Global Constraints

- 纯前端，后端零改动（沿用 Vault REST 接口、session/fan-out 机制）。
- 用户可见文案中文；代码/注释英文。
- 不持久化文档 tab 浏览状态（openPath/cwd）——前序 spec 明确非目标。
- localStorage 键沿用 `zeromux:doc-tabs`，只存 `{id,title,kind}[]`。
- 不新造配色，复用现有 CSS 变量（`--accent-brand` 等）。
- 验证命令从 `frontend/` 运行：`npm test`（vitest run）、`npm run lint`、`npm run build`（含 `tsc -b`）。

---

### Task 1: docTabs 通用标签常量 + 标题派生 + 落盘去笔记名

**Files:**
- Modify: `frontend/src/lib/docTabs.ts`
- Test: `frontend/src/lib/__tests__/docTabs.test.ts`

**Interfaces:**
- Produces:
  - `DEFAULT_DOC_TITLE: string`（值 `'文档'`）
  - `docTitleFromPath(path: string): string` —— 取路径 basename 去掉结尾 `.md`（大小写不敏感）。
  - `saveDocTabs(tabs: DocTab[]): void` —— 行为变更：`kind === 'vault'` 的 tab 落盘 `title` 强制为 `DEFAULT_DOC_TITLE`（不写内存里的临时笔记名）。
  - `newDocTab(title: string)`、`isDocTabId`、`loadDocTabs`、`DocTab` 保持不变。

- [ ] **Step 1: 更新/新增失败测试**

在 `frontend/src/lib/__tests__/docTabs.test.ts`：

1) 替换现有 `save then load round-trips only id/title/kind` 用例（其断言依赖旧的直写 title 行为，契约已变）为：

```typescript
  it('saveDocTabs strips vault tab title down to the generic label on disk', () => {
    const tabs: DocTab[] = [{ id: 'doc-1', title: '我的笔记', kind: 'vault' }]
    saveDocTabs(tabs)
    expect(loadDocTabs()).toEqual([{ id: 'doc-1', title: '文档', kind: 'vault' }])
  })
```

2) 追加 `docTitleFromPath` 用例（在 `describe` 内新增）：

```typescript
  it('docTitleFromPath returns basename without a trailing .md', () => {
    expect(docTitleFromPath('a/b/My Note.md')).toBe('My Note')
    expect(docTitleFromPath('Top Level.md')).toBe('Top Level')
    expect(docTitleFromPath('folder/no-ext')).toBe('no-ext')
    expect(docTitleFromPath('folder/Weird.MD')).toBe('Weird')
  })

  it('DEFAULT_DOC_TITLE is 文档', () => {
    expect(DEFAULT_DOC_TITLE).toBe('文档')
  })
```

3) 更新顶部 import 以包含新符号：

```typescript
import { newDocTab, isDocTabId, loadDocTabs, saveDocTabs, docTitleFromPath, DEFAULT_DOC_TITLE, type DocTab } from '../docTabs'
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd frontend && npx vitest run src/lib/__tests__/docTabs.test.ts`
Expected: FAIL —— `docTitleFromPath` / `DEFAULT_DOC_TITLE` is not defined，且 round-trip 用例断言不符。

- [ ] **Step 3: 实现**

编辑 `frontend/src/lib/docTabs.ts`，在文件顶部（`DocTab` 类型下方）新增常量与派生函数，并改 `saveDocTabs`：

```typescript
export type DocTab = { id: string; title: string; kind: 'vault' }

const KEY = 'zeromux:doc-tabs'

// Generic label a doc tab shows when no note is open (list mode) and what we persist —
// live note names live only in memory, never on disk (refresh reopens in list mode).
export const DEFAULT_DOC_TITLE = '文档'

// Note title shown in the sidebar tab: basename without a trailing .md (case-insensitive).
export function docTitleFromPath(path: string): string {
  const base = path.split('/').pop() || path
  return base.replace(/\.md$/i, '')
}
```

将 `saveDocTabs` 改为：

```typescript
export function saveDocTabs(tabs: DocTab[]): void {
  localStorage.setItem(KEY, JSON.stringify(
    tabs.map(t => ({ id: t.id, title: t.kind === 'vault' ? DEFAULT_DOC_TITLE : t.title, kind: t.kind }))
  ))
}
```

（`uuid`、`newDocTab`、`isDocTabId`、`isValid`、`loadDocTabs` 保持原样不动。）

- [ ] **Step 4: 运行测试确认通过**

Run: `cd frontend && npx vitest run src/lib/__tests__/docTabs.test.ts`
Expected: PASS（全部用例绿）。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/docTabs.ts frontend/src/lib/__tests__/docTabs.test.ts
git commit -m "feat(doctab): generic 文档 label + docTitleFromPath, strip note name on save"
```

---

### Task 2: VaultReader 上报当前笔记标题

**Files:**
- Modify: `frontend/src/components/VaultReader.tsx`

**Interfaces:**
- Consumes: `docTitleFromPath` from `../lib/docTabs`（Task 1）。
- Produces: `VaultReader` 新增可选 prop `onTitleChange?: (title: string | null) => void`。打开笔记成功 → `onTitleChange(docTitleFromPath(path))`；回到 list 模式 → `onTitleChange(null)`。现有 `onClose?` prop 保留不变。

- [ ] **Step 1: 修改组件签名与 import**

编辑 `frontend/src/components/VaultReader.tsx`。

顶部 import 追加：

```typescript
import { docTitleFromPath } from '../lib/docTabs'
```

组件签名改为（`onClose` 之外加 `onTitleChange`）：

```typescript
export default function VaultReader({ onClose, onTitleChange }: { onClose?: () => void; onTitleChange?: (title: string | null) => void }) {
```

- [ ] **Step 2: 打开笔记成功时上报标题**

在 `openNote` 的成功回调里，`setMode('read')` 之后追加上报（保持其余不变）：

```typescript
  const openNote = useCallback((path: string) => {
    getVaultFile(path).then(r => {
      setContent(r.content); setTruncated(r.truncated); setOpenPath(path); setMode('read')
      pushRecentNote(path); setRecent(getRecentNotes())
      onTitleChange?.(docTitleFromPath(path))
    }).catch(() => {
      alert('无法打开笔记(可能已被删除或移动):' + path)
      removeRecentNote(path); setRecent(getRecentNotes())
    })
  }, [onTitleChange])
```

- [ ] **Step 3: 回到 list 模式时清空标题**

read 模式返回按钮（当前 `onClick={() => setMode('list')}`，约 `L57`）改为同时上报 `null`：

```tsx
          <button onClick={() => { setMode('list'); onTitleChange?.(null) }} className="p-1.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"><ChevronLeft size={18} /></button>
```

- [ ] **Step 4: 类型检查通过**

Run: `cd frontend && npx tsc -b`
Expected: 无错误（`onTitleChange` 全可选，现有 `<VaultReader />` 调用点仍合法）。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/VaultReader.tsx
git commit -m "feat(vault): report open-note title via onTitleChange callback"
```

---

### Task 3: App 连线 —— 用笔记标题更新 doc tab

**Files:**
- Modify: `frontend/src/App.tsx`

**Interfaces:**
- Consumes: `VaultReader` 的 `onTitleChange`（Task 2）、`DEFAULT_DOC_TITLE` from `./lib/docTabs`（Task 1）。
- Produces: 内部 `updateDocTabTitle(id: string, title: string | null): void`。

- [ ] **Step 1: import 补 DEFAULT_DOC_TITLE**

`App.tsx` 顶部现有 docTabs import（`L17`）改为：

```typescript
import { type DocTab, newDocTab, isDocTabId, loadDocTabs, saveDocTabs, DEFAULT_DOC_TITLE } from './lib/docTabs'
```

- [ ] **Step 2: 新建 tab 初始标题改「文档」**

`handleCreate`（`L200`）里 `newDocTab('Obsidian')` 改为：

```typescript
      const tab = newDocTab(DEFAULT_DOC_TITLE)
```

- [ ] **Step 3: 新增 updateDocTabTitle**

在 `handleDeleteDocTab`（`L218`）附近新增回调：

```typescript
  const updateDocTabTitle = useCallback((id: string, title: string | null) => {
    setDocTabs(prev => prev.map(t => t.id === id ? { ...t, title: title ?? DEFAULT_DOC_TITLE } : t))
  }, [])
```

- [ ] **Step 4: 渲染处传 onTitleChange**

主区域 docTabs 渲染（`L350`）`<VaultReader />` 改为：

```tsx
                <VaultReader onTitleChange={(title) => updateDocTabTitle(t.id, title)} />
```

- [ ] **Step 5: 类型检查 + 全量测试**

Run: `cd frontend && npx tsc -b && npm test`
Expected: PASS（tsc 无错误；vitest 全绿）。

- [ ] **Step 6: Commit**

```bash
git add frontend/src/App.tsx
git commit -m "feat(app): live doc-tab title from VaultReader onTitleChange"
```

---

### Task 4: Sidebar 底部 New session/Settings 对调 + New session 强调样式

**Files:**
- Modify: `frontend/src/components/Sidebar.tsx`

**Interfaces:**
- 无新导出。纯 JSX 顺序与 className 调整。

- [ ] **Step 1: 对调按钮 + 弹层顺序**

`Sidebar.tsx` 底部 `<div className="relative px-2 py-3 border-t border-[var(--border)]">`（`L451`）内，当前结构是：Settings 按钮 → `showSettings` 弹层 → `showPromptManager` 弹层 → New session 按钮 → `step` 弹层。

调整为 **New session 相关块在前、Settings 相关块在后**：把 New session 按钮（`L518-524`）及其 `step !== 'closed'` 弹层块整体**移到** Settings 按钮之前。移动后顺序为：

1. New session 按钮
2. `step !== 'closed'` 弹层
3. Settings 按钮
4. `showSettings` 弹层
5. `showPromptManager` 弹层

（`showPromptManager` 由 Settings 菜单触发，保持与 Settings 相邻。所有弹层仍为 `absolute bottom-full`，向上弹不受顺序影响。）

- [ ] **Step 2: New session 加 brand 强调样式**

New session 按钮 className 从当前次要样式改为 brand 强调（Settings 按钮 className 保持不变）：

```tsx
        <button
          onClick={openTypePicker}
          className="flex items-center gap-2 w-full px-3 py-2 text-sm font-medium text-[var(--accent-brand)] border border-[var(--accent-brand)]/40 hover:bg-[var(--accent-brand)]/10 rounded-lg transition-colors min-h-[40px]"
        >
          <Plus size={14} />
          <span>New session</span>
        </button>
```

- [ ] **Step 3: 类型检查 + lint + 构建**

Run: `cd frontend && npx tsc -b && npm run lint && npm run build`
Expected: tsc 无错误；lint 无**新增**错误（既存 flaky/既存告警不算回归）；build 成功产出 `frontend/dist/`。

- [ ] **Step 4: 手动冒烟（视觉验证）**

Run: `cd frontend && npm run dev`，浏览器打开：
- 底部区块 **New session 在上**（brand 描边/文字强调）、**Settings 在下**（灰色次要）。
- 点 New session → 类型菜单向上弹出，含「Obsidian 文档」（vault 启用时）。
- 点 Settings → 菜单向上弹出（主题/推送/prompt 管理/用户管理）。
- 两个弹层不重叠、点击外部关闭正常。
- 新建「Obsidian 文档」→ 左侧 tab 显示「文档」；打开一篇笔记 → tab 立即变为笔记名（去 `.md`）；点返回 → tab 回到「文档」。
- 刷新页面 → 文档 tab 仍在、标题为「文档」、VaultReader 回 list 模式。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/Sidebar.tsx
git commit -m "feat(sidebar): New session above Settings with brand emphasis"
```

---

## Self-Review

**1. Spec coverage:**
- 需求 1（对调 + primary 样式）→ Task 4 ✅
- 需求 2（文档 tab 实时标题）→ Task 1（helper/落盘去名/常量）+ Task 2（VaultReader 回调）+ Task 3（App 连线、初始「文档」）✅
- 非目标（不持久化浏览状态）→ Task 1 `saveDocTabs` 落盘去笔记名 + Task 2 回 list 上报 null 共同保证 ✅
- 验收「刷新回「文档」」→ Task 1 落盘 + 刷新回 list 模式（VaultReader 默认 `mode='list'`，App 从 localStorage 读回「文档」）✅

**2. Placeholder scan:** 无 TBD/TODO；每处代码步骤均给出完整代码。

**3. Type consistency:** `docTitleFromPath`/`DEFAULT_DOC_TITLE`/`onTitleChange`/`updateDocTabTitle` 在定义（Task 1/2）与消费（Task 2/3）处签名一致；`onTitleChange?: (title: string|null)=>void` 前后统一。
