# S3+S4 会话内体验(Focus 区)—— 设计

日期:2026-09-27
状态:v2(2026-09-27 CTO + PM + 高级 UI/UX 三方交叉评审后修订,见 §0.3;**§0.3 与正文冲突时以 §0.3 为准**,plan 阶段按 §0.3 落实)
基线:`main` @ `3601fb4`(P0 止血已上线)
上游:
- 总体设计 `docs/superpowers/specs/2026-09-26-frontend-triage-focus-redesign-design.md`(下称「总 spec」)—— 本文取代其 §5(S3)与 §6(S4)纲要。
- 前端审计 `docs/superpowers/audits/2026-09-26-frontend-ux-audit.md`(§/I-/B- 编号均指它)。

**依赖顺序**:本 spec 的实施**必须**在 S1(token + primitives + 数据层)与 S2(AppShell + zustand store)之后。本文引用的 `<Sheet>`、`<Popover>`、`<Menu>`、`<SegmentedControl>`、`confirm()`、`toast`、`lib/format.ts`、`useAsyncResource`、`useLatestRequest`、`usePolling`、`useIsNarrow/useIsTouch`、zustand store 均由 S1/S2 产出(总 spec §3.3–3.4、§4.7)。

---

## 0. 决策记录

### 0.1 用户确认的选择

| # | 问题 | 选择 |
|---|---|---|
| Q1 | 每个 turn 默认呈现 | **D 按状态自适应**:运行中 = 步骤时间线;完成后自动收成「结论 + 改动」摘要卡 |
| Q2 | 摘要卡「改动」精度 | **C 混合**:卡片显示从 tool 调用推断的文件名(零成本、实时、无行数);点开 Context 面板按需跑 git diff 看精确全貌 |
| Q3 | Context 面板桌面形态 | **C 随会话类型**:agent 会话默认常驻右栏,终端会话默认收起;每会话记住选择 |
| Q4 | 终端「发给 agent」 | **C 两者都要**:选中文本 → 菜单「发给 〈同目录最近 agent〉/ 其他 agent 会话 / 新开…」 |
| — | S3 与 S4 合并 | 一份 spec,**两份 plan 分期上线**:Plan A = 共享层 + agent 对话;Plan B = 终端 |

### 0.2 主会话按判断补全的决定(可在审阅时推翻)

| 决定 | 理由 |
|---|---|
| tool_use/result **按顺序配对**,不改后端协议 | 已核实:三 backend 均无 `tool_use_id`;Claude 的 tool_result 在后端被丢弃(`process.rs:644` 测试锁定);Codex/Crew 有 result 但只带 `name`,且 Codex shell/apply_patch 串行 |
| Claude 步骤耗时 = 到下一事件的间隔 | Claude 无 result 块;事件到达时间是唯一信号,前端本地打点(不持久化,重放后无耗时,显示「—」) |
| 移除全局 `density` 概念 | 被「每 turn 自己的展开态」取代;`lib/density.ts` 的 thinking 折叠语义并入时间线规则 |
| Context 面板 5 个 tab:改动 / 文件 / 历史 / 事件 / 记忆;运行记录(metrics)进「事件」tab | 现 SessionInfoBar 顶栏 ≤5 图标是手机宽度硬上限(`App.tsx:423-425`);收编后顶栏只剩 1 个「面板」开关 |
| Context 面板**按会话常驻挂载 + hidden** | 修复现 overlay 条件挂载关掉即丢状态(审计 §1.1);与 I-1 同构 |
| WebGL 预算 4(active + 最近 3) | 浏览器上限 ~16(未验证);4 足够覆盖「来回切两三个终端」,其余 DOM 渲染 |
| 队列模式 chip 放 composer 左侧 | 高频且影响发送语义,必须在发送键视野内(审计 §3.3 痛点) |

### 0.3 v2 修订(三方交叉评审;优先于正文)

