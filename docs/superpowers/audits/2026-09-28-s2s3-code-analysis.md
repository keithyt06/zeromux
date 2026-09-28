# S2+S3 合并期只读代码分析

日期:2026-09-28 基线:`main` @ `025364f`(只读，未改代码)
对照:`specs/2026-09-26-frontend-triage-focus-redesign-design.md`(含 **v3 §0.5**,分析期间落盘)、`specs/2026-09-27-focus-session-experience-design.md`(§0.3 / §2 / §3)、`audits/2026-09-26-frontend-ux-audit.md` §7 I-1~I-19。
路径:Rust 相对 repo 根;前端相对 `frontend/src/`。标注「推断」的是读码得出、未实测。

> **读法**:§0.5 已吸收的断言(Kiro 已删、zustand 未装、320KB、无 App 级测试、`sessionControls` 只有两个方法等)这里不重复，只列**新增发现**和 **§0.5 仍与代码不符之处**。

---

## 0. 最关键发现(TL;DR)

1. **Crew 审批卡在线上大概率从不渲染(已存在的 bug,推断)**。`AcpEvent::Approval` 的字段是 `id`(`src/acp/process.rs:108-110`,枚举只有 `#[serde(tag="type", rename_all="snake_case")]`,见 `:24-26`,rename_all 不作用于变体字段)→ 线上 JSON 为 `{"type":"approval","id":…}`;前端读 `evt.approval_id`(`components/AcpChatView.tsx:440`),`if (!aid) break` 静默丢弃。`crewEventCases.test.tsx:24,40` 手造的是 `approval_id`,后端没有 Approval 序列化测试 → 两侧都绿、契约不通。**M5/M6「行内批准」的前提就是这条链路**,合并期首个 task 应先补序列化测试并修(后端加 `#[serde(rename="approval_id")]` 或前端读 `id`)。
2. **新会话永远收不到 `replay_done`**:`src/acp/ws_handler.rs:105,120` 只在 `has_history` 时发送。所以 useAcpSocket 的 characterization 第 2 项必须分「有历史 / 无历史」两个 case。AcpChatView 在 onopen 把 `replayingRef=true`(`:373`),只有 replay_done 才会清(`:660`)。**全新会话的 replayingRef 会一直停在 true**:`onScroll` 的上滚检测一直处于 armed(`:838`),`shouldStickToBottom` 可能被误用。这是现有语义，搬迁不能改，但 steps/arrivals 任何「replay 期间不记」的逻辑都不能依赖这个 ref。
3. **useAcpSocket 按 S3 §3.1 列出的返回值搬不动**。WS 逻辑写、渲染也读的量还有 `pushNotice`、`nowMs`、`ctxUsage`、`resolvedApprovals`、`metricsRefresh/bumpMetrics`,以及 scroll 相关的 6 个 ref;`pending` 是它的输入(§3.2 表)。onopen、replay_done、scrollBottom 三处共用 scroll ref,拆不开 → 要么把 scroll 门控一起搬进 hook,要么通过参数传入 `scrollRef` 和 `scrollBottom`。
4. **首屏余量实测 10.0KB**(`index-*.js` 311.3KB + css 8.7KB = **320.0KB / 330KB**,门禁参数 337920 B,`package.json` build 脚本)。M27 的懒载是本期唯一的腾挪手段，粗估可腾 **~25–35KB br**(§6.3)。**必须先懒载、后加新壳**,否则第一个加 AppShell 的 task 就会撞门禁。
5. **pending_approvals 后端只能做到近似**:Gateway 不回执，`post_json_ok` 丢掉 body,失败只 `warn`(`src/acp/crew_process.rs:311-322,562-570`)。M5 的方案可行，但 −1 应放在「WS 真正 send 了 approval」这一侧(`session_manager.rs:4007` 臂)，并接受 404/过期不被感知。还有一个耦合:Crew 断线重连会发 `Error{"连接中断，正在重连"}`(`crew_process.rs:524-528`),它算 boundary → 当前 turn 被记成 errored → **分诊把它显示为 `error`**。§1.3 有细节。

---

## 1. 后端态势字段(§4.2 / M2–M8)

### 1.1 现状:`GET /api/sessions` 返回什么

- 处理器 `src/web.rs:983-1006`:按 owner 过滤(admin 看全部),调 `list_sessions(filter)`,用 `host_tmux_all` 回填 `other_clients`(`:996-1001`),返回 `{sessions, host_tmux}`(`host_tmux` 仅 admin,`:1003-1005`)。
- `SessionInfo` 在 `src/session_manager.rs:385-406`,字段:`id, name, type(:390), cols, rows, work_dir, description, status: SessionMeta(:395), running, turn_state: Option<&str>, turn_started_ms, last_activity_ms, turns_completed: u32, source_task_id, tmux_name, tmux_origin, other_clients, peer_name`。
- `session_info_of` 在 `:656-683`:`turn_state/turn_started_ms` 取自 `s.running`(`:666-670`);`other_clients` 这里填 0(`:680`),由 web 层补;`peer_name` 仅 Claude,格式 `zmx-ai-<id6>`(`:640-643,681`)。
- **没有 `queue_mode`**:它存在 `RunningProcess.queue_mode`(`:286`),只经 `replay_done` 和 live 的 `queue_mode` 事件下发。I-6 不受影响，但意味着**非挂载会话的 queue mode 无从得知**。所有会话常驻挂载，所以现在没问题;如果将来做面板懒挂载，就需要注意。
- 前端类型 `lib/api/sessions.ts:7-26` 与后端一一对应(`source_task_id`/`peer_name` 在 TS 里可选，无害)。
- 陷阱:重启 hydrate 时 `last_activity_ms = now_millis()`,`turns_completed=0`,lifetime 三项归零(`session_manager.rs:2276-2281`)→ **部署后所有会话都显示「刚活跃」**,空闲组的排序整体失真一次(M10 已覆盖 turns_completed 部分，排序失真没提)。

### 1.2 咽喉:`emit` → `record_and_broadcast`

- 三个 fan-out 的每个事件都走 `emit`:Claude `spawn_acp_fanout :2764`(调用 `:2874`)、Crew `spawn_crew_fanout :3759`(`:3805`)、Codex `spawn_codex_fanout :4057`(`:4102`);UserPrompt 回显 `:3090 / :3888 / :4184`。
- `emit` 在 `:3555-3623`:只给 ContentBlock、Result、PeerMessage 盖 turn_id(`:3566-3570`,`with_turn_id` 在 `:3668-3676`)→ **Approval 没有 turn_id**,前端回退到 `activeTurnIdRef ?? 0`(`AcpChatView.tsx:445`)。在锁外序列化(`:3607`),再调 `record_and_broadcast`(`:2025-2063`:锁内写 scrollback + 淘汰 + `event_tx.send`,无 I/O ✅)。
- **绕过 emit 的路径**(M2 的 PostureDelta 覆盖不到，这里全部列出):

