# 设计:Claude 成本校准 + 会话级累计

- **日期**:2026-06-26
- **状态**:待实现(spec 已过实证门 + CTO/PM 双重评审)
- **范围**:Feature 1(两件事之一;Feature 2 = PWA + Web Push,另立 spec)
- **接入点**:`src/acp/process.rs`、`src/session_manager.rs`、`src/run_metrics.rs`、`src/web.rs`、`frontend/src/components/AcpChatView.tsx`
- **不变量**:不破坏广播扇出模型(fan-out 任务仍是会话进程唯一所有者)

---

## 1. 背景与问题

zeromux 每个 agent 会话跑一个**常驻** `claude -p --output-format stream-json` 进程,多轮 prompt 走 stdin 发送(进程不重启,见 `session_manager.rs:839` spawn、`1029/1091` send_prompt)。每轮结束 CLI 发一个 `result` 事件带 `total_cost_usd`。

当前代码(`process.rs:341`)把 `total_cost_usd` 原样存进**该轮** `RunMetric.cost_usd`。镜像孪生项目 naozhi 在同位置踩坑修复(`920c626` "record genuine per-turn cost instead of CLI cumulative snapshot"),提示这是会话累计值。

## 2. 实证门(已执行 — 这是整个设计的地基)

跑一个常驻 `claude -p` stream-json 会话,连发两轮 prompt(apple / banana),抓两个原始 `result` 事件:

| 字段 | 第1轮 | 第2轮 | 判定 |
|---|---|---|---|
| `total_cost_usd` | 0.27995250 | **0.40114475** | **累计**(第2轮含第1轮) |
| `usage.input_tokens` | 13868 | 180 | **单轮** |
| `usage.output_tokens` | 37 | 4 | **单轮** |
| `usage.cache_read_input_tokens` | 0 | 41047 | **单轮** |
| `usage.cache_creation_input_tokens` | 33550 | 15947 | **单轮** |
| `num_turns` | 1 | 1 | 单轮 |
| `assistant.message.model` | claude-opus-4-8 | claude-opus-4-8 | 有模型名 |

**结论(三条,锁定设计)**:

1. **bug 证实**:`total_cost_usd` 累计。本轮真实成本 = 0.40114 − 0.27995 = **0.12119**。会话级求和会三角累加(第N轮已含前N-1轮)。
2. **口径分裂**:`total_cost_usd` 累计,但 `usage.*` 单轮。→ **只有 cost 需要差分,tokens 保持原样**(原代码 tokens 字段本就正确)。
3. **自算 vs 差分**:模型名可拿到(`claude-opus-4-8`),理论上可用 `tokens × 单价` 自算。但 cache_creation/cache_read 各有独立计价,自算需维护完整价表 + 缓存单价且随官方调价漂移。**采用 cost 差分**:`本轮 = 本次 total − 上次 total` 已能精确还原(0.12119),无需价表。放弃自算。

## 3. 设计(Part A:差分修复)

### 3.1 差分核心(仅 Claude,仅 cost)

在 Claude 的 fan-out 任务(`session_manager.rs` 约 2005 行,`AcpEvent::Result` 取值处)做差分:

```
本轮 cost = clamp_0(本次 total_cost_usd − 上次 total_cost_usd)
```

- `tokens_in/tokens_out` **不动**(实证确认单轮)。
- "上次累计值" `prev_cost: Option<f64>` 存为 fan-out 任务**局部变量**,紧挨现有 `run_started_ms/local_running`(无锁,契合 fan-out 单一所有者模型)。
- **仅 Claude 路径**。Kiro(`kiro_process.rs:356` 恒 `None`)、Codex(`codex_process.rs:712` 恒 `None`)**确定无 cost**,不做差分、不显示花费——非"待核实",是已知事实。

### 3.2 冷启动 vs resume 边界(修 P1-B)

`prev_cost` 随 fan-out 任务生命周期存亡;进程重 spawn(冷启动 / B-1 持久化恢复 / `--resume`)→ fan-out 重建 → `prev_cost` 归零。**但冷启动与 resume 必须区分**,否则:

- 若首轮一律记 0 → **冷启动会话第一轮成本永久丢成 0**(手机上发一两轮即结束的会话极常见,总计显示 $0.00 = 数据缺陷)。
- 若首轮一律记 total 本身 → **resume 会把 CLI 恢复的历史累计额误算成"本轮花了一大笔"**。

**修法**:`spawn_claude` 已收 `resume: Option<&str>` 参数(`session_manager.rs:1353`)。把"本次 spawn 是否带 resume token"作为 `is_resumed: bool` 传入 fan-out,初始化 `prev_cost`:

| 场景 | `prev_cost` 初值 | 首个 Result 行为 |
|---|---|---|
| 冷启动(`is_resumed=false`) | `Some(0.0)` | 增量 = total − 0 = **total 本身**(正确,首轮就是本轮) |
| resume(`is_resumed=true`) | `None` | 增量记 **0**,并把 `prev_cost` 设为该轮 total(不误算历史额) |

