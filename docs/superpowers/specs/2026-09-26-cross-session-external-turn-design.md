# Claude 跨会话消息 —— 外部 turn 正式支持 — 设计

日期：2026-09-26
状态：v3（tmux 默认终端合入 main 后复核；待用户审阅）

## 修订记录

**v3（本版）** —— 用户合入 tmux 默认终端（`e247aa7`…`ad42dda`，26 个提交）后复核。逐项核对：
Claude 路径（`process.rs`、`spawn_acp_fanout`、`auto_titler.rs`、`acp/ws_handler.rs`、`AcpChatView.tsx`、`transcript.ts`、
`SessionInfoBar.tsx`）**零改动**；`push.rs` 只新增 `term_ended`（`turn_done` 的 60 秒门槛与 routine 档位不变）；
CLI 升到 2.1.283，一次性沙箱会话复测 `user.origin.kind/name/body`、`result.origin`、stdin 回显 `isReplay:true` 无 origin，**全部与 2.1.282 一致**。

| # | 差异 | 改动 |
|---|---|---|
| 1 | **peer 名与 tmux 会话名撞前缀**：tmux 终端现在叫 `zmx-<id8>`（`session_manager.rs:1084` 用 `starts_with("zmx-")` 判 Own；`ListAgents` 对 tmux 里的 claude 会显示 `tmux zmx-…:@0.%0`）。v2 的 `zmx-<id6>` 在 UI 和 `ListAgents` 里会被当成 tmux 终端名，用户复制错地址 | peer 名改为 **`zmx-ai-<id6>`**：仍 ASCII、稳定、带 zmx 前缀便于识别，但与 `zmx-<8位 hex>` 形态不同，且 `starts_with("zmx-")` 判 tmux Own 的逻辑只作用于 tmux 的 resume token，不会误伤 |
| 2 | 交互式 Claude Code **跑在 tmux 终端里**已经是主路径（tmux 默认 + `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`），它们自带收件 socket、默认名 `<cwd>-<2位>`，本 spec 不管它们的计数（那是 CLI 自己的 TUI），但**它们是最常见的发送方/接收方**：用户在 tmux 里的 claude 让 ZeroMux agent 干活，正是用途 C 的 B 半边 | 目标补一句：tmux 终端里的交互 claude 是一等发送方，验收加一项；非目标补「不改 tmux 里交互 claude 的命名/inbound（CLI 自管）」 |
| 3 | 新增的交互 tmux claude 是 **非 bypass**（普通权限模式），ZeroMux agent 是 bypass：默认规则下 bypass 接收方会 hold 非 bypass 发送方 —— v2 的 `accept` 决策因此更关键（否则这条最常见路径必然被 hold 后 5 分钟丢弃） | 用户决策表理由补这一条；验收第 7 项从「SSH 里交互 claude」扩为「SSH **或 ZeroMux tmux 终端**里的交互 claude」 |
| 4 | `SessionManager::new` 多了 `tmux` 参数，调用点 5→**9**（main 1 + 测试 8） | 计划的 `set_oauth_mode` setter 方案不受影响（仍不改构造签名），仅更新行号与计数描述 |
| 5 | `SessionInfo` 多了 `tmux_name/tmux_origin/other_clients`；`running_session` 测试 helper 多了 `tmux_origin/pending_kill_until` 字段 | 计划 Task 6 的锚点更新（加在 `other_clients` 之后）；测试 helper 直接复用，无需改 |
| 6 | 大量行号漂移（fan-out 现 :2727-3581，`TurnStarts` :3250，`emit` :3391，`with_turn_id` :3491，`spawn_claude` :1147 / 调用点 :1214 :1760 :1801，`decide_spawn` :561，`session_info_of` :630，`load_persisted` 注释 :2190，main `set_search` :569，`oauth_configured` :251，App `<AcpChatView` :453） | 计划改为「以函数/符号为锚，行号仅供参考」并刷新行号 |
| 7 | 冒烟隔离：新增 `--tmux-socket`（默认空=生产 default socket），启动时还会对 tmux 做 `set-environment` 与 `reconcile_pending_kills` | Task 4 Step 7 冒烟命令必须加 `--tmux-socket zmx-xs-smoke`，否则会触碰生产 tmux server |