| 路径 | 位置 | 对态势字段的影响 |
|---|---|---|
| `emit_queued` / `emit_queue_mode` | `:3509-3518` / `:3529-3535` | 只广播;无影响 |
| emit 内 ephemeral 分支、Manager 已销毁兜底 | `:3611-3614`、`:3619-3622` | 只广播 |
| `resume_failed` | `:1853` 直接 `event_tx.send` + `push_scrollback :1909` | 不算 turn outcome;无影响 |
| `connected` / `replay_done` | `ws_handler.rs:98-100,134-140` | 每个连接单独发 |
| TurnOrigin / StdinEcho | `:2818-2828` 在 emit 前 `continue` | 无 |
| PTY | `broadcast_pty :2008-2015`;legacy `:1034` 直接调 `record_and_broadcast` | M2 已说「PTY 传 None」,**`:1034` 这个调用点也要改** |

- `record_and_broadcast` 的签名只接收 `String`(M2 已知);改签名时共有 4 个调用点:emit、`:1034`,以及 broadcast_pty 内部是否复用需要 plan 阶段 grep 确认。

### 1.3 各字段在三个 fan-out 里的真实数据源

| 字段 | 写入点(锁) | Claude | Codex | Crew | 注意 |
|---|---|---|---|---|---|
| `last_outcome` / `_ms` | `record_run_metric :817-833`(已在锁内;`RunMetric` 自带 outcome、ended_ms) | settle `:3016-3043` | `:4142-4159` | `:3846-3863` | `classify_outcome`(`src/run_metrics.rs:35-43`):有 intent 用 intent,否则 Result→Completed,Error/Exit→Errored;intent 由 `set_live_intent :3384` 写入。**只在 `settled.is_some()` 时记**(同一 turn 的第二个 boundary 不记);Claude SkipBoundary(`:2866-2871`)不 settle |
| `last_snippet` | M3:只取 Result.text | Result.text = `result` 全文(`process.rs:497-504`);正文本来就是整块(`:430` `streaming: None`,启动参数无 partial,`:172-190`) | Result.text = tools/call 全文(`codex_process.rs:795-803`);正文是 delta(`:679-688`) | Result.text = 本轮 chunk 累积(`crew_process.rs:145-158`) | 截断复用 `format.rs:10-17` 的 chars 截断;在**锁外**算好再传入(M2) |
| `current_step` | emit(tool_use)/ `apply_turn :587-611` 清 | summary 来自 `format_tool_use`(`process.rs:415-423`),**只认** Read/Edit/Write/Bash/Grep/Glob/Agent/Task(`format.rs:37-62`),其余为 None | name 固定是 `shell`/`apply_patch`,summary 为拼接的命令或文件列表，**不截断**(`codex_process.rs:278-300,331-351,738-748`) | **name = 命令串本身**(测试夹具 `crew_process.rs:687,695,787`),summary 取 `purpose`,没有才用 `format_tool_use`(`:98-101`) | 必须自行截断到 80 chars;格式 `name · summary` 对 Crew 会变成「命令 · 目的」,可以接受但会显得长 |
| `pending_approvals` | +1 在 emit(已持锁);−1 在 `:4007` 臂(新拿一次短锁);清零在 `apply_turn` 以及 `mark_fanout_ended :2632-2638` | 恒 0 | 恒 0 | 见 §1.4 | — |
| `lifetime_cost_usd` | `record_run_metric :827` 累加;现在只经 `GET /runs` 的 `lifetime` 导出(`web.rs:1301-1309`,`session_lifetime :864-868`) | 有 | **None**(`:3024-3026`) | **None** | 重启归零(`:2281`);run_metrics 只写不读回(`run_metrics.rs:205`) |

**Crew 重连误报 error**(新发现，推断):`crew_process.rs:524-528` 在 Gateway WS 断线时发 `AcpEvent::Error{"连接中断，正在重连"}`,属于 boundary → 如果恰好有 turn 在跑，就被 settle 成 Errored → `last_outcome=errored` → 分诊显示 `error`(判定 1 最高优先级)。而那一轮其实可能还在 Gateway 那边继续。建议 plan 里二选一:① 该 Error 不作为 boundary(同 F-CODEX-1 的思路，改成非 boundary 的 ContentBlock{error});② 接受误报。**①会改动 metrics 和 settle 语义，需要单独一个 task 并配三 backend 的 parity 测试。**

**interrupt 后重发的时序**:旧轮迟到的 boundary 在新轮运行中写入 `last_outcome=cancelled`(FIFO 正确)。分诊判定 1/5 都要求 `turn_state !== 'running'`,所以不会误显示，只是 `last_outcome_ms` 可能早于 `turn_started_ms`。**M10 的判定可以再加一条:`last_outcome_ms >= turn_started_ms`**(或者直接依赖 turn_state),更稳。

### 1.4 pending_approvals 回执链路

1. 浏览器 WS 发 `{"type":"approval",approval_id,action}`(`AcpChatView.tsx:315-320`)→ `ws_handler.rs:33-35,203-208` → `SessionInput::Approval`(`session_manager.rs:163`)→ Crew fan-out 臂 `:4007-4020` → `process.resolve_approval`(`crew_process.rs:654-658`)→ 事件循环里 detached spawn(`:562-570`)→ `POST {gateway}/api/approvals/{id}/{action}`(`:335-338`)→ `post_json_ok` **只看状态码，丢 body,失败只 warn**(`:311-322`),**结果不回 fan-out**。
2. zeromux 自己**没有**审批 HTTP 端点(`web.rs:28-99` 路由表)。
3. Gateway **没有 resolved 帧**(`normalize_frame` 的丢弃列表 `crew_process.rs:201-206`;`AcpChatView.tsx:141-143` 的注释)。过期时 POST 返回 404(见 `specs/2026-09-13-kiro-crew-backend-design.md:963`),但没有推送。

**结论**:−1 只能表示「经 zeromux 回答了」。在 IM/dashboard 上处理的、过期的、POST 失败的都要等 boundary/Exit 才清零。M5 已接受这一点。补充两点:
- 前端 `resolveApproval` **不论 WS 是否 OPEN 都写 `resolvedApprovals`**(`AcpChatView.tsx:315-320`)。M7 让它未 OPEN 时返回 false 且不写 state,这点要同步落实，否则行内「批准」在断线时会显示已批准，实际没发出。
- 同一个 approval 重复点击:后端的 −1 需要按 id 去重(饱和到 0 不够;两个挂起的审批里，点一个两次会把另一个也清掉)。建议 Session 上存 `pending_approval_ids: SmallVec<String>`,计数取 len。

### 1.5 确认队列按会话分组(M11)

- `GET /api/scheduled-tasks/confirmations`(`web.rs:65`,处理器 `:3644-3661`),查询在 `src/scheduled_tasks.rs:807-822`。每条是完整的 `TaskRun`,带 `session_id` 和 `task_id`(`:401-417`)。
- `trigger_run` 每次**新建会话**(`session_manager.rs:1405-1425`)→ session_id 与 run 基本 1:1,**会话被删后 run 行里的 session_id 悬空**(`remove_session → abort_active_run_for_session :1953-1957`)。M11 的「悬空 → 全局行」正好覆盖这种情况 ✅。

---

## 2. App.tsx:state 归属与 AppShell 迁移

### 2.1 现有 state / 副作用全表(`App.tsx`)