| # | 修订 | 来源 | 影响正文 |
|---|---|---|---|
| V1 | **ContextPanel 从 5 tab 收为 3 tab**:**Git**(内部 SegmentedControl「改动 / 历史」)、**文件**、**运行**(RunMetrics 列表;AgentDashboard 事件列表并入其下半段,若实施时证明无独立价值则删)。**记忆 tab 删除**,统一走 composer 的 ⌘ 记忆弹层(内含完整列表 + 编辑,取代 MemoryPanel 全屏) | PM | §2.2 表格、§2.3 记忆、§0.2 第 4 行 |
| V2 | **删**:`⌘1…5`、`Esc Esc` 中断、`⌘⇧Enter`、右栏拖宽、1024–1279px 覆盖形态、每会话记忆面板状态(`zmx_ctx:<sid>`)、自定义键编辑器 | PM | §2.2、§2.3、§4.2、§4.3 |
| V3 | **ContextPanel 形态简化**:≥ 1280px 右栏 **固定 360px**;< 1280px 一律 `Sheet side="bottom"`(两档)。默认展开态**只按会话类型**(agent 展开 / tmux 收起),用户切换仅在当前页面生命周期内记住(不持久化) | PM | §2.2 形态表 |
| V4 | **键栏**:收起/展开保留(全局记忆);**不做自定义键编辑器**,改为第二页硬编码补 `^R`、`^L`、`Home`、`End` | PM | §4.2 |
| V5 | **手机「终端报错发给 agent」一击**:HistoryView 底部「发给…」在**无选区时**直接取尾部 200 行(现有语义),默认目标 ★ 直接发送,菜单只在长按时出现;目标 ≤ 2 击 | PM | §4.3、§5.2 |
| V6 | **SendToMenu 是「发给 agent」唯一实现**:⚡ 问 agent(笔记)、HistoryView「发给 agent」、Git「让 agent 处理」、终端选中文本 全部调用它;`App.tsx:454` `onAskAgent` 删除 | PM | §2.4(已是此意,明确「⚡」也收编) |
| V7 | **预设只有一个入口**:composer 行首 `/`;⌘K 新建模式的 prompt 框复用同一补全组件;删除 composer ListPlus 按钮、Sidebar Settings 的 PromptManager 入口;管理只在 `/` 列表底部「管理…」 | PM | §2.3 |
| V8 | **队列模式 chip 一击切换**(Collect ⇄ Interrupt,不开菜单);chip 放输入框内左下角;📎 与 ⌘ 收进输入框内「＋」;发送键 36px | PM + UI/UX | §2.3 |
| V9 | **状态表达统一为 StatusDot(+ 可选文字)**:摘要卡出错**不用左边框**,改为 `--danger` 4% 底色 + 结论区错误文字;Interrupt 模式发送键不变色,改为 chip 高亮 + 发送键旁 `text-ui-2xs` 「将打断」 | UI/UX | §3.4、§2.3 |
| V10 | **成本/耗时格式统一走 `lib/format.ts`**:列表/顶栏 `$0.42`,摘要卡与运行 tab 详情 `$0.4213`;耗时 `3m12s` / `12s` / `0.4s`,`tabular-nums` | UI/UX | §3.4、§2.1 |
| V11 | **TurnTimeline 步骤图标**用 StatusDot 同源 12px 图标(✓/⟳/┊ 字符弃用);耗时右对齐 `.num`;thinking `--fg-subtle` 斜体 | UI/UX | §3.3 |
| V12 | **SummaryCard 布局**:结论下方**一行**合并「改动文件 chip(可点)· N 步 · 耗时 · $」,「过程 ▾」右对齐 | UI/UX | §3.4 |
| V13 | **WebGL 预算推迟**:B3 仅保留「隐藏终端 status 拉取收敛」;WebGL LRU 等出现 context lost 报告再做(保留 §4.5 作为备选设计) | PM + CTO(未验证闪烁风险) | §4.5、§6 B3 |
| V14 | **S2 v2 已取消手机底部 Tab**(总 spec §0.4 R20):Focus 区手机布局为 顶栏(‹ 分诊 (N) · 会话名 · ⋯)+ 内容 + composer/键栏;FAB ⏭ 位于 composer 上方右侧 | PM | §2.1、§5.2 可视高度目标因此 ≥ 82% 可达 |
| V15 | **会话动作走 `lib/sessionActions.ts` 注册表**(总 spec R23);FocusHeader `⋯` 不再单独实现重命名/关闭/复制;**删除手动 Blocked/Done 状态**(与 attention 双系统,总 spec R24) | PM | §2.1 |
| V16 | **所有 emoji 图标换 lucide**(📜 → `History`、⧉ → `Copy`、🖱 → `Mouse`、👍👎 → `ThumbsUp/Down`) | UI/UX | §4.2 |
| V17 | **与总 spec 的重复消除**:「终端 status 轮询只在 active」只由本 spec §4.6 负责(总 spec §3.4 已移除);「GitViewer loadLog stale 守卫 / B5 / B6」只由本 spec §2.2 负责 | CTO | — |

---

## 1. 范围与结构

