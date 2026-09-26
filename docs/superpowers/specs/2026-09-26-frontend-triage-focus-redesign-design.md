# 前端重设计「Triage + Focus」—— 设计

日期:2026-09-26
状态:v1(PM + CTO 交叉评审后收敛;用户已确认方向「按建议来」,待审阅 spec 文本)
基线:`main` @ `acb3ea3`
输入:
- 前端审计 `docs/superpowers/audits/2026-09-26-frontend-ux-audit.md`(以下简称「审计」,§/I-/B- 编号均指它)
- PM review、CTO review(本会话并行子 agent,结论已吸收进本文;关键断言主会话复核,见 §0.3)

---

## 0. 背景与决策

### 0.1 用户与目标(用户确认)

- 单人自用;**手机浏览器与 Mac 浏览器比例相当,两端都要一流**;纯 Web/PWA,不做原生。
- 同时开 3–8 个会话,agent 会话为主。
- 五大痛点**全部存在**:A 找/切会话慢、分不清谁在跑/谁在等我;B 盯 agent 累、无全局态势;C 操作路径长;D 对话信息阅读费劲;E 视觉过时。
- 接受大刀阔斧修改。

### 0.2 交叉评审收敛

| 议题 | PM | CTO | 决定 |
|---|---|---|---|
| 核心隐喻 | 分诊队列(Superhuman 式)+「下一个」键 | 可接受看板,但只读聚合 + 跳转 | **分诊队列**。单人 3–8 会话,四列看板多数时间空。同一份数据以后可加看板视图 |
| 「等你处理」 | 砍审批类(Claude 以 skip-permissions 运行,几乎无审批) | 只有 Crew 审批 + 定时确认两类真信号;「空闲」不可包装成「等你」 | 保留收件箱,**只收真信号**:出错/卡住、完成未读、Crew 待审批、定时待确认 |
| 卡片直接回复 | 不做(易发错会话) | 若做,只能走已挂载 AcpChatView 的 `sessionControls`,禁止卡片自开 WS | **不做回复**;行内只做「中断」「批准」一击操作,经 `sessionControls` |
| 顺序 | 止血 → 地基 → 分诊 | 修缺陷/压缩/api/stale 收敛 → characterization → strangler 新壳 | 合并为 P0 → S1 → S2 → S3 → S4(§1) |
| 库 | — | 引 zustand、Radix(按需);不引路由、motion、cmdk;虚拟列表暂不引 | 采纳 |
| 分屏(方案 C) | 不做 | WebGL 上下文上限 | 非目标 |

### 0.3 主会话复核过的关键断言

- `Composer.tsx:39` Enter 未判 `isComposing`;`App.tsx:72` `isMobile` 单次 `useMemo`;`AcpChatView.tsx:687` WS 未 OPEN 直接 `return`;全仓 `.tsx` 零 `sm:/md:/lg:`;`MarkdownViewer.tsx` 仅被测试引用。
- `Cargo.toml:9` tower-http 只开 `cors`、`set-header`,**无压缩**;`frontend/dist/assets/index-*.js` 1,364,669 B 原样下发。
- `SessionInfo`(`session_manager.rs:386-406`)无成本/结果/片段/当前步骤字段;`lifetime_cost_usd` 存在于 `Session`(`:331`)但未导出。
- 所有 fan-out 事件经唯一咽喉 `emit`(`:3555`)→ `record_and_broadcast`(`:2025`,锁内、无 I/O)。

---

## 1. 路线图

| 阶段 | 目标 | 本 spec 深度 | 可独立部署 |
|---|---|---|---|
| **P0 止血** | 修高频缺陷、压缩、手机终端底部 | 详细(§2) | ✅ |
| **S1 地基** | 设计 token、响应式、primitives、数据层收敛 | 详细(§3) | ✅(视觉统一,IA 不变) |
| **S2 分诊与导航** ⭐ | 态势字段 + 分诊队列 + 下一个 + ⌘K + 新壳 | **完整**(§4) | ✅(新旧壳开关) |
| S3 对话体验 | turn 摘要卡、tool 配对、Context 面板 | 纲要(§5),另起 spec | — |
| S4 移动终端 | 键栏收起、选中转发、WebGL 策略 | 纲要(§6),另起 spec | — |

