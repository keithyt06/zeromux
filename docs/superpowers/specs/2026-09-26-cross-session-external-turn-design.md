# Claude 跨会话消息 —— 外部 turn 正式支持 — 设计

日期：2026-09-26
状态：v1（用户已确认方向：用途 C、inbound 统一 accept、方案 1 改进版 + informational 提示；待审阅 spec 文本）

## 背景

Claude Code v2.1.224 起支持跨会话消息（`ListAgents` / `SendMessage`），本机走
per-session Unix socket。`claude -p` 会话同样绑定收件 socket，所以 ZeroMux spawn 的
Claude 会话**不改代码就已在网络里**（实测 `ListAgents` 能列出 `zeromux-6f`，互发成功）。

但 CLI 在空闲时收到消息会**自己开一个 turn**，而 ZeroMux 的 Claude fan-out 只在
自己写 stdin 时计 turn 开始（`turn_seq += 1` / `turn_starts.start()` / `mark_turn(Running)`），
导致三个问题（2026-09-26 实测）：

1. **不可见**：默认 stream-json 里外部 turn 没有任何 `user` 事件，UI 上 agent 无缘由地开始说话。
2. **计数错位**：外部 turn 只贡献一个 boundary、不贡献 turn 开始。单独发生时被
   `boundary_count` 钳制吸收；但若外部 turn 进行中用户发 prompt，外部 turn 的 `Result`
   会被当成用户 turn 的结束 → 用户 turn 提前 Idle，度量 / `turn_done` 推送 / FIFO intent 全部错位。
3. **busy 不亮**：前端外部 turn 期间显示空闲。

另：被唤醒的 agent 会顺带继续自己之前的待办（实测回复后又跑了 4 分钟部署检查），
所以外部 turn 可能很长，必须当作一等 turn 处理。

## 目标 / 非目标

**目标**
- 外部消息在聊天流中可见（「来自 @zeromux-98」气泡），重连 replay 一致。
- 外部 turn 是一等 turn：有自己的 `turn_id`、`turn_starts` 条目、Running/Idle 状态；
  期间用户发的 prompt 按 queue mode 正常排队或打断；度量、`turn_done` 推送、vault 标脏走现有路径。
- 竞态（CLI 先处理外部消息、后处理 ZeroMux 刚写入的 prompt）下状态机不错乱。
- 发送失败/被 hold/被拒的 CLI 通知（`system/informational`）在 UI 上显示为一行提示。

**非目标**
- Codex / Kiro / Crew 后端（无此机制；Crew 另有 Gateway）。
- 在 ZeroMux UI 里主动发起跨会话消息（仍由 agent 自己调 `SendMessage`）。
- 外部 turn 的独立度量维度 / 按来源过滤推送。
- 审批 UI（用户选择统一 `accept`，见下）。

## 用户决策

| 问题 | 决策 | 理由 |
|---|---|---|
| 用途 | C：ZeroMux 会话间协作 + 外部 `claude` 会话指挥 ZeroMux agent | — |
| 外部（非 bypass）发送方 | 统一 `crossSessionInbound: accept` | 个人项目；bypass 会话默认会 hold 非 bypass 发送方的消息，而 `-p` 无审批框，5 分钟后静默丢弃 |
| 实现路线 | 方案 1 改进版（下文） | 方案 2（全部 turn 改由 CLI 回显驱动）要重写 prompt/collect/interrupt 起点与 FIFO intent，回归风险过高；方案 3（只修 boundary）不满足 busy/度量目标 |

**风险记录**：socket 仅对同 OS 用户开放。`accept` 意味着本机该用户下任何 claude 会话
（包括读了外部网页可能被 prompt 注入的会话）都能驱动 `--dangerously-skip-permissions`
的 ZeroMux agent。接收侧 CLI 仍会把消息标注为「来自其他会话、不能授予权限」，但
bypass 会话本来就没有权限门。用户已知悉并接受。

## 实测事实（地基）

2026-09-26 用 3 个一次性 `claude -p --replay-user-messages` 会话（`/tmp` 沙箱）测得，
CLI 2.1.282：