```
Focus 区(S2 AppShell 主区)
├── 共享层(Plan A)
│   ├── FocusHeader        顶栏:会话名 · 状态 · 耗时 · $ · [面板] · ⋯
│   ├── ContextPanel       右栏(桌面)/ 底部 Sheet(手机),5 tab
│   ├── FocusComposer      统一输入区(agent/终端两种模式)
│   └── SendToMenu         「发给…」目标选择(终端选中文本、Git「让 agent 处理」共用)
├── Agent 对话(Plan A)
│   ├── useAcpSocket       从 AcpChatView 整体搬迁的 WS 生命周期(不改逻辑)
│   ├── TurnTimeline       运行中 turn:步骤时间线
│   ├── TurnSummaryCard    完成 turn:结论 + 推断改动 + 统计
│   ├── StepRow            单步(tool 配对卡 / thinking / 正文)
│   └── lib/steps.ts       纯函数:blocks → steps(配对、耗时、改动推断)
└── 终端(Plan B)
    ├── useTerminalSocket  从 TerminalView 整体搬迁(不改逻辑)
    ├── TerminalKeyTray    可收起键栏 + 自定义键
    ├── 选中 → SendToMenu
    └── WebGL 预算器
```

**非目标**:多会话分屏;卡片内回复;全局事件 WS;后端 tool_use_id 协议改造;LLM 生成的 turn 摘要(结论首段直接取正文,不做二次总结)。

---

## 2. 共享层

### 2.1 FocusHeader

```
桌面: ← api-refactor  ● 运行中 2m14s  $0.42          [▤ 面板]  ⋯
手机: ‹ api-refactor  ● 运行中 2m                         [▤]  ⋯
```

- 状态点、耗时、成本复用 S2 的分诊数据(`triage()` 结果 + `turn_started_ms` + `lifetime_cost_usd`),**不在 Focus 区另算**。
- `⋯` 菜单(`<Menu>`):重命名、复制 peer 名(Claude)、复制 attach 命令(tmux)、状态(Blocked/Done,原 SessionInfoBar 展开区)、关闭会话(撤销 toast,I-18)。
- 终端会话的路径 / 分支 / dirty 数显示在 `⋯` 菜单首行(P0 已从手机底部移除状态栏;桌面底部状态栏同步移除)。
- 取代 `SessionInfoBar.tsx` 全部职责;队列模式下拉移到 composer(§2.3)。

### 2.2 ContextPanel

**形态**:

| 视口 | agent 会话默认 | 终端会话默认 | 呈现 |
|---|---|---|---|
| ≥ 1280px | 展开 | 收起 | 右栏,默认 360px,可拖 280–560px,宽度全局记忆 |
| 1024–1279px | 收起 | 收起 | 展开时覆盖在主区右侧(不挤压主区),点外或 Esc 收起 |
| < 1024px(含手机) | 收起 | 收起 | 底部 `<Sheet side="bottom">`,两档停靠:半屏 / 全屏,下拉关闭 |

- 每会话记住展开/收起与当前 tab(zustand store,持久化到 localStorage `zmx_ctx:<sid>`,会话删除时 GC)。
- 快捷键:`⌘.` 切换面板;`⌘1…5` 切 tab(面板展开时)。
- **终端会话展开右栏会改变 cols**:展开/收起后 50ms `handleResize`(沿用 I-12 的 active + 非 0×0 + `shouldSendResize` 去重)。

**挂载(I-1 同构)**:每个会话一个 ContextPanel 实例,**常驻挂载、hidden 切换**;tab 内容按首次激活懒挂载后常驻。关闭面板不卸载 → GitViewer 选中的 commit、FileBrowser 的 cwd 均保留(修复审计 §1.1「overlay 条件挂载关掉即丢状态」)。

**5 个 tab**:

| tab | 内容 | 来源组件 | 本期改动 |
|---|---|---|---|
| 改动 | 工作区 diff(按文件过滤)+「让 agent 提交 / 撤销」 | `GitViewer` WorktreePanel | 选中文件**过滤 diff**(修 B6);慢 status 不覆盖用户已选 tab(修 B5);窄屏单栏(文件列表 → diff 两级导航) |
| 文件 | 文件浏览 / 预览 / 上传 | `FileBrowser` | 手机单栏;hover-only 按钮改 `<Menu>`(审计 §2.6) |
| 历史 | git log + graph + commit diff | `GitViewer` 历史 tab | `loadLog` 加 stale 守卫(B5);窄屏两级导航;graph 仅 ≥ md 显示 |
| 事件 | 运行记录(RunMetrics)+ 事件列表 | `RunMetricsPanel` + `AgentDashboard` | 合并为一个 tab 两段;删除 hover-only 删除钮 |
| 记忆 | Crew 全局记忆 | `MemoryPanel` | 仅 crew 会话显示此 tab |

- 终端会话:显示 改动 / 文件 / 历史 三个 tab(无事件、记忆)。
- 「改动」tab 的数据用 `useAsyncResource(['worktree', sid], getGitWorktree)`,**复用现有 `/api/sessions/{id}/git` 系端点及其凭证过滤**,前端不做任何 diff 过滤逻辑。
- 摘要卡点击推断文件 → 打开面板「改动」tab 并选中该文件;若该文件不在工作区 diff 中(已提交 / 推断有误),显示「此文件当前无未提交改动」+「在历史中查看」链接,**不报错**。

