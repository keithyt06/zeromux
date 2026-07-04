# Settings 聚合 + Obsidian 文档伪会话 + 重放落底 — 设计

日期：2026-07-04
状态：已确认 + 经 Fable 5 双评审（CTO/PM 独立）修订，待写实现计划

## 评审修订摘要（2026-07-04，Fable 5 扮演 CTO + PM 独立评审 + websearch）

三处**独立收敛**的修正已并入下方对应章节：

1. **需求 3「一律落底」收窄为「重放期间用户未上滚才落底」**（CTO+PM 撞车）：主动打开和被动重连（手机切后台回来 / WS idle 重连 / PWA 恢复）走同一条 `onopen→重放` 路径无法区分，一律落底会在用户翻历史时被强制拽走。用一个 boolean flag（记录重放期间是否发生过向上滚动），**非**"距底 N 像素"启发式。业界聊天 UI 的 `isAtBottom` 追踪也是同一思路。
2. **docTabs 改为 localStorage 持久化**（CTO+PM 撞车）：iOS 杀后台是本产品主战场，"刷新即丢 + 与真会话同列同 × 删除"叠加会造成"我明明开着怎么没了"的困惑。只存 `{id,title,kind}[]`，约 10 行（`recent notes` 已有同款先例），不存浏览状态。
3. **需求 3 终端侧必须加"仅重放期"闸门**（CTO 独有）：终端没有 `replay_done` marker，落底逻辑若不限定重放窗口会作用于所有实时输出 → 用户上翻 scrollback 时被持续拽底（真回归）。

另采纳：CTO 指出的 4 个实现坑（见需求 2「实现约束」）；PM 的"以小博大"折中——数据结构现在就带 `kind` 字段为未来 `viewTabs` 泛化留口，但本次只实现 vault（避免过度设计）。

**未采纳**：CTO 备选的"后端终端也发 replay marker"——本次承诺纯前端零后端改动，加后端 marker 扩大爆炸半径；改用纯前端闸门（`onopen` 武装、首帧 debounce 落底后解除）。

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

**状态**：App 层新增独立的 `docTabs` 状态数组，元素形如 `{ id, title, kind: 'vault' }`——`kind` 字段现在就留着，为未来把 GitViewer/文件浏览/运行记录等"无进程查看面板"泛化成统一 `viewTabs` 抽象留口（本次**只**实现 `'vault'`，不做泛化，避免过度设计）。不污染现有的 `sessions: SessionInfo[]`（那些全是后端真会话）。左侧列表渲染时把真会话和文档 tab 拼在一起，靠图标区分。

**id 命名**：doc tab id 必须加前缀（如 `doc-<uuid>`）与后端 UUID 会话 id 隔离，防止两个 id 域混淆导致误路由或误删。

**持久化（localStorage）**：`docTabs` 存入 localStorage（键如 `zeromux:doc-tabs`），启动时读回重建。只持久化 `{ id, title, kind }[]`——**不**存浏览状态（cwd/openPath），重开后 VaultReader 回到默认 list 模式即可。理由：iOS 杀后台页面是本产品（手机 PWA）常态，纯内存态会让"我明明开着的 tab 怎么没了"的困惑必然发生；而存浏览状态才是过度设计。`recent notes` 已有同款 localStorage 先例可参照。

**新建入口**：Sidebar 的 New session 类型菜单里，在 Terminal/Claude/Kiro/Codex 之后加一项「📓 Obsidian 文档」，**仅当 `vaultEnabled` 为真时显示**（复用现有 `getVaultMeta` gate）。选它 → 跳过选目录/prompt 流程，直接回调 App 新建一个 doc tab（push 进 `docTabs`），`setActiveId` 指向它。

**渲染**：App 主区域渲染循环中，除 `sessions.map` 外再 `docTabs.map` 渲染 `<VaultReader>`，同样用 `absolute inset-0` + `isActive ? '' : 'hidden'` 常驻挂载、CSS 显隐 —— 与 Claude 会话来回切**不丢浏览状态、不用关页面**。

