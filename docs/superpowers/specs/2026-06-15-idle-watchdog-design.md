# 无人值守 run 空闲看门狗(idle-watchdog)设计

> **类型**:feature spec
> **日期**:2026-06-15
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
- 完全复用 Sprint 2 已上线的三态 / 确认队列 / replay 链路,**不加新状态**。

### 非目标(明确 YAGNI)
- **不做 in-flight 兜底**(C2):不查 Codex `tools/call` 是否未回 / Claude 是否 mid-turn。"活动"就是事件流有新行(C1)。
- **不发独立 keepalive 心跳事件包**:不新增 `AcpEvent` 类型,沿用已有事件流作为活动信号。
- **不碰普通交互会话**:看门狗本来就只跑在 scheduled run 上,维持此边界。
- **不加"疑似卡住"中间状态**:沉默超阈值直接走现有 `aborted`+`watchdog_timeout`(已否决 B2 方案)。

---

## 3. 设计决策摘要(澄清结论)

| 决策点 | 选定 | 理由 |
|---|---|---|
| 超时后动作粒度 | **B1**:照旧 `aborted`+`watchdog_timeout`,不加新状态 | 完全复用现有三态 + 确认队列,零 schema 语义新增 |
| "活动"定义 | **C1**:任何 `events.ndjson` 新行重置空闲时钟 | 消除最常见的流式长任务误杀;C2 要动三个 backend 内部状态,违背 simplicity-first |
| 阈值配置粒度 | **D2**:`max_runtime_min`(总时长硬上限)+ 新增 `idle_timeout_min`(空闲上限),先到先触发 | C1 下刷屏死循环永不静默,总时长是唯一兜底——不能只留沉默判据 |
| 空闲默认 | `idle_timeout_min` 默认 **60** 分钟 | 无人值守宁可给足耐心;纯静默 60min 基本可断定卡死 |
| 总时长默认 | `max_runtime_min` 默认 **30 → 300** 分钟(5 小时) | 配合 60min 空闲判据,30min 总上限太短会砍掉健康慢任务 |
| 覆盖范围 | 仅 scheduled run | naozhi 机制本针对无人值守;交互会话用户自己盯着、随时能 Ctrl-C |

---

## 4. 核心判据改造

一个 run 被 abort,当且仅当满足以下**任一**条件(先到者触发),二者都走 `state='aborted'` + `failure_kind='watchdog_timeout'`:

1. **空闲超时**:`now - COALESCE(last_activity_ms, started_ms) > COALESCE(idle_timeout_min, 60) * 60000`
2. **总时长硬上限**:`now - started_ms > COALESCE(max_runtime_min, 300) * 60000`

判据仍在**单条 set-based UPDATE**里完成(不引入 per-task 循环,保持现有"避免 N+1 每 tick 查询"的设计)。`reconcile_timeouts_per_task` 的 WHERE 子句从单一 `started_ms` 判据扩成两个 COALESCE 子句的 OR:

```sql
UPDATE agent_task_runs SET state='aborted', failure_kind='watchdog_timeout', ended_ms=?1
WHERE state IN ('claimed','running')
  AND (
    -- 空闲超时
    COALESCE(last_activity_ms, started_ms) < ?1 - (COALESCE(
        (SELECT idle_timeout_min FROM agent_runs_config WHERE id = agent_task_runs.task_id), 60) * 60000)
    OR
    -- 总时长硬上限
    started_ms < ?1 - (COALESCE(
        (SELECT max_runtime_min FROM agent_runs_config WHERE id = agent_task_runs.task_id), 300) * 60000)
  )
```

> **注**:`reconcile_orphans`(开机孤儿回收 / `cutoff_ms` 路径)**不改**——它是开机一次性回收和按 `started_ms` 的旧 cutoff 路径,与本次的"每 tick 沉默判据"是不同职责。本次只改 `reconcile_timeouts_per_task`。

### `last_activity_ms` 的来源(几乎免费)

Sprint 2 已经在把每个 run 的事件 tee 进 `events.ndjson`(commit `aa684e5`,`active_run_id`-scoped)。在那个 tee 写入点**顺手更新**:

```
UPDATE agent_task_runs SET last_activity_ms = <now> WHERE id = <active_run_id>
```

- 任何 `AcpEvent`(text / thinking / reasoning / tool_use / tool_result / …)都重置时钟。
- run 在 `claim_run` 时 `last_activity_ms` 初始化为 `started_ms`,避免刚开机就被判空闲。

---

## 5. 数据模型与迁移

涉及两张表,共 **2 个新列**,全部走现有幂等 `ALTER TABLE ADD COLUMN` 模式(`scheduled_tasks.rs:363` 的 `max_runtime_min` 即此模式,照抄)。

### 5.1 `agent_task_runs.last_activity_ms INTEGER`

每个 run 的"最后活动时刻"(epoch ms)。

