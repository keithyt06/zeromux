# CTO 审 S6 / S7 spec（2026-09-29）

审阅对象：`specs/2026-09-29-s6-gate-review-dispatch-design.md`（下称 S6）和 `specs/2026-09-29-s7-crew-cockpit-and-backend-parity-design.md`（下称 S7）。代码行号都在 `33c2236` 上亲自 Read 过。总体评价：两份 spec 的核实质量很高，S7 §0.3 还纠正了我终稿里「G10 免费得到」的错误，这一点接受。以下只列问题。

## BLOCKER

**B1（S6 §3.2 表格与 §3.4）话题模式用 `mark_turn` 驱动忙闲，会让 turn 永久停在 Running。**
`apply_turn` 的 Idle 分支只在 `rp.turn_seq == seq` 时生效（`session_manager.rs:614`），而 Running 分支会把 `rp.turn_seq` 设为当时的 seq（:603）。S6 的设计是每个回答都 `turn_seq += 1`，然后 `crew_busy` 再执行 `mark_turn(Idle, turn_seq)`。结果是：
- busy=true 时写入 seq=N；
- 之后到来的回答把 seq 推到 N+1；
- busy=false 时的 `mark_turn(Idle, N+1)` 被忽略，`turn_state` 永远停在 Running。

后果有三个：
- 重连时 `replay_done.running`（`acp/ws_handler.rs:121`）恒为 true，而 §3.4 恰恰依赖它来恢复忙闲；
- `apply_turn` 会刷新 `last_activity_ms`（:597），与 §3.4「crew_busy 不 bump」相矛盾；
- Running 分支会清空 `approval_ids`（:606）。

**建议**：话题模式不走 `mark_turn`。新增 `set_crew_busy(sid, bool)`，直接写 `rp.turn_state`，不带 seq、不改 `last_activity_ms`，并补一条单测：「busy→回答→idle」之后 `turn_is_running == false`。

**B2（S7 §6.4、§7.3）G10 的 replay 会静默改用 Claude 执行。**
快照里的 `agent_type` 记的是 `scheduled_session_type(agent_type).to_string()`（`session_manager.rs:1460`），而 SessionType 的 Display 输出是 `"crew"`（:78）。replay 从快照读回 `"crew"`（:1521）后再次调用 `trigger_run`。S7 §6.4 又明确要求「`"crew"` → Claude（未知值回落）」，所以一个 conductor run 被 replay 时会变成 Claude 会话执行。
**建议**：快照改记任务标签（`crew-conductor`），或者让 `scheduled_session_type` 同时接受 `"crew"`。§7.3 的测试「snapshot 的 agent_type 记为 crew」要改成断言「replay 仍然走 Crew」。

## MAJOR

**M1（S7 §6.2 第 5 点，以及 S6 §2.2）`upsert_config` 的 ON CONFLICT SET 列表里根本没有 `agent_type`。**
见 `scheduled_tasks.rs:481`：update 永远改不了后端。S7 写的「缺省时保留原值」在现状下天然成立，但「改成 codex」同样不会生效。
- S7：SET 列表里要加 `agent_type`，并保留 handler 层的「缺省保留」逻辑。
- S6：SET 里除了 `gate_cmd`，**还要加 `gate_since_ms`**，否则 handler 算出来的新值写不进去。
- 两份 spec 都要同步修改 `query_configs` 按下标取列的 SELECT（:497、:501）。

**M2（S5 R4 与 S6 §3.7、S7 §3.2）`owns_slot` 的来源必须是持久化的 origin，不能是 `resume.is_none()`。**
自建的 slot 在重启后也会走 `resume=Some(k)`（`crew_process.rs:596`）。如果 R4 用「是否 resume」来推断归属，那么重启过的自建会话关闭时就不会删除 slot，泄漏到 Gateway。
**建议**：S5 R4 就引入 `crew_origin` 列（S7 §3.2 那一列提前到 S5），`owns_slot = origin != external`。S7 §3.6 已经把这一点当作回归重点，要前移到 S5 一起测。

**M3（S6 §0.1、§3.2 与 S7 §0.4、§2.2、§4.3）G2 持久化字段的命名不一致。**
S6 用单列 `crew_mode ∈ chat|topics|goal`；S7 同时使用 `crew_mode` 和 `crew_agent == "kirocrew-conductor"`。
**建议**：S5 G2 定死为两列 `crew_mode`（Gateway 原值 `""|crew`）和 `crew_agent`（原值）。展示用的三档由前端派生。S6/S7 统一引用这两列。

**M4（S6 §3.6）前端的 result 分支会与 `crew_busy` 抢 busy 状态。**
`content_block` 会 `setBusy(true)`，result 会 `setBusy(false)`（`hooks/useAcpSocket.ts:383`、`:401-440`）。话题模式下每个回答都会先置忙再置闲，覆盖掉 `crew_busy` 给出的状态（其他话题可能仍在跑）。
**建议**：topics 会话里，content_block 和 result 不改 busy，busy 只由 `crew_busy` 和 `replay_done` 驱动。补 hook 单测。

