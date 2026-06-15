# 无人值守 run 空闲看门狗(idle-watchdog)设计

> **类型**:feature spec
> **日期**:2026-06-15(经 CTO/PM 双评审修订)
> **来源**:naozhi 灵感清单 §5 #5 第 3 点(keepalive / 区分"静默"与"卡死");[[zeromux-sched-terminal-state-replay-spec]] 的自然续作
> **范围**:仅定时任务(scheduled)的无人值守 run;不碰普通交互会话

---

## 1. 背景与问题

Sprint 2(三态终态判定 + 副作用确认队列 + run record + replay)已实现并上线(commits `aa684e5`→`db8dd16`)。本 spec 补的是该设计里**唯一未落地的残留项**:无人值守 agent 的"静默 vs 卡死"判别。

**现状的盲区**(已对照 `src/scheduled_tasks.rs` 真实代码核实):

- 看门狗函数 `reconcile_timeouts_per_task`(`scheduled_tasks.rs:493`)按**总运行时长**判超时:
  ```sql
  WHERE state IN ('claimed','running')
    AND started_ms < now_ms - (COALESCE(max_runtime_min, 30) * 60000)
  ```
- 后果:一个**流式产出了 30 分钟的健康慢任务**(Claude thinking / Codex reasoning 持续输出),和一个**一开始就卡死的任务**,被这条"总时长"判据**一刀切地同等对待**——前者被误杀,后者要白等到总时长上限才被发现。
- 一个卡住但没退出的 agent(没发 `Result`/`Error`/`Exit`)会一直挂在 `running`,直到这个粗粒度看门狗把它切成 `aborted`(`failure_kind='watchdog_timeout'`)。系统**区分不出**它是"真卡死"还是"其实在干活被误杀"。

**核心洞见**:看门狗真正的毛病不是"缺心跳",而是它**按总时长判,而不是按沉默时长判**。只要 agent 还在产出事件,就不该判它卡死。

---

## 2. 目标与非目标

### 目标
- 看门狗改用**沉默时长**(距上次活动多久)判超时,让流式慢任务不被误杀。
- 保留**总时长硬上限**作为双保险,兜住"刷屏死循环"(在纯沉默判据下永不静默 → 否则永生)。
- **空闲超时与总时长超时在确认队列里可区分**(不同 `failure_kind` + 不同 UI 文案),让人工裁决"重放/不重放"有依据。
- 完全复用 Sprint 2 已上线的三态 / 确认队列 / replay 链路,**不加新 run 状态**。

### 非目标(明确 YAGNI)
- **不做 in-flight 兜底**(C2):不查 Codex `tools/call` 是否未回 / Claude 是否 mid-turn。"活动"就是 `events.ndjson` 有写入(C1)。**已知边界见 §10**。
- **不发独立 keepalive 心跳事件包**:不新增 `AcpEvent` 类型,沿用已有事件流作为活动信号。
- **不碰普通交互会话**:看门狗本来就只跑在 scheduled run 上,维持此边界。
- **不加"疑似卡住"中间状态**:沉默超阈值直接走现有 `aborted`(已否决 B2 方案)。

---

## 3. 设计决策摘要(澄清结论 + 评审修订)

| 决策点 | 选定 | 理由 |
|---|---|---|
| 超时后动作粒度 | **B1**:照旧 `aborted`,不加新 run 状态 | 复用现有三态 + 确认队列,零 schema 语义新增 |
| "活动"信号 | **C1**:`events.ndjson` 被写入即"活动" | 消除最常见的流式长任务误杀;C2 要动三个 backend 内部状态,违背 simplicity-first |
| 活动时间来源 | **文件 mtime**(CTO P1-a 修订) | `append_run_event` 本就每事件写 `events.ndjson`,其 mtime 天然是"最后活动时刻"——**零新增写、零新列、零迁移**。比"加 `last_activity_ms` 列 + 每事件 UPDATE"省一半工作量且无写放大 |
| 阈值配置粒度 | **D2**:`max_runtime_min`(总时长硬上限)+ 新增 `idle_timeout_min`(空闲上限),先到先触发 | C1 下刷屏死循环永不静默,总时长是唯一兜底 |
| 空闲默认 | `idle_timeout_min` 默认 **60** 分钟 | 无人值守宁可给足耐心;对"长静默命令"(§10)更宽容。想更早发现卡死的用户可 per-task 调低 |
| 总时长默认 | `max_runtime_min` 默认 **30 → 300** 分钟(5 小时) | 配合 60min 空闲判据,30min 总上限太短会砍掉健康慢任务 |
| 超时区分 | 空闲触发 → `failure_kind='idle_timeout'`;总时长触发 → `'watchdog_timeout'`(PM P1 修订) | 两种超时对"能否安全重放"指向相反动作,UI 必须可区分 |
| 覆盖范围 | 仅 scheduled run | naozhi 机制本针对无人值守;交互会话用户自己盯着、随时能 Ctrl-C |