**v2** —— CTO + PM 并行终审。所有断言本人复核：CTO 的 `/tmp/zmx-cto-probe/{a,b,c}.log`
原始日志逐行核对；`push.rs:301`（<60s 不推）、`push.ts:112`（routine 默认关）、`AcpChatView.tsx:840`
（中断键仅 stuck 时出现）、`session_manager.rs:2082`（重启后 `running: None`）、`:1125`（定时 run 走同一
`spawn_claude`）、systemd `ExecStart … --watch-build …/target/release/zeromux`、`run_metrics.rs:194` 硬编码 `$HOME/.zeromux`。

| # | 改动 | 来源 | 理由 |
|---|---|---|---|
| 1 | **CLI 会把 ZeroMux 刚写入的 prompt 并进正在进行的外部 turn**，只出一个带 origin 的 result。新增 stdin 回显追踪（`StdinEcho` 标记 + `TurnEntry.echoed`），SkipBoundary 仅在队首**未回显**时成立 | CTO BLOCKER | v1 规则会把这个唯一 result 跳过 → turn N 永不结算 → 30 分钟后 TimeoutKill、排队 prompt 丢失。竞态窗口 = 外部 turn 首 token 时间（实测 3–5s），不是「几乎同时」 |
| 2 | spawn 传 `--name zmx-<会话 id 前 6 位>`（v3 改为 `zmx-ai-<id6>`）；SessionInfoBar 展开区显示 peer 名 + 复制；气泡把 `zmx-xxxxxx` 反查成会话标题 | PM HIGH | 默认名 `<cwd>-<2位后缀>` 同 repo 多会话无法区分，UI 也不知道它叫什么，用途 C 无法闭环 |
| 3 | inbound 按模式与会话类型选：legacy 交互会话 `accept`；**OAuth 模式与定时 run 会话 `refuse`** | CTO HIGH + PM MED | 所有会话同一 OS 用户：OAuth 多用户下 B 的 agent 能驱动 A 的 bypass agent（v1 前就存在的 bypass→bypass 通道，accept 只会扩大）；定时 run 无人值守，不应有外部输入 |
| 4 | busy 时「中断」按钮**始终可见**（不再只在 stuck 时） | PM MED | 外部 turn 是非用户发起的自主执行（实测回复后又跑 4 分钟），手机上必须能随时停 |
| 5 | 已知限制加 L4（休眠会话不可达）；SessionInfoBar 显示在线 / 休眠 | PM HIGH | 重启/部署后所有会话 `running: None`，没有进程就没有 inbox socket |
| 6 | 验收：推送项拆「短回复不推 / sleep 70 + 常规档推」；加 ZeroMux↔ZeroMux 往返、交互式 SSH claude 发送、重启后名字不变 | PM HIGH/MED | v1 第 1 项按 60s 门槛必然失败 |
| 7 | plan：先 push 再 `./deploy.sh --build`（不单独 `cargo build --release`，线上 `--watch-build` 会抢先热更新）；冒烟后清 `~/.zeromux/run-metrics/<sid>.ndjson` | CTO LOW | — |