| 场景 | stdout 事件 |
|---|---|
| 空闲收到 peer 消息 | `user`（`isSynthetic:true, isReplay:true, origin:{kind:"peer", name, body, msg_id, from, fromMode}`，`message.content` 为**字符串**）→ assistant… → `result`（**带同一 `origin`**） |
| 忙时（工具执行中）收到 | 在 `tool_result` 之后插入 `user(origin:peer)`；**不开新 turn、不多 `result`**；本 turn 的 `result` **不带 origin** |
| ZeroMux 写 stdin 的 prompt | `user`（`isReplay:true`，**无 origin**，content 为数组）→ … → `result`（无 origin） |
| 后台任务完成（`run_in_background`） | CLI **自开 turn**：无 `user` 事件，`system/init` → assistant… → `result`（`origin:{kind:"task-notification"}`） |
| stdin prompt 与 peer 消息几乎同时到达 | CLI **串行**处理，各自一个 `result`，由 origin 区分 |
| 接收方 `refuse` | 接收方 stdout 无任何事件；发送方收到拒收通知 |
| 发送方消息被 hold | 发送方 stdout 出现 `system/informational`（`content` 文本、`level:"warning"`），**且该通知本身会在空闲时触发一个自开 turn** |
| 未加 `--replay-user-messages` | 外部 turn 无任何 `user` 事件（仅写入 jsonl transcript） |

结论：**`result.origin` 是 CLI 给出的权威 turn 来源**；`user.origin.kind=="peer"` 是结构化的消息体来源，无需解析 `<cross-session-message>` 文本。

## 设计

### 1. 进程层 `src/acp/process.rs`

**1a. spawn 参数**（仅 `AcpProcess::spawn`）：追加
`--replay-user-messages` 与 `--settings '{"crossSessionInbound":"accept"}'`。

**1b. titler 硬化**（`spawn_titler`）：追加 `--settings '{"crossSessionInbound":"refuse"}'`。
titler 也绑定收件 socket；它的 reader 取**第一个** `Result` 当标题，一个 peer 自开 turn 会污染标题。
一行改动，与本特性直接相关。

**1c. 新增 `AcpEvent` 变体**

- `PeerMessage { from_name: String, text: String, turn_id: u64 }`
  —— 前端渲染的外部消息。`text` 取 `origin.body`（不含 CLI 包装的说明文字），
  过 `truncate_prompt_for_scrollback` 同等截断。`turn_id` 进程层填 0，fan-out `emit` 盖值（同 ContentBlock）。
- `TurnOrigin { kind: StaticOrOwnedStr }` —— **仅 fan-out 内部**使用的标记，
  紧挨在带 origin 的 `result` 所产生的 `Result`/`Error` **之前**发出。fan-out 消费后不 emit、
  不写 scrollback、不进 `log_result_event`。不直接给 `Result`/`Error` 加字段：
  `Error` 在三个后端有大量构造点，标记事件把改动局限在 Claude 路径。
- `Notice { text: String, level: StaticOrOwnedStr }` —— `system/informational` 的可见提示。
  不复用 `System`（给它加字段要改 16 个构造点）；也**不能**用 `ContentBlock`（空闲时到达会被 §2 误判为外部 turn 开始）。

**1d. `translate_event` 分支**

- `"user"`：仅当 `origin.kind == "peer"` 时产出 `PeerMessage`（`from_name` 取 `origin.name`，
  缺省 `"unknown"`）。其余 `user`（stdin 回显、`tool_result`）返回空 —— 与现状一致。
- `"result"`：若顶层有 `origin.kind`，先产出 `TurnOrigin{kind}`，再产出原有 `Result`/`Error`。
- `"system"` 且 `subtype == "informational"`：产出 `Notice{text: content, level}`，不再产出 `System`。

### 2. fan-out `spawn_acp_fanout`（仅 Claude 路径）

**2a. `TurnStarts` 条目加来源**：`(i64, Option<RunOutcome>)` → 增加 `external: bool`。
新增 `start_external(ms)`、`front_is_external()`。`start()` 语义不变（internal）。
Codex / Crew fan-out 共用该结构但从不调 `start_external`，行为不变。