---

## 4. 核心判据改造

### 4.1 判定逻辑(纯函数,便于单测)

抽出一个纯函数,把"读什么"和"怎么判"分离——这样单测无需碰文件系统或 DB:

```rust
/// 返回 Some(failure_kind) 表示该 run 应被 abort,None 表示健康。
/// last_activity_ms: events.ndjson 的 mtime;无文件时传 None(退化为 started_ms)。
fn stale_verdict(
    now_ms: i64, started_ms: i64, last_activity_ms: Option<i64>,
    idle_timeout_min: i64, max_runtime_min: i64,
) -> Option<&'static str> {
    let last = last_activity_ms.unwrap_or(started_ms);
    if now_ms - last > idle_timeout_min * 60_000 { return Some("idle_timeout"); }
    if now_ms - started_ms > max_runtime_min * 60_000 { return Some("watchdog_timeout"); }
    None
}
```

判定顺序:**先判空闲,再判总时长**——空闲是更常见、更需早发现的情形,且二者都触发时"静默"是更准确的死因描述。

### 4.2 看门狗改写(SQL → 查询 + 循环 + stat)

> **架构变化(评审暴露)**:SQLite 无法 stat 文件,所以看门狗**不能再是单条 set-based UPDATE**。改成:

1. `SELECT id, started_ms, task_id` + 关联 config 的 `idle_timeout_min`/`max_runtime_min`,取所有 `state IN ('claimed','running')` 的 run。
2. 对每个 run:`stat(run_dir(id).join("events.ndjson"))` 取 mtime(ms);文件不存在 → `None`。
3. 调 `stale_verdict(...)`;返回 `Some(kind)` 则 `set_run_state(id, "aborted", .., failure_kind=kind, ended_ms=now)`。

**N+1 担忧不成立**:活跃的 scheduled run 通常个位数,看门狗每 60s tick 一次,逐个 stat + 可能一条 UPDATE 的成本可忽略——远小于"每事件写 DB"的写放大。`set_run_state` 的 `state IN ('claimed','running')` 终态守卫(`scheduled_tasks.rs:454`)保证与 fanout 正常 finalize 不双写(见 §11 竞态说明)。

> **`reconcile_orphans` 不改**——它是开机一次性回收(`main.rs:285`)和 scheduler respawn 回收(`scheduled_tasks.rs:743`),按 `started_ms`,与每 tick 的沉默判据职责正交。其 `Some(cutoff)` 分支当前**无生产调用方**,本次不触碰。

### 4.3 活动信号 = events.ndjson mtime

`append_run_event`(`session_manager.rs:2151`)在 `active_run_id` 窗口内对**每个 `AcpEvent`** append 一行到 `~/.zeromux/runs/<run_id>/events.ndjson`(Sprint 2 已有行为)。因此该文件 mtime 天然随每次事件刷新——**本 feature 在事件路径上零新增代码、零新增写**。

- 任何 `AcpEvent`(text / thinking / reasoning / tool_use / tool_result …)都刷新 mtime。
- run 从未产出任何事件(agent 瞬死)→ 文件不存在 → mtime=None → 退化按 `started_ms` 判(与 NULL 兜底同语义)。

---

## 5. 数据模型与迁移

> mtime 方案**取消了原 `last_activity_ms` 列**。只剩一个新列。

### 5.1 `agent_runs_config.idle_timeout_min INTEGER`

per-task 空闲上限(分钟)。

- 迁移:`ALTER TABLE agent_runs_config ADD COLUMN idle_timeout_min INTEGER`,走现有幂等循环(`scheduled_tasks.rs:361-374`,该模式已吞 "duplicate column name")。可空,旧行自动 NULL。
- `TaskConfig` 结构体加 `pub idle_timeout_min: Option<i64>`。
- `upsert_config` 的 INSERT 列 + `ON CONFLICT DO UPDATE SET` 列表加上它;`query_configs` 的 SELECT 列 + row mapping 加上它(和 `max_runtime_min` 并列)。
- NULL → 看门狗里 `COALESCE(idle_timeout_min, 60)`(或纯函数侧默认 60)。

### 5.2 默认值落点