未采纳 / 延后：推送文案区分外部 turn（PM LOW，非目标）；notice 刷新后沉底（PM LOW，现有 `resume_failed` 同机制）；
`command_lifecycle` 提前信号（CTO 可选项，只能缩窗口，echo 规则已兜底）；外部 turn 刷 `task_done` 事件（CTO NIT，接受）。

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
- 竞态（外部 turn 开始到其首个输出之间 ZeroMux 写入 prompt；CLI 串行处理或把 prompt 并进外部 turn）下状态机不错乱。
- 发送失败/被 hold/被拒的 CLI 通知（`system/informational`）在 UI 上显示为一行提示。
- **可寻址**：每个 ZeroMux Claude 会话有稳定、可读的 peer 名（`zmx-ai-<id6>`），UI 能看到并复制；收到的气泡显示发送方的 ZeroMux 会话标题。
- **tmux 终端里的交互 claude 是一等发送方**（v3）：从 ZeroMux tmux 终端或 SSH 里运行的普通（非 bypass）`claude` 发来的消息直接送达，不被 hold。
- **可停止**：外部 turn（及任何 busy turn）期间手机上随时可点「中断」。

**非目标**
- Codex / Kiro / Crew 后端（无此机制；Crew 另有 Gateway）。
- 在 ZeroMux UI 里主动发起跨会话消息（仍由 agent 自己调 `SendMessage`）。
- 外部 turn 的独立度量维度 / 按来源过滤推送。
- 审批 UI（用户选择统一 `accept`，见下）。
- tmux 终端里交互 `claude` 的命名、inbound 与 turn 计数（由 CLI 自己的 TUI 管理，ZeroMux 只提供 PTY）。

## 用户决策

| 问题 | 决策 | 理由 |
|---|---|---|
| 用途 | C：ZeroMux 会话间协作 + 外部 `claude` 会话指挥 ZeroMux agent | — |
| 外部（非 bypass）发送方 | legacy 模式交互会话 `crossSessionInbound: accept` | 个人项目；bypass 会话默认会 hold 非 bypass 发送方的消息，而 `-p` 无审批框，5 分钟后静默丢弃。v3：tmux 默认终端上线后，最常见的发送方正是 tmux 里的普通权限 `claude`，不 accept 则这条主路径必然丢消息 |
| OAuth 模式 / 定时 run 会话 | `refuse`（v2 新增，终审建议） | OAuth 多用户同 OS 用户无租户隔离；定时 run 无人值守 |
| 实现路线 | 方案 1 改进版（下文） | 方案 2（全部 turn 改由 CLI 回显驱动）要重写 prompt/collect/interrupt 起点与 FIFO intent，回归风险过高；方案 3（只修 boundary）不满足 busy/度量目标 |

**风险记录**：socket 仅对同 OS 用户开放。`accept` 意味着本机该用户下任何 claude 会话
（包括读了外部网页可能被 prompt 注入的会话）都能驱动 `--dangerously-skip-permissions`
的 ZeroMux agent。接收侧 CLI 仍会把消息标注为「来自其他会话、不能授予权限」，但
bypass 会话本来就没有权限门。用户已知悉并接受（legacy 单用户）。

OAuth 模式下所有用户的 Claude 进程同为 systemd `User=ubuntu`，CLI 的 socket 隔离对 ZeroMux 的
租户无效：B 的 agent 可 `ListAgents` 看到 A 的会话并驱动它，绕过 ZeroMux 的 owner-scoped authz。
这个 bypass→bypass 通道**在本特性之前就存在**（默认规则 bypass 接收 bypass）。v2 在 OAuth 模式下
一律 `refuse`，顺带关闭它。前端 `from_name` / `text` 经 React 转义渲染，无 XSS。

## 实测事实（地基）

2026-09-26 用 3 个一次性 `claude -p --replay-user-messages` 会话（`/tmp` 沙箱）测得，
CLI 2.1.282：

