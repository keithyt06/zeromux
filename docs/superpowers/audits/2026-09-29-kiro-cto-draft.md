# Kiro Stage 3→5 功能补充：CTO 草案（2026-09-29）

底稿：`2026-09-29-kiro-stage-inventory.md`。约束：单用户、all-trust，**不做**治理/权限/沙箱/审计。引用的 file:line 都已经 Read 核实过。

## 总原则
1. **zeromux 只做编排平面**：会话生命周期、调度、verdict、看板、推送。推理、记忆、子任务拆解交给后端自己的能力：Claude 的 CLAUDE.md/peer、Codex 的 AGENTS.md、Crew 的 Gateway。
2. 新功能**只能通过 `SessionInput` 进入 fan-out**。不引入新的进程持有者，不写手工 kill，编排层的状态放进 SQLite（`scheduled_tasks.rs` 的 store），不挂在 Session 上。
3. 前端新面板一律放进 `lazyPanels.ts`。首屏门禁是 `package.json:8` 的 `check-size.mjs dist 337920`，余量很小，不允许静态 import。

## 提案

### ① 仓库级约定注入 → **不做（P2 仅文档）**
- 动机：Stage 3「为 agent 设计代码库」。
- 判断：Claude 在 `current_dir(work_dir)`（`acp/process.rs:219`）下会原生读 CLAUDE.md；Codex 同样在 `cwd`（`codex_process.rs:389`）下原生读 AGENTS.md；Crew 的 cwd 由 Gateway 的 project 决定（`crew_process.rs:323`）。再做一套 `.zeromux/context.md` 等于重复发明，路线图里的 `teamwork_enhanced_tasks.md:18` 应该划掉。
- 唯一值得做的：在 README 里写明「约定文件放仓库根」，另外把 Codex 的 `DEVELOPER_FORMAT_INSTRUCTIONS`（`codex_process.rs:25`）保持为纯格式约定，不往里塞项目知识。

### ② 定时任务支持 Codex/Crew → **P0，M**
- 动机：Stage 3 定时任务要覆盖所有后端，这也是 ③④⑥ 的前置条件。
- 复用：`scheduled_session_type`（`session_manager.rs:2641`），它的注释已经把前置条件写全了；Claude 的终结逻辑在 `session_manager.rs:3007-3013`（`active_run_id.take()` → `extract_verdict` → `finalize_run`）；`trigger_run` 里的穷尽 match 在 `session_manager.rs:1427-1433`。
- 形态：在 `spawn_codex_fanout`（:4205）和 `spawn_crew_fanout`（:3897）里各补一个 `active_run_id` 窗口：`Prompt{run_id:Some}` 时置位，`Result`/`Error` 边界时 `finalize_run`，被 Interrupt 抢占时走 `finalize_active_run_if_scheduled`。然后新增 `create_codex_session_tagged` / `create_crew_session_tagged`（参照 `create_acp_session_tagged` :1261），并把 `maybe_push_turn_done` 挂上 `active_run_id.is_none()` 门。
- 不变量：fan-out 仍然独占进程，run_id 继续走 `SessionInput::Prompt`，只改 fan-out 内部。
- 风险：三个后端的 parity 容易漏。历史 review 里 FIFO/intent 相关问题出过 10 次以上。必须补测：每个后端各写一条「run 永不停在 running」的单测，同时验证 `active_run_count` 会归零，否则 auto-update 会被永久阻塞。
- 前端：`ScheduledTasksPanel` 的 agent 下拉加两个选项，不增加首屏体积。