每阶段单独出 implementation plan;每步部署走 `./deploy.sh --build`,**先 commit + push 再 deploy**。

---

## 2. P0 止血

### 2.1 缺陷修复

| # | 位置 | 修法 | 测试 |
|---|---|---|---|
| B7 | `Composer.tsx:38-43` | `if (e.nativeEvent.isComposing \|\| e.keyCode === 229) return` 先于 Enter 判断 | Composer 单测:`isComposing:true` 的 Enter 不触发 send |
| B8 | `AcpChatView.tsx:687` | `sendPrompt` 返回 `boolean`;未 OPEN 返回 `false`,Composer 不清空(同 TerminalView `sendInput` 语义 I-13);`registerControls` 暴露的签名同步改 | 组件测:socket CLOSED 时发送 → 文本保留 + 出现连接条 |
| — | AcpChatView / TerminalView | **连接状态条**:WS 状态 `connecting/open/reconnecting(attempt)/ended` 暴露为 state;非 open 超 1.5s 在 composer 上方显示细条「重连中…」,ended 显示「会话已结束」 | 同上 |
| B3 | `App.tsx:261-274` + Sidebar 调用点 | `handleCreate` 返回 Promise,失败抛出;Sidebar `await` 后才关弹层,失败留在当前步并显示错误行 | `Sidebar.newflow` 增 case:create reject → 弹层不关、显示错误 |
| B1 | `ScheduledTasksPanel.tsx:79-93` | toggle 改为发送完整 task(含 `idle_timeout_min`、原 schedule kind),或后端改 PATCH 语义(plan 阶段二选一,优先前端) | 单测:toggle body 含 `idle_timeout_min` 与原 schedule |
| B4 | `FileBrowser.tsx:109-127` | cwd 变化时同步 `setLoading(true)` + 清 `entries`;加载中列表不可点 | FileBrowser 测:切目录期间旧行不存在 |
| B15 | `MarkdownViewer.tsx` + 其测试 + 过时注释 | 删除 | `npm test` 绿 |

### 2.2 压缩

- `Cargo.toml`:tower-http 加 `compression-gzip`、`compression-br` feature;`build_router` 外层加 `CompressionLayer`。
- **WS 升级路由不得被压缩层影响**(plan 阶段实测 `/ws/*` 仍能 101 升级);SSE/流式端点若有需同样验证。
- 验收:`curl -H 'Accept-Encoding: br' -sI /assets/index-*.js` 带 `content-encoding: br`;主包传输体积 ≤ 400KB。

### 2.3 手机终端底部(对应截图 IMG_1629)

- 滚动胶囊(`TerminalView.tsx:710-717`,现 `bottom-28` 固定)改为相对**输入区顶部**定位,不覆盖 MobileKeyBar。
- 「⤒顶」字符在 iOS 渲染为「不」:改用 lucide `ArrowUpToLine` 图标 + `aria-label`。
- 软键盘收起时,MobileKeyBar + Composer 合并为**一行**(键栏横向滚动,右端发送);路径/tmux 名状态栏(`:745`)收进顶栏 ⋯。
- 验收:iPhone 竖屏(390×844 视口)键盘收起时终端可视高度 ≥ 75%;任何浮层不遮挡键栏按钮(截图回归,见 §7)。

---

## 3. S1 地基

### 3.1 设计 token(Tailwind v4 `@theme`)

在 `index.css` 以 `@theme` 声明,颜色映射到现有 CSS 变量(保留 `:root` / `:root.light` 覆盖机制):