### 2.3 FocusComposer

agent 模式:

```
[Collect ▾] ┌──────────────────────────────┐ [📎] [⌘] [➤]
            │ 输入… (/ 调出预设)            │
            └──────────────────────────────┘
```

- **队列模式 chip**(agent 会话):显示值**只**来自 store 的 `queueModes[sid]`(后端权威,I-6);点开 `<Menu>` 切换,经 `sessionControls.setQueueMode`,送达才 adopt(现有语义)。Interrupt 模式且 busy 时,发送键变 `--color-warning` 并 tooltip / 手机下方小字「发送将打断当前轮」。
- **`/` 预设**:行首输入 `/` 弹出 `<Popover>` 预设列表(模糊匹配名称);↑↓ + Enter 选择;含 `{{input}}` 则把 `/xxx` 后的文字代入,否则**若输入框已有非 `/` 内容先确认覆盖**(审计 §3.8 痛点)。preset 管理入口统一为列表底部「管理…」→ PromptManager(在 `<Sheet>` 内),删除 Sidebar Settings 与新建流程中的另两个入口(审计 §3.8「三处」)。
- **⌘ 记忆**(crew):现 QuickMemoryPopover 迁入 `<Popover>`;与 MemoryPanel 共享数据层(同一 `useAsyncResource` key,写后 `reload`),修审计 §4.3「两套实现互不同步」。
- 附件 tray、IME 守卫(P0 B7)、断线不清空(P0 B8)、16px(I-15)全部保留。
- **中断**:busy 时 composer 上方 `TurnStatusBar` 显示「运行中 12s · 中断」;stuck 变红(现有语义,`collectHint.ts` 注释已在 P0 更正)。快捷键 `Esc Esc`(焦点在 composer,500ms 内两次)= 中断。1s 时钟**下沉到 TurnStatusBar 组件内部**,不再让整个对话视图每秒重渲染(审计 §6.4)。

终端模式:见 §4.2。

### 2.4 SendToMenu

一个组件,三个入口复用:终端选中文本(§4.3)、HistoryView「发给 agent」、GitViewer 改动 tab「让 agent 处理」。

```
发给…
  ★ zeromux-fe (Claude · 同目录 · 2m 前活跃)      ← 默认高亮
    docs-sync (Codex · ~/s3-workspace/…/docs)
    crew-a (Crew)
  ─────────
  ＋ 新开 Claude / Codex / Kiro / Crew…
```

- **候选**:store 中所有 agent 会话(非 tmux),排序:同 `work_dir` 优先 → `last_activity_ms` 降序。首项 ★ 默认选中,Enter 直接发送。
- **发给已有会话**:`sessionControls[sid].sendPrompt(text)`(P0 已改为返回 boolean)。返回 `false`(WS 未 OPEN 或会话视图未挂载)→ toast「未连接,未发送」+ 文本保留在剪贴板式暂存(`toast` action「复制」)。成功 → toast「已发给 〈名〉」+ action「查看」(切到该会话)。**不切换焦点**(用户可能还要继续看终端)。
- **新开**:选类型 → `handleCreate(type, work_dir, undefined, prompt)`;失败沿用 P0 B3 的可见错误。
- **prompt 包装**:沿用 `lib/historyToAgent.ts` 的 `historyPrompt({name, workDir, text})`(带「来自终端 X 的输出」上下文与凭证提醒);**删除原生 `confirm` 密钥提示**(`HistoryView.tsx:132`),改为菜单底部固定一行小字「发送前请确认内容不含密钥」。
- Collect 模式下目标会话 busy 时,菜单项旁显示「将排队」;Interrupt 模式显示「将打断」(读 `queueModes`,I-6)。

---

## 3. Agent 对话

### 3.1 前置:useAcpSocket 整体搬迁(Plan A 第一步)

- 先补 characterization 测试(`components/__tests__/acpSocket.characterization.test.tsx`,基于 `test/fakeWs.ts`):
  1. onopen 清空 events/notices/busy/turnStartedMs(I-5);
  2. `replay_done` 携带 `running/queue_mode/last_activity_ms` → busy、queue mode、时钟基线按后端(I-5/I-6/I-7);
  3. 乐观气泡 MAX_SAFE_INTEGER + 回显按 client_id 改写 turn_id(I-10);
  4. 退避:连续 close 的重连间隔 1s/2s/4s/8s/10s/10s,稳定 3s 后归零(I-4,fake timers);
  5. 断线 sendPrompt 返回 false(P0);
  6. ConnectionBar `since` 跨重试保持(P0 fix)。