| 项 | 行 | 新家(M1) | 触及的不变量 |
|---|---|---|---|
| authState / user / initAuth(5xx 时 2s 重试) | 36-37, 87-111 | AppShell 或 `useAuth` | I-3 |
| sessions / hostTmux + `loadSessions`(唯一的 `resolveActivePane` 调用) | 38, 41, 113-128 | `useSessionsPoll` | **I-2**:只有显式路径才调 resolveActivePane |
| 3s 轮询(401 登出，其余忽略;**不写 activeId**) | 135-159 | `useSessionsPoll` | I-2 / I-3。注意:轮询是 `setInterval` + async,**没有 stale guard**,慢响应可能乱序覆盖(3s 间隔下可接受，搬迁不改) |
| peerNames(按内容 key memo) | 39-40 | AppShell | **I-9** |
| docTabs / docTabsRef / docTargets / nonceRef | 42-50 | AppShell(`useDocTabs`) | I-1(docTabs 常驻) |
| askAgentRequest | 49, 295-297 | **删除**(M24:改走 SendToMenu) | — |
| activeId | 51 | AppShell | I-2 |
| overlay / toggleOverlay | 52, 360-365 | `useContextPanelState`(M23) | I-1 |
| readCounts / baselineInit / hasUnread | 54, 58, 224-241 | `useReadState`(M10 改为 lastViewedMs) | — |
| metricsOpen | 57 | 删除(M23) | — |
| sessionControls / registerControls | 61-65 | `useSessionControls`(M7 扩展) | I-6 |
| queueModes / handleQueueModeChange | 73-76 | AppShell,下传给 FocusComposer | **I-6** |
| theme / isMobile(useIsNarrow)/ sidebarOpen | 77-79 | AppShell | — |
| confirmCount + 30s 轮询 | 80, 162-174 | 改为 `confirmsBySession`(M11),需要 `listConfirmations` 返回明细，不只 count | — |
| panel(admin/scheduled/push/prompts)条件挂载 | 81, 488-491 | AppShell;懒载(M27) | — |
| historyReq(Sidebar ⋯ → 终端历史) | 85, 405 | `sessionActions`「查看历史」(§0.5.4) | — |
| SW active_session 上报 ×2 | 177-186 | AppShell 原样 | **I-17** |
| push resync(visibility,1h 节流 + resync-needed) | 189-202 | 原样 | I-17 |
| SW `open_session` → setActiveId + `getSessionStatus → deepLinkView(git_dirty)` 写 overlay | 204-217 | 改为打开 ContextPanel Git「改动」(M26) | I-17 |
| `?session=` 深链 | 219-222 | 原样 | I-17 |
| handleRename(乐观写 sessions) | 243-251 | sessionActions | — |
| handleLegacyLogin(0 会话时自动建 tmux) | 253-266 | 原样 | — |
| handleCreate(vault / session;失败抛出) | 268-281 | ⌘K 新建、SendToMenu「新开」 | P0 B3 |
| handleOpenVault / handleDeleteDocTab / updateDocTabTitle | 283-320 | AppShell | — |
| handleDelete(tmux closeCheck confirm → delete → undo toast) | 322-348 | sessionActions「关闭」 | **I-18**(`:345` 时长公式) |
| handleApproved / handleLogout | 299-305, 350-354 | 原样 | — |
| handleSessionUpdate(SessionInfoBar 回写 description/status) | 356-358 | sessionActions「重命名/描述…」 | — |

### 2.2 渲染树(要搬的 DOM)

- Sidebar `:383-407` → Triage + ⌘K + 头部 ⚙ 菜单。
- SessionInfoBar `:410-438`(`key=activeSession.id`,切会话会重新挂载)→ FocusHeader + ContextPanel 开关 + composer chip。
- **会话层 `:452-487` 要原样搬**(I-1):`sessions.map` 外层 `absolute inset-0 hidden` 切换(`:457`);内层在 overlay≠none 时 hidden(`:459`),`active={isActive && view==='none'}`(`:461,463`)。
  - **关键耦合**:现在的 `active` 取决于 overlay。换成 ContextPanel 右栏后，主视图**不再被遮挡**,所以 `active` 应只等于 `isActive`。但手机上 ContextPanel 是 Sheet(`<dialog>` top-layer),对 TerminalView 的 resize/focus 语义有两种选择:① Sheet 打开时仍 active(xterm 在背后，不 resize,因为容器尺寸不变 ✅);② 置为 inactive。**建议 ①**。I-12 只看容器是否 0×0,Sheet 不会改变主区尺寸。桌面右栏展开会改变 cols → I-12 的 refit 路径(S3 §2.2 已提及)。
  - `onAskAgent` 写死 claude `:461`,M25 保留到 Plan B。
  - GitViewer 的 `onForward` 只对非 tmux 提供(`:467`)。
- overlay 四件条件挂载 `:466-470` → ContextPanel 常驻 + tab 懒挂载(修审计 §1.1)。**MemoryPanel 不接 sessionId**(`:469` 注释:Crew 记忆全局)→ 如果进 ContextPanel,每个 Crew 会话各挂一份，数据相同但彼此不同步(见 §4)。
- docTabs `:474-481`(VaultReader,常驻)。
- `<Toaster/><DialogHost/>` `:492`,挂一次。

### 2.3 AppShell 替换时受影响的不变量

- **I-1**:会话层 DOM 与 key 必须原样;ContextPanel 必须按会话常驻。现有**没有**任何 App 级测试(`grep "import App"` 只有 `main.tsx`)→ §0.5.6-1 的 characterization **必须对旧 App 先写**。现在 `fakeWs` 的 `readyState` 默认就是 OPEN、`close()` 不触发 onclose(`test/fakeWs.ts:22-45`),「WS 不重连」的断言要改用 `all.length` 不变来判断。
- **I-2**:`resolveActivePane` 只在 `loadSessions`(`:121`)里调;`docTabs.test.ts:63` 锁了「轮询不调它」。分诊排序变化不写 activeId,J/FAB 只在用户动作里写。
- **I-3**:`initAuth` 在 catch 分支重试(`:102-108`);轮询只在 `isAuthError` 时登出(`:148`)。
- **I-6**:`queueModes` 默认值 `'collect'`(`:425`)是显示兜底。chip 在没收到 replay_done 的新会话上会显示 collect,和后端默认一致 ✅。
- **I-9**:`peerNames` 的 memo 必须保留。它是 TurnGroupView memo 比较器的字段之一(§3.3)。
- **I-17**:四个 SW / 深链 effect 原样;M26 只改 overlay 写入目标。
- **I-18**:`handleDelete` 整段搬进 sessionActions,公式不变;`undoCloseToast` 恢复时调 `loadSessions()` + `setActiveId(id)`(`:346`)。
- `handleDelete` / `handleDeleteDocTab` 捕获 `sessions/docTabs/activeId` 闭包(`:348,316`)。搬进 `sessionActions` 注册表时，注册表必须读最新值(ref 或每次 render 重建)，否则 TriageRow ⋯ 会拿到旧闭包。

### 2.4 onAskAgent 与三条「发给 agent」路径