- 空闲:无 per-task 值 → **60**
- 总时长:无 per-task 值 → **300**(从现有看门狗 SQL 里的 `30` 改成 `300`,并改掉 `scheduled_tasks.rs:490` 那句 "default 30 if NULL" 注释)

### 5.3 输入校验(CTO P1-b)

`idle_timeout_min` 与 `max_runtime_min` 一样,在 `web.rs` 创建/编辑入口 `clamp(1, 1440)`。**下限必须 ≥1**:若允许 0,纯函数里 `now - last > 0` 恒真 → 所有 run 一进来就被判 idle abort(全员秒杀)。前端也应挡 0/负数(见 §7)。

### 5.4 ⚠️ 向后兼容行为变化(显著标注)

把看门狗里 `max_runtime_min` 兜底默认从 **30** 改成 **300**:

- **现存任务**(未显式设 `max_runtime_min`)总时长硬上限从 30min 跳到 5h。预期且合理(配合 60min 空闲判据,30min 太短会砍健康慢任务),但属对存量任务的静默放宽。
- **旧 run 在新判据下不是"变宽松"**:`events.ndjson` mtime 仍在(若有事件),所以旧 run 照常按沉默判;真正"无任何活动信号"的旧 run 退化按 `started_ms` 起算 idle,会在 **60min**(空闲默认)被 abort,而非 300min。即旧 run 的 idle 判据反而**比总时长更早触发**。
- **建议给用户一处可见提示**:前端 changelog 或表单说明里点一句"超时默认已调整",别只埋在 spec。

---

## 6. API 层(`src/web.rs`)

- 创建 / 编辑任务请求体 + `TaskConfig` 序列化加 `idle_timeout_min`(与 `max_runtime_min` 完全并列,含 `clamp(1,1440)`,见 `web.rs:1368/1410`)。
- 反序列化用 `#[serde(default)]` 兜旧客户端。

---

## 7. 前端(`frontend/src/components/ScheduledTasksPanel.tsx` + `lib/api.ts`)

### 7.1 任务表单
- `max_runtime_min` 输入框旁加 `idle_timeout_min` 输入框,**两者折叠进"高级"区**(降低双 timeout 的认知负担):
  - 「空闲超时(分钟)」— 多久没有任何输出就判定卡住(留空=默认 60)
  - 「最长运行(分钟)」— 总运行硬上限,防死循环(留空=默认 300)
- 两框可空,前端挡 0/负数(下限 1)。
- 「空闲超时」加 tooltip 透传 §10 边界:**「若任务会运行长时间无输出的命令(全量测试 / CI / 大型 build),请把空闲超时设得高于该命令的预期时长,否则会被误判为卡死」**。

### 7.2 确认队列卡片文案(PM P1)
`runReason()`(`ScheduledTasksPanel.tsx:55`)加分支:
- `idle_timeout` → 「静默超时(N 分钟无输出)」
- `watchdog_timeout` → 「超过最长运行时长」(原「超时中止」语义收窄)
- `orphaned_restart` → 「重启中断」(不变)

`lib/api.ts` 的 `TaskConfig` 类型 + create/update 调用加 `idle_timeout_min`。

---

## 8. 确认队列白名单连带改动(必改,不能漏)

新增 `idle_timeout` 这个 `failure_kind` 后,**`scheduled_tasks.rs` 里 5 处硬编码白名单必须全部加上它**,否则 idle-abort 的副作用任务进不了确认队列(功能就废了):

- `scheduled_tasks.rs:533`、`:549`、`:564`、`:604`、`:621` —— 全部从
  `failure_kind IN ('watchdog_timeout','orphaned_restart')`
  改成
  `failure_kind IN ('watchdog_timeout','orphaned_restart','idle_timeout')`
- 前端 `ScheduledTasksPanel.tsx:581` 的同款 OR 判断(决定是否显示确认按钮)同步加 `idle_timeout`。

> 实现建议:考虑把这串值抽成一个 SQL 片段常量 / Rust 辅助,避免下次再漏。但若改动风险更大,则按 5 处机械替换 + 一条测试锁住(见 §9 测试 6)。

---

## 9. 测试(对齐 `scheduled_tasks.rs` 现有 `#[cfg(test)]` 风格)