| 类别 | token | 取值 |
|---|---|---|
| 语义色 | `--color-surface-{0,1,2,3}`、`--color-border{,-subtle}`、`--color-fg{,-muted,-subtle,-strong}`、`--color-accent`、`--color-success`、`--color-warning`、`--color-danger`、`--color-info` | 映射现有 `--bg-*`/`--text-*`/`--accent-*` |
| 状态色 | `--color-state-{error,stuck,done,running,idle,waiting}` | 分诊与所有状态点唯一来源 |
| 字号 | `--text-2xs:12px`、`--text-xs:13px`、`--text-sm:14px`、`--text-base:16px`、`--text-lg:18px` | **下限 12px**;手机正文 14px;输入框 16px(I-15) |
| 圆角 | `--radius-sm:4px`、`--radius-md:8px`、`--radius-lg:12px`、`--radius-full` | |
| 阴影 | `--shadow-{sm,md,lg}`(暗色用边框+微光,亮色用投影) | |
| 层级 | `--z-{base:0,sticky:10,drawer:30,popover:40,modal:50,toast:60}` | 取代散落 z-10…z-50 |
| 动效 | `--ease-out`、`--dur-{fast:120ms,base:200ms}`;`prefers-reduced-motion` 时归零 | CSS transition,无动画库 |
| 字体 | `--font-sans`(system-ui 栈 + PingFang SC)、`--font-mono`(JetBrains Mono 栈) | 取代 `TerminalView.tsx:301` 写死 |

- **主题**:新增「跟随系统」(`prefers-color-scheme`)为默认;`lib/theme.ts` 三态 `system/dark/light`。
- **消除硬编码**:审计 §2.1 列出的 24 处 Tailwind 调色板直用、GitViewer 硬编码色、`LoginPage` GitHub 按钮;mermaid 按当前主题初始化(B13)。
- **xterm 主题**:`TerminalView.tsx:27-72` THEMES 改为运行时 `getComputedStyle` 读 `--ansi-*`,主题切换时 `term.options.theme = …`。
- **门禁**:`scripts/lint-tokens.sh`(或 eslint 规则)拒绝 `text-\[(8|9|10|11)px\]`、`(text|bg|border)-(zinc|gray|yellow|orange|green|red|blue)-\d+`、`z-\d+`;接入 `npm run lint`。

### 3.2 响应式

- 断点:`md` = 768px、`lg` = 1024px(Tailwind 默认)。布局切换全部用 CSS 断点。
- `lib/useMediaQuery.ts`:`matchMedia` 监听,取代 `App.tsx:72` 单次判定(B11)。
- 统一移动判定:**布局**看宽度(`md`),**输入方式**看 `(any-pointer: coarse)`;两者分别暴露 `useIsNarrow()` / `useIsTouch()`,TerminalView 现有触屏判定(`:131-135`)改用后者。

### 3.3 Primitives(`components/ui/`)

依赖 Radix(按需:`@radix-ui/react-dialog`、`-popover`、`-dropdown-menu`),全部 portal 到 `#overlay-root`(`index.html` 新增,**不在** `.vault-reading-surface` 内,I-16)。

| 组件 | 职责 | 取代 |
|---|---|---|
| `<Sheet side="right\|bottom\|full" title actions>` | 面板/抽屉;bottom 用 VisualViewport 键盘补偿;手机 bottom 支持下拉关闭 | Admin/Scheduled/Push 全屏面板(消除「无定位祖先才全屏」隐式行为,审计 §4.2)、DirectoryPicker modal |
| `<Popover>` | 锚定浮层 + Esc + 点外关闭 | `Sidebar.tsx:599,980,1019`、`AcpChatView.tsx:914,963` 手写遮罩 |
| `<Menu items>` | 行菜单,触屏 44px 行高 | SessionRowMenu、QuickTargets/SearchResults 行内操作 |
| `<ConfirmInline>` / `confirm()` promise API | 替代原生 `alert/confirm/prompt`(~17 处) | 两段确认先例 `PromptManager.tsx:63-78` |
| `toast.push({msg, action?, durationMs, key?})` | 队列 + 同 key 去重;撤销 toast 时长公式不变(I-18) | 单槽 `undoToast`(`App.tsx:315`) |
| `<IconButton>` | 强制 `aria-label`、触屏 ≥44px 命中区 | 散落 `p-0.5`/`p-1` 图标按钮 |
| `<StatusDot state>` | 语义状态点(running 呼吸、stuck 脉冲) | TurnDot、`SessionInfoBar.tsx:37` |
| `<PaneStatus kind="loading\|empty\|error">` | 统一空态/加载/错误 | Git/FileBrowser 重复占位 |

**测试**:每个 primitive 有组件测(键盘、Esc、焦点回归、portal 挂载点);新增测试「给侧栏根加 `relative` 后 Sheet 仍全屏」。