**2b. 外部 turn 开始**：在事件分支、`emit` 之前：

```
if !local_running && matches!(evt, PeerMessage{..} | ContentBlock{..}) {
    // 外部 turn：与 ZeroMux 自己开 turn 的三步完全相同
    turn_seq += 1; local_running = true;
    turn_starts.start_external(now_millis());
    mark_turn(Running, turn_seq);
}
```

依据：ZeroMux 自己开 turn 时在写 stdin **之前**已置 `local_running = true`，所以空闲期
出现的助手输出只可能来自 CLI 自开的 turn。`ContentBlock` 覆盖无 `user` 事件的
task-notification / informational 自开 turn；`PeerMessage` 让气泡与其 turn 同 `turn_id`。
`System`/`Notice` **不**触发（空闲期会有 `task_updated`、`background_tasks_changed`、hold 通知等生命周期事件）。

外部 turn 开始时若 collect 窗口已 arm（上一 turn 结束后、flush 前），调用 `queue.disarm()`
保留 `pending`：flush 仅在 Idle 时发生的不变量要求如此；外部 turn 结束的 boundary 会照常 `queue.arm()`。

**2c. 忙时 `PeerMessage`**：`local_running == true` 时只 emit（盖当前 `turn_seq`），不计数。

**2d. boundary 归属**：维护 `pending_origin: Option<StaticOrOwnedStr>`。收到 `TurnOrigin` 时置位并 `continue`。
在 `is_boundary` 处理前取出：

- 有 origin 且 `turn_starts.front_is_external()` → 正常结算（现有路径全部照走）。
- 有 origin 但队首不是外部 turn（为空或为 internal）→ **跳过**：不增 `boundary_count`、
  不 settle、不 mark Idle、不推送、不 arm 队列；仍 emit 给前端（前端见 §3c）。打 `debug` 日志。
- 无 origin → 现有逻辑不变（含 `Exit`：外部 turn 中进程退出时队首即外部条目，正常结算）。

**竞态走查**（空闲时 ZeroMux 写入 prompt P，CLI 先处理同时到达的 peer 消息 M）：
P 写入即 `turn_seq=N, local_running=true, FIFO=[P]` → `user(peer M)` 到达，忙时只显示 →
M 的输出以 turn N 分组 → `result(origin:peer)`：队首 P 为 internal → 跳过 →
P 的 `result`（无 origin）→ 结算 turn N。状态正确。

**外部 turn 进行中用户发 prompt**：`local_running == true` → collect 模式入队、外部 turn 结束 boundary 后 flush；
Interrupt 模式对 FIFO 队尾（外部条目）打 Cancelled、interrupt、开新 turn —— 与现有语义一致，无需改动。
Cancel / TimeoutKill 同理。

**其他现有路径**
- `turn_done` 推送：外部 turn `active_run_id` 为 None，会推送。保持（用户不在场时外部 turn 完成正是需要通知的事）。
- auto-titler：只由 `first_substantive_prompt`（用户 prompt）触发，外部 turn 不影响。
- 度量：外部 turn 进 FIFO 后按现有 `classify_outcome` 记录，不区分来源（非目标）。
- `log_result_event`：跳过 `TurnOrigin`；`PeerMessage` / `Notice` 不是 result 类，现有匹配已忽略。

### 3. 前端

**3a. `peer_message`**（`AcpChatView.tsx` + `lib/transcript.ts`）
- `WireEvent` 加 `from_name?`。`foldTranscript` 将其作为该 turn 的一条用户侧消息
  （`userPrompts` 增加可选 `fromName` 字段），渲染为带「来自 @{from_name}」标签的气泡，样式区别于用户自己的 prompt。
- `AcpChatView` 的 `peer_message` 分支：更新 `activeTurnIdRef`、`setBusy(true)`、
  与 `content_block` 分支相同的 turn 计时起点逻辑（`setTurnStartedMs(prev => prev ?? now)` 与 nowMs seed）。

**3b. `notice`**：`pushNotice({kind:'system', text})`，与 `resume_failed` 同一渲染路径。

