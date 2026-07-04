# Settings 聚合 + Obsidian 文档伪会话 + 重放落底 — 设计

日期：2026-07-04
状态：已确认，待写实现计划

## 背景与动机

三个独立的 UI 交互改进，来自实际使用痛点：

1. **左上角 header 太拥挤** —— 主题切换、推送设置、PE 提示词管理等配置项散落在侧边栏顶部 header，按钮过多。希望收进一个统一的 Settings 入口。
2. **Obsidian 文档阅读器是全屏 modal，查资料必须关掉才能回到会话** —— 用户希望 md 文档和代码 CLI 会话（Claude Code 等）之间能无缝来回切换，不丢状态、不用关页面。
3. **会话（重）连接后从头加载，要手动翻到底** —— 每次打开会话希望自动停在最后一句执行内容，而不是停在顶部。

三个需求彼此独立，但都集中在前端 `frontend/src/`，一并设计、可分任务实现。

## 需求 1：左下角 Settings 聚合入口

### 现状

侧边栏顶部 header（`Sidebar.tsx` 头像那一行）挤了：推送(`Bell`)、Vault(`BookOpen`)、定时任务(`Clock`+红点)、Admin(`Users`)、主题(`Sun/Moon`)、登出(`LogOut`)、折叠(`PanelLeftClose`)。PE 提示词管理(`PromptManager`)目前**没有顶层入口**，只藏在「New session → 初始 prompt → ✎ 管理」和聊天输入框的弹层里。

### 设计

在侧边栏**底部**、「New session」按钮**上方**新增一个「⚙ Settings」按钮（lucide `Settings` 图标）。点击弹出一个 popover，复用现有 New session 那套 `absolute bottom-full` 向上弹出的样式（同一视觉语言），**不是**全屏 modal。

Settings 面板内容（菜单列表）：

- 🎨 **主题** —— 一行即时 toggle（浅色/深色），点击立即切，复用现有 `onToggleTheme`。
- 🔔 **推送通知** —— 点开 `PushSettings`（现有组件，保持它自己的 modal 呈现）。
- ✎ **PE 提示词管理** —— 点开 `PromptManager`（现有组件，包一层弹层呈现，参照聊天里那套用法）。
- 👤 **用户管理** —— 仅 `isAdmin` 显示，点开 `AdminPanel`（现有 modal）。

### Header 清理

从顶部 header **移除**这三个按钮：主题(`Sun/Moon`)、推送(`Bell`)、Admin(`Users`)——它们的功能搬进 Settings 面板。同时**删除** header 的 Vault(`BookOpen`)按钮（见需求 2：打开 Obsidian 统一走 New session）。

清理后 header 只剩：头像/名字、⏰ 定时任务（带红点 badge，保留在外——它是带实时提醒的功能面板而非配置项）、登出、折叠。

### 取舍

- 定时任务**不**进 Settings：它带实时待确认红点 badge，是功能面板不是设置项，留在外面才能持续提醒。
- Settings 用 popover 而非全屏 modal：配置项轻量，popover 与现有交互一致，且不遮挡会话。

## 需求 2：Obsidian 文档作为纯前端伪会话

### 现状

`VaultReader` 以全屏 modal 呈现（`absolute inset-0 z-50` + 右上角关闭按钮），从 header 的 `BookOpen` 打开，必须 `onClose` 才能回到会话。而**会话视图**（终端/Claude/Kiro/Codex/文件/git）已经是常驻挂载 + CSS 显隐切换，天然无缝。

后端事实：终端/Claude/Kiro/Codex 会话在后端都有真实进程（PTY 或 agent 进程）撑着，进 `SessionType` 枚举、走 fan-out 机制。而 Vault 阅读器是**纯前端**的，只调 `/api/vault/*` 这些 REST 接口，不需要后端起任何进程、不写 session 表。

### 设计

把 Obsidian 文档做成**纯前端伪会话**：出现在左侧列表、能无缝切换、保留浏览状态，但不占后端进程、不进后端 session 表。

**状态**：App 层新增独立的 `docTabs` 状态数组（元素形如 `{ id, title }`），不污染现有的 `sessions: SessionInfo[]`（那些全是后端真会话）。左侧列表渲染时把真会话和文档 tab 拼在一起，靠图标区分。

**新建入口**：Sidebar 的 New session 类型菜单里，在 Terminal/Claude/Kiro/Codex 之后加一项「📓 Obsidian 文档」，**仅当 `vaultEnabled` 为真时显示**（复用现有 `getVaultMeta` gate）。选它 → 跳过选目录/prompt 流程，直接回调 App 新建一个 doc tab（push 进 `docTabs`），`setActiveId` 指向它。