| 场景 | stdout 事件 |
|---|---|
| 空闲收到 peer 消息 | `user`（`isSynthetic:true, isReplay:true, origin:{kind:"peer", name, body, msg_id, from, fromMode}`，`message.content` 为**字符串**）→ assistant… → `result`（**带同一 `origin`**） |
| 忙时（工具执行中）收到 | 在 `tool_result` 之后插入 `user(origin:peer)`；**不开新 turn、不多 `result`**；本 turn 的 `result` **不带 origin** |
| ZeroMux 写 stdin 的 prompt | `user`（`isReplay:true`，**无 origin**，content 为数组）→ … → `result`（无 origin） |
| 后台任务完成（`run_in_background`） | CLI **自开 turn**：无 `user` 事件，`system/init` → assistant… → `result`（`origin:{kind:"task-notification"}`） |
| 外部 turn 开始后、其首个输出前 ZeroMux 写入 stdin prompt，外部 turn **不用工具** | CLI **串行**：外部 turn 的 `result(origin:peer)` → 之后 stdin 回显 `user` → prompt 的 `result`（无 origin）（CTO `b.log`） |
| 同上，但外部 turn **用了工具** | CLI 把 prompt **并进外部 turn**：`tool_result` 之后出现 stdin 回显 `user`，最终**只有一个** `result`，且**带 `origin:peer`**，内容是对 prompt 的回答（CTO `a.log` / `c.log`） |
| 竞态窗口 | 从外部 turn 的 `system/init` 到 peer 回显 `user`：实测 3.2s / 4.4s（含首 token 与 thinking），期间 ZeroMux 看到的仍是空闲 |
| `--resume` 重新拉起 | 旧 jsonl 不回放到 stdout，只输出新 turn（CTO 实测） |
| 接收方 `refuse` | 接收方 stdout 无任何事件；发送方收到拒收通知 |
| 发送方消息被 hold | 发送方 stdout 出现 `system/informational`（`content` 文本、`level:"warning"`），**且该通知本身会在空闲时触发一个自开 turn** |
| 未加 `--replay-user-messages` | 外部 turn 无任何 `user` 事件（仅写入 jsonl transcript） |

结论：**`result.origin` 标记 CLI 自开的 turn**；`user.origin.kind=="peer"` 是结构化的消息体来源，无需解析 `<cross-session-message>` 文本。
但 `result.origin` **不足以**单独判定归属：并入场景下带 origin 的 result 同时结算了 ZeroMux 的 prompt。
第二个信号是 **stdin 回显**（`user`、`isReplay:true`、无 `origin`）：它出现在哪个 result 之前，就说明该 prompt 被哪个 turn 消化了。
`tool_result` 与中断产生的 `user` 事件都**没有** `isReplay`（CTO 实测），可据此区分。

## 设计

### 1. 进程层 `src/acp/process.rs`

**1a. spawn 参数**（仅 `AcpProcess::spawn`）：追加
`--replay-user-messages`、`--name <peer_name>`、`--settings '{"crossSessionInbound":"<inbound>"}'`。
`spawn` 新增两个入参 `peer_name: &str`、`inbound: Inbound`（`Accept | Refuse`）。由 `SessionManager::spawn_claude` 计算：

- `peer_name = "zmx-ai-" + 会话 id 前 6 个字符`。uuid 在会话创建时生成，resume 时 id 不变，所以名字稳定。
  （v3：不用 `zmx-<id>`，因为 tmux 终端已占用 `zmx-<id8>` 形态，`ListAgents` 与 UI 里会混淆。）
  只含 ASCII 小写十六进制与连字符，避开文档所说含空格/中文的名字需要加引号的问题。
  不用会话标题：标题在 auto-titler 之后才生成，`-p` 进程无法改名。
- `inbound = Refuse` 当 **OAuth 模式**或会话 `source_task_id.is_some()`（定时 run）；否则 `Accept`。
  `SessionManager` 新增字段 `oauth_mode: bool`（经 `set_oauth_mode` 在启动时注入，与 `set_push` 同模式，
  避免改动 `SessionManager::new` 的 5 个调用点）。`source_task_id` 在 `create_acp_session_tagged` 与
  `ensure_running` 两处都能拿到（后者经 `SpawnPlan` 新增字段 `source_task_id`）。

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
- `StdinEcho` —— **仅 fan-out 内部**：CLI 回显了一条 ZeroMux 写入 stdin 的 prompt（`user`、`isReplay:true`、无 `origin`）。
  与 `TurnOrigin` 同样处理：消费后不 emit、不写 scrollback。