### 3.3 差分推进规则(覆盖所有 Result 分支)

- **None 值**:本轮 cost 记 `None`(不参与聚合),**不更新** `prev_cost`(下轮仍以上一个有效累计为基线)。
- **负差**:`本次 < 上次` → clamp 到 0(对齐 `run_metrics::duration_ms` 的单调时钟回拨保护风格)。
- **Cancelled 但有值**(interrupt-resend:被打断的旧 turn 的 Result 仍会到达且带累计 cost,见 `session_manager.rs:1968` 注释):**只要 total 非 None 就推进 `prev_cost`**,无论 outcome 是 Completed 还是 Cancelled——被打断也烧了钱,且必须推进基线否则下轮差分错。

### 3.4 不受影响的并发场景(已核实,写明打消疑虑)

- **lagged broadcast 不断裂差分链**:差分发生在 fan-out 内部(读 `process.event_rx`,`session_manager.rs:1933`),`prev_cost` 是 fan-out 局部变量。`BROADCAST_CAPACITY`/`Lagged` 只影响下游 WS 订阅者,不影响 fan-out 读进程事件。fan-out 永不漏 Result。
- **turn_seq 错位无关**:差分按"Result 到达顺序"算,FIFO boundary(`1959-1973`)保证每个 started turn 恰好一个 boundary 按序到达。

## 4. 设计(Part B:会话级累计总计)

### 4.1 致命陷阱:不能在 cap-50 滑动窗口上求和(修 P1-A)

`session_manager.rs:589` 的 `run_metrics` 是**硬上限 50 条的 `VecDeque`**,超了 `pop_front()` 丢最老。`compute_stats` 注释自称 "full history" 是**假的**——只是内存里最近 50 条。

若在读路径(`runs_for_session:613` 的 `compute_stats`)对这个 VecDeque 求和:80 轮的会话 `total_turns` 永远封顶 50、`total_cost` 系统性偏低且**无任何截断提示**(偏低比偏高更隐蔽,看着合理实则错)。

**修法**:把累计移到**写路径**。在 `Session` 结构体加三个单调累加字段:

```rust
pub lifetime_turns: u64,
pub lifetime_duration_ms: i64,
pub lifetime_cost_usd: f64,
```

在 `record_run_metric`(`session_manager.rs:584`)入队 `RunMetric` 的**同时**累加这三个字段(此处尚未被 cap-50 丢弃,是唯一能看到每一条的地方)。`runs_for_session` 直接返回这三个字段,**不在读路径对 VecDeque 求和**。

> **三维度同源(代码核实后定)**:Session 已有 `turns_completed: u32`(`session_manager.rs:229`,在 `mark_turn(Idle)` 即 `:479` 累加),它服务别的用途且累加点与 `record_run_metric` 不同——混用会让"轮次 N 但成本只累加 N−1 次"的口径错位。因此**三个维度(turns/duration/cost)全部新增字段并统一在 `record_run_metric` 这一个点累加**,不复用 `turns_completed`,换取三维度同源、口径绝对一致。

**额外收益**:`record_run_metric` 是三后端共享的单点,累加放这里天然覆盖 Claude/Kiro/Codex 全部 run,无需碰三份扇出拷贝(`2017/2546/2792`)。

### 4.2 累加细节

- `lifetime_turns += 1`、`lifetime_duration_ms += m.duration_ms` 对每条 run 累加。
- `lifetime_cost_usd += m.cost_usd.unwrap_or(0.0)`(None 不影响和;Kiro/Codex 恒 None → 不贡献 cost,但仍计 turns/duration)。
- 这三个字段是**会话内存生命周期**的累计(随 Session 存活);进程重 spawn 不重置它们(它们属于 Session 不属于 fan-out 任务)。

### 4.3 口径:含后台调度运行(修 PM 方向错误)

调度/无人值守运行(`run_id.is_some()`,`session_manager.rs:2071`)与交互轮次走**同一个** `record_run_metric` 进同一 VecDeque。原设计要"只统计交互轮次"——但 PM 评审指出:**这恰恰排除了最该被观测的成本**(后台 agent 在用户睡觉时烧钱才是真焦虑),且 `RunMetric` 当前无标志位可区分,实现需额外加字段。

**决策**:`lifetime_*` **统计该会话的全部 run(含后台调度)**。语义清晰("这个会话——含它触发的后台运行——总共花了多少/几轮/多久"),实现最简(写路径无差别累加)。后台运行的成本护栏/`max_cost_usd` 上限/超阈值推送留作**后续独立 feature,与 Feature 2(PWA 推送)合流**。

### 4.4 暴露与前端

- `runs_for_session` 返回的 `stats`(`web.rs:665-669` 的 `GET /api/sessions/{id}/runs` 已返回 `{runs, stats}`)中**新增** `lifetime_turns / lifetime_duration_ms / lifetime_cost_usd`。**零新端点**。
- 前端 `AcpChatView` 头部读 `stats` 渲染"总计:N 轮 · M 分 · $X"。
- **Cost 显示诚实标注**:沿用 `RunMetricsPanel.tsx:149-156` 已有范式——非 Claude 后端 cost 列显示"—" + tooltip"该后端不上报成本"。会话总花费仅含 Claude 轮次的成本,但轮次/耗时含全部后端。