### 3.4 数据层收敛

- `lib/api/` 按域拆分 `api.ts`(sessions/git/files/vault/scheduler/push/memory/prompts/auth),统一 `request<T>(path, init & {timeoutMs?})`:`!res.ok` 抛 `ApiError(status, message)`,默认 15s AbortController。**轮询 catch 行为不变**(I-3:只有 `isAuthError` 登出)。`WaitingPage` 改走 `request`(B12)。
- `lib/useLatestRequest.ts`:
  ```ts
  useLatestRequest(): { begin(): Token; isCurrent(t: Token): boolean; bump(): void }
  ```
  三点显式(请求前 `begin`、await 后 `isCurrent`、乐观写前 `bump`),**不做**包装 `run()` 以免藏掉第三点(I-8)。
- `lib/useAsyncResource.ts`:`(key, fetcher) → {data, loading, error, reload}`,内部用 `useLatestRequest`;key 变化立即 `loading=true` 并清 data。
- 迁移审计 §4.1 的 13 处 reqRef + 5 处无守卫(GitViewer.loadLog、ScheduledTasksPanel.load、ConfirmationQueue.reload、AdminPanel.load、PushSettings)。**每迁一处:先注释守卫确认对应 stale 测试变红,再迁;无测试者先补。** 7 个 `*.stale.test.tsx` 必须原样通过。
- `lib/usePolling.ts`:`(fn, intervalMs, {enabled})`,`document.visibilityState==='hidden'` 暂停、恢复可见立即跑一次。迁移审计 §4.3 的全部轮询;TerminalView status/health 轮询**只在 `active` 时启用**(每次触发 `web.rs` 同步 git 子进程)。
- 合并 `useDirBrowser`(Sidebar + DirectoryPicker)、`usePathSearch`(Sidebar + VaultReader,含 4s 重查)。

### 3.5 S1 验收

- `text-[8-11px]` 与调色板直用 grep 为 0;原生 `alert/confirm/prompt` 为 0;hover-only 控件为 0(审计 §2.6 四处)。
- 亮/暗/系统三主题下截图无对比度失败(对比度 ≥ 4.5:1 正文,≥ 3:1 辅助)。
- 69 个既有测试文件 + 新增测试全绿;`npm run lint` 含 token 门禁通过。

---

## 4. S2 分诊与导航(本期核心)

### 4.1 信息架构

**桌面(≥ lg)三栏**:

```
┌─ Triage 队列 (272px) ─┬─ Focus 主区 ──────────────────────────┬─ Context (S3) ─┐
│ ⌘K 搜索或命令…         │ 顶栏:← 会话名 · ●状态 · 耗时 · $  ⋯   │ (S2 仍用现有    │
│ ── 需要你 (3) ──       │───────────────────────────────────────│  overlay 图标,  │
│ ● api-refactor  出错   │  TerminalView / AcpChatView           │  S3 收编)       │
│   "cargo test 失败…"   │  (常驻挂载,hidden 切换,I-1)          │                │
│ ◉ docs-sync  完成·未读 │                                       │                │
│ ⚑ crew-a  待审批 1     │                                       │                │
│ ── 运行中 (2) ──       │                                       │                │
│ ◌ zeromux-fe  Edit…3m │                                       │                │
│ ── 空闲 ──             │                                       │                │
│ ○ shell-main           │                                       │                │
│ ── 文档 ──             │                                       │                │
│ ＋ 新建  ⌘N    J 下一个 │                                       │                │
└────────────────────────┴───────────────────────────────────────┴────────────────┘
```

- `md ≤ 宽 < lg`:队列可折叠为 56px 图标栏(沿用现 CollapsedRail 语义)。

**手机(< md)**:

```
┌────────────────────────────────┐
│ ‹  api-refactor  ● 出错 · 4m  ⋯ │  顶栏(横滑:切到上/下一个会话)
├────────────────────────────────┤
│                                │
│   主区(聊天 / 终端)             │
│                                │
├────────────────────────────────┤
│ [Composer / 终端输入行]          │
├────────────────────────────────┤
│ 分诊(3) │ 当前 │ ＋新建 │ 搜索   │  底部 Tab(56px + safe-area)
└────────────────────────────────┘
               (⏭ FAB:下一个需要你的,仅在「需要你」>0 时出现,位于 Tab 上方右侧)
```