- **A 终端 → 新开 Claude**:`App.tsx:461` → `TerminalView.tsx:43,701-705` → `HistoryView.tsx:129-135`(有选区取选区，否则取最后 200 行，先经原生 `confirm` 提示密钥)→ `lib/historyToAgent.ts:6-24`。M25:本期保留。
- **B 笔记 ⚡ → Sidebar 新建流程**:`VaultReader.tsx:159` → `App.tsx:478` `handleAskAgent :295-297` → `askAgentRequest`(`:49,404`)→ `Sidebar.tsx:272-284` 按 nonce 消费 → `askAgent`(`:217-219`)→ pick-type(隐藏 Terminal)→ pick-prompt(`lib/askAgent.ts:31-35` 预填)。另有 Sidebar 内部搜索结果 ⚡(`Sidebar.tsx:576`)和「在此开 agent」(`:577`,`openHere :220-222`)。**Sidebar 删除后 B 的消费者消失**,M24 要求同一提交改接。
- **C Git → 本会话**:`App.tsx:467` → `sessionControls[sid].sendPrompt`;`GitViewer.tsx:274-281,344-347`(撤销前原生 `window.confirm`,`:276`)。
- **SendToMenu 要统一三种语义**:新开(A/B)、新开并预填 ⌘K(B,M24)、发给已有会话(C,返回 false 时 toast)。B 的「预填 ⌘K」依赖 ⌘K 能接收 `{type?, dir, prompt}` 初始值，这是 ⌘K 的接口需求。

---

## 3. AcpChatView:useAcpSocket 抽取边界

### 3.1 WS 生命周期(精确行号)

- **WS effect `:333-419`**,deps `[sessionId]`(`:418` 关掉了 exhaustive-deps)。
- **connect / onopen `:339-375`**:
  - `setWsStatus({open, now})`(`:345`);稳定 3s 后 `attempt=0`(`:353-354`,I-4)。
  - **清空**:`setEvents([])`(`:357`)、`seenClientIds.clear()`(`:358`)、`activeTurnIdRef=null`(`:359`)、`setNotices([])`(`:360`)、`setBusy(false)`(`:361`)、`setTurnStartedMs(null)`(`:362`)、`queueModeRef='collect'`(`:370`,**不上报 App**,等 replay_done 的 adopt)、`replayingRef=true`(`:373`)、`userScrolledUpRef=false`(`:374`)。
  - **不清**:`queuedCount`、`lastEventMs`、`nowMs`、`ctxUsage`、`resolvedApprovals`(后者有意保留,`:141-143`)。
- **onmessage `:377-382`**:`JSON.parse` → `handleEvent`,外包 `try{}catch{}`,**handler 里抛异常也会被吞**(characterization 要知道这一点)。
- **onclose `:384-406`**:
  - `wsRef=null`(**无条件**,B14 同类问题;Acp 侧有没有旧 socket 的迟到 close 需要验证)。
  - 如果已在 reconnecting 就保留 `since`(`:389`),否则设 `{reconnecting, now}`。
  - 清 stableTimer;`setBusy(false)`、`setTurnStartedMs(null)`(`:396-397`)。
  - `delay=min(1000*2**attempt,10000)`,`attempt++`,`setTimeout(connect)`(`:401-405`)。
- `onerror → ws.close()`(`:407`);cleanup `disposed=true` + 清 timer + close(`:412-417`)。
- **Acp 侧从不设 `'ended'`**(只有 TerminalView 设,`TerminalView.tsx:518`)。S3 §3.1 所说「ended 不重连」在 Acp 侧只对应 `disposed`。exit 事件后 WS 仍然连着。

### 3.2 handleEvent `:421-664`

deps `[pushNotice, appendEvent, bumpMetrics, adoptQueueMode, settleActiveTurn]`(`:664`),在同一 sessionId 下全部稳定(`adoptQueueMode :216-219` 只依赖 sessionId;`pushNotice/appendEvent :237-250` 只依赖 `scrollBottom`,deps 为 `[]`)。
**现在没有用 ref 保证最新**,靠的是 effect 只随 sessionId 重建、捕获首次 render 的闭包。S3 §3.1 说「handleEvent 闭包用 ref 保证最新」**不是只搬不改**。建议搬迁 PR 保持现状，只加注释说明依赖全稳定;改成 ref 另起 task。

| type | 行 | 写 |
|---|---|---|
| queue_mode | 423-435 | `adoptQueueMode`(ref + 上报 App) |
| approval | 437-458 | append `content_block/approval`,`turn_id ?? activeTurnIdRef ?? 0`;`setLastEventMs` |
| context_usage | 460-466 | `setCtxUsage`(total>0) |
| system | 468-484 | queued → `setQueuedCount`;`resume_failed` → pushNotice;其余(含 `connected`)丢弃 |
| peer_message | 486-498 | activeTurnId、append、busy、`turnStartedMs ??=`、nowMs、lastEventMs |
| notice | 500-504 | pushNotice |
| user_prompt | 506-527 | 非 MAX_SAFE 时写 activeTurnId;client_id 在 seen 里 → **就地改写**乐观事件的 turn_id(`:515-523`,I-10),否则 append |
| content_block | 529-552 | 同 peer_message;**不清** queuedCount |
| result | 554-564 | activeTurnId=null、append、busy=false、turnStartedMs=null、queuedCount=0、bumpMetrics |
| error / exit | 566-581 / 583-593 | `settleActiveTurn()`(`:326-331`,注入空 result)+ pushNotice + 重置 + bumpMetrics |
| replay_done | 595-662 | adopt(`:603-605`);`busyAfterReplay`(`:613`,`lib/collectHint.ts:39-41`);running 时 `nowMs/turnStartedMs ??=/lastEventMs=replaySilenceBaseline`(`:615-630`,`collectHint.ts:57-62`);否则 turnStartedMs=null;**无条件 `setQueuedCount(0)`**(`:636`);`shouldStickToBottom` → 滚底 + 2s ResizeObserver follow(`:639-658`);`replayingRef=false`(`:660`) |

### 3.3 控制面

- `sendPrompt(text): boolean`(`:696-733`,deps `[appendEvent, pending]`):
  - 未 OPEN 返回 false(`:697`);`buildPromptWithAttachments(text, pending)`。
  - cid 入 seen;append 乐观事件 `{user_prompt, turn_id: MAX_SAFE_INTEGER, client_id}` 并 force 滚动(`:706`)。
  - send;`setPending([])`。
  - `wasBusy=busyRef`;`setBusy(true)`;`shouldSeedTurnClock(wasBusy, queueModeRef)`(`lib/stuck.ts:90-92`)为真时重置三个时钟。
  - `sendPrompt('')` 用于只发附件(`:914`)。
- `interrupt`(`:754-760`):OPEN 才发，但 **`setQueuedCount(0)` 无条件执行**(M7 已点名)。
- `setQueueMode`(`:762-775`):OPEN 且 send 之后才 adopt(I-6 ✅)。
- `resolveApproval`(`:315-320`):OPEN 才发，但 **`resolvedApprovals` 无条件写**(M7 应一并修，§1.4)。
- **registerControls effect `:779-782`**:deps 含 `sendPrompt`,后者 deps 含 `pending` → **附件每变一次就重新注册一次**。M7 扩展成 5 个方法后，如果 `pendingApprovals()` 读 state,还会随 events 变化频繁重新注册 → 建议 controls 对象用 ref 持有最新实现，注册只随 sessionId。**这是逻辑变化**,放在搬迁之后单独做。

### 3.4 状态 / ref 耦合表(hook 返回值设计)