- **全部绿后**,把 `AcpChatView.tsx` 的 WS effect、`handleEvent`、`sendPrompt`、`setQueueMode`、`resolveApproval`、`interrupt` 原样搬到 `hooks/useAcpSocket.ts`,返回 `{ events, notices, busy, turnStartedMs, lastEventMs, queuedCount, wsStatus, sendPrompt, setQueueMode, interrupt, resolveApproval }`。`handleEvent` 闭包用 ref 保证最新(审计 §6.3 约束);`pushNotice` 先于 mem 回调定义(TDZ,`:247`)。
- 搬迁 PR **只搬不改**:characterization 测试 + 既有 69+ 测试不改一行断言即通过,才进入 §3.2。

### 3.2 步骤模型(`lib/steps.ts`,纯函数)

```ts
export type StepKind = 'tool' | 'thinking' | 'text' | 'error' | 'approval'
export interface Step {
  kind: StepKind
  name?: string            // tool 名
  summary?: string         // tool 一行摘要(后端 format_tool_use)
  input?: unknown          // 原始 tool input(展开时显示)
  result?: string          // 配对到的 tool_result 文本(Codex/Crew);Claude 恒 undefined
  status: 'running' | 'done' | 'error'
  startedAt?: number       // 本地到达时间(ms);replay 事件无 → undefined
  endedAt?: number
  text?: string            // thinking/text/error 正文
  approvalId?: string
}
export function toSteps(blocks: Block[], arrivals: number[] | undefined, complete: boolean): Step[]
export function touchedFiles(steps: Step[]): { path: string; label: string }[]
export function conclusion(group: TurnGroup): string
```

- **配对规则**:遍历 blocks;`tool_use` 开一个 `tool` step(status running);随后第一个**同名** `tool_result` 归入最近一个未配对的同名 step(result + done);遇到下一个 `tool_use` 或 text 时,前一个未配对 step 置 done(Claude 路径)。turn complete 时所有 running → done。
- **连续 text 合并**为一个 text step(流式块本就合并,见 transcript)。thinking 连续合并。
- **耗时**:`arrivals[i]` 为 blocks[i] 本地到达时间(AcpChatView/useAcpSocket 在 append 时记录,replay 期间不记);step `startedAt` = 首块到达,`endedAt` = 下一 step 首块到达或 result 到达。任一缺失 → 不显示耗时。**仅前端展示用,不入度量**(度量仍以后端 run_metrics 为准)。
- **touchedFiles**(推断改动):
  - `name ∈ {Edit, Write, MultiEdit, NotebookEdit}` → `input.file_path`(或 `notebook_path`);
  - `name === 'apply_patch'`(Codex)→ `summary` 按逗号 / 空白拆出路径;
  - 其他 backend 的 tool:`name` 匹配 `/write|edit|patch|create_file|str_replace/i` 且 `summary` 形如路径(含 `/` 或 `.` 扩展名、无空格)→ summary;
  - 去重保序。返回 `{ path, label }`:`path` 为可得的最完整路径(Edit/Write 的 `input.file_path` 是绝对路径;`apply_patch`/其他为 summary 原文),用于在「改动」tab 中匹配(按 work_dir 相对化后比较,匹配不到则按 basename 后缀匹配);`label` 显示用,复刻后端 `shorten_path`(`format.rs:21`:`父目录/文件名`)。
- **conclusion**:turn 最后一个 text step 的正文(若无则 `result.text`,沿用 transcript 的 result 门控);取首段(到第一个空行)且最多 600 字符;markdown 渲染。
- **单测**(`lib/__tests__/steps.test.ts`):Claude 序列(无 result)、Codex shell+apply_patch 序列、Crew 带 approval 序列、同名工具连续调用配对、replay 无 arrivals、MultiEdit/NotebookEdit、apply_patch 多文件 summary、非路径 summary 不入 touchedFiles。

### 3.3 TurnTimeline(运行中)

```
▸ 你:修复 sidebar 双击                            (用户气泡,peer 来源紫色标签保留)
  ✓ Read  Sidebar.tsx                        0.4s
  ✓ Edit  Sidebar.tsx                        1.2s
  ⟳ Bash  npx vitest run …                   12s   ← running 步:spinner + 实时秒数
  ┊ 思考 · 3 段                                    ← thinking 默认折叠为一行
  正文流式…(markdown)
```