- 「分诊」Tab = 全屏队列(同桌面左栏内容);「当前」= 最近活动会话;「＋新建」= 打开 ⌘K 并预置「新建」模式;「搜索」= ⌘K 默认模式。
- 软键盘弹出时底部 Tab 隐藏(沿用 VisualViewport 补偿),Composer 贴键盘。
- 横滑只在**顶栏**识别(不在 xterm 区域,I-15 `touch-action:none`)。

### 4.2 后端:会话态势字段

在 `SessionInfo`(`session_manager.rs:386`)新增,均为 `Session` 上**预计算**字段,`session_info_of` 只拷贝,**锁内零 I/O、零扫描**:

| 字段 | 类型 | 维护点 | 语义 |
|---|---|---|---|
| `last_outcome` | `Option<"completed"\|"errored"\|"cancelled"\|"timeout">` | 与 `record_run_metric` 同处(turn settle 时已知 `RunOutcome`) | 最近一个**已结束** turn 的结果;新 turn 开始时不清(用于「上一轮出错」显示),由 `turn_state` 表达正在跑 |
| `last_outcome_ms` | `Option<i64>` | 同上 | 结束时间 |
| `last_snippet` | `Option<String>` | `emit` → `record_and_broadcast` 锁内 | 最近一个 `ContentBlock{text}`(非 streaming 或合并后)或 `Result.text` 的**末行**,去 markdown 标记后截 **120 字符**(按 `chars()`,防多字节切片 panic,见历史 review);tmux 会话为 None |
| `current_step` | `Option<String>` | 同上 | 最近一个 `tool_use` 的 `name · summary`(截 80 字符);turn 结束(boundary)时清为 None |
| `pending_approvals` | `u32` | 同上 | Crew 专属:收到 `AcpEvent::Approval` +1;该 approval 被处理(plan 阶段定位 `POST /api/approvals/{id}/{action}` 的回执路径或 Gateway 后续事件)−1;turn boundary 与进程退出时归零。其余 backend 恒 0 |
| `lifetime_cost_usd` | `f64` | 已有(`:331`) | 仅导出 |

- **三 backend parity**:`last_snippet`/`current_step` 依赖统一 `AcpEvent`,在 `emit` 咽喉处维护 → Claude/Kiro/Codex/Crew 自动一致。Codex 非流式正文经 `Result.text` 覆盖;Crew `System{status}` 心跳不更新片段。Rust 单测对四种 backend 各喂一段代表事件序列断言字段。
- **不新开全局事件 WS**。沿用 3s `/api/sessions` 轮询(态势感知 3s 足够;全局 WS 需新鉴权/owner 过滤/重连语义,列为非目标)。
- `pending_approvals` 若 plan 阶段发现回执路径无法在后端可靠观测,**降级**为:前端对**已挂载**的 Crew 会话从 transcript 派生(`AcpChatView` 已有 `resolvedApprovals`),经 `sessionControls` 上报 App;spec 接受任一实现,验收只看行为。

### 4.3 分诊模型(`lib/triage.ts`,纯函数,全覆盖单测)

```ts
type Attention = 'error' | 'stuck' | 'approval' | 'confirm' | 'done_unread' | 'running' | 'idle' | 'ended'
triage(s: SessionInfo, ctx: { now: number; readCount: number; confirmsBySession: Record<string, number> }): Attention
```

判定顺序(先中先得):

1. `error`:`turn_state !== 'running'` 且 `last_outcome ∈ {errored, timeout}` 且 `last_outcome_ms` 晚于用户最后一次查看该会话(见下「已读」)
2. `stuck`:`turn_state === 'running'` 且 `now - last_activity_ms > STUCK_SILENCE_MS`(**复用** `lib/stuck.ts:3` 的 180s,与 Rust 同名常量镜像,不另立阈值)
3. `approval`:`pending_approvals > 0`
4. `confirm`:该会话 `source_task_id` 对应定时确认队列有待确认项(复用现有 30s 确认轮询,改为按 session 分组)
5. `done_unread`:`turn_state !== 'running'` 且 `turns_completed > readCount`
6. `running`:`turn_state === 'running'`
7. `idle`:其余运行中的进程
8. `ended`:`running === false`