**1d. `translate_event` 分支**

- `"user"`：`origin.kind == "peer"` → `PeerMessage`（`from_name` 取 `origin.name`，缺省 `"unknown"`）；
  无 `origin` 且 `isReplay == true` → `StdinEcho`；其余（`tool_result`、中断等）返回空。
- `"result"`：若顶层有 `origin.kind`，先产出 `TurnOrigin{kind}`，再产出原有 `Result`/`Error`。
- `"system"` 且 `subtype == "informational"`：产出 `Notice{text: content, level}`，不再产出 `System`。

### 2. fan-out `spawn_acp_fanout`（仅 Claude 路径）

**2a. `TurnStarts` 条目加来源与回显**：`(i64, Option<RunOutcome>)` → 具名 `TurnEntry { ms, intent, external, echoed }`。
新增 `start_external(ms)`（`external=true, echoed=true` —— 外部 turn 没有 stdin 写入，视为无需等回显）、
`front_is_external()`、`mark_echoed()`（把**最早一个** `echoed==false` 的条目置 true）、`front_is_echoed()`。
`start()` 语义不变（`external=false, echoed=false`）。每个 `start()` 调用点紧跟一次 `send_prompt`（Claude fan-out
五处：调度、Interrupt、空闲、collect 空闲、collect flush —— 已核对），所以回显与条目 1:1。
Codex / Crew fan-out 共用该结构，从不调新方法，行为不变。

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

**2d. boundary 归属**：维护 `pending_origin: bool`。收到 `TurnOrigin` 时置位（kind 写入 debug 日志）并 `continue`；
收到 `StdinEcho` 时 `turn_starts.mark_echoed()` 并 `continue`。在 `is_boundary` 处理前：

- 有 origin 且队首**外部**或队首**已回显** → 正常结算（现有路径全部照走）。
- 有 origin、队首是 internal 且**未回显**（或 FIFO 为空）→ **跳过**：不增 `boundary_count`、
  不 settle、不 mark Idle、不推送、不 arm 队列；仍 emit 给前端（§3c）。打 `debug` 日志。
- 无 origin → 现有逻辑不变（含 `Exit`：外部 turn 中进程退出时队首即外部条目，正常结算）。

**竞态走查 A —— 串行**（外部 turn 不用工具；`b.log`）：外部 turn 已开始但 ZeroMux 尚未看到输出时写入 P →
`turn_seq=N, FIFO=[P(未回显)]` → `user(peer)` 忙时只显示 → 外部输出归 turn N → `result(origin:peer)`：
队首 P 未回显 → **跳过** → `StdinEcho` → P 已回显 → P 的 `result`（无 origin）→ 结算 turn N。✅

**竞态走查 B —— 并入**（外部 turn 用了工具；`a.log` / `c.log`）：同样 FIFO=[P(未回显)] → `user(peer)` 只显示 →
工具调用 → `StdinEcho`（在 `tool_result` 之后）→ P 已回显 → 唯一的 `result(origin:peer)`：队首 P 已回显 →
**正常结算** turn N。✅（v1 规则会在这里跳过，turn N 永不结算。）

**走查 C —— 用户 turn 中后台任务通知**（CTO 提出的潜在同类，未实测）：若 CLI 把 task-notification 并入用户 turn、
最终 result 带 `origin:task-notification`，队首 P 早已回显（P 本身就是开这个 turn 的 stdin 写入）→ 正常结算。✅

**外部 turn 进行中用户发 prompt**：`local_running == true` → collect 模式入队、外部 turn 结束 boundary 后 flush；
Interrupt 模式对 FIFO 队尾（外部条目）打 Cancelled、interrupt、开新 turn —— 与现有语义一致，无需改动。
Cancel / TimeoutKill 同理。

**其他现有路径**
- `turn_done` 推送：外部 turn `active_run_id` 为 None，会推送。保持（用户不在场时外部 turn 完成正是需要通知的事）；
  沿用现有 60 秒门槛（`push.rs:301`）与 routine 档位（默认关，`push.ts:112`）。
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