**VaultReader 改造**：从「全屏 modal + onClose」改为「内嵌面板」——去掉 `absolute inset-0 z-50` 和右上角关闭按钮（关闭 = 删这个 tab，走列表的 × 删除，与真会话一致）。其余（list/read 模式、搜索、wikilink、最近打开、图片解析）原样复用。read 模式内部的 `absolute inset-0`（相对内嵌容器）可保留用于 list↔read 切换的层叠。

**列表区分（图标，方案 A）**：文档 tab 在列表用 `BookOpen` 图标；代码 CLI 会话保持各自 Claude/Kiro/Codex/终端图标。`TurnDot`、last-activity 时间、未读红点等只对真会话有意义的元素对文档 tab **不渲染**。

**刷新行为**：doc tabs 是纯前端态但经 localStorage 持久化，刷新后**还原**（只还原 tab 列表，回到默认 list 模式，不还原浏览路径）。

### 实现约束（评审踩坑清单，务必进实现计划）

1. **`loadSessions` 的 activeId 兜底**（`App.tsx:66`）：现在只在 `sessions` 里找 prev，若 prev 是 doc tab 会被判"失效"跳回 `list[0]`。兜底判断必须把 `docTabs` 也纳入"prev 是否仍有效"的检查。
2. **`handleDelete`**（`App.tsx:207`）：删最后一个真会话时 `next[0]` 只看 sessions，忽略 docTabs → activeId 被置 null 而丢掉仍存在的文档 tab。删除后的 activeId 兜底要同时考虑两个数组。
3. **删除路径隔离**：删 doc tab **不得**调 `deleteSession`（后端会 404 或误删）；走独立的 `docTabs` 移除逻辑。列表 × 按钮按 id 前缀分派到对应删除函数。
4. **挂载点迁移**：`VaultReader` 现挂在 `Sidebar.tsx:386`（作为 Sidebar 内的 modal），迁到 App 主区域是**移动挂载点**，不只是改样式——原 Sidebar 里的 `showVault` state、`BookOpen` 触发按钮、`<VaultReader onClose>` 都要一并移除。

### 取舍

不把 Vault 塞进后端 `SessionType` 枚举和 fan-out 机制：它没有进程、语义完全不同，硬塞要在大量 agent-only 逻辑里到处加 `if type==vault` 特判，得不偿失。纯前端伪会话是最贴合的抽象。

不为本次做 `viewTabs` 全量泛化（GitViewer/文件浏览/运行记录）：它们当前是 per-session 语义、与 vault 的全局单例语义不同，一并抽象是为多个未定型消费者建框架。只保留 `kind` 字段这一零成本的扩展口。

## 需求 3：重放结束后稳定滚到最后一句

### 根因

- **终端**（`TerminalView.tsx`）：`onopen` 里 `reset()` 后逐帧 `write` 重放 scrollback。xterm `write` 异步，重放大缓冲时视图不保证停在底部，且重放完那一刻没有显式"滚到底"。
- **Agent 聊天**（`AcpChatView.tsx`）：每条事件 append 都调 `scrollBottom()`（`requestAnimationFrame` 单次滚动）；重放几百条历史事件时前面的 rAF 被后面覆盖/打断，且 Markdown/mermaid/KaTeX 异步渲染在滚动**之后**才改变高度，最终停在中间。

### 设计

两视图共用一个前提：**落底只发生在重放窗口内，且仅当用户在该窗口内未主动向上滚动**。这既修"停在顶部"，又不在被动重连（手机切后台回来 / WS idle 重连 / PWA 恢复）时把正在翻历史的用户拽走。

**「用户已上滚」判据**：用一个 boolean flag（重放窗口内监听到 wheel/touchmove 向上、或滚动位置离底超过一屏即置真），**不用**"距底 N 像素"这类启发式阈值——评审明确要求保持为简单 flag。首连/新开时 flag 为假 → 必落底。