- 分组:**需要你** = {error, stuck, approval, confirm, done_unread};**运行中** = {running};**空闲** = {idle, ended};**文档** = docTabs。
- 组内排序:需要你按 (Attention 优先级, 事件时间降序);运行中按 `turn_started_ms` 升序(跑得最久在上);空闲按 `last_activity_ms` 降序。用户可**置顶**(localStorage `zmx_pins`,置顶项在各组内最前)。
- **已读**:沿用 `readCounts`(`App.tsx:216-234`);另记 `lastViewedMs[sid]`(切入会话时写),用于 error 的「已看过」判定。
  - 现状(已核对):`readCounts` **不持久化**,每次加载由 `baselineInit`(`:218-222`)把全部既有完成视为已读 → 刷新页面会丢掉「离开期间完成」的未读。
  - 改为:二者持久化到 localStorage(`zmx_read`,按 sid);加载时**只对 localStorage 中不存在的 sid** 做 baseline;列表中已消失的 sid 在写回时 GC。这样「推送 → 打开页面」后离开期间完成的会话仍在「需要你」组。
- **identity 稳定(I-9)**:队列项由 `useMemo` 按 `(id, attention, name, last_snippet, current_step, cost 四舍五入到分)` 生成签名,签名不变复用对象;行组件 `memo`。3s 整表替换不导致全部行重渲染(组件测断言 render 次数)。
- **I-2**:分诊只派生视图,**绝不写 `activeId`**;测试沿用 07-07 场景(轮询导致排序变化时焦点不动)。

### 4.4 队列行(`TriageRow`)

```
[StatusDot] [类型图标] 会话名                    右侧:耗时 / 相对时间
            last_snippet 或 current_step(1 行,fg-muted,12px+)      $0.42
            [行内动作:中断 | 批准 | 打开确认]  (仅在对应 attention 时出现)
```

- 行高 ≥ 56px(手机 ≥ 64px),整行可点;⋯ 菜单(`<Menu>`):重命名、置顶、复制 peer 名、关闭(沿用撤销 toast,I-18)。
- 行内动作:
  - **中断**(running/stuck):先 `setActiveId`?**否**——中断不切焦点;调用 `sessionControls[sid].cancel()`(新增,等价现「中断」按钮的 WS 消息)。返回 `false`(WS 未 OPEN)时 toast「未连接,稍后重试」。
  - **批准**(approval):展开行内审批摘要(tool + purpose),「批准 / 拒绝」经 `sessionControls[sid].resolveApproval(id, action)`(复用 ApprovalCard 同一路径)。
  - **打开确认**(confirm):打开定时任务确认 Sheet 并定位该项。
  - **不提供回复**(§0.2)。
- 所有动作走已挂载会话的 `sessionControls`,**禁止新开 WS**(每条 WS 连接触发全量 replay,`acp/ws_handler.rs:100-139`)。tmux 会话无行内动作。

### 4.5 「下一个」

- 定义:按分诊「需要你」组的当前排序,取**当前会话之后**的第一项(环绕);组为空时 no-op + toast「都处理完了 ✓」。
- 入口:桌面 `J`(下一个)/ `K`(上一个)——仅在焦点不在输入框/xterm 时生效;`⌘]` / `⌘[` 在任何焦点下生效。手机 FAB ⏭。
- 切入即视为已读(更新 readCount + lastViewedMs)。
- **推送闭环**:SW `open_session` 深链(I-17,`App.tsx:197-210`)保持;新增 `&turn=<turn_id>`,AcpChatView 收到后滚动定位到该 turn(复用 I-11 的程序滚动豁免)。无 turn 参数时行为不变。

### 4.6 命令面板 ⌘K