- 迁移:`ALTER TABLE agent_task_runs ADD COLUMN last_activity_ms INTEGER`(NULL 容忍)。
- 写入点:① `claim_run` 初始化为 `started_ms`;② events.ndjson tee 写入点同步 `UPDATE`。
- 读取点:`reconcile_timeouts_per_task` 的 WHERE 子句。
- **NULL 兜底**:旧数据 / 初始化前 NULL → 判据里 `COALESCE(last_activity_ms, started_ms)`,退化为"按开机时间判空闲",安全不 panic、不漏判。
- **纯内部字段**:不进任何对外 API(确认队列卡片已有 `ended_ms` 够用)。

### 5.2 `agent_runs_config.idle_timeout_min INTEGER`

per-task 空闲上限(分钟)。

- 迁移:`ALTER TABLE agent_runs_config ADD COLUMN idle_timeout_min INTEGER`。
- `TaskConfig` 结构体加 `pub idle_timeout_min: Option<i64>`。
- `upsert_config` 的 INSERT 列 + `ON CONFLICT DO UPDATE SET` 列表加上它(和 `max_runtime_min` 并列)。
- NULL → SQL 里 `COALESCE(idle_timeout_min, 60)`。

### 5.3 默认值落点

两个默认值**只活在 SQL 的 `COALESCE` 里**,不硬编码进结构体:

- 空闲:`COALESCE(idle_timeout_min, 60)`
- 总时长:`COALESCE(max_runtime_min, 300)` —— **从现有的 `30` 改成 `300`**

### ⚠️ 向后兼容行为变化(显著标注)

把看门狗 SQL 里 `max_runtime_min` 的兜底默认从 **30** 改成 **300**,意味着**所有未显式设置过 `max_runtime_min` 的现存任务,总时长硬上限会从 30 分钟跳到 5 小时**。

这是预期且合理的:配合新的 60min 空闲判据,30min 总上限太短会砍掉健康慢任务。但它是一个**对现存任务的行为变化**,部署后旧任务的超时行为会变宽松。

---

## 6. API 层(`src/web.rs`)

- 创建 / 编辑任务的请求体和 `TaskConfig` 序列化加上 `idle_timeout_min`(与 `max_runtime_min` 完全并列,照抄该线)。
- `last_activity_ms` **不进任何对外 API**。

---

## 7. 前端(`frontend/src/components/ScheduledTasksPanel.tsx` + `lib/api.ts`)

- 任务表单里 `max_runtime_min` 输入框旁加一个 `idle_timeout_min` 输入框,文案区分:
  - 「空闲超时(分钟)」— 多久没有任何输出就判定卡住(默认 60)
  - 「最长运行(分钟)」— 总运行硬上限,防死循环(默认 300)
- 两个框都可空(空 = 用默认)。
- `lib/api.ts` 的 `TaskConfig` 类型 + create/update 调用加该字段。

---

## 8. 测试(对齐 `scheduled_tasks.rs` 现有 `#[cfg(test)]` 风格)

1. **空闲超时触发**:`last_activity_ms` 距今 > idle 阈值、但 `started_ms` 距今 < 总上限 → 被 abort 为 `watchdog_timeout`。(新判据生效)
2. **活动重置保护**:`last_activity_ms` 最近(< idle 阈值)、即使 `started_ms` 很老 → **不** abort。(健康慢任务不被误杀——核心价值)
3. **总时长硬上限**:`last_activity_ms` 一直很新(模拟刷屏死循环)、但 `started_ms` 距今 > 总上限 → 仍被 abort。(D2 双保险硬上限生效)
4. **NULL 兜底**:`last_activity_ms IS NULL` 的旧 run → 退化为按 `started_ms` 判,不 panic、不漏判。
5. **默认值**:`idle_timeout_min`/`max_runtime_min` 均 NULL → 用 60 / 300。
6. **确认队列衔接**:`side_effects=true` 的任务被空闲超时 abort 后,出现在现有 confirmations 查询里。(复用链路没断)

---

## 9. 受影响文件清单

### 后端
- `src/scheduled_tasks.rs` —— 两个迁移;`TaskConfig` 加字段;`upsert_config` 加列;`claim_run` 初始化 `last_activity_ms`;新增/复用一个 `touch_activity(run_id)`;改写 `reconcile_timeouts_per_task` 判据;6 条单测。
- events.ndjson tee 写入点(`src/session_manager.rs` 内,`active_run_id`-scoped tee 处)—— 调 `touch_activity`。
- `src/web.rs` —— 创建/编辑任务请求体 + 序列化加 `idle_timeout_min`。

### 前端
- `frontend/src/components/ScheduledTasksPanel.tsx` —— 表单加输入框。
- `frontend/src/lib/api.ts` —— `TaskConfig` 类型 + 调用加字段。
</content>
</invoke>