### ③ 定时任务串联 / 流水线（基于 VERDICT）→ **P0，M**
- 动机：Stage 4「分类→实现→审查」，各阶段只通过队列协调。
- 复用：`TaskConfig`（`scheduled_tasks.rs:380`）、`TaskRun.verdict`（:409）、`extract_verdict`（:51）、`claim_run` / `claim_won`（:535/:651）、`add_columns` 幂等迁移。
- 形态：`TaskConfig` 增加 `after_task_id: Option<String>` 和 `after_when: "succeeded"|"verdict_match:<正则>"|"always"`（`trigger_type` 新增 `"after"`）。`finalize_run` 成功后，由 **scheduler tick** 扫描「上游最新终态 run 还没有被下游消费」的任务并 claim。下游的 prompt 模板支持 `{{upstream.verdict}}` 和 `{{upstream.output_tail}}`，后者复用 `run_output_tail`（:999）。
- 关键：在 tick 里触发，而不是在 fan-out 里直接 spawn，这样可以复用 overlap / TOCTOU / watchdog 的整套保护，fan-out 也保持无副作用。去重用一个新列 `upstream_run_id`，加 UNIQUE 约束。
- 不做：DAG、fan-in、条件分支语言。单链加一个正则就能覆盖「审查发现问题 → 修复」。
- 前端：ScheduledTasksPanel 的触发器选择器新增「在任务 X 之后」，run 列表显示上游链接。

### ④ 确定性预检（shell gate）→ **P0，S**
- 动机：Kiro 的「确定性脚本检查、最小上下文唤醒」。这是 ROI 最高的一项：不唤醒 agent 就不花钱。
- 形态：`TaskConfig` 增加 `gate_cmd: Option<String>`（`sh -c`，`current_dir` 设为 canonical work_dir，带 60s timeout）。在 scheduler tick 里 claim 之后、`trigger_run` 之前执行：exit 0 就把 run 记为 `skipped` + `failure_kind="gate_clean"`；非 0 才唤醒 agent，并把 stdout 尾部 4KB 作为 `{{gate.output}}` 注入 prompt。
- 必须 `tokio::spawn` 加 timeout，不能在 tick 里 `.await` 裸调用。07-29 那次 tick 冻死的教训：`scheduled_tasks.rs:1150` 的注释就是为此写的。
- 风险：gate 输出可能很大或阻塞，所以要截断并 kill_on_drop。all-trust，不设沙箱。
- 前端：任务表单加一个可选文本框，run 行显示「gate 通过，未唤醒」。

### ⑤ 全局 activity feed / 看板 → **P1，S**
- 复用：`log_result_event` 已经在三个后端的 `Result` 上写 `task_done`（`session_manager.rs:2564`）；`EventStore::list` 支持不传 session_id（`events.rs:119`）；`AgentDashboard` 的 `sessionId` 本来就是可选参数（`AgentDashboard.tsx:9,36`）。
- 形态：后端几乎不用改，只需 `finalize_run` 时额外写一条 `run_done`（带 verdict、task_id），让流水线也进入 feed。
- 前端：⌘K 里加一个「全局动态」动作，以 Sheet 打开 `<AgentDashboard />`（不传 sessionId），复用已经懒加载的 chunk，增量接近 0。**不做**独立看板页或第二套 Triage；Triage（`lib/triage.ts`）已经就是「需要我处理」的视图。

### ⑥ 协调者（Stage 5）→ **P1，M，交给 Claude 原生 + 暴露 CLI**
- 判断：zeromux **不写协调逻辑**。decompose/judge 是 LLM 的活，由用户开的一个 Claude 会话来当 coordinator。
  - 会话之间的对话用 **Claude peer**：`--name zmx-ai-<id6>`（`acp/process.rs:180-181`、`session_manager.rs:651`），external turn 的归属已经解决（`classify_claude_event` :3491）。
  - zeromux 负责暴露「手脚」，也就是 REST 已有的部分：`POST /api/sessions`（带 `initial_prompt`，`web.rs:29,948`）、`GET /api/sessions`、`/status`、`/history`、`/runs`（`web.rs:35-58`）。**缺的只有两个：**
    1. `POST /api/sessions/{id}/prompt`：往**任意后端**发 `SessionInput::Prompt`，复用 `input_tx`（:2105）。这是给 Codex/Crew 用的，因为它们没有 peer 通道。
    2. agent 取 token 的方式：legacy 模式下 Bearer 就是密码（`auth.rs:227-233`）。在 spawn 时注入 `ZEROMUX_URL` 和 `ZEROMUX_TOKEN` 环境变量，另外做一个 `zeromux ctl` 子命令（list/new/send/wait-verdict，大约 150 行 clap），比让 agent 拼 curl 更稳。
  - 巡检（patrol）复用 stuck watchdog（:963）和推送，不另写。