- 实现:Radix Dialog + 自写列表(不引 cmdk);模糊匹配:会话/动作在前端内存匹配(新 `lib/fuzzy.ts`,纯函数单测);目录/笔记复用后端模糊搜索接口 + `lib/searchOrder.ts` 排序。桌面 `⌘K` / `Ctrl+K`;手机「搜索」Tab、「＋新建」Tab。
- 输入框 16px(I-15);↑/↓ 选择,Enter 执行,Tab 补全,Esc 关闭;IME 组合中 Enter 不执行(同 B7 守卫)。
- **结果分区**(按输入动态):
  1. **会话**:按名称 / work_dir / peer 名模糊匹配,右侧显示 attention。Enter 切入。
  2. **动作**:新建会话、下一个、切换主题、打开定时任务/推送设置/管理、当前会话的 Git/文件/事件/记忆、切换当前会话队列模式(显示值取 `queueModes`,I-6)。
  3. **目录 / 笔记**:复用现有模糊搜索接口(`sections`),⚡ 问 agent 保留。
  4. **预设**(输入以 `/` 开头):选中后发往当前 agent 会话(走 `sessionControls.sendPrompt`,返回 false 则 toast)。
- **新建模式**(一步到位):
  - 语法:`<类型>? <目录片段> <prompt>?`,类型关键字 `claude|codex|kiro|crew|tmux|term`,缺省 = **上次使用的类型**(localStorage `zmx_last_type`)。
  - 面板底部**预览行**:`Claude · ~/s3-workspace/…/zeromux · "修复 xx"`,Enter 确认创建(有 prompt 则 Create & send)。目录片段解析为目录搜索首项,`Tab` 在候选间切换;输入以 `/` 或 `~` 开头时按**字面路径**补全(取代逐级点目录,审计 §3.1)。
  - 创建失败:面板不关,预览行变错误态(依赖 P0 B3)。
  - 无 LLM,纯规则解析;歧义时靠预览行让用户确认。
- 现 Sidebar 新建状态机(`Sidebar.tsx:74` 六步)在新壳下由 ⌘K 新建模式取代;旧壳保留原流程直至删除。

### 4.7 新壳 `AppShell` 与迁移(strangler)

1. **zustand store**(`lib/store.ts`):`sessions`、`hostTmux`、`queueModes`、`readCounts`、`lastViewedMs`、`activeId`、`overlay`、`pins`、`confirmsBySession`。App 的 3s 轮询写 store;组件用 selector 订阅。行为与现 App state 一一对应,**先做纯搬迁**(一个 PR,不改 UI),App 级 characterization 测试托底:
   - 轮询不改 activeId(I-2);401 登出、5xx 不登出(I-3);切换会话 xterm 实例不重建、WS 不重连(I-1);撤销关闭 toast 时长(I-18);`?session=` 深链(I-17)。
2. **`AppShell`**:桌面三栏 / 手机单栏 + 底部 Tab;**会话层 DOM 原样搬入**(`App.tsx:446-474` 的 sessions.map + docTabs.map,常驻 + hidden)。分诊队列、⌘K、下一个、FAB 挂在壳上。
3. **开关**:`localStorage.zmx_shell = 'v2' | 'v1'`;设置里可切换;S2 上线默认 `v2`,v1 保留至 v2 稳定两周后删除(另起清理 PR)。
4. S2 期间 overlay(files/git/events/memory)**保持现状**:仍由顶栏图标打开、条件挂载;S3 收编进 Context 面板。

### 4.8 S2 非目标

看板视图;卡片内回复;全局事件 WS;自然语言(LLM)命令;批量操作;多会话分屏;Context 面板(S3);时间线重做(S3);手机终端键栏重做(P0 做最小修复,完整在 S4)。

---

## 5. S3 对话体验(纲要,另起 spec)

- **前置**:AcpChatView WS 流程 characterization 测试(replay 清空、`replay_done` 定 busy/queue_mode/时钟、client_id 对账、退避计时、B14 验证),然后整体搬迁出 `useAcpSocket`,不改逻辑。1s 时钟下沉到 `TurnStatusBar`。
- **Turn 摘要卡**:默认显示结论首段 + 「改 N 个文件 · M 次工具 · 耗时 · $」;tool_use/result 配对为一张卡(状态、时长、截断后「看全文」);**单块展开**取代整会话切 full;`TurnGroupView` memo 比较器与 `stabilizeGroups` 原样保留(I-9);折叠/展开高度变化不计为用户上滚(I-11)。
- **Composer**:队列模式常驻 chip(受控于 `queueModes`,I-6),Interrupt 下发送按钮变色 + 提示;`/` 预设补全;preset 无 `{{input}}` 时覆盖前确认。
- **Context 面板**:Diff/文件/事件/记忆/度量,桌面右栏常驻、手机底部 Sheet;**按会话常驻挂载 + hidden**(修复 overlay 条件挂载丢状态);GitViewer 选文件过滤 diff(B6)、tab stale(B5)。
- notices 按时间穿插;成本精度统一。