| 名称 | WS 逻辑读写 | 其他消费者 | S3 §3.1 列了? |
|---|---|---|---|
| events | 357,443,491,518,525,531,556,330 | groups memo 115-121 | ✅ |
| notices + **pushNotice** | 360, 247-250 | 渲染 868;**mem 回调 287/300 写入** | notices ✅ / pushNotice ❌ |
| busy / busyRef(737) | 多处 | 渲染 878、RunMetricsPanel 826 | ✅ |
| turnStartedMs / lastEventMs | 多处 | 渲染 748-752、RunMetricsPanel 825 | ✅ |
| **nowMs** + 1s 时钟(742-746,只在 busy 时) | 495,547,620,727 | 仅渲染 748-752(elapsed/stuck/silence → 状态栏与中断 878-898) | ❌ |
| queuedCount / wsStatus | — | 渲染 873 / ConnectionBar 871 | ✅ |
| **ctxUsage** | 463 | 渲染 812-818 | ❌ |
| **resolvedApprovals** | 319 | TurnGroupView prop 863 + memo 比较 1162 | ❌ |
| **metricsRefresh / bumpMetrics / metricsDebounce** | 562,579,591 | lifetime effect 180-189、RunMetricsPanel 827、卸载 801 | ❌ |
| **pending**(附件) | sendPrompt 读写 698/708 | 上传 683、渲染 900-918 | ❌(应作 hook 输入) |
| **scrollRef / replayingRef / userScrolledUpRef / followingRef / roRef / roTimerRef** | 373-374, 639-660, scrollBottom 237-245 | onScroll 832-844、卸载 804-808 | ❌ |
| queueModeRef / seenClientIds / activeTurnIdRef / wsRef / onQueueModeChangeRef(214-215) | 仅内部 | — | 内部 |

- **TDZ**:`pushNotice :247` 必须在 `rememberMem :269-292`、`forgetMem :294-305` 之前(`:252` 注释)。抽出后 mem 回调必须写在 `useAcpSocket(...)` 调用之后，并从返回值取 `pushNotice`。`crewMemoryWrite.test.tsx:97-105` 锁了这条回执路径。
- **1s 时钟下沉**(S3 §2.3):nowMs 只被渲染消费，可以整体移进 `TurnStatusBar`,但 **nowMs 在事件到达时也被写入**(`:495,547,620,727`),作用是让 elapsed 立刻刷新。下沉后改为「TurnStatusBar 自己 tick + 以 turnStartedMs/lastEventMs 为输入」即可，语义等价。stuck 同时被中断按钮使用，也要一起下沉。

### 3.5 渲染侧依赖面

- `TurnGroupViewImpl :1105-1150`:`partitionBlocks(group.blocks, density)`;BlockView **key=下标**(`:1128`);cost 显示在 `:1141`。
- **memo 比较器 `:1152-1166`**:`group, agentName, density, onExpand, resolvedApprovals, onResolveApproval, peerNames` 全部用 `===`。调用处 `key=g.turnId`(`:858`)。**乐观气泡 key=MAX_SAFE_INTEGER,回显改写 turn_id 后 key 变化 → 整组重新挂载**。TurnView 如果有「展开态」local state,会在回显那一刻丢失。影响不大(刚发出，还没展开),但测试要知道。
- **`stabilizeGroups` / `groupSignature`**(`lib/transcript.ts:142-179`):签名为 `complete#cost#prompts(fromName:text)#blocks(type:textLen:summary:name)`,**不含 input、approvalId**。steps.ts 用 input 推 touchedFiles 没问题(input 不会在同一 block 内变化),但**签名不含 approvalId**:同一 turn 内 approval id 变化不会触发重渲染(实际不会发生，记录在案)。
- **density**:只在 AcpChatView 内，每实例一个 `useState('concise')`(`:191`),**只能切到 full,没有切回去的路径**(`:200`);只有提示条持久化 `zeromux:density-hint`(`:193-199,847-855`)。`lib/density.ts:11-27` 的 concise 模式会**丢掉 thinking 并把 tool_use 重建为只剩 `{type,name,summary}`**(`:20-22`,去掉 input)→ **steps.ts 必须吃原始 `group.blocks`,不能吃 `partitionBlocks` 的输出**。`density.test.ts` 按 §0.5.6-2 转写进 steps.test。
- BlockView `:1190-1330`:thinking 在未完成时 `open`;tool_use input JSON 截 2000;tool_result 截 4000;approval 卡 `:1257-1307`(44px,testid `approval-approve/reject`,缺 id 时显示黄字提示 `:1302`);未知 block_type 返回 null;`TOOL_ICONS :1181-1188` 缺 MultiEdit/shell/apply_patch。
- NoticeBubble `:1168-1178`;`Notice` 没有 turn_id(`:32`)→ 「notices 按时间穿插」(已砍)本来就缺数据。
- 滚动:`lib/scrollReplay.ts:5-7,16-19(NEAR_BOTTOM_PX=80),31-33`;scrollBottom 同步测距 + rAF(`:237-245`);onScroll `<4`(`:832-844`)。

### 3.6 transcript 结构与 backend 差异(给 lib/steps.ts)

- 类型(`lib/transcript.ts`):
  - `WireEvent :7-22`(含 `approval_id`,见 §0-1 的 bug)。
  - `Block :24-38`,type 取值 `text|thinking|tool_use|tool_result|error|approval`,外加 text/name/input/summary/approvalId。
  - `TurnGroup :40-47`:turnId、userPrompts `{text,clientId?,fromName?}[]`、blocks、complete、cost?、`assistantText()`。
- `foldTranscript :59-137`:只合并「streaming 且 text/thinking 且与上一块同类型」的块(`:100-103`);**tool_use/tool_result 平铺，不配对**;result 置 complete + cost,如果流式文本不含 result 文本就追加一个 text 块(`:106-131`)。**顶层 error/exit 不进 events**(只注入空 result)→ **TurnGroup 不知道本轮是出错结束的**。TurnSummaryCard 要显示「出错」,需要新增关联:onError 时在 events 里 append 一个带 turn_id 的 `content_block/error`,或者让 settleActiveTurn 注入的 result 带 `is_error` 标记。**这是 S3 §3.4「出错 turn」的数据前提,spec 没写。**

| | Claude(`process.rs`) | Codex(`codex_process.rs`) | Crew(`crew_process.rs`) |
|---|---|---|---|
| tool_use | name ✓,**原始 input 转发**(`:429`),summary=`format_tool_use`(`:415-420`) | name=`shell`/`apply_patch`,**input=None**,summary=argv 拼接 / changes 键 `", "` 拼接(`:278-300,331-351,738-750`) | **name=命令串**,input=`input_preview` 解析的 JSON,summary=purpose \|\| format_tool_use(`:80-115`) |
| tool_result | **丢弃**(`:442-448`,测试 `:643-652`) | name 同上;text=输出+`[exit: N]` / `✓ applied`/`✗ failed`(`:302-326,354-375,751-763`) | name=tool,text=output/result/content/text 中第一个有的(`:121-136`) |
| 工具 id | 无 | 上游有 `call_id`(夹具 `:1151,1167,1189,1200`),**被丢** | 上游有 `tool_call_id`,只用于去重(`:83-92`),不转发 |
| 正文 / thinking | 整块;thinking 先读 `thinking` 字段(`:399-408`) | delta `streaming:true`(`:680-687,698-705`) | chunk `streaming:true`(`:62-77`);无 thinking |
| 行内 error | — | ContentBlock error,非 boundary(`:648-660,727-734`) | — |
| Result | text + `total_cost_usd`(`:497-504`);`is_error`→Error(`:486-494`) | text,**cost None**(`:795-800`) | 累积 text,**cost None**(`:147-158`) |
| 丢块 | — | notify `try_send` 满了就丢(`:78-92`);两个 turn 之间收到的工具事件丢弃(`:845-852`) | — |
| 未知块 | `server_tool_use` 等原样透传(`:390-393`),BlockView 渲染 null | — | — |