- 不做：zeromux 内置 coordinator agent、轻模型监督器、任务拆解 UI。
- 风险：`ctl new` 可能被 agent 失控递归调用。all-trust 下只加一个硬上限 `max_sessions`，超过就返回 429（一行判断），不做配额体系。
- 前端：TriageRow 显示「由 zmx-ai-xxxx 创建」的来源徽标，需要在 Session 上加 `parent_id`。

### ⑦ backlog / 任务队列 → **P2，交给 GitHub**
- 判断：用 GitHub issue label（`agent:todo → agent:doing → agent:review`）作为队列，由 `gh` CLI 在 gate（④）里拉取。例如 `gh issue list -l agent:todo --json ... | jq -e 'length>0'`：有 issue 才唤醒，issue 正文作为 `{{gate.output}}` 注入，由 agent 自己改 label。**zeromux 不建 backlog 表**，④ 加 ③ 就已经构成 Stage 4 管道。
- 不做：内置看板、issue 同步、webhook 接收（公网暴露和签名校验都是治理面）。

### ⑧ 成本核算覆盖所有后端 → **P1，S（Codex）/ 依赖上游（Crew）**
- 现状：只有 Claude 会填 `cost_usd`（`acp/process.rs:501`），Codex 和 Crew 的 Result 都写死 `None`（`codex_process.rs:799`、`crew_process.rs:156`）。累计计算已经统一（`record_run_metric` :849）。
- 形态：Codex 从 MCP 的 `token_count` 通知里取 tokens（需要实测 codex mcp-server 是否会推这个通知），再用本地 `model→$/Mtok` 常量表换算；Crew 已经有 `context_usage`（`crew_process.rs:191`），只能拿到 used/total，先填 tokens，cost 留空，UI 标「估」。
- 不做：计费账本、预算告警。
- 前端：`SessionLifetimeBadge` 已经存在，只需让 None 显示「—」而不是 $0。

### 补充 ⑨ 流水线运行视图 → **P2，S**
在 ScheduledTasksPanel 的 run 列表按 `upstream_run_id` 缩进成链。等 ③ 稳定后再做。

## 明确不做
- 治理、权限、沙箱、审计、多用户配额，原因见约束。
- `.zeromux/context.md` 和角色模板：和 CLAUDE.md/AGENTS.md 重复。
- DAG 引擎、内置 coordinator、轻模型监督器：LLM 的判断交给 Claude 会话，确定性部分交给 gate。
- 内置 backlog 或 issue 同步：GitHub label 就够用。
- zeromux 自建跨后端记忆：Crew 已有记忆，Claude/Codex 用仓库文件。

## ROI 排序
| 级 | 项 | 复杂度 | 理由 |
|---|---|---|---|
| P0 | ④ shell gate | S | 最省钱，独立可交付 |
| P0 | ② 定时任务支持 Codex/Crew | M | 解锁多后端流水线 |
| P0 | ③ after 串联 + verdict 模板 | M | 让 Stage 4 成立 |
| P1 | ⑥ `/prompt` 端点 + `zeromux ctl` + env 注入 | M | 让 Stage 5 可以用 Claude 原生能力组装 |
| P1 | ⑤ 全局 feed（复用 AgentDashboard） | S | 50+ 会话时的可观测性 |
| P1 | ⑧ Codex tokens/cost | S | 需先实测通知 |
| P2 | ⑦ GH label 队列（纯配方，文档化） | S | 零代码 |
| P2 | ⑨ 链视图、① 文档 | S | 锦上添花 |

建议顺序：④ → ② → ③ 合并为一期（都改 `scheduled_tasks.rs` 和 tick），然后 ⑥ 单独一期。