**3c. 被跳过的 `result`**（竞态）：前端会收到 turn N 的一个额外 `result` 并把该组标 `complete`、
`setBusy(false)`；真正的 turn N `result` 随后又到。为免 busy 闪灭，busy 以后端为准：
**不改前端**，接受竞态下 busy 短暂熄灭直至下一个 `content_block` 重新点亮（已知限制 L1）。

## 已知限制

- **L1 竞态显示**：CLI 先处理 peer 消息时，外部 turn 的输出显示在用户 turn N 分组内，
  turn N 的耗时包含外部 turn；前端 busy 可能短暂熄灭。后端状态机正确。
- **L2 CLI 协议依赖**：依赖 `--replay-user-messages`、`user.origin`、`result.origin`
  这三个未文档化字段（实测于 2.1.282）。若 CLI 去掉 `result.origin`，退化为现状
  （外部 turn 仍能被 §2b 识别为开始，但 boundary 归属失去竞态保护）。单元测试 fixture 用实测 NDJSON，CLI 变更时第一时间暴露。
- **L3 安全**：见「风险记录」。

## 测试

**Rust — `process.rs` 单元测试**（fixture 取本次实测 NDJSON，去除签名等无关字段）
- 空闲 peer `user` → 一个 `PeerMessage`（`from_name`/`text` 取自 origin）。
- stdin 回显 `user`（无 origin）→ 空；`tool_result` `user` → 空。
- `result` 带 `origin` → `[TurnOrigin, Result]`；`is_error` 且带 origin → `[TurnOrigin, Error]`；无 origin → `[Result]`。
- `system/informational` → `Notice`。

**Rust — fan-out 状态机测试**

fan-out 目前没有可注入假进程的脚手架（`AcpProcess` 直接持有 `Child`/`ChildStdin`），
所以把 §2b / §2d 的判定抽成纯函数 `classify_claude_event(local_running, kind, pending_origin, front_is_external) -> Step`
（`Step::StartExternal | Step::SkipBoundary | Step::SettleBoundary | Step::Pass`），fan-out 只做调用；
`TurnStarts` 的 `start_external` / `front_is_external` 单独单测。以下场景以「纯函数 + `TurnStarts`」逐步模拟，
每条先注释掉对应守卫验红，再恢复验绿：

1. 空闲 `PeerMessage` → StartExternal；随后 `TurnOrigin(peer)`+`Result` 且队首外部 → SettleBoundary。
2. 空闲仅 `ContentBlock` → StartExternal；`TurnOrigin(task-notification)`+`Result` → SettleBoundary。
3. 竞态：队首 internal（用户 turn N）→ 忙时 `PeerMessage` → Pass；`TurnOrigin(peer)`+`Result` → SkipBoundary；无 origin `Result` → SettleBoundary。
4. 队首为空（钳制后多余的 boundary）+ 有 origin → SkipBoundary。
5. 空闲 `System` / `Notice` → Pass（不开 turn）。
6. 外部 turn 中 Interrupt：`set_live_intent` 打在外部条目上，`front_intent()` 为 Cancelled。
7. `TurnOrigin` 不进 scrollback、不 broadcast（`emit` 前被消费）—— 在 `translate_event` + 纯函数层面断言其永远走 `continue` 分支。

collect / interrupt 的排队行为不改代码，由端到端验收覆盖。

**前端 — vitest**
- `foldTranscript`：`peer_message` 进入对应 turn 分组且带 `fromName`；与同 turn 的 `content_block` 共组。
- `AcpChatView` 无组件测试（现有只测纯函数 `transcript` / `collectHint`），`peer_message` 分支的 busy 与计时由端到端验收覆盖，不为此新建组件测试脚手架。

**端到端验收**（部署后，用一次性沙箱会话发消息给 ZeroMux 会话）
- 空闲会话收到消息：气泡出现、busy 亮、结束后熄、`turn_done` 推送一次。
- 外部 turn 进行中在 UI 发 prompt：显示「已排队」，外部 turn 结束后才执行。
- 刷新页面（replay）：气泡与分组一致、busy 状态正确。
- ZeroMux 会话向一个 `refuse` 会话发消息：UI 出现灰色 notice。
