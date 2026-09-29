# CTO 审 PM 初稿（2026-09-29）

审阅对象：`2026-09-29-kiro-pm-draft.md`。PM 引用的行号都已 Read 核实，全部属实：`push.rs:345`、`TriageRow.tsx:65`、`ScheduledTasksPanel.tsx:106-110/271`、`paletteParse.ts:9`、`TurnSummaryCard.tsx:33`、`GitViewer.tsx:382-384`、`RunMetricsPanel.tsx:84`、`prompts.rs:32`、`paletteActions.ts:336`。

## 逐条判断

- **F1 态势持久化：同意，P0，S。** 需要澄清一点：「已读」这一侧本来就在 localStorage（`lib/readState.ts:4` 的 `zmx_read`），重启服务后不会丢。真正丢的是后端的 `Posture`（`session_manager.rs:3607`），它是纯内存，建会话时是 `Posture::default()`（:1189/1308/1654/1758）。重启后 `last_outcome_ms=None`，`triage.ts:22` 的 `newerThanView` 恒为 false，所以「未读」消失了。详见下文专项 2。
- **F2 推送带结论：同意，但要改。**
  - turn_done 很简单。`emit`（:2932）先写入 `last_snippet`，之后才走到 :2981 的 push，所以 `payload_for` 加一个 `body: Option<&str>` 参数就够了，S。
  - PM 漏看了一点：**定时 run 成功时根本不推送**。:2979 的门是 `active_run_id.is_none()`，定时 run 只有 run_failed 和 confirm 两类推送。「附带 verdict」需要新增 `run_done` 推送类型，放在 `finalize_run` 成功分支（:3011）。另外 SW 的 level 表（`sw.js`，`zmx-push` Cache）也要同步。
- **F3 离开期间卡：同意，P0，S，纯前端。** 数据都已存在：`SessionInfo.last_outcome_ms`、`lifetime_cost_usd`（:413），以及 `GET /api/scheduled-tasks/confirmations`。**强依赖 F1**，F1 没上时卡片会显示「0 完成」。它是首屏组件，但体积很小，不需要懒加载。只有 Codex/Crew 的花费要标「未计」（见我初稿 ⑧）。
- **F4 记为约定：同意方向，但改实现，并且我据此调整初稿 ①。** 详见专项 1。
- **F5 backlog：修改。** 可以做，但先用最小形态：backlog 本质是「没发出去的 ⌘K 输入」，放 localStorage（和 `zmx_last_type` 同层）就够。不建表、不做跨设备同步，等真有跨设备需求再上 SQLite。
- **F6 批量派发：修改。** 详见专项 3。
- **F7 review 动作：同意，P1，M。** 「采纳」可以直接复用 `POST /runs/{run_id}/verdict`（`web.rs:59`）。文件 chip 定位到单个文件需要改 GitViewer 的入参，这项之前被推迟，是合理的，应拆成单独一个 task。
- **F8 立即运行后打开会话：同意，S。** `run_now` 的响应需要带回 session_id，要核对 `web.rs` 的 `run_scheduled_now` 是否已经返回。
- **F9 串联放 P2：部分同意。** 我初稿把串联放在 P0，理由偏架构完整性。按 PM 的「等人时长」北极星，它确实不如 F1-F3。**我把 ③ 降到 P1。**
- **F10 定时任务支持 Codex/Crew 放 P2：同意。** 没有真实需求，而且风险是三个后端的 parity（历史上最常出问题的类别）。**我把 ② 降到 P2**，前置条件仍按 :2641 的注释。
- **F11 今日成本：同意，P2。**
- **「不做」表：** 同意不做全局 feed。F3 覆盖了离开期间的场景，**我撤回初稿 ⑤**。同意不做协调 agent，但我保留 ⑥ 里那个最小的 `POST /api/sessions/{id}/prompt` 作为 P2 储备，理由是它只有 10 行左右，复用 `input_tx`（:2105）。

## PM 漏掉的点

