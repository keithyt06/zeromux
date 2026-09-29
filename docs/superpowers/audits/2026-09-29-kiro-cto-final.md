# Kiro Stage 3→5：CTO 终稿（2026-09-29）

输入：CTO 初稿、CTO 审 PM、PM 初稿、Crew 差距调研。以下证据都已亲自核实。

## 核实结论
- `normalize_frame` 的兜底分支会丢弃 `chat_message`（`crew_process.rs:202-206`），而且 slot 过滤先于 match 执行（:56）。**属实。**
- Crew Mode 的回答在 `KC/crew_chat.py:1177-1183` 通过 `chat_message` 广播，其中 `kind∈{crew_result,crew_meta,crew_ask}`（:55），回答带 `meta.crew_reply`（:1163）。crew 模式下 `POST /api/chat` 会走 `_crew.ingest`，立即 ack（`chat_handlers.py:648-662`）。**属实。**
- **R1 的风险比调研写的更大**。普通模式下，`slot.append` 在没有 HTTP reader 时也会经 `_broadcast_chat_message` 发出 `chat_message`（`state.py:2296-2348`、`:6597`）；compaction 还会发 `role=compacting` 的空帧（`chat_runner.py:9562`）。**所以放行时必须白名单 `kind∈crew_*`，不能按 role 放行，否则普通会话的正文会渲染两遍。**
- `create_slot` 只传 `name`（`crew_process.rs:320`），Gateway 接受 `mode∈_CREATABLE_MODES` 和 `agent`（`chat_handlers.py:2271`、`:2389`）。**属实。**
- `Drop` 无条件执行 `delete_slot`（`crew_process.rs:665-683`），而 `resume=Some(k)` 已支持挂到已有 slot（:596-601）。**R4 属实。**

## 1. ⑥ 撤回
**撤回**「Claude peer 当协调者 + `zeromux ctl`」。Crew 已经有 `kirocrew-conductor` / `pipeline-conductor`（`~/.kiro/agents/` 下已安装），zeromux 再造一套协调器是重复建设。Stage 5 交给 Crew conductor，zeromux 只做**入口（G2）、可视化（G1/G3/G4）、叫醒（G7）**。Claude peer 保留现状，不再扩展。`/prompt` 端点从路线图中删除。

## 2. G1–G3 最小做法
- **G1（S）**：`normalize_frame` 新增 `"chat_message"` 分支，只有当 `role=="assistant"` 且 `kind` 以 `crew_` 开头时，才映射为**非边界**的 `ContentBlock{text}`，同时附一个 `summary=kind`，供前端渲染问题卡或结果卡。**这类文本不进 `turn_text`**，否则会混进下一个 `chat_done` 的 Result。其余 `chat_message` 继续丢弃。保持纯函数，补单测：普通模式的 assistant `chat_message` 必须被丢弃。
- **G2（S）**：`create_slot(…, mode, agent)` 透传；`CrewConfig` 或 `create_crew_session` 增加 `crew_mode: Option<..>`，并持久化到 session 描述或新列，保证重启 resume 后语义不变。前端在 ⌘K 的 TYPE_CHOICES 下加两个子项。
- **G3（M，取决于 R2）**：crew 模式的会话**不把 ack 当 turn**。fan-out 在 `Prompt` 时不进入 Running，也不入 `turn_starts` FIFO；忙闲状态由 fan-out 内部定时（30s）调用 `GET /api/chat/slots/{key}` 读 `queue_depth/subagents_running`，写入 posture。这样 watchdog、push、metric 都不会被误触发。每个 `crew_result` 发一条 turn_done 推送（复用 `maybe_push_turn_done`，dur 记 0）。
- **不变量**：以上全部在 `crew_process` / `spawn_crew_fanout` 内部完成。fan-out 仍然独占进程，输入仍走 `SessionInput::Prompt`。Claude/Codex 不改，parity 只对「普通模式 Crew」要求，crew 模式明确作为 Crew 的专属分支，并在 :3960 附近写注释说明。
- **Spike（半天，一次性测试 slot，用完手动删除）**：
  - R1：普通 slot 发一轮 prompt，抓 WS，确认会不会出现 `chat_message(role=assistant)`，以及是否带 `kind`。
  - R2：`mode=crew` 的 slot 发 2 个话题，记录 ack 之后有没有 `chat_done`，以及 `crew_result` 的数量和时序。
  - 抓到的帧直接作为 `normalize_frame` 的单测夹具。

## 3. 优先级
**R4（S）> G6 > G7 > G4。**
- R4 是 G6 的**硬前置**。给 `CrewProcess` 加 `owns_slot: bool`（新建时为 true，附着外部 slot 时为 false），Drop 时只有 owns 才删。它是 0 行为变化的防御修复，和 G1 放在同一期。
- G6（附着外部 slot）和 G7（外部 slot 的 needs_input 推送）是 P1。G7 放在 scheduler 那种后台 tick 里轮询 `/api/chat/slots`，并复用 confirm 推送的 debounce。
- G4（子任务树）放 P2。topics 没有 HTTP 路由（R5），只能间接拼出来，性价比低；先靠 G1 的 `crew_meta` 文本凑合。

## 4. 统一路线图

| 期 | 内容 |
|---|---|
| **S5「喂养」P0** | F1 posture 持久化；F2 推送带结论 + 定时 `run_done`；F3 离开期间卡；F4 记为约定（方案 A：让当前会话自己追加）；Crew spike R1/R2；G1、G2、R4 |
| **S6 P1** | G3（按 spike 结果）；G7；G6；④ shell 预检；F7 review 动作；F8；F5（backlog 用 localStorage）；F6 批量派发（不做逐会话隔离） |
| **S7 P2** | ③/F9 串联（可用「定时触发 conductor 会话」替代，也就是 G10，由 G2 免费得到）；G4；G8；G9 Crew cron 只读；⑧/F11 Codex 成本；②/F10 Codex 定时任务；F6 逐会话隔离（先改 `spawn_blocking`）；跨设备已读 |
| **不做** | ① `.zeromux/context.md`；⑤ 全局 feed；⑥ 自建协调器、`ctl`、`/prompt`；⑦ 内置 backlog 表；G11/G12（没有使用之前不做）、G14/G15；治理、权限、沙箱、审计 |