**对 S3 §0.2 / §3.2 断言的修正**:
- 「三 backend 均无 `tool_use_id`」只在 **wire 层**成立:Codex、Crew 上游都有 id,只是 zeromux 丢了。如果要稳配对，后端透传一个 `tool_id` 是纯新增字段、成本很低(S3 把「后端 tool_use_id 协议改造」列为非目标，建议重新评估)。
- 「Codex 串行」不是 zeromux 保证的，而且 `try_send` 会丢掉 ToolUse/ToolResult 中的一个 → 配对规则必须容忍孤儿 result(没有前驱 use)。
- Crew 按「同名」配对 = 按命令串配对，同一命令连续两次会配错(影响有限)。
- touchedFiles:`MultiEdit/NotebookEdit` 的 summary 是 None(`format.rs:37-62`),只能读 `input.file_path/notebook_path`(Claude 有 input ✅);Codex apply_patch 的 summary 用 `", "` 拼接(`:331-351`),**应按 `", "` 拆，不能按空白拆**(路径可能含空格)。路径是相对还是绝对取决于 Codex 的 changes 键，代码里看不出来，要实测。
- steps 的「arrivals」已被 §0.5.5 砍掉 ✅(否则与 §0-2 的 replayingRef 问题冲突)。

### 3.7 现有测试对 characterization 六项的覆盖

- `test/fakeWs.ts:22-45`:`readyState` 默认 1(OPEN),**不 fireOpen 也能 send,onopen 清理也不会跑**;`close()` 只设 readyState=3,**不触发 onclose**;有 `emit/fireOpen/fireClose/all[]`;测试里无 StrictMode(只有 `main.tsx:14`)。
- 挂载 AcpChatView 的测试:`acpConnection.test.tsx`、`crewEventCases.test.tsx`、`crewMemoryWrite.test.tsx`、`crewSessionType.test.tsx:81-88`(**读源码断言 `agentType?:` 行 → Props 接口必须留在 AcpChatView.tsx**)、`acpHeaderLifetime`。
- 纯函数测试:`transcript.test.ts`、`density.test.ts`、`scrollReplay.test.ts`、`collectHint.test.ts`、`stuck.test.ts`、`wsStatus.test.ts`。

| # | 项 | 现状 |
|---|---|---|
| 1 | onopen 清空 | ❌ 无组件级测试 |
| 2 | replay_done 按后端定状态 | 只有纯函数测试;❌ 组件级;**需加「无历史 → 不发 replay_done」case** |
| 3 | client_id 对账 | `acpConnection:48-58` 只验证 "You" 出现;❌ turn_id 改写 |
| 4 | 退避 1/2/4/8/10/10 + 3s 归零 | `acpConnection:35-46` 只覆盖首个 1000ms;❌ 其余 |
| 5 | 断线 sendPrompt=false | ✅ `acpConnection:20-33` |
| 6 | ConnectionBar since 跨重试保持 | ✅ `acpConnection:35-46` |
| — | interrupt / setQueueMode 只在送达后 adopt / registerControls / error·exit settle / peer_message | ❌ 全无(I-6/I-19 相关，建议补进 characterization) |

---

## 4. 旧组件去留与 stale 守卫

| 组件 | 现挂载 | 结论 | 要点(file:line) |
|---|---|---|---|
| `Sidebar.tsx`(973 行) | 常驻 `App.tsx:383-407` | **拆后删** | 会话行 `:419-465`(`TurnDot :64-78` 调 `isStuck`;`relativeTime :54-61` 与 `lib/format.ts` 重复);折叠栏 `:292-359`;本机 tmux `:496-521`;**新建六步状态机** `:91,107-136,163-269,535-924`(**`creatingRef/runCreate :135,245-259` 必须原样迁到 ⌘K**,测试 `Sidebar.newflow.test.tsx:85`);askAgentRequest `:272-284`;调度器健康 `usePolling` `:145-148`;header `:383-399`;设置 `:926-956`。自身无 reqRef,目录浏览/搜索走 `useDirBrowser :155` / `usePathSearch :159-161` |
| `SessionRowMenu.tsx` | `Sidebar.tsx:467` | **删**,菜单项并入 `sessionActions` | 测试 `SessionRowMenu.test.tsx:14,24,36`(:36 窄屏改名焦点 T12 的语义要移植) |
| `SessionInfoBar.tsx`(235 行) | `App.tsx:410-438` | **删** | 手动状态 `:36-46,52-67,93,192-210`;description 编辑 `:50,59-63,69-72,95-107`(§0.5.4 已给新家);5 图标 `:109-170`;peer 复制 `:176-191`(直接用 `navigator.clipboard`);队列 select `:213-229`(测试 `SessionInfoBar.queuemode.test.tsx:26,50` → 移植到 chip)。无 stale 守卫。**同名 `StatusDot :43`**(M28) |
| `GitViewer.tsx`(578 行) | 条件挂载 `App.tsx:467` | **改后复用**(Git tab) | 手写 tab `:46,122-144` → SegmentedControl;`defaultGitTab(git_dirty)` `:94-100`(`lib/gitviewer.ts:1-3`)与 M26 深链重合;**`w-80` `:157,294` 放不进 360px 右栏**;「让 agent 处理」`:344-347`(原生 confirm `:276`)→ SendToMenu。守卫:`selectedHashRef :40,71,79,84,89`(`GitViewer.stale.test.tsx:22`);`wtReqRef :111-116`(`GitViewer.worktreeStale.test.tsx:24`);转发 `GitViewer.forward.test.tsx:10` |
| `FileBrowser.tsx`(572 行) | 条件挂载 `App.tsx:466` | **改后复用**(文件 tab) | `w-72 max-w-[40%]` `:333` 在窄栏要改成上下叠放;root 持久化 `zeromux:fb-root:<sid>` `:23,75-77`;原生 confirm/prompt/alert `:229,243,274,282,288,301,308,319`。守卫:`openReqRef :101,147,195,204,209,298,316` + listing ignore-flag `:124-141`(`FileBrowser.test.tsx:97,125,152,224`) |
| `AgentDashboard.tsx` | 条件挂载 `App.tsx:468` | §0.5.5 默认**删** | `useLatestRequest :48`(`AgentDashboard.stale.test.tsx:23`)。**删掉组件时，这个 stale 测试也会跟着删 → 「stale 测试原样通过」的清单要同步去掉它** |
| `RunMetricsPanel.tsx` | AcpChatView `:822-828` 内联(`showMetrics`) | **改后复用**(运行 tab) | props `{sessionId, turnStartedMs, running, refreshKey}` `:8-16`。挪到 ContextPanel 后，这三个值要从 AcpChatView(hook)**往上传给 App 或 ContextPanel**,新增一条 AcpChatView→外部的数据通道(可以放进 sessionControls,或新增 `onTurnStateChange`)。`useLatestRequest :61`(`RunMetricsPanel.stale.test.tsx:32,68`) |
| `MemoryPanel.tsx` | 条件挂载 `App.tsx:470`(仅 crew,无 sessionId) | 本期保留为 Sheet(§0.5.5) | `useLatestRequest :24`(`MemoryPanel.stale.test.tsx:32`;`crewMemoryWrite.test.tsx:136,147,158,185`) |
| QuickMemoryPopover(**不是独立组件**) | 内联 `AcpChatView.tsx:128-140,253-305,973-1047`,Brain 按钮 `:1076-1088` | 保持内联或抽出 | **`memReqRef :139,254,257,264,277,296` 是手写守卫，没有 stale 测试** → R11 要求迁移前补测试并验红 |
| `PromptManager.tsx` | Sidebar `:912`、AcpChatView `:930`、PromptsSheet `:16` | **原样复用** | 纯展示;入口收敛到 `/` 列表底部「管理…」→ `PromptsSheet`。三个入口各持有一个 `usePromptPresets()`(Sidebar `:120`、AcpChatView `:124`、PromptsSheet `:10`),`useLatestRequest` 在 `lib/usePromptPresets.ts:31`(测试 `:43,61`) |
| `Composer.tsx` | AcpChatView `:1049`、TerminalView `:716` | **原样复用**,作 FocusComposer 底座 | `rightSlot` + `onSend` 返回 false 保留输入 |
| `QuickTargets.tsx` | Sidebar `:585`、DirectoryPicker `:63`、VaultReader `:176` | 复用(⌘K 空状态) | **`onPickWithPrompt` 依赖 Sidebar pick-prompt 步骤**(`Sidebar.tsx:592-598`)→ ⌘K 要接住。守卫 `:41-64`(`QuickTargets.test.tsx:48`) |
| `SearchResults.tsx` | Sidebar `:565`、VaultReader `:154` | 复用 | `onAskAgent`(⚡ `:115`)改接 SendToMenu;`onOpenHere :116-117` |
| `DirectoryPicker.tsx` | FileBrowser `:560`、ScheduledTasksPanel `:520` | 复用 | Sidebar `:737-821` 是它的重复实现(随 Sidebar 删除) |
| `HistoryView.tsx` | TerminalView `:701` | Plan B | 原生 confirm `:132` |