**3d. 可寻址性（SessionInfoBar + 气泡）**
- 后端 `SessionInfo` 新增 `peer_name: string | null`（仅 Claude 会话非空，= `zmx-ai-<id6>`，由 id 直接派生，无需存储）。
- SessionInfoBar 展开区新增一行「Peer」：显示 `peer_name` + 复制按钮 + 在线/休眠标记（直接用现有 `running` 字段；
  休眠提示「打开会话后才能收到消息」）。
- 气泡标签：`from_name` 以 `zmx-ai-` 开头且在当前会话列表里能找到 `peer_name` 相同的会话 → 显示「来自 @{会话名}」，
  否则显示「来自 @{from_name}」。反查在 `AcpChatView` 渲染层完成（`foldTranscript` 仍只存原始 `from_name`），
  会话列表经新 prop `peerNames: Record<string, string>`（peer_name → 会话名）从 `App.tsx` 传入。

**3e. 中断按钮**：`busy` 期间始终渲染「中断」按钮；`stuck` 时仍显示红色「已静默 Ns，可能卡住」提示，
非 stuck 时显示灰色「已运行 Ns…」+ 同一个按钮（次要样式）。

**3c. 被跳过的 `result`**（竞态）：前端会收到 turn N 的一个额外 `result` 并把该组标 `complete`、
`setBusy(false)`；真正的 turn N `result` 随后又到。为免 busy 闪灭，busy 以后端为准：
**不改前端**，接受竞态下 busy 短暂熄灭直至下一个 `content_block` 重新点亮（已知限制 L1）。

## 已知限制

- **L1 竞态显示**：外部 turn 开始后、首个输出前（实测 3–5s）ZeroMux 写入 prompt 时，外部 turn 的输出显示在用户 turn N
  分组内，turn N 的耗时与成本包含外部 turn；串行情况下前端 busy 可能短暂熄灭（§3c）。后端状态机正确。
- **L2 CLI 协议依赖**：依赖 `--replay-user-messages`、`user.origin`、`result.origin`
  这三个未文档化字段（实测于 2.1.282）。若 CLI 去掉 `result.origin`，退化为现状
  （外部 turn 仍能被 §2b 识别为开始，但 boundary 归属失去竞态保护）。单元测试 fixture 用实测 NDJSON，CLI 变更时第一时间暴露。
- **L3 安全**：见「风险记录」。
- **L4 只有活进程可达**：休眠会话（重启 / 部署 / fan-out 结束后 `running: None`，`session_manager.rs:2082`）没有进程，
  也就没有 inbox socket，不在 `ListAgents` 中。需要在 UI 打开一次（`ensure_running`）。本期不做自动唤醒；
  SessionInfoBar 显示在线/休眠。
- **L5 外部 turn 会写 `task_done` 事件**：话多的 peer 会在 events 库留下对应条目，与普通 turn 相同，接受。

## 测试

**Rust — `process.rs` 单元测试**（fixture 取本次实测 NDJSON，去除签名等无关字段）
- 空闲 peer `user` → 一个 `PeerMessage`（`from_name`/`text` 取自 origin）。
- stdin 回显 `user`（`isReplay:true`、无 origin）→ `StdinEcho`；`tool_result` `user`（无 `isReplay`）→ 空。
- spawn 参数构造（抽成纯函数 `claude_args`）：含 `--replay-user-messages`、`--name zmx-ai-…`、按 `Inbound` 生成的 `--settings`。
- `result` 带 `origin` → `[TurnOrigin, Result]`；`is_error` 且带 origin → `[TurnOrigin, Error]`；无 origin → `[Result]`。
- `system/informational` → `Notice`。

**Rust — fan-out 状态机测试**