**终端**（`TerminalView.tsx`，关键风险点）：终端**没有** `replay_done` marker，所以必须自建"仅重放期"闸门，否则落底会作用于所有实时输出、用户上翻 scrollback 时被持续拽底（真回归，xterm 现状是上翻时 write 不动视口，正确）。方案：
- `onopen` 后**武装**重放窗口（`replaying = true`），并清除上滚 flag。
- `onmessage` 写入用 `term.write(data, cb)`，cb 里 debounce 调 `scrollToBottom()`；仅当 `replaying && !userScrolledUp` 时才真正落底。
- **解除武装**：首帧 debounce 落底触发后（重放突发结束）即 `replaying = false`；同时用户任何主动滚动/输入也解除。此后实时输出不再自动落底，恢复 xterm 原生行为。
- 纯前端闸门，不加后端 marker（保持本次零后端改动的边界）。

**Agent 聊天**（`AcpChatView.tsx`）：后端 ACP 重放结束发 `replay_done` marker（代码已有，`handleEvent` 已处理）。改为：
- 重放期间**不**每条 rAF 滚动（去掉逐条 `scrollBottom` 在重放阶段的作用；实时新消息仍走原 `scrollBottom`）。
- 收到 `replay_done` 时，若 `!userScrolledUp`，做**稳定落底**：`scrollRef.scrollTop = scrollRef.scrollHeight`（非动画）。
- 为扛异步渲染（Markdown/mermaid/KaTeX/图片高度后变，业界公认的落底失败主因），用 **ResizeObserver** 观察内容容器：`replay_done` 后一小段时间内容器高度增长就跟随落底。ResizeObserver **必须解除**（用户 wheel/touch 主动滚动，或 ~2s 超时），否则后加载的图片会永久钉底。选 ResizeObserver 而非 rAF×2：mermaid/KaTeX 渲染常在数百 ms 后才改高，rAF×2 会漏。

### 验收标准

- 首连/新开会话：重放完成后稳定停在最后一句（最新内容可见），无需手动翻。
- 被动重连时用户正在翻历史：不被拽到底（上滚 flag 生效）。
- 终端实时输出阶段用户上翻 scrollback：不被落底逻辑干扰（重放窗口已解除）。
- 为 agent 聊天写单测：`replay_done → 落底`、`replay_done + 已上滚 → 不落底`；ResizeObserver 解除逻辑。终端 xterm 落底难做纯单测，靠手动冒烟（含"上翻时来实时输出不被拽底"这条回归）。

## 影响范围

纯前端，主要文件：
- `frontend/src/App.tsx` —— `docTabs` 状态、主区域渲染文档 tab、新建/删除文档 tab 的回调。
- `frontend/src/components/Sidebar.tsx` —— Settings 按钮与面板、header 清理、New session 加「Obsidian 文档」项、列表渲染文档 tab（图标区分）。
- `frontend/src/components/VaultReader.tsx` —— 从全屏 modal 改为内嵌面板。
- `frontend/src/components/TerminalView.tsx` —— 重放后 debounce 落底。
- `frontend/src/components/AcpChatView.tsx` —— `replay_done` 稳定落底。

后端：无改动（Vault REST 接口、session 机制、fan-out 全部沿用）。

## 非目标

- 文档 tab 的**后端**持久化（用前端 localStorage，不建后端表）。
- 文档 tab 浏览状态（cwd/openPath）的持久化——只还原 tab 列表。
- 把 Vault 纳入后端 `SessionType`。
- `viewTabs` 全量泛化（GitViewer/文件浏览/运行记录），本次只留 `kind` 扩展口。
- 重放落底的后端 marker（终端用纯前端重放窗口闸门替代）。
- 定时任务收进 Settings。

> 注：早先"重放一律落底、不看用户上滚"和"docTabs 刷新即丢"两个取舍已被 CTO/PM 双评审推翻，见开头「评审修订摘要」——现分别改为"上滚 flag 守卫"和"localStorage 还原"。