- 每 step 一行(≥ 44px 触控高度在手机);点击展开**该步**:tool → 原始 input(`<details>` 语义,JSON 美化,截 2000 字 + 「看全文」在 `<Sheet>` 打开)+ result(截 4000 字 + 「看全文」);thinking → 全文。
- `JSON.stringify(input)` 只在展开时计算(修审计 §3.3「每次渲染 stringify」)。
- 正文 text step 始终展开显示(它就是「过程中的结论」)。
- error step:红色内联,不结束 turn(F-CODEX-1 语义)。approval step:ApprovalCard 原样(44px 按钮,经 `resolveApproval`)。
- running 步的实时秒数由**该行自己的** 1s ticker 驱动(只在 running 时存在),不上抬到 turn / 对话层。

### 3.4 TurnSummaryCard(完成)

```
▸ 你:修复 sidebar 双击
  结论首段(markdown,≤ 6 行,超出「展开全文」)
  ✎ Sidebar.tsx · Sidebar.newflow.test.tsx · +1       ← touchedFiles,最多显示 3 个
  9 步 · 3m12s · $0.4213                   [过程 ▾]
```

- `group.complete` false → true 时**自动**由 Timeline 切换为 SummaryCard;切换前若用户已展开某步,**保持该 turn 为 Timeline 形态**(尊重用户正在看的东西),直到其手动收起。
- 「过程 ▾」= 就地展开该 turn 的 Timeline(每 turn 独立展开态,存组件内 state;会话切换常驻不丢,I-1)。
- 耗时 = `turn_started_ms` 到 result 到达(有则显示);replay 的历史 turn 无本地时间 → 只显示步数与成本。
- 成本:`cost_usd` 统一 `toFixed(4)`,与 RunMetricsPanel 统一精度(审计 §3.3「三处精度不一」);非 Claude 无成本 → 省略该段。
- touchedFiles 为空 → 不显示该行(不显示「无改动」,因为推断可能漏)。
- 点击文件 → ContextPanel「改动」tab 定位该文件(§2.2)。
- 出错 turn(error 事件结束):卡片左边框 `--color-danger`,结论区显示错误消息。

### 3.5 其他对话改进

- **notices 按时间穿插**:NoticeBubble 按到达顺序插入对应 turn 之后,而非统一渲染在末尾(审计 §3.12);重连 onopen 清空 notices 的行为保持(I-5)。
- **推送深链定位 turn**:S2 已约定 `?session=&turn=`;本期实现 AcpChatView(TurnList)滚动到该 turn 并高亮 2s,滚动走程序滚动豁免(I-11)。
- **长会话性能**:TurnList 对**完成且未展开**的 SummaryCard 使用 `content-visibility: auto` + `contain-intrinsic-size`(不引虚拟列表库,总 spec §3 决定);`foldTranscript` 每事件 O(N) 暂不动(stabilizeGroups 已挡重渲染),列为观测项。

### 3.6 不变量对照

| 不变量 | 本期触及点 | 保持方式 / 测试 |
|---|---|---|
| I-1 | ContextPanel、TurnList 展开态 | 常驻挂载 + hidden;App 级测试:切会话再切回,展开态与面板 tab 不丢 |
| I-4/I-5/I-7/I-10 | useAcpSocket 搬迁 | §3.1 characterization 测试先行,搬迁不改断言 |
| I-6 | composer 队列 chip、SendToMenu 提示 | 只读 `queueModes`;测试:后端推 queue_mode 变化 → chip 跟随,本地点击未送达不变 |
| I-9 | TurnGroupView → TurnView(Timeline/SummaryCard) | memo 比较器保留并**新增** `expanded`、`arrivalsVersion` 字段;`stabilizeGroups` 不动;测试:3s 轮询 peerNames 不变时已完成 turn 不重渲染(render 计数) |
| I-11 | 自动 Timeline→Card 收起、步骤展开 | 高度变化不计为用户上滚:收起/展开由程序触发时置 `programmaticScrollRef` 窗口;测试:底部跟随中 turn 完成收起后仍贴底 |
| I-16 | 结论 markdown、tool result 全文 Sheet | 全部走 `MarkdownContent`(sanitize);result 全文用 `<pre>` 纯文本 |
| I-19 | 队列提示 | 「已排队 N 条」语义不变,显示位置移到 TurnStatusBar |

---

## 4. 终端

### 4.1 前置:useTerminalSocket 整体搬迁(Plan B 第一步)

- characterization 测试(基于 P0 引入的 xterm mock,`TerminalView.mobileLayout.test.tsx` 同款):onopen `term.reset()`(I-5);退避 + 稳定 3s(I-4);`tmux_ended` 不重连;`sendInput` 未 OPEN 返回 false(I-13);resize 仅 active 且非 0×0、onopen 首发不视为冗余(I-12);keyboardOpen 切换触发 refit(P0 保留路径);wsStatus open 后 refit(P0 final fix)。
- B14(审计,未验证):`onclose` 无条件 `wsRef=null` 可能清掉新 socket 引用 —— **先写测试验证**;若复现,在搬迁 PR 之前单独修(`if (wsRef.current === ws) wsRef.current = null`)。
- 搬迁到 `hooks/useTerminalSocket.ts` + `hooks/useXterm.ts`,只搬不改。