**M5（S6 §3.2 `crew_ask`）「待回答」状态重启后会丢失。**
ask 路径刻意不调用 `settle_posture`，而 F1 的持久化只挂在 `settle_posture` 上（我在 cto-reviews-pm 专项 2 里的建议）。所以 `awaiting_input` 和问题 snippet 在重启后都会丢，而一天会有多次部署。
**建议**：新增 `persist_posture(sid)`，settle 和 ask 两条路径都调用它；F1 列补上 `awaiting_input`。§3.8 补测试「ask 后重启仍是待回答」。

**M6（S6 §3.1、§3.8，遗漏的边界）zeromux 重启期间到达的 `crew_result` 会永久丢失。**
话题天然是异步的，而 auto-update 和部署会让 WS 断开几十秒。这段时间里 Gateway 广播的 `chat_message` zeromux 收不到，既进不了 transcript，也不会推送。
**建议**：topics 模式重连时 GET `/api/chat/slots/{key}`（S6 §3.1 已核实它返回 `messages`），按已见的 `meta.mid` 补发缺失的 `crew_*` 回答，复用 `seen_mids` 去重。这个 seen 集合要持久化或者从 scrollback 重建，否则重启后会重复补发。

**M7（S6 §9.1 与 S7 §0.1）两个使用门槛各自定义，口径不同。**
- 数据源不一样：S6 用 DB 的 `crew_mode` 加 `lifetime_turns`，S7 用 journalctl 的 `zmx_usage`。
- 话题模式不调用 `record_run_metric`（S6 §3.2），所以 `lifetime_turns` 恒为 0。
- S5 只开放「目标指挥」，「并行话题」要等 S6 才可用，14 天窗口起点不同会低估话题模式的用量。

**建议**：只保留 S7 的门槛 T，它用埋点，更可靠；S6 T9 直接引用 T。T 的窗口改为「目标指挥」和「并行话题」各自从上线日起算。

## MINOR

- **m1（S6 §2.3 第 2 步）** 超时执行 `kill(-pgid)` 之后要 `child.wait().await` 回收 `sh`，否则会留下僵尸进程。
- **m2（S6 §2.3）** gate 执行期间任务可能被删除：`delete_config` 会删掉 run 行（`scheduled_tasks.rs:511`）。随后 `set_run_state` 空操作，但 Wake 分支仍会 `trigger_run` 建出会话。**建议**：Wake 之前先 `get_config` 复核任务存在且 enabled。
- **m3（S6 §2.4 D4）** 「7 天未唤醒」需要新增两列、在 confirmations 响应里捎带字段、再加一行卡片提示，有过度设计的倾向。建议挪到 S7，S6 只保留 `gate_clean` 的 run 行展示。
- **m4（S6 §4.2 G7b）** `apply_posture_delta` 在锁内执行（:2071），fan-out 拿不到「这是不是新的 approval id」。需要让 `record_and_broadcast` 返回这个信息。另外 ask 和 approval 共用去抖 map，会导致 5 分钟内先推了 ask 就压掉审批推送。建议按 kind 分 key。
- **m5（S6 T9 §9.2 与 S7 §2.2 `children`）** 父子关系有两套实现（crew_watch 快照一套，SlotsCache 一套）。建议只让 crew_watch 写快照，S7 的代理层只读这份快照；S7 的 `SlotsCache` 与 S6 共用同一个 owner，不要做两个 5s 缓存。
- **m6（S7 §9.2 D10）** `static tokio::sync::Mutex` 的 const 构造依赖 tokio 版本和 feature（当前 1.52，`full`）。更稳妥的做法是放在 `SessionManager` 字段上或者用 `LazyLock`。实施前用 `cargo check` 确认即可。
- **m7（S7 §12 S7-a）** 这一期捆了 ②、F6、跨设备已读、⑧ 实测、代理层和 G9 六项。② 是历史上 parity 问题最多的一类，建议单独成一期、单独安排 reviewer，其余项放到 S7-a2。
- **m8（S6 §2.8）** 测试缺三条：`reconcile_orphans` 在 `gate_phase=1` 且 `side_effects=0` 时的状态；Wake 后 `gate_phase` 已清 0，随后崩溃时应该按 orphaned 处理；`input_snapshot` 里含预检输出、replay 不再跑 gate 的对称测试。
- **m9（迁移幂等）** 两份 spec 新增的都是 `ALTER ... ADD COLUMN`，走 duplicate-column 吞错（`scheduled_tasks.rs:447-461`、`session_store.rs:60-66`），**是幂等的**。唯一的例外是 S7 A.1 的部分唯一索引，它用 `CREATE UNIQUE INDEX IF NOT EXISTS`，本身也幂等。但 spec 写的「失败时启动报错」只会在 SQLite 版本过旧时触发，建议加一条启动自检测试。

## 不变量核对结论

- **fan-out 独占 / SessionInput**：两份都守住了。话题模式的轮询在 process 层 detached 执行、结果回流事件循环；gate 进程由独立任务持有，不碰 fan-out。
- **Drop 清理**：取决于 M2。
- **tick 不阻塞**：S6 的 gated 分支合格；非 gated 分支仍然在 tick 内 inline `.await trigger_run`（:1194），这是已知的既有问题，同意本期不修。
- **三后端 parity**：S7 §6.3 的「五条路径 × 三个后端」矩阵是正确的门槛。S6 的话题模式作为 Crew 专属分支的豁免也合理，前提是 B1 修掉。