### 4.1 stale 测试清点(「7 个」对不上)

- `*.stale.test.tsx` 实际 **5 个**:AgentDashboard、DirectoryPicker、GitViewer、MemoryPanel、RunMetricsPanel(`components/__tests__/`)。
- 文件名含 stale 但 glob 匹配不到:`GitViewer.worktreeStale.test.tsx`。
- 其他含 stale/reqRef 断言的:`FileBrowser.test.tsx:97,125,152,224`、`VaultReader.test.tsx:43`、`QuickTargets.test.tsx:48`、`Sidebar.search.test.tsx:90`、`Sidebar.newflow.test.tsx:73,85`、`lib/__tests__/{usePromptPresets:43,61, usePathSearch:35, useAsyncResource:19-60, useDirBrowser:11,20, useLatestRequest:6,13}`、`markdown/__tests__/MermaidBlock.test.tsx:65`、`lib/__tests__/docTabs.test.ts:63`(I-2)。
- **建议**:§0.5.6-2 把「7 个 `*.stale.test.tsx`」改成**显式文件清单**;AgentDashboard 如果删掉，它的 stale 测试也从清单里去掉;Sidebar 的两个断言按 §0.5.6-2 移植。

### 4.2 删除 Sidebar / SessionInfoBar 后要改的测试

`Sidebar.newflow.test.tsx`、`Sidebar.search.test.tsx`(含 `:163` 改名输入 16px、`:172/178` askAgentRequest)、`SessionInfoBar.queuemode.test.tsx`、`SessionRowMenu.test.tsx`;**`crewSessionType.test.tsx:48-55` 直接读 `Sidebar.tsx` 源码**,断言 `case 'crew': return <CrewIcon`、`Kiro Crew`、恰好 4 个 `selectType(...)`(**§0.5.6-2 说它「原样通过」,这不可能**,必须改为指向 ⌘K/Triage 的新文件);`crewMemoryWrite.test.tsx` 只有在 MemoryPanel 形态变化时才需要改。

### 4.3 S1 产物现状

- `components/ui/index.ts` 已导出:Dialog、Sheet、DialogHost/confirm/promptText、Toaster/toast、Popover、Menu、IconButton、Tooltip、Kbd、Badge、SegmentedControl、Skeleton。**没有 StatusDot、PaneStatus**(按 R12 在本期实现)。
- `lib/` 已有:`useLatestRequest`、`useAsyncResource`(**尚无组件使用**)、`usePolling`、`useMediaQuery/useIsNarrow/useIsTouch`、`http.ts`、`format.ts`、`useDirBrowser`、`usePathSearch`、`attachCommand`、`lib/api/*` 拆分(没有 `api/push.ts`,push 在 `lib/push.ts`)。
- **缺**:`lib/sessionActions.ts`、`lib/sendTargets.ts`、`lib/triage.ts`、`lib/fuzzy.ts`、`lib/steps.ts`,以及全部新壳组件。

---

## 5. 手动 Blocked/Done(R24)

- **前端**:类型 `SessionMetaStatus = 'running'|'done'|'blocked'|'idle'|'ended'`(`lib/api/sessions.ts:5`),`SessionInfo.status`(`:15`);写入只有 `SessionInfoBar.tsx:52-57,65-67`,经 `updateSession(id,{status})` 发 `PATCH /api/sessions/{id}`(`lib/api/sessions.ts:116-126`,`renameSession :128-130` 共用同一函数);展示只有 `SessionInfoBar.tsx:93`(StatusDot)与 `:201`。**Sidebar 不显示 status**;没有 localStorage key;测试不断言 blocked/done。
- **后端**:`Session.status: SessionMeta`(`session_manager.rs:309`,定义 `:31-39`),**只在内存**(sessions 表无 status 列,`session_store.rs:13-30,44-66`;`apply_meta :614-634` 只持久化 name/description);PATCH 处理器 `web.rs:1218-1264`(`patch_status_allowed` 禁止写 Ended,`:1227-1229`)。
- **服务端会覆盖**:ensure_running → Running(`:1882`)、fan-out 退出 → Idle(`:2636`)、重启 → Idle(`:2263`)、tmux 消失 → Ended(`:2330`)、revive → Idle(`:2348`)。**也就是说手动 Done/Blocked 今天在下一次重生时就丢了**,删掉它没有任何数据损失 ✅。
- 删除点:前端删 SessionInfoBar 即可;后端字段与 PATCH 的 `status` 保留(§0.5.4)。`SessionInfo.status` 在分诊里**不要当作 attention 输入**(它是服务端生命周期与旧手动值的混合)。

---

## 6. 风险清单

### 6.1 spec 断言与代码不符(类似之前的 I-12)