### 4.2 TerminalKeyTray(可收起键栏 + 自定义键)

```
展开: [📜][↑][↓][↵][^C][claude][codex][crew][⋯][⌄]      ← ⌄ 收起
      [输入文字,点 ➤ 发送…                     ][➤]
收起: [⌃ 键栏][输入文字…                        ][➤]      ← 一行
```

- 收起状态全局记忆(localStorage `zmx_keytray`);收起时终端可视高度再增约 48px。
- **自定义键**:`⋯` 第二页末尾「编辑键…」→ `<Sheet>` 列出可选键(现 PAGE2 全集 + `^R`、`^L`、`^A`、`^E`、`Home`、`End`、`/`、`|`、`~`)与已选列表,拖动或上下箭头排序,第一页最多 8 个;存 localStorage `zmx_keys_p1`。默认值 = 当前第一页(无迁移成本)。
- 所有键仍 `onPointerDown + preventDefault`(I-15),经 `sendInput`(I-13)。
- 📜 历史键:保持;HistoryView 全屏时键栏隐藏(现有行为)。
- 仅触屏渲染(`useIsTouch()`,总 spec §3.2)。

### 4.3 选中文本 → 发给 agent

- **桌面**:xterm `onSelectionChange` + `hasSelection()` → 选区右下角浮出小按钮「发给…」(`<Popover>` 锚定到最后一个选中单元格的屏幕坐标;选区清空即消失)。点击 → SendToMenu(§2.4)。
- **手机**:xterm 触摸选择不可用(`touch-action:none`,I-15)→ 入口为键栏 📜 进入 HistoryView,长按 / 选中后底部操作条「发给…」(HistoryView 已有 selection 逻辑,`HistoryView.tsx:132` 附近);以及 HistoryView 无选区时「发给…」发送尾部 N 行(现有 `selectionOrTail` 语义)。
- 快捷键(桌面):`⌘⇧Enter` 把当前选区发给 ★ 默认目标(不弹菜单);无选区时 no-op。
- 删除 `App.tsx:454` 写死 `handleCreate('claude', …)` 的 `onAskAgent`,改为 SendToMenu 的「新开」路径。

### 4.4 GitViewer 手机布局

由 ContextPanel「改动 / 历史」tab 承接(§2.2):窄屏两级导航(列表 → 详情,顶部返回),`w-80` 固定左栏(`GitViewer.tsx:157,292`)只在 ≥ md 使用;diff 行渲染对超过 2000 行的 diff 分块(每块 500 行,滚动到底加载下一块,复用 HistoryView 的分块思路),修审计 §3.5「每字符一 span 无虚拟化」的最坏情况。

### 4.5 WebGL 预算

- `lib/webglBudget.ts`:模块级 LRU,容量 `WEBGL_BUDGET = 4`。`acquire(sid)` 在 TerminalView active 时调用;超出容量时对最久未 active 的终端调用其注册的 `release()`(`webgl.dispose()`,xterm 自动回落 DOM 渲染器)。
- 终端重新 active 时若未持有 WebGL → `acquire` 后重新 `loadAddon(new WebglAddon())`,仍挂 `onContextLoss → dispose`(I-14)。
- 切换闪烁:**未验证**;Plan B 需在真机(iPhone Safari + Mac Chrome)实测,若闪烁明显,降级为「只在 onContextLoss 时回落,不主动释放」并把预算改为仅记录日志。
- 单测:LRU 淘汰顺序、release 回调调用、重复 acquire 幂等。

### 4.6 隐藏终端的开销

- `TerminalView` 10s status/health 轮询:S1 的 `usePolling` 已限定 active + 可见;本期把 status 的消费方从底部状态栏改为 FocusHeader `⋯` 菜单 → **只在菜单打开或会话 active 时**拉取。
- 隐藏终端保持 WS(I-1 代价,可接受)。

---

## 5. 测试与验收

### 5.1 测试清单