## 6. S4 移动终端(纲要,另起 spec)

- 键栏可收起(记忆状态)、自定义键;选中文本「发给…」任意会话(取代固定 claude,`App.tsx:454`);GitViewer 手机布局。
- WebGL:仅 active + 最近 N(暂定 4)个终端加载 WebglAddon,其余 DOM 渲染;切换闪烁需实测(未验证)。
- 软键盘下状态信息收进顶栏。

---

## 7. 测试与验收

### 7.1 贯穿全部阶段的硬约束

1. 审计 §7 不变量 **I-1 ~ I-19 全部保持**;任一改动触及须在 plan 中写明如何保持并附测试。
2. 新 UI **不新开 WS、不在前端猜测后端状态**(queue_mode/busy/running 均取后端权威)。
3. 每处 stale/WS 相关迁移:**先注释守卫验红,再迁移**。
4. 首屏传输 gzip/br 后 ≤ 400KB(主包 + CSS,不含懒载 mermaid/katex)。
5. 后端新字段只做预计算;`list_sessions` 锁内零 I/O。
6. 每次上线 `./deploy.sh --build`;commit + push 先于 deploy。

### 7.2 成功指标

| 指标 | 目标 | 验证方式 |
|---|---|---|
| 到达下一个需要我的会话 | 手机 ≤ 1 击,桌面 1 键 | 手测 + 组件测(J/FAB) |
| 常用目录新建 agent 并发 prompt | ≤ 1 击 + 打字(⌘K) | 手测 |
| 非常用目录新建 | ≤ 3 击(或字面路径输入) | 手测 |
| 首屏判断各会话状态 | 不进会话即可见 状态/类型/片段/耗时 | 截图 |
| 字号 | 正文 ≥ 14px(手机),辅助 ≥ 12px;`text-[8-11px]` = 0 | lint 门禁 |
| 触控目标 | ≥ 44×44px;hover-only = 0 | 审查 + 截图 |
| 原生弹窗 | `alert/confirm/prompt` = 0 | grep |
| 手机终端 | 390×844 键盘收起时可视高度 ≥ 75%;浮层遮挡交互控件 = 0 | 截图回归 |
| 断线发送 | WS 断开时发送不丢文本(保留在输入框)并提示 | 组件测 |
| 包体积 | 首屏传输 ≤ 400KB | curl 验证 |

### 7.3 截图回归

用 gstack browse(headless)在 390×844 与 1440×900 两视口、暗/亮两主题,对登录后首页、分诊 Tab、Claude 会话、tmux 会话、⌘K 新建模式截图,存 `docs/superpowers/screens/<阶段>/`,每阶段 plan 的收尾步骤对比。**冒烟必须用 `--data-dir` 隔离**,不得指向线上数据目录(历史教训)。

---

## 8. 风险

| 风险 | 缓解 |
|---|---|
| zustand 搬迁破坏 I-1/I-2/I-3 | 先补 App 级 characterization 测试;纯搬迁 PR 不改 UI |
| 态势字段三 backend 语义不一致 | 在 `emit` 咽喉统一维护;四 backend 各一组 Rust 测试 |
| `pending_approvals` 回执不可观测 | §4.2 降级方案(前端派生) |
| CompressionLayer 影响 WS 升级 / 流式 | P0 实测 `/ws/*` 101 与流式端点 |
| Radix + React 19 StrictMode 细节 | S1 首个 primitive 落地即跑 StrictMode 组件测(未验证项) |
| 新壳回归无法快速回退 | `zmx_shell` 开关一键回 v1 |
| 分诊「error」误报(上一轮出错但用户已处理) | `lastViewedMs` 判定;看过即降级为 idle |