| # | spec 位置 | 断言 | 代码实情 |
|---|---|---|---|
| D1 | 总 spec §4.4 / M6 | 「批准」复用 ApprovalCard 同一路径 | **该路径大概率从未工作**(§0-1,`process.rs:108-110` vs `AcpChatView.tsx:440`) |
| D2 | S3 §3.1 | 「handleEvent 闭包用 ref 保证最新」且只搬不改 | 现状不是 ref,靠 `[sessionId]` effect 与全稳定 deps(`:418,664`);改成 ref = 逻辑变化 |
| D3 | S3 §3.1 | hook 返回 11 项 | 至少还缺 pushNotice、nowMs、ctxUsage、resolvedApprovals、metricsRefresh 与 scroll refs,且需要 pending 作输入(§3.4) |
| D4 | S3 §3.1-1/2 | onopen 清空 + replay_done 定状态 | 新会话**没有** replay_done(`ws_handler.rs:120`);onopen **不清** queuedCount/lastEventMs/ctxUsage(`:357-374`) |
| D5 | S3 §3.1 「ended 不重连」 | — | Acp 侧没有 ended 状态;只有 disposed |
| D6 | S3 §0.2 | 三 backend 无 tool_use_id;Codex 串行 | 上游都有 id(被丢);Codex 可能丢块(`codex_process.rs:78-92`) |
| D7 | S3 §3.2 | apply_patch summary「按逗号/空白拆」 | 实际用 `", "` 拼接(`codex_process.rs:331-351`),按空白拆会切坏路径 |
| D8 | S3 §3.2 | Crew tool 按 `name` 配对 | Crew name 是命令串(`crew_process.rs:687`) |
| D9 | S3 §3.4 | 出错 turn 显示错误 | TurnGroup 无出错信息(顶层 error 只变成没有 turn_id 的 Notice + 空 result,`transcript.ts:59-137`,`AcpChatView.tsx:326-331`) |
| D10 | §0.5.6-2 | `crewSessionType` 原样通过 | 它读 Sidebar 源码(`crewSessionType.test.tsx:48-55`),删 Sidebar 必失败 |
| D11 | §0.5.6-2 / S3 §5.1 | 「7 个 `*.stale.test.tsx`」 | 实际 5 个(+1 驼峰命名);AgentDashboard 删除会再少 1 个 |
| D12 | 总 spec §4.3 判定 1/5(M10) | 按 last_outcome 判 error | Crew 重连 Error 算 boundary → 误报 error(`crew_process.rs:524-528`) |
| D13 | 总 spec §4.3 空闲组排序 | 按 last_activity_ms | 重启后全部 = now(`session_manager.rs:2276`) |
| D14 | S3 §2.2 「改动 tab 复用 `/api/sessions/{id}/git` 系」 | — | ✅ 无误(仅记录:GitViewer `w-80` 与 360px 右栏冲突,`:157,294`) |
| D15 | 项目 CLAUDE.md | 三个 agent CLI(Claude/Kiro/Codex) | Kiro 已删(`src/main.rs:53-56`);M4 已记录「顺手更正」 |

### 6.2 隐藏耦合

1. **`active` 语义**:现在 `active = isActive && overlay==='none'`(`App.tsx:461,463`)。去掉 overlay 后这个 AND 就消失了。TerminalView 的 resize/focus 与 AcpChatView 的 active 用途(聚焦、滚动)都要重新确认(§2.2)。
2. **RunMetricsPanel 的数据来自 AcpChatView 内部 state**(`:822-828`)。挪进 ContextPanel 需要新的向上通道。
3. **registerControls 的重新注册频率**(`:779-782`)在 M7 扩展后会放大(§3.3)。
4. **sessionActions 的闭包**:`handleDelete` / `handleDeleteDocTab` 依赖 sessions/docTabs/activeId(`App.tsx:316,348`)。
5. **乐观气泡 key 变化导致重挂载**(`:858` key=turnId,MAX_SAFE→真 id)。TurnView 的 local 展开态会在回显时丢失。
6. **MemoryPanel 是全局数据**(`App.tsx:469`),多个 Crew 会话各挂一份会互不同步(§0.5.5 保持 Sheet,暂时不触发)。
7. **QuickMemoryPopover 的 `memReqRef` 没有测试**(`AcpChatView.tsx:139`)。
8. **confirmCount → confirmsBySession** 需要确认 `listConfirmations` 前端函数返回了完整的 runs(现在 App 只读 `r.count`,`App.tsx:168`)。
9. **3s 轮询没有乱序保护**(`App.tsx:137-157`)。态势字段变多后，偶发乱序会让分诊行短暂回跳(低风险，记录在案)。
10. **fakeWs 的 readyState 默认 OPEN、close() 不触发 onclose**(`test/fakeWs.ts:22-45`)。写 characterization 前可能要给 fakeWs 加「CONNECTING 初态」选项，否则第 1 项(onopen 清空)测不出来。

### 6.3 首屏 br 体积

- **实测(本会话 `vite build` 到 /tmp + precompress + check-size)**:`assets/index-euBytDNh.js` 311.3KB br(原始 1,446,145 B)+ `assets/index-B-VL3lEx.css` 8.7KB = **320.0KB / 330KB(余量 10.0KB)**;无 modulepreload。现有 `dist/` 同为 320.0KB。
- 目前只有两处动态 import:mermaid(`markdown/MermaidBlock.tsx:43`)、katex(`markdown/MarkdownContent.tsx:57`)。**没有任何 `React.lazy`。**
- 粗估(源码级 brotli q11,未经转译和压缩，偏大;用于排序，不作承诺):
  - ContextPanel 各 tab(GitViewer + FileBrowser + AgentDashboard + RunMetricsPanel + MemoryPanel)≈ **17.8KB**
  - Admin / Scheduled / Push / PromptsSheet / PromptManager / VaultReader ≈ **12.5KB**
  - 删除 Sidebar + SessionInfoBar + SessionRowMenu ≈ **12.5KB**(大部分会被 Triage + ⌘K + FocusHeader 重新吃掉)
  - 首屏最大头是 react-markdown / rehype-highlight + `lowlight` 的 `common` 语言集(`MarkdownContent.tsx:6,10,65-68`)与 xterm。**markdown 管线本身懒载**(首条消息前不需要)潜力更大，但会带来首条消息闪烁，spec 没提，可作为后备。
- **建议 plan 顺序**:① 首个 task 只做 M27 的懒载，并记录新基线(预计 ~290–300KB);② 之后每个 task 跑 `check-size` 并在 commit message 里写 Δ。

---

## 7. 对 plan 的建议(按依赖排序)

1. **T0 修 Approval 契约**(后端序列化测试 + 修字段名;验证 crewEventCases 用真实 wire 形状)。它是行内批准的前提，可以独立上线。
2. **T1 懒载腾体积**(M27),记录新基线。
3. **T2 App 级 characterization**(对旧 App 写;必要时先给 fakeWs 加 CONNECTING 初态)+ **useAcpSocket characterization**(补 §3.7 的 ❌ 项，含无历史 case)。
4. **T3 useAcpSocket 只搬不改**:返回值按 §3.4 全表;handleEvent 保持 `[sessionId]` 捕获语义;scroll 门控一起进 hook 或作为参数传入。
5. **T4 后端态势字段**(M2/M3/M5/M8)+ 三组 parity 测试;决定 Crew 重连 Error 是否算 boundary(D12);pending_approvals 按 id 去重。
6. **T5 壳切换大提交**(§0.5.6-3)。
7. 其后:steps.ts / Timeline / SummaryCard(D6–D9 的修正纳入)、composer chip、SendToMenu。