| 层 | 新增 |
|---|---|
| 纯函数 | `steps.test.ts`(§3.2 全部 case)、`webglBudget.test.ts`、`sendTargets.test.ts`(候选排序:同目录优先、活跃度降序、排除 tmux) |
| characterization | `acpSocket.characterization.test.tsx`(§3.1 六项)、`terminalSocket.characterization.test.tsx`(§4.1) |
| 组件 | TurnTimeline(运行中步骤、单步展开、thinking 折叠)、TurnSummaryCard(自动收起、用户展开时不收起、文件点击回调)、ContextPanel(随类型默认态、记忆、tab 懒挂载后常驻)、FocusComposer(队列 chip 受控、`/` 预设、覆盖确认、IME)、SendToMenu(默认目标、返回 false 的 toast、新开失败可见)、TerminalKeyTray(收起记忆、自定义键顺序) |
| App 级 | 切会话往返:面板 tab / turn 展开态 / xterm 实例不变、WS 不重连(I-1) |
| 回归 | 既有全部测试 + 7 个 `*.stale.test.tsx` 原样通过;P0 新增测试(acpConnection、TerminalView.mobileLayout)原样通过 |

### 5.2 成功指标

| 指标 | 目标 | 验证 |
|---|---|---|
| 扫读一个完成 turn | 不展开即可见 结论 / 改动文件 / 步数 / 耗时 / 成本 | 截图 |
| 看某文件的改动 | 摘要卡 → 1 击到该文件 diff | 手测 |
| 终端报错交给 agent | 桌面:选中 → `⌘⇧Enter`(0 击菜单)或 2 击;手机:📜 → 选中 → 发给… → 目标,≤ 4 击 | 手测 |
| 切换队列模式 | 1 击(composer chip),当前模式始终可见 | 截图 |
| 常用预设 | 输入 `/` + 2–3 字 + Enter | 手测 |
| 手机终端可视高度 | 键栏收起时 ≥ 82%(390×844,键盘收起) | 截图回归 |
| 对话滚动性能 | 200 turn 会话滚动无明显卡顿(Mac Chrome Performance 面板无 > 50ms long task 于滚动期间) | 手测 + 记录 |
| 首屏传输 | 仍 ≤ 400KB(br,JS+CSS);S1 引入的 size-budget 检查通过 | 自动检查 |

### 5.3 截图回归

沿用总 spec §7.3:390×844 与 1440×900、暗/亮;新增场景:运行中 turn(时间线)、完成 turn(摘要卡)、Context 面板三种形态、SendToMenu、键栏收起。隔离实例 `--data-dir` + `--tmux-socket`。

---

## 6. 分期

| Plan | 内容 | 可独立上线 | 回退 |
|---|---|---|---|
| **A1** | useAcpSocket characterization + 搬迁(无 UI 变化) | ✅ | revert PR |
| **A2** | steps.ts + TurnTimeline + TurnSummaryCard + TurnStatusBar;移除全局 density | ✅ | `zmx_turn_ui=v1` 开关回旧 TurnGroupView,保留两周 |
| **A3** | ContextPanel(5 tab,收编 overlay + SessionInfoBar)+ FocusHeader + FocusComposer(chip、`/` 预设、记忆统一) | ✅ | 依赖 S2 壳开关 `zmx_shell` |
| **A4** | SendToMenu + GitViewer「让 agent 处理」接入 | ✅ | — |
| **B1** | useTerminalSocket characterization + B14 验证/修 + 搬迁 | ✅ | revert PR |
| **B2** | TerminalKeyTray(收起 + 自定义键)+ 选中文本 → SendToMenu + 删 `onAskAgent` 写死 claude | ✅ | — |
| **B3** | WebGL 预算(真机实测后决定启用或降级)+ 隐藏终端 status 拉取收敛 | ✅ | `WEBGL_BUDGET = Infinity` |

Plan A 写成一份 implementation plan(A1–A4 为其 task 组),Plan B 一份。

---

## 7. 风险

| 风险 | 缓解 |
|---|---|
| useAcpSocket 搬迁破坏 WS 不变量 | characterization 先行;搬迁 PR 只搬不改;每条测试先注释被测逻辑验红 |
| 顺序配对错配(并行工具调用) | Claude 无 result 不受影响;Codex 串行;Crew 若出现并行,错配只影响展开时 result 归属,不影响摘要卡 —— 单测覆盖「同名连续调用」 |
| 推断文件漏报(Bash `sed -i` 等) | 卡片不写「已修改」、不显示行数、空时不显示;精确视图在 Context「改动」tab |
| Timeline→Card 自动切换打断正在阅读的用户 | 用户已展开任一步时不自动收起;收起不触发滚动跳动(I-11 测试) |
| ContextPanel 常驻挂载的内存开销(N 会话 × 5 tab) | tab 懒挂载;GitViewer diff 分块;若会话数 > 12,最久未访问会话的面板 tab 内容可卸载(仅保留 tab 选择与 cwd 等轻量 state)—— 实施时观测再决定,不预先实现 |
| WebGL 主动释放导致闪烁 | §4.5 真机实测 + 降级路径 |
| 桌面终端展开右栏挤压 cols 导致 tmux 重排 | 终端默认收起;展开时一次 refit(去重) |