fan-out 目前没有可注入假进程的脚手架（`AcpProcess` 直接持有 `Child`/`ChildStdin`），
所以把 §2b / §2d 的判定抽成纯函数 `classify_claude_event(local_running, evt, has_pending_origin, front_settles_on_origin) -> ClaudeStep`
（`ClaudeStep::StartExternal | SkipBoundary | Normal`；`front_settles_on_origin = front_is_external() || front_is_echoed()`），fan-out 只做调用；
`TurnStarts` 的 `start_external` / `front_is_external` / `mark_echoed` / `front_is_echoed` 单独单测。以下场景以「纯函数 + `TurnStarts`」逐步模拟，
每条先注释掉对应守卫验红，再恢复验绿：

1. 空闲 `PeerMessage` → StartExternal；随后 `TurnOrigin(peer)`+`Result` 且队首外部 → Normal（正常结算）。
2. 空闲仅 `ContentBlock` → StartExternal；`TurnOrigin(task-notification)`+`Result` → Normal（正常结算）。
3. 串行竞态（走查 A）：队首 internal 未回显 → 忙时 `PeerMessage` → Normal；`TurnOrigin(peer)`+`Result` → SkipBoundary；`StdinEcho`；无 origin `Result` → Normal（正常结算）。
3b. 并入竞态（走查 B）：队首 internal 未回显 → `PeerMessage` → Normal；`StdinEcho`；`TurnOrigin(peer)`+`Result` → **Normal（正常结算）**。
4. 队首为空（钳制后多余的 boundary）+ 有 origin → SkipBoundary。
4b. `mark_echoed` 只标最早一个未回显条目；外部条目天然已回显；两个 internal 条目依次回显。
5. 空闲 `System` / `Notice` → Normal（不开 turn）。
6. 外部 turn 中 Interrupt：`set_live_intent` 打在外部条目上，`front_intent()` 为 Cancelled。
7. `TurnOrigin` 不进 scrollback、不 broadcast（`emit` 前被消费）—— 在 `translate_event` + 纯函数层面断言其永远走 `continue` 分支。

collect / interrupt 的排队行为不改代码，由端到端验收覆盖。

**前端 — vitest**
- `foldTranscript`：`peer_message` 进入对应 turn 分组且带 `fromName`；与同 turn 的 `content_block` 共组。
- `AcpChatView` 无组件测试（现有只测纯函数 `transcript` / `collectHint`），`peer_message` 分支的 busy 与计时由端到端验收覆盖，不为此新建组件测试脚手架。

**端到端验收**（部署后，用一次性沙箱会话或 UI 发消息给 ZeroMux 会话）
- 空闲会话收到短消息：气泡出现、busy 亮、结束后熄；**不**推送（<60s，预期）。
- 在 PushSettings 打开「常规」，发一条让它先 `sleep 70` 再回复的消息，锁屏：收到一次「✅ {name} 完成」。
- 外部 turn 进行中在 UI 发 prompt：显示「已排队」，外部 turn 结束后才执行；会话最终回到 Idle。
- 外部 turn 进行中点「中断」（非 stuck 状态也可见）：turn 停止，会话回到 Idle。
- 刷新页面（replay）：气泡与分组一致、busy 状态正确。
- ZeroMux 会话 A 经 UI 让它给会话 B（用 SessionInfoBar 复制的 peer 名）发消息，B 回信给 A：两边都出现「来自 @会话名」气泡，两边都不卡 Running。
- 从 SSH 里、以及 **ZeroMux tmux 终端里**运行的交互式 `claude`（非 bypass）给 ZeroMux Claude 会话发消息：直接送达，未被 hold；`ListAgents` 里两者能区分（`zmx-ai-…` 是 agent 会话，tmux 里的 claude 带 `tmux zmx-…` 标注）。
- ZeroMux 会话向一个 `refuse` 会话发消息：UI 出现灰色 notice。
- deploy 后未打开的会话不在 `ListAgents` 中；打开后出现，且 peer 名与部署前相同。
- 新会话首条 prompt 后标题正常生成（titler 未被干扰）。
