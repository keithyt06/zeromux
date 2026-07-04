# New session/Settings 对调 + 文档 tab 显示笔记标题 — 设计

日期：2026-07-04
状态：已确认，待写实现计划

## 背景

紧接 `2026-07-04-settings-doctab-replay-scroll` 上线后的两处后续微调,来自实际使用:

1. **New session 与 Settings 位置反了** —— 底部区块当前 Settings 在上、New session 在下。New session 是最高频动作,应在上且更突出。
2. **文档伪会话在左侧永远显示「Obsidian」** —— 无论打开哪篇笔记,tab 标题不变,无法一眼分辨。希望显示当前笔记标题。

两处均纯前端,后端零改动。

## 需求 1:New session 与 Settings 位置对换

### 现状

`Sidebar.tsx` 底部 `border-t` 区块内,渲染顺序为:Settings 按钮(约 `L452`)在上,New session 按钮(约 `L518`)在下。两者 popover 都是 `absolute bottom-full` 向上弹出。

### 设计

- 对调两个按钮的渲染顺序:**New session 在上,Settings 在下**。各自的 popover(`showSettings` / `showPromptManager` / `step` 三个弹层)随所属按钮一起移动,弹层逻辑不变(仍向上弹)。
- New session 是主操作,对调后加 **primary 强调样式**:用 `--accent-brand` 系变量做描边/文字强调(参照现有 primary 按钮的既有用法,不新造配色),使其在底部醒目。
- Settings 保持当前次要灰色样式不变。

### 取舍

只调顺序与主按钮样式,不动弹层结构、不动菜单内容。

## 需求 2:文档 tab 显示当前笔记标题(实时,不持久化)

### 现状

- `App.tsx` 的 `handleCreate` 建 tab 时写死 `newDocTab('Obsidian')`。
- `VaultReader`(`App.tsx` 渲染处)不把"当前打开哪篇笔记"回传给 App,所以 tab `title` 永远是 "Obsidian"。

### 设计(Option A:实时标题,不持久化浏览状态)

- **VaultReader 回调**:新增可选 prop `onTitleChange?: (title: string | null) => void`。
  - `openNote(path)` 成功打开笔记时,回传该笔记 **basename 去掉 `.md`** 作为标题。
  - 回到 list 模式(`setMode('list')` / 返回列表)时,回传 `null`。
- **App 更新 tab 标题**:渲染处传 `onTitleChange={(title) => updateDocTabTitle(t.id, title)}`。`updateDocTabTitle(id, title)` 把对应 doc tab 的 `title` 设为笔记名;`title` 为 `null` 时回落到通用标签 **「文档」**。
- **初始标签**:`newDocTab` 的初始 title 从 `'Obsidian'` 改为 **「文档」**。
- **侧栏列表**:直接读 `t.title`,渲染结构不变(仍 `BookOpen` 图标)。
- **不持久化浏览状态**(遵守前序 spec 的非目标):刷新后 VaultReader 回默认 list 模式 → `onTitleChange(null)` → 标题回到「文档」。
  - **落盘去笔记名**:`saveDocTabs` 对 vault tab 落盘时统一写通用标签「文档」,**不**把内存里的临时笔记名写进 localStorage。避免"刷新前磁盘存了旧笔记名、刷新后回 list 模式却显示旧名"的不一致。内存态可以是笔记名(供当前会话实时显示),磁盘只存「文档」。

### 取舍

- 不持久化 `openPath`、不刷新后重开笔记 —— 这是前序 spec 明确的非目标,本次沿用。
- 多个文档 tab 打开同名笔记(或都在 list 模式显示「文档」)时列表重名,不处理(YAGNI)。

## 影响范围

纯前端:
- `frontend/src/components/Sidebar.tsx` —— New session/Settings 对调 + New session primary 样式。
- `frontend/src/App.tsx` —— `updateDocTabTitle`、渲染处传 `onTitleChange`。
- `frontend/src/components/VaultReader.tsx` —— 新增 `onTitleChange` prop,openNote/回 list 时回调。
- `frontend/src/lib/docTabs.ts` —— 初始 title 改「文档」;`saveDocTabs` 对 vault tab 落盘统一写「文档」。

后端:无改动。

## 验收标准

- 底部区块 New session 在上(primary 强调)、Settings 在下(次要);两个 popover 各自向上弹、互不干扰。
- 新建文档 tab 初始显示「文档」;打开某篇笔记后侧栏 tab 立即显示该笔记名(去 `.md`);返回列表后回到「文档」。
- 刷新页面后:文档 tab 仍在,标题为「文档」(不残留旧笔记名),VaultReader 回 list 模式。
- 单测:`docTabs.ts` 的 `saveDocTabs` 对带笔记名的 vault tab 落盘后读回为「文档」;`newDocTab` 初始 title 为「文档」。

## 非目标

- 文档 tab 浏览状态(openPath/cwd)持久化。
- 多 tab 同名笔记去重。
- New session/Settings 弹层内容或结构的其他改动。