**渲染**：App 主区域渲染循环中，除 `sessions.map` 外再 `docTabs.map` 渲染 `<VaultReader>`，同样用 `absolute inset-0` + `isActive ? '' : 'hidden'` 常驻挂载、CSS 显隐 —— 与 Claude 会话来回切**不丢浏览状态、不用关页面**。

**VaultReader 改造**：从「全屏 modal + onClose」改为「内嵌面板」——去掉 `absolute inset-0 z-50` 和右上角关闭按钮（关闭 = 删这个 tab，走列表的 × 删除，与真会话一致）。其余（list/read 模式、搜索、wikilink、最近打开、图片解析）原样复用。read 模式内部的 `absolute inset-0`（相对内嵌容器）可保留用于 list↔read 切换的层叠。

**列表区分（图标，方案 A）**：文档 tab 在列表用 `BookOpen` 图标；代码 CLI 会话保持各自 Claude/Kiro/Codex/终端图标。`TurnDot`、last-activity 时间、未读红点等只对真会话有意义的元素对文档 tab **不渲染**。

**刷新行为**：doc tabs 是纯前端态，页面刷新会丢失（回到只剩真会话）。可接受——重开一秒钟的事，不值得为它建后端持久化。

### 取舍

不把 Vault 塞进后端 `SessionType` 枚举和 fan-out 机制：它没有进程、语义完全不同，硬塞要在大量 agent-only 逻辑里到处加 `if type==vault` 特判，得不偿失。纯前端伪会话是最贴合的抽象。

## 需求 3：重放结束后稳定滚到最后一句

### 根因

- **终端**（`TerminalView.tsx`）：`onopen` 里 `reset()` 后逐帧 `write` 重放 scrollback。xterm `write` 异步，重放大缓冲时视图不保证停在底部，且重放完那一刻没有显式"滚到底"。
- **Agent 聊天**（`AcpChatView.tsx`）：每条事件 append 都调 `scrollBottom()`（`requestAnimationFrame` 单次滚动）；重放几百条历史事件时前面的 rAF 被后面覆盖/打断，且 Markdown/mermaid/KaTeX 异步渲染在滚动**之后**才改变高度，最终停在中间。

### 设计

**终端**：包一个 `scrollToBottom()`，在 `onmessage` 收到 output 且 `write` 的 callback 触发后调用，用小 debounce 合并连续帧，保证"这一阵重放写完就落底"。（xterm `write(data, cb)` 的 cb 在该块解析进缓冲后触发。）

**Agent 聊天**：区分"重放阶段"与"实时阶段"。后端 ACP 重放结束发 `replay_done` marker（代码已有）。改为：重放期间不必每条 rAF 滚动，在收到 `replay_done` 时做一次**稳定落底**——直接 `scrollRef.scrollTop = scrollRef.scrollHeight` 置底（非动画）；为扛异步渲染（Markdown 高度后变），在 `replay_done` 后的一小段时间内补落底（rAF 连补 2 次，或用 ResizeObserver 观察内容容器高度变化时跟随落底）。实时新消息仍走原有每条 `scrollBottom()`。

**落底策略（方案 A）**：重放结束**一律**落底，不判断用户是否在重放期间手动上滚。正是"每次打开自动加载到最后一句"的直接实现，避免过度设计。

### 验收标准

连接/重连后，一旦重放完成，两种视图都稳定停在最后一句（最新内容可见），无需手动翻。为 agent 聊天的 `replay_done → 落底` 逻辑写单测；终端 xterm 落底难做纯单测，靠手动冒烟验证。

## 影响范围

纯前端，主要文件：
- `frontend/src/App.tsx` —— `docTabs` 状态、主区域渲染文档 tab、新建/删除文档 tab 的回调。
- `frontend/src/components/Sidebar.tsx` —— Settings 按钮与面板、header 清理、New session 加「Obsidian 文档」项、列表渲染文档 tab（图标区分）。
- `frontend/src/components/VaultReader.tsx` —— 从全屏 modal 改为内嵌面板。
- `frontend/src/components/TerminalView.tsx` —— 重放后 debounce 落底。
- `frontend/src/components/AcpChatView.tsx` —— `replay_done` 稳定落底。

后端：无改动（Vault REST 接口、session 机制、fan-out 全部沿用）。

## 非目标

- 文档 tab 的后端持久化（刷新即丢，有意为之）。
- 把 Vault 纳入后端 `SessionType`。
- 重放落底的"尊重用户手动上滚"智能判断。
- 定时任务收进 Settings。