**纯函数 `stale_verdict` 单测**(无需文件/DB,锁核心判据):
1. **空闲触发**:`last_activity` 距今 > idle、`started` 距今 < 总上限 → `Some("idle_timeout")`。
2. **活动重置保护(核心价值)**:`last_activity` 很新(< idle)、即使 `started` 远超**旧 30min 默认** → `None`。显式证明"过去会被误杀的健康慢任务现在活下来"(对照 §1 动机)。
3. **总时长硬上限**:`last_activity` 一直很新(模拟刷屏死循环)、`started` 距今 > 总上限 → `Some("watchdog_timeout")`。
4. **两者同时越界,空闲先到**:`started` 200min(< 300)但 `last_activity` 90min 前(> 60)→ `Some("idle_timeout")`(锁定先判空闲)。
5. **mtime=None 兜底**:`last_activity_ms=None` → 退化按 `started_ms`,不 panic(started 老于 idle 阈值 → `idle_timeout`,新于则 `None`)。
6. **边界 0/clamp**:验证 `web.rs` clamp 后 idle/max 最小为 1;直接构造 idle=0 喂纯函数验证"会秒杀"以证明 clamp 的必要性(防回归)。

**看门狗集成测**(用 tempdir 造 `events.ndjson` 控制 mtime,仿 `scheduled_tasks.rs:990` 已有写法):
7. **确认队列衔接**:`side_effects=true` 任务被 idle abort(`failure_kind='idle_timeout'`)后,出现在 `confirmation_queue` 查询里(证明 §8 白名单 5 处已正确加 `idle_timeout`)。

**必改的现存测试(CTO P0)**:
8. `per_task_timeout_respects_max_runtime_min`(`scheduled_tasks.rs:838-865`)断言 `r_def`(started 45min 前、`max_runtime_min=None`)→ aborted,依赖旧默认 30。默认改 300 后 45 < 300 不再触发 → **该测试必失败**。须更新:把 `r_def` 的 `started` 调到 > 300min 前,或改测它的 idle 触发路径。**这是必改项,不是新增。**

---

## 10. 已知边界与风险(C1 的代价,透传给用户)

naozhi F6 教训:**事件流静默 ≠ 进程死**。C1 用"events.ndjson 有写入"当活动信号,所以一类任务会被坑:

- agent 发出 `tool_use` 调一个**长时间静默的外部命令**(全量测试套件 / 远程 CI / 大型 build / `sleep`),命令返回前没有任何新 `AcpEvent` → events.ndjson 静默 → 若该命令 >60min,会被误判 idle 卡死并 abort。

**为何不上 keepalive 解决**:那要改三个 backend 的内部状态(C2),违背克制原则,Sprint 2 已正确延后。

**缓解(本 spec 采用)**:
- 默认 idle 60min 已给长命令留较多余量。
- §7.1 表单 tooltip 明确告知此边界,让用户对长命令任务**手动调高** `idle_timeout_min` 自救。
- 控制权交用户 + 清晰文案,而非 spec 替所有任务猜一个普适值(本就不存在)。

---

## 11. 竞态说明(CTO P1)

看门狗 abort 与 fanout 正常 `finalize_run` 可能在同一 tick 撞车,但都走 `set_run_state` 的 `state IN ('claimed','running')` 终态守卫——**先到者赢,不会双写,无数据损坏**。极低概率下(60s 粒度)可能出现"agent 刚 finalize 成功、看门狗同秒判 idle"——终态守卫保证只有一个生效。视为 acceptable race;§9 测试 7 可附带验证"finalize 先到则 abort 不覆盖"。

---

## 12. 受影响文件清单

### 后端
- `src/scheduled_tasks.rs` ——
  - 1 个迁移(`idle_timeout_min`);
  - `TaskConfig` 加字段 → **连锁修改 ~11 处构造点**(测试里的 `TaskConfig {...}` 字面量约 7-9 处:`:193/222/249/282/784/842/903/937/967` 一带,各补 `idle_timeout_min: None`)+ `query_configs` SELECT/mapping(`:400/406`)+ `upsert_config` INSERT/ON CONFLICT(`:378-388`);
  - 新增纯函数 `stale_verdict`;
  - 改写 `reconcile_timeouts_per_task` 为查询+stat+循环;
  - §8 的 5 处白名单加 `idle_timeout`;
  - §9 的 7 条新测试 + 更新 1 条现存测试。
- `src/session_manager.rs` —— **无需改**(events.ndjson tee 已存在,mtime 天然刷新)。
- `src/web.rs` —— create/update 请求体 + 序列化加 `idle_timeout_min`(2 处构造点)+ `clamp(1,1440)`。

### 前端
- `frontend/src/components/ScheduledTasksPanel.tsx` —— 表单加输入框(折叠高级)+ tooltip;`runReason` 加 `idle_timeout` label;`:581` 确认按钮判断加 `idle_timeout`。
- `frontend/src/lib/api.ts` —— `TaskConfig` 类型 + 调用加字段。
</content>