## 5. 错误处理

- 差分仅局部算术,无新 I/O / 无新锁,不破坏扇出不变量。
- `prev_cost` 随 fan-out 任务存亡,重 spawn 归零(由 `is_resumed` 正确初始化)。
- `lifetime_*` 随 Session 存亡;空会话返回 0,不报错。
- None cost 在差分与累加两处都安全跳过。

## 6. 测试策略(TDD:先写失败测试)

### Rust 单元测试

1. **`diff_normal_cumulative`**:累计序列 `[0.01, 0.03, 0.06]` → 增量 `[0.01, 0.02, 0.03]`。
2. **`diff_cold_start_first_turn`**:`is_resumed=false`,`prev=Some(0.0)`,首个 total=0.28 → 本轮增量 = **0.28**(冷启动首轮不丢)。
3. **`diff_resume_first_turn_zero`**:`is_resumed=true`,`prev=None`,首个 total=0.50 → 本轮记 **0**,`prev` 置 0.50,下轮 total=0.55 → 增量 0.05。
4. **`diff_none_does_not_advance_prev`**:序列含 None,后续轮以上一个有效值为基线。
5. **`diff_negative_clamped_zero`**:`本次 < 上次` → 0。
6. **`diff_cancelled_with_value_advances_prev`**:outcome=Cancelled 但 total 非 None → 推进 prev(P2-A)。
7. **`lifetime_accumulates_beyond_cap50`**:push 80 条 run → `lifetime_turns==80`、`lifetime_cost==80条之和`(钉死 P1-A,防止有人把累加挪回读路径)。
8. **`lifetime_includes_scheduled_runs`**:交互 run + 调度 run 混合 → 都计入 lifetime(钉死 4.3 口径)。
9. **`lifetime_cost_skips_none`**:含 None cost 的 run → turns/duration 计入,cost 和不受 None 影响。

### 前端测试

10. `AcpChatView` 头部渲染 `stats.lifetime_*` 三字段(跟随现有 RunMetricsPanel 测试风格);非 Claude 会话 cost 显示"—"。

### 验证标准(goal-driven)

- 实证门已过(§2 证据表)。
- 上述 10 个测试全绿。
- `cargo test` + 前端 `npm test` 全过。
- 真机:同一 Claude 会话发 3 轮,头部"总花费"= 三轮实际增量之和(不随轮次膨胀);冷启动只发 1 轮的会话总花费 ≈ 该轮真实成本(非 0)。

## 7. 评审记录(CTO + PM 双重对抗性评审,2026-06-26)

本 spec 是评审后的修订版。原始设计("首轮一律记 0" + "读路径对 stats 求和" + "只统计交互轮次")被双评审推翻,关键取舍:

- **P1-A(CTO)**:`total_*` 不能建在 cap-50 滑动窗口 → 移到写路径 `record_run_metric` 单调累加(§4.1)。**已采纳。**
- **P1-B(CTO)**:冷启动首轮记 0 会永久丢首轮成本 → `is_resumed` 布尔区分(§3.2)。**已采纳。**
- **P1-D(CTO)**:cost/tokens 口径分裂 → 实证证实 tokens 单轮、仅 cost 差分(§2、§3.1)。**已采纳。**
- **方向错误(PM)**:原"排除后台调度运行"恰排除了最该观测的成本 → 改为含后台运行(§4.3)。**已采纳。**
- **拆分(PM)**:差分是正确性 bug 不是 feature → 本 spec 内 Part A(bug)与 Part B(总计)合做,因 Part B 求和正确性依赖 Part A 差分修对(naozhi 同样配套修)。**部分采纳**:不拆成两个 PR,但 spec 内分 Part A/B 明确职责。
- **更优方案"tokens×单价自算"(CTO/PM)**:实证后判定差分已足够精确且无需维护价表 → 采用差分(§2 结论3)。**评估后不采纳,理由记录在案。**
- **后台成本护栏 / `max_cost_usd` / 超阈值推送(PM 首推)**:真 painkiller,但范围更大且与 Feature 2(PWA 推送)咬合 → **留作后续独立 feature,不在本期**(§4.3)。

## 8. 非目标(明确划出范围)

- ❌ 后台运行成本护栏 / 单次运行 `max_cost_usd` 上限(后续 feature)。
- ❌ 跨会话 / 全局 / 月度成本 dashboard。
- ❌ 成本超阈值推送告警(并入 Feature 2)。
- ❌ Kiro/Codex 成本支持(上游 CLI 不上报,非 zeromux 可解)。
- ❌ tokens 差分(实证证实单轮,无需)。
- ❌ 持久化 `prev_cost`(进程重启 CLI 累计本就归零,持久化反而制造跨重启差分错误)。