1. **确定性预检（我初稿 ④）**：S 级，而且直接降低无人值守的成本和噪音，对 J1 也有帮助，因为 gate 通过就不唤醒 agent、不推送。建议放 P1，排在 F9 前面。
2. **F2 的定时成功推送缺口**：见上文 F2。
3. **F6 的阻塞隐患**：见专项 3。

## 三项专项评估

**1.「记为约定」写入仓库 CLAUDE.md：S（方案 A）/ M（方案 B），风险中。**
- 现有文件写 API `write_session_file`（`web.rs:2264`）是**整文件覆盖的 `std::fs::write`**，不支持追加。前端「读取→拼接→写回」有 lost-update 竞态：agent 可能正在同一时刻改 CLAUDE.md，而这里是 JuiceFS，延迟高、窗口大。
- **方案 A（推荐，MVP）**：前端复用 SendToMenu，给**当前会话**发一条 prompt：「把以下约定追加到仓库 CLAUDE.md 的『约定(zeromux)』段，若有 AGENTS.md 同步」。零后端改动，由 agent 自己合并措辞；当前会话立即知道这条约定，下一次新会话读文件也生效；手机上 2 击。缺点是要消耗一轮 turn、依赖 agent 听话。
- **方案 B**：新增 `POST /api/sessions/{id}/conventions`，服务端在 `O_APPEND` 模式下追加一段，复用 `resolve_write_target` 等守卫，大约 60 行。注意在 worktree 隔离下，应该写入 base 仓库还是 worktree 需要定义清楚。另外 Claude 只在启动时读 CLAUDE.md，当前会话仍要另发 prompt。
- 结论：**P0 做方案 A**，发现 agent 落盘不可靠再做方案 B。我初稿的 ①「不做 `.zeromux/context.md` 注入」判断不变。F4 写的是原生文件，不是另造一套注入机制，所以不冲突，我接受 F4。

**2. 已读 / 结论重启后保留：S，风险低。**
- **放在后端 session_store 层**，不放在前端。给 `sessions` 表加三列 `last_outcome TEXT, last_outcome_ms INTEGER, last_snippet TEXT`，沿用 `session_store.rs:60-66` 的幂等 `ALTER` 写法。在 `settle_posture`（:2127）末尾调用新的 `update_posture`（每个 turn 写一次，频率很低），`load_all` 时再回填 `Posture`。不要改 `persisted_of`/`upsert`，因为那是元数据全量写，posture 不该搭它的车。
- 注意 :2136：失败的 turn 会清空 snippet，持久化时要保持同样语义。
- 前端的 `zmx_read` 不动。跨设备同步已读（例如手机上读过、电脑上仍显示未读）是另一个需求，建议 P2 再议，需要新增 `read_ms` 列加一个 PATCH，大约 M。

**3. 批量并行派发：S（前端）/ M（每会话单独选隔离），风险中。**
- 前端循环调用现有的 `POST /api/sessions` 并带 `initial_prompt`（`web.rs:835,948`）即可，后端零改动。建议串行调用，间隔约 200ms，并逐个显示进度。
- 「每会话单独选是否隔离 worktree」需要改 `CreateSessionReq` 和 `resolve_work_dir(…, isolation)`（:506），目前取的是全局 `self.worktree_isolation`。
- **隐患**：`create_worktree`（:431-453）是同步的 `std::process::Command::output()`，直接在 async 的 `create_*_session` 里调用。在 JuiceFS 上每个约 24s，会**阻塞一个 tokio worker**。4 路并发请求可能把 worker 占满，拖慢所有 WS。要做逐会话隔离就必须同时改成 `spawn_blocking` 或 `tokio::process`。并发执行 `git worktree add` 还可能争抢 `.git` 锁，所以要串行。
- 目标标签直接写进 `description`（PATCH 已支持），不新增字段。

## 调整后的合并排序（CTO 视角）

- **P0**：F1、F2（含 run_done）、F3、F4 方案 A。
- **P1**：预检 gate、F7、F8、F9/③、F5（localStorage 版）、F6（先做不带逐会话隔离的版本）。
- **P2**：F10/②、F11/⑧、`/prompt` 端点、跨设备已读、F6 逐会话隔离（需先解决 spawn_blocking）。
