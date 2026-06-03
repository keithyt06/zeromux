# Group B-2：会话主动管理 — 设计文档（占位，待 B-1 落地后细化）

**日期**：2026-06-02
**状态**：**占位（PLACEHOLDER）**。依赖 [B-1 持久可恢复会话](2026-06-02-session-persistence-B1-design.md) 已实现并**线上验证 resume 可靠**后才动工。原因：B-2 的所有行为都是「主动让进程消失」，只有当 resume 被证明能可靠重生上下文时，这些行为才是非破坏性的、才安全。

本文件记录 B-2 的范围与已定决策，避免遗忘；正式细化（含逐节设计）在 B-1 完成后用一次新的 brainstorming 进行。

---

## 范围（B-2）

在 B-1 的「持久可恢复 session」基石上，叠加**主动生命周期管理**：

1. **中央轮询任务** —— 单个 tokio 后台任务，每 TICK（约 10s）扫一遍 session HashMap。
2. **Watchdog 两级超时** —— turn 跑太久：软超时发 `Cancel` 中断该 turn（保留 session）；连续 `MAX_STRIKES` 次仍超时 → 硬超时 `running=None`（drop 进程，靠 B-1 resume 下次重生）。
3. **Idle 容量驱逐** —— 活进程数超 `MAX_LIVE` 时，休眠（`running=None`）`turn_state==Idle` 且 `last_activity` 最久的 agent session。
4. **中断重发** —— session 正在跑 turn 时收到新 prompt：先 `Cancel` 在途 turn，等回到 Idle（或超时兜底），再发新 prompt。

## 已定决策（来自 2026-06-02 brainstorming）

- **tick 机制**：单个中央后台任务轮询（非 per-task timeout，非事件驱动——卡死进程无后续事件，懒检查不触发）。
- **超时动作**：两级——先取消 turn，连续多次再杀进程。
- **驱逐策略**：驱逐最久空闲，但**只驱逐 `Idle` 状态**的；`Running` 不驱逐。
- **红线**：tmux 永不被休眠/驱逐（B-1 已确立 tmux 仅做重启存活、不主动休眠）。
- **中断重发**：只做「打断旧的、发新的」，**不做** naozhi 的消息 coalesce（YAGNI）。

## B-2 引入的新状态（B-1 不含）

`RunningProcess` 增加观测字段：
- `turn_state: TurnState`（Idle | Running）
- `turn_started_ms: Option<u64>`
- `timeout_strikes: u8`
`Session` 增加 `last_activity_ms`（驱逐排序用；B-1 未引入，因 B-1 无驱逐需求）。

fan-out 在 **turn 边界**（转发 Prompt 时 / 收到 Result|Error|Exit 时）通过 B-1 已建立的 `Weak<SessionManager>` 回引用上报 turn 状态。

## 未决问题（细化时回答）

- 中断重发「等 Idle 超时兜底」后的明确行为：强发新 prompt？丢弃并提示？（B-1 review 标记的模糊点，B-2 细化时定。）
- Codex 的 cancel 是 drop call_fut（不真正通知服务端停），「等 Idle」可能久等——中断重发的等待上限与兜底语义需明确。
- `MAX_LIVE` 默认值与是否做成 CLI flag。
- 阈值常量：`TICK`、`SOFT_TIMEOUT`、`MAX_STRIKES` 的具体值（naozhi 量级：约 10s / 120s / 2）。

## 不在 B-2

naozhi 的多平台 IM、Cron、多节点反向拨入、外部进程发现/接管——与 zeromux 定位无关，不做。

## 后续修复项（来自 B-1 最终 review，2026-06-02）

- **tmux 服务器已死时 resume_failed 不触发**：`PtyHandle::spawn` 在 exec `tmux` 二进制后即返回 Ok，不检查退出状态。所以 `tmux attach -t <已死target>` 会"spawn 成功"、瞬间退出，`ensure_running` 的 attempted_resume 回退分支不进入，stale Tmux token 不清、resume_failed 不发 → 该 session 变僵尸（每次重连 attach→秒退→Idle）。仅当 zeromux 与外部 tmux server 一起重启时触发（`systemctl restart zeromux` 不影响独立 tmux server,re-attach 正常）。非阻塞:不挂不漏不崩,删除重建即可恢复。修复方向:`spawn_tmux` 在 attach 前 `tmux has-session -t <target>` 探测,或检测子进程短窗口内退出,使 tmux 回退与 agent 后端对齐。
- `SessionStore::update_name` 为未接线的 dead code（无 rename API）——接线 rename 或删除。
