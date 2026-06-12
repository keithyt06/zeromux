# 定时运行终态精化 + 副作用确认队列 + run-record/replay 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 zeromux 无人值守定时运行补上"终态精化(失败原因区分)+ 副作用任务失败后人工确认队列 + 输入快照/输出落盘/replay",消除"任务声称跑完其实断了 / 副作用任务被误判"的盲区。

**Architecture:** 全部严格增量,接已有 `src/scheduled_tasks.rs` 调度框架。给 `agent_runs_config` 加 2 列(`side_effects`/`max_runtime_min`),`agent_task_runs` 加 3 列(`input_snapshot`/`confirm_status`/`replay_of`);`reconcile_orphans` 给 `aborted` 打 `failure_kind`(`watchdog_timeout`/`orphaned_restart`);watchdog 按 per-task `max_runtime_min` 用单条集合式 UPDATE+JOIN 判超时;`finalize_run`/`set_run_state` 加终态守卫防迟到覆盖;fanout 对 `active_run_id==Some` 窗口 tee 事件到 `~/.zeromux/runs/<run_id>/events.ndjson`;新增 3 个 owner-scoped 端点(确认队列、confirm-done、replay)。广播扇出与 Drop 清理不变量不碰。

**Tech Stack:** Rust / Axum / rusqlite(SQLite,**无迁移系统,用 `ALTER TABLE ADD COLUMN` 加列**) / React 19 + Vite + Tailwind v4 / vitest。

**Spec:** `docs/superpowers/specs/2026-06-12-scheduled-run-terminal-state-and-replay-design.md`(已 gstack CEO+eng 双评审,commit e6d6fb2)。

---

## 关键实现现实(动手前必读)

1. **无迁移系统**:`ScheduledStore::open`(`scheduled_tasks.rs:222`)用 `CREATE TABLE IF NOT EXISTS`。线上 `scheduled.db` 已存在,新列必须 `ALTER TABLE ... ADD COLUMN`。SQLite **不支持** `ADD COLUMN IF NOT EXISTS`,重复执行会报 `duplicate column name`——必须吞掉这个特定错误(幂等)。
2. **`set_run_state` 当前用 `COALESCE` 且无状态守卫**(`scheduled_tasks.rs:297-306`),迟到的 finalize 会覆盖已 `aborted` 的行。终态守卫要加 `WHERE ... AND state IN ('claimed','running')`。
3. **run_id 是单 turn 的**:`session_manager.rs:1762` 在终态事件 `active_run_id.take()`。events.ndjson tee 必须绑这个窗口,不能按 session 生命周期。
4. **finalize 判定点**:`session_manager.rs:1762-1772`,`Result→succeeded` / `Error→failed(cli_error)` / `Exit→failed(cli_exited)`。
5. **watchdog**:`scheduled_tasks.rs:355-398`,每 60s tick,当前 `cutoff = now - 30*60*1000` 全局;启动清理在 `main.rs:285` + panic 恢复在 `scheduled_tasks.rs:403`(均 `reconcile_orphans(None)`)。
6. **owner 鉴权模式**:`cfg.owner_id != user.id → 403`(见 `list_scheduled_runs`/`run_scheduled_now`)。
7. **数据目录**:`ScheduledStore::open(data_dir)` 已知 `data_dir`;run 输出目录用 `~/.zeromux/runs/<run_id>/`(与 notes 的 `~/.zeromux/` 同根)。需确认 home 解析方式(用 `dirs` 或既有 helper)。
8. 跑测试:`cargo test scheduled` / `cargo test --lib`;前端 `cd frontend && npx vitest run <file>`。迭代用 `cargo check`(release 慢)。

---

## 文件结构

| 文件 | 职责 | 改动 |
|---|---|---|
| `src/scheduled_tasks.rs` | run/task 持久化 + 调度 watchdog | 加列(ALTER)、`TaskConfig`/`TaskRun` 字段、`reconcile_orphans` 打 kind、per-task 超时 UPDATE、终态守卫、队列 SELECT、`confirm_status`/`replay_of` 写、retention 改目录删 | 
| `src/session_manager.rs` | fanout 拥有进程/输出 | events.ndjson tee(绑 `active_run_id`)、trigger 时写 `input_snapshot`、`finalize_run` 终态守卫、`replay_run()` helper | 
| `src/web.rs` | HTTP 路由 | 3 新端点 + create/update 收 `side_effects`/`max_runtime_min` | 
| `src/main.rs` | 启动 | `reconcile_orphans(None)` 已调,无需改(kind 在函数内打) | 
| `frontend/src/lib/api.ts` | 前端 API | 类型加字段 + 3 新函数 | 
| `frontend/src/components/ScheduledTasksPanel.tsx` | 定时任务面板 | 表单字段、待确认区+徽标、run-history replay 按钮+replay_of | 
| `frontend/src/App.tsx` | 会话列表宿主 | 消费 confirmations 计数浮到会话列表 | 

---

## Task 1: 加 5 个新列(幂等 ALTER)+ 扩展 struct

**Files:**
- Modify: `src/scheduled_tasks.rs:222-240`(`ScheduledStore::open` 建表后追加 ALTER)
- Modify: `src/scheduled_tasks.rs:191-216`(`TaskConfig` / `TaskRun` 字段)
- Test: `src/scheduled_tasks.rs`(inline `#[cfg(test)]`)

- [ ] **Step 1: 写失败测试 —— 加列幂等**

在 `scheduled_tasks.rs` 的 `#[cfg(test)] mod tests` 内加:

```rust
#[test]
fn add_columns_is_idempotent() {
    let dir = tempfile::tempdir().unwrap();
    // 开两次:第二次 open 不能因 "duplicate column" panic
    { let _s = ScheduledStore::open(dir.path()).unwrap(); }
    let s = ScheduledStore::open(dir.path()).unwrap();
    // 新列可写可读
    let c = TaskConfig {
        id: "t1".into(), owner_id: "u1".into(), name: "n".into(),
        trigger_type: "cron".into(), trigger_spec: "0 0 * * * *".into(),
        tz: "Asia/Shanghai".into(), agent_type: "claude".into(),
        work_dir: ".".into(), prompt: "p".into(), enabled: true,
        retention_n: 20, created_ms: 1, side_effects: true, max_runtime_min: Some(60),
    };
    s.upsert_config(&c).unwrap();
    let got = s.get_config("t1").unwrap().unwrap();
    assert!(got.side_effects);
    assert_eq!(got.max_runtime_min, Some(60));
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --lib add_columns_is_idempotent`
Expected: 编译失败(`TaskConfig` 无 `side_effects`/`max_runtime_min` 字段)。

- [ ] **Step 3: 扩展 `TaskConfig` 与 `TaskRun`**

`TaskConfig`(`scheduled_tasks.rs:191`)末尾加:

```rust
    pub created_ms: i64,
    #[serde(default)]
    pub side_effects: bool,
    #[serde(default)]
    pub max_runtime_min: Option<i64>,
}
```

`TaskRun`(`scheduled_tasks.rs:207`)末尾加:

```rust
    pub ended_ms: Option<i64>,
    #[serde(default)]
    pub input_snapshot: Option<String>,
    #[serde(default)]
    pub confirm_status: Option<String>,
    #[serde(default)]
    pub replay_of: Option<String>,
}
```

- [ ] **Step 4: 建表后追加幂等 ALTER + helper**

在 `ScheduledStore::open` 的 `execute_batch(...)` 之后、`Ok(Self...)` 之前插入:

```rust
        // No migration system: tables are CREATE IF NOT EXISTS, so new columns
        // must be added via ALTER on already-existing DBs. SQLite has no
        // "ADD COLUMN IF NOT EXISTS" — swallow the duplicate-column error so
        // repeated opens are idempotent.
        for stmt in [
            "ALTER TABLE agent_runs_config ADD COLUMN side_effects INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE agent_runs_config ADD COLUMN max_runtime_min INTEGER",
            "ALTER TABLE agent_task_runs ADD COLUMN input_snapshot TEXT",
            "ALTER TABLE agent_task_runs ADD COLUMN confirm_status TEXT",
            "ALTER TABLE agent_task_runs ADD COLUMN replay_of TEXT",
        ] {
            if let Err(e) = conn.execute(stmt, params![]) {
                let msg = e.to_string();
                if !msg.contains("duplicate column name") {
                    return Err(msg);
                }
            }
        }
```

- [ ] **Step 5: 更新 `upsert_config` 与 `query_configs` 读写新列**

`upsert_config`(:246)改 INSERT 列与 `ON CONFLICT`:

```rust
        conn.execute(
            "INSERT INTO agent_runs_config
             (id,owner_id,name,trigger_type,trigger_spec,tz,agent_type,work_dir,prompt,enabled,retention_n,created_ms,side_effects,max_runtime_min)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)
             ON CONFLICT(id) DO UPDATE SET name=?3,trigger_spec=?5,work_dir=?8,prompt=?9,enabled=?10,retention_n=?11,side_effects=?13,max_runtime_min=?14",
            params![c.id,c.owner_id,c.name,c.trigger_type,c.trigger_spec,c.tz,c.agent_type,
                    c.work_dir,c.prompt,c.enabled as i64,c.retention_n,c.created_ms,
                    c.side_effects as i64, c.max_runtime_min],
        ).map_err(|e| e.to_string())?;
```

`query_configs`(:265)的 SELECT 与映射加两列:

```rust
        let sql = format!("SELECT id,owner_id,name,trigger_type,trigger_spec,tz,agent_type,work_dir,prompt,enabled,retention_n,created_ms,side_effects,max_runtime_min FROM agent_runs_config {}", where_clause);
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt.query_map(p, |r| Ok(TaskConfig {
            id: r.get(0)?, owner_id: r.get(1)?, name: r.get(2)?, trigger_type: r.get(3)?,
            trigger_spec: r.get(4)?, tz: r.get(5)?, agent_type: r.get(6)?, work_dir: r.get(7)?,
            prompt: r.get(8)?, enabled: r.get::<_, i64>(9)? != 0, retention_n: r.get(10)?, created_ms: r.get(11)?,
            side_effects: r.get::<_, i64>(12)? != 0, max_runtime_min: r.get(13)?,
        })).map_err(|e| e.to_string())?;
```

- [ ] **Step 6: 更新 `runs_for_task` 读新列**

`runs_for_task`(:330)SELECT 与映射加三列(其余 `TaskRun` 构造点同理补 `None`,见 Step 7):

```rust
        let mut stmt = conn.prepare("SELECT id,task_id,scheduled_for_ms,state,session_id,verdict,failure_kind,started_ms,ended_ms,input_snapshot,confirm_status,replay_of FROM agent_task_runs WHERE task_id=?1 ORDER BY scheduled_for_ms DESC LIMIT ?2").map_err(|e| e.to_string())?;
        let rows = stmt.query_map(params![task_id, limit], |r| Ok(TaskRun {
            id: r.get(0)?, task_id: r.get(1)?, scheduled_for_ms: r.get(2)?, state: r.get(3)?,
            session_id: r.get(4)?, verdict: r.get(5)?, failure_kind: r.get(6)?, started_ms: r.get(7)?, ended_ms: r.get(8)?,
            input_snapshot: r.get(9)?, confirm_status: r.get(10)?, replay_of: r.get(11)?,
        })).map_err(|e| e.to_string())?;
```

- [ ] **Step 7: 修所有 `TaskRun {...}` 构造点的编译错**

新增 3 字段后,所有手写 `TaskRun { ... }` 字面量(`run_scheduled_now`、watchdog 循环、各 test)会编译错。给它们补 `input_snapshot: None, confirm_status: None, replay_of: None`。
Run: `cargo build 2>&1 | grep "TaskRun"` 定位全部构造点逐一补齐。

- [ ] **Step 8: 跑测试确认通过**

Run: `cargo test --lib add_columns_is_idempotent`
Expected: PASS。

- [ ] **Step 9: Commit**

```bash
git add src/scheduled_tasks.rs
git commit -m "feat(sched): add side_effects/max_runtime_min/input_snapshot/confirm_status/replay_of columns (idempotent ALTER)"
```

---

## Task 2: `reconcile_orphans` 给 aborted 打 failure_kind

**Files:**
- Modify: `src/scheduled_tasks.rs:316-326`(`reconcile_orphans`)
- Test: `src/scheduled_tasks.rs`(inline)

- [ ] **Step 1: 写失败测试**

```rust
#[test]
fn reconcile_stamps_failure_kind() {
    let dir = tempfile::tempdir().unwrap();
    let s = ScheduledStore::open(dir.path()).unwrap();
    // 两个 running 运行
    let mk = |id: &str, started: i64| TaskRun {
        id: id.into(), task_id: "t1".into(), scheduled_for_ms: started, state: "claimed".into(),
        session_id: None, verdict: None, failure_kind: None, started_ms: Some(started), ended_ms: None,
        input_snapshot: None, confirm_status: None, replay_of: None };
    s.claim_run(&mk("r_old", 1)).unwrap();
    s.set_run_state("r_old", "running", None, None, None, None).unwrap();
    s.claim_run(&mk("r_new", 1_000_000)).unwrap();
    s.set_run_state("r_new", "running", None, None, None, None).unwrap();

    // watchdog cutoff=100: 只 r_old 超时
    s.reconcile_orphans(Some(100)).unwrap();
    let old = s.runs_for_task("t1", 10).unwrap().into_iter().find(|r| r.id == "r_old").unwrap();
    let new = s.runs_for_task("t1", 10).unwrap().into_iter().find(|r| r.id == "r_new").unwrap();
    assert_eq!(old.state, "aborted");
    assert_eq!(old.failure_kind.as_deref(), Some("watchdog_timeout"));
    assert_eq!(new.state, "running"); // 未超时不动

    // 启动清理 cutoff=None: 剩余 running → orphaned_restart
    s.reconcile_orphans(None).unwrap();
    let new2 = s.runs_for_task("t1", 10).unwrap().into_iter().find(|r| r.id == "r_new").unwrap();
    assert_eq!(new2.state, "aborted");
    assert_eq!(new2.failure_kind.as_deref(), Some("orphaned_restart"));
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --lib reconcile_stamps_failure_kind`
Expected: FAIL(failure_kind 为 None)。

- [ ] **Step 3: 改 `reconcile_orphans` 写 kind**

替换 `reconcile_orphans` body(:319-325):

```rust
    pub fn reconcile_orphans(&self, cutoff_ms: Option<i64>) -> Result<usize, String> {
        let conn = self.conn.lock().unwrap();
        let n = match cutoff_ms {
            None => conn.execute(
                "UPDATE agent_task_runs SET state='aborted', failure_kind='orphaned_restart' \
                 WHERE state IN ('claimed','running')", params![]),
            Some(c) => conn.execute(
                "UPDATE agent_task_runs SET state='aborted', failure_kind='watchdog_timeout' \
                 WHERE state IN ('claimed','running') AND started_ms < ?1", params![c]),
        }.map_err(|e| e.to_string())?;
        Ok(n)
    }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cargo test --lib reconcile_stamps_failure_kind`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/scheduled_tasks.rs
git commit -m "feat(sched): reconcile_orphans stamps watchdog_timeout / orphaned_restart"
```

---

## Task 3: watchdog 按 per-task max_runtime_min 判超时(集合式 UPDATE)

**Files:**
- Create: `src/scheduled_tasks.rs` 新方法 `reconcile_timeouts_per_task()`
- Modify: `src/scheduled_tasks.rs:363-365`(watchdog 循环改调新方法)
- Test: `src/scheduled_tasks.rs`(inline)

> **Eng review Issue 2**:单条集合式 UPDATE + JOIN config,杜绝 per-task N+1。

- [ ] **Step 1: 写失败测试**

```rust
#[test]
fn per_task_timeout_respects_max_runtime_min() {
    let dir = tempfile::tempdir().unwrap();
    let s = ScheduledStore::open(dir.path()).unwrap();
    let mk_cfg = |id: &str, max: Option<i64>| TaskConfig {
        id: id.into(), owner_id: "u".into(), name: "n".into(), trigger_type: "cron".into(),
        trigger_spec: "0 0 * * * *".into(), tz: "Asia/Shanghai".into(), agent_type: "claude".into(),
        work_dir: ".".into(), prompt: "p".into(), enabled: true, retention_n: 20, created_ms: 1,
        side_effects: false, max_runtime_min: max };
    s.upsert_config(&mk_cfg("t_long", Some(60))).unwrap();  // 60min 限
    s.upsert_config(&mk_cfg("t_def", None)).unwrap();        // 默认 30min
    let now = 100_000_000i64;
    let mk_run = |id: &str, task: &str, started: i64| TaskRun {
        id: id.into(), task_id: task.into(), scheduled_for_ms: started, state: "running".into(),
        session_id: None, verdict: None, failure_kind: None, started_ms: Some(started), ended_ms: None,
        input_snapshot: None, confirm_status: None, replay_of: None };
    // t_long 运行了 45min:60min 限内,不该被切
    s.claim_run(&mk_run("r_long", "t_long", now - 45*60*1000)).unwrap();
    s.set_run_state("r_long", "running", None, None, None, None).unwrap();
    // t_def 运行了 45min:超 30min 默认,该被切
    s.claim_run(&mk_run("r_def", "t_def", now - 45*60*1000)).unwrap();
    s.set_run_state("r_def", "running", None, None, None, None).unwrap();

    s.reconcile_timeouts_per_task(now).unwrap();
    let long = s.runs_for_task("t_long", 10).unwrap().into_iter().find(|r| r.id=="r_long").unwrap();
    let def = s.runs_for_task("t_def", 10).unwrap().into_iter().find(|r| r.id=="r_def").unwrap();
    assert_eq!(long.state, "running");                       // 60min 限内存活
    assert_eq!(def.state, "aborted");                        // 超 30min 默认
    assert_eq!(def.failure_kind.as_deref(), Some("watchdog_timeout"));
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --lib per_task_timeout_respects_max_runtime_min`
Expected: FAIL(方法不存在)。

- [ ] **Step 3: 实现 `reconcile_timeouts_per_task`**

在 `reconcile_orphans` 之后加:

```rust
    /// Watchdog: abort runs that exceeded their task's max_runtime_min
    /// (default 30 if NULL). Single set-based UPDATE joining config — no
    /// per-task loop (Eng review Issue 2: avoid N+1 every tick).
    pub fn reconcile_timeouts_per_task(&self, now_ms: i64) -> Result<usize, String> {
        let conn = self.conn.lock().unwrap();
        let n = conn.execute(
            "UPDATE agent_task_runs SET state='aborted', failure_kind='watchdog_timeout', ended_ms=?1 \
             WHERE state IN ('claimed','running') \
               AND started_ms < ?1 - (COALESCE( \
                     (SELECT max_runtime_min FROM agent_runs_config WHERE id = agent_task_runs.task_id), \
                     30) * 60000)",
            params![now_ms],
        ).map_err(|e| e.to_string())?;
        Ok(n)
    }
```

- [ ] **Step 4: watchdog 循环改调新方法**

`scheduled_tasks.rs:363-365` 当前:

```rust
                    let cutoff = now.timestamp_millis() - 30 * 60 * 1000;
                    let _ = s.reconcile_orphans(Some(cutoff));
```

改为:

```rust
                    let _ = s.reconcile_timeouts_per_task(now.timestamp_millis());
```

(`reconcile_orphans(None)` 在 `main.rs:285` 启动 + `:403` panic 恢复处仍保留,负责 `orphaned_restart`。)

- [ ] **Step 5: 跑测试确认通过**

Run: `cargo test --lib per_task_timeout_respects_max_runtime_min`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add src/scheduled_tasks.rs
git commit -m "feat(sched): per-task max_runtime_min watchdog via set-based UPDATE+JOIN"
```

---

## Task 4: 终态守卫 —— set_run_state 不覆盖已终结的行

**Files:**
- Modify: `src/scheduled_tasks.rs:297-306`(`set_run_state`)
- Test: `src/scheduled_tasks.rs`(inline)

> **Eng review Issue 3 兜底 + spec §6.1**:迟到的 finalize 不能把 `aborted` 改回 `succeeded`。

- [ ] **Step 1: 写失败测试**

```rust
#[test]
fn set_run_state_does_not_overwrite_terminal() {
    let dir = tempfile::tempdir().unwrap();
    let s = ScheduledStore::open(dir.path()).unwrap();
    let run = TaskRun { id: "r1".into(), task_id: "t1".into(), scheduled_for_ms: 1, state: "claimed".into(),
        session_id: None, verdict: None, failure_kind: None, started_ms: Some(1), ended_ms: None,
        input_snapshot: None, confirm_status: None, replay_of: None };
    s.claim_run(&run).unwrap();
    s.set_run_state("r1", "running", Some("sess1"), None, None, None).unwrap();
    // watchdog 切成 aborted
    s.set_run_state("r1", "aborted", None, None, Some("watchdog_timeout"), Some(50)).unwrap();
    // 迟到的 finalize 想改成 succeeded —— 必须被拒
    s.set_run_state("r1", "succeeded", None, Some("done"), None, Some(99)).unwrap();
    let r = s.runs_for_task("t1", 1).unwrap().into_iter().next().unwrap();
    assert_eq!(r.state, "aborted");                          // 未被覆盖
    assert_eq!(r.failure_kind.as_deref(), Some("watchdog_timeout"));
    assert!(r.verdict.is_none());                            // 迟到的 verdict 也没写进去
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --lib set_run_state_does_not_overwrite_terminal`
Expected: FAIL(当前 COALESCE 无守卫,被改成 succeeded)。

- [ ] **Step 3: 给 set_run_state 加终态守卫**

替换 `set_run_state` 的 UPDATE(:300-305):

```rust
        conn.execute(
            "UPDATE agent_task_runs SET state=?2, session_id=COALESCE(?3,session_id),
             verdict=COALESCE(?4,verdict), failure_kind=COALESCE(?5,failure_kind),
             ended_ms=COALESCE(?6,ended_ms)
             WHERE id=?1 AND state IN ('claimed','running')",
            params![run_id, state, session_id, verdict, failure_kind, ended_ms],
        ).map_err(|e| e.to_string())?;
```

> **注意**:这会让 Task 6 的 `confirm_status`/`replay_of` 写**不能**走 `set_run_state`(它们要改已 `aborted` 的行)。Task 6 用独立方法 `set_confirm_status`,绕过此守卫。

- [ ] **Step 4: 跑测试确认通过**

Run: `cargo test --lib set_run_state_does_not_overwrite_terminal`
Expected: PASS。同时跑全量确保没回归:`cargo test --lib`。

- [ ] **Step 5: Commit**

```bash
git add src/scheduled_tasks.rs
git commit -m "feat(sched): set_run_state guards against overwriting terminal states"
```

---

## Task 5: trigger 时写 input_snapshot + events.ndjson tee

**Files:**
- Modify: `src/scheduled_tasks.rs`(新方法 `set_input_snapshot`)
- Modify: `src/session_manager.rs:843-925`(`trigger_run`:写快照)
- Modify: `src/session_manager.rs:~1740-1772`(fanout:tee 事件,绑 `active_run_id`)
- Test: `src/scheduled_tasks.rs`(快照往返)+ `src/session_manager.rs`(tee,见 Task 9)

- [ ] **Step 1: 写失败测试 —— 快照往返**

```rust
#[test]
fn input_snapshot_roundtrips() {
    let dir = tempfile::tempdir().unwrap();
    let s = ScheduledStore::open(dir.path()).unwrap();
    let run = TaskRun { id: "r1".into(), task_id: "t1".into(), scheduled_for_ms: 1, state: "claimed".into(),
        session_id: None, verdict: None, failure_kind: None, started_ms: Some(1), ended_ms: None,
        input_snapshot: None, confirm_status: None, replay_of: None };
    s.claim_run(&run).unwrap();
    let snap = r#"{"prompt":"do x","work_dir":"/home/u/p","agent_type":"claude","max_runtime_min":30,"secrets":[]}"#;
    s.set_input_snapshot("r1", snap).unwrap();
    let r = s.runs_for_task("t1", 1).unwrap().into_iter().next().unwrap();
    assert_eq!(r.input_snapshot.as_deref(), Some(snap));
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --lib input_snapshot_roundtrips`
Expected: FAIL(`set_input_snapshot` 不存在)。

- [ ] **Step 3: 实现 `set_input_snapshot`**

`scheduled_tasks.rs` 加(无终态守卫——快照在 claimed 阶段写):

```rust
    pub fn set_input_snapshot(&self, run_id: &str, snapshot: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute("UPDATE agent_task_runs SET input_snapshot=?2 WHERE id=?1",
            params![run_id, snapshot]).map_err(|e| e.to_string())?;
        Ok(())
    }
```

- [ ] **Step 4: 跑快照测试确认通过**

Run: `cargo test --lib input_snapshot_roundtrips`
Expected: PASS。

- [ ] **Step 5: `trigger_run` 在 claim 后写快照**

`session_manager.rs` 的 `trigger_run`,在 `set_run_state(run_id, "running", ...)`(:889)之后插入快照写入。快照内容用 trigger 入参(prompt/canonical_dir/agent),secrets 留空数组:

```rust
        // run-record: snapshot the exact input at trigger time so a later config
        // edit doesn't change what a replay of THIS run does (spec §5.1).
        // secrets: reference names only, NEVER raw values.
        if let Some(store) = self.scheduled.lock().unwrap().clone() {
            let snap = serde_json::json!({
                "prompt": prompt,
                "work_dir": canonical_str,
                "agent_type": "claude",
                "secrets": [],
            }).to_string();
            let _ = store.set_input_snapshot(run_id, &snap);
        }
```

> 注：`max_runtime_min` 此处不在 trigger 入参中(trigger_run 只拿到 prompt/work_dir);它不影响 replay 注入(replay 也走 trigger_run),故快照不含它即可。若后续需要,Task 8 replay 时按当前 config 取。

- [ ] **Step 6: fanout 内 tee 事件到 events.ndjson(绑 active_run_id)**

在 `session_manager.rs` fanout `emit(...)` 附近(`active_run_id` 为 `Some` 时),把序列化后的事件 append 到 `~/.zeromux/runs/<run_id>/events.ndjson`。新增一个 best-effort helper(写失败只 log,不中断运行,spec §6.1):

```rust
/// Append one serialized AcpEvent to a run's events.ndjson. Best-effort:
/// a write failure logs once and is dropped (spec §6.1) — never blocks the run.
/// Scoped to the active_run_id window only (Eng review Issue 1).
fn append_run_event(run_id: &str, serialized: &str) {
    // Home resolution matches the existing pattern (main.rs:183) — no `dirs` crate.
    let home = std::env::var("HOME").unwrap_or_else(|_| "/home/ubuntu".to_string());
    let dir = std::path::Path::new(&home).join(".zeromux").join("runs").join(run_id);
    if std::fs::create_dir_all(&dir).is_err() { return; }
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("events.ndjson")) {
        let _ = writeln!(f, "{}", serialized);
    }
}
```

在 fanout 循环里,事件已被序列化(scrollback 用)。在 `active_run_id` 为 `Some(rid)` 的分支调用 `append_run_event(rid, &serialized)`。**关键:只在 `active_run_id.is_some()` 时 tee**,`active_run_id.take()`(:1762 终态)之后自然停止——保证 events.ndjson 只含该 run 那一个 turn。

> 实现注意:home 解析用 `std::env::var("HOME")`(`main.rs:183` 既有模式),**不引入 `dirs` crate**(当前依赖里没有)。复用 fanout 已有的事件序列化结果,不要二次序列化。

- [ ] **Step 7: 跑全量确认编译+无回归**

Run: `cargo test --lib`
Expected: 全 PASS(events.ndjson 的专门测试在 Task 9)。

- [ ] **Step 8: Commit**

```bash
git add src/scheduled_tasks.rs src/session_manager.rs
git commit -m "feat(sched): write input_snapshot at trigger + tee run events to events.ndjson (active_run_id-scoped)"
```

---

## Task 6: 确认队列查询 + confirm_status 写(独立于终态守卫)

**Files:**
- Modify: `src/scheduled_tasks.rs`(新方法 `confirmation_queue` / `confirmation_count` / `set_confirm_status`)
- Test: `src/scheduled_tasks.rs`(inline)

- [ ] **Step 1: 写失败测试 —— 队列谓词**

```rust
#[test]
fn confirmation_queue_predicate() {
    let dir = tempfile::tempdir().unwrap();
    let s = ScheduledStore::open(dir.path()).unwrap();
    let mk_cfg = |id: &str, se: bool| TaskConfig {
        id: id.into(), owner_id: "u".into(), name: id.into(), trigger_type: "cron".into(),
        trigger_spec: "0 0 * * * *".into(), tz: "Asia/Shanghai".into(), agent_type: "claude".into(),
        work_dir: ".".into(), prompt: "p".into(), enabled: true, retention_n: 20, created_ms: 1,
        side_effects: se, max_runtime_min: None };
    s.upsert_config(&mk_cfg("t_se", true)).unwrap();
    s.upsert_config(&mk_cfg("t_ro", false)).unwrap();
    let mk_run = |id: &str, task: &str| TaskRun { id: id.into(), task_id: task.into(), scheduled_for_ms: 1,
        state: "claimed".into(), session_id: None, verdict: None, failure_kind: None, started_ms: Some(1),
        ended_ms: None, input_snapshot: None, confirm_status: None, replay_of: None };
    // 副作用任务 + watchdog_timeout → 进队列
    s.claim_run(&mk_run("r_se", "t_se")).unwrap();
    s.set_run_state("r_se", "aborted", None, None, Some("watchdog_timeout"), Some(2)).unwrap();
    // 只读任务 + watchdog_timeout → 不进队列
    s.claim_run(&mk_run("r_ro", "t_ro")).unwrap();
    s.set_run_state("r_ro", "aborted", None, None, Some("watchdog_timeout"), Some(2)).unwrap();

    let q = s.confirmation_queue("u").unwrap();
    assert_eq!(q.len(), 1);
    assert_eq!(q[0].id, "r_se");
    assert_eq!(s.confirmation_count("u").unwrap(), 1);

    // 标记 confirmed_done → 移出队列
    s.set_confirm_status("r_se", "confirmed_done").unwrap();
    assert_eq!(s.confirmation_queue("u").unwrap().len(), 0);
    assert_eq!(s.confirmation_count("u").unwrap(), 0);
    // 终态守卫不该被它触发改 state
    let r = s.runs_for_task("t_se", 1).unwrap().into_iter().next().unwrap();
    assert_eq!(r.state, "aborted");
    assert_eq!(r.confirm_status.as_deref(), Some("confirmed_done"));
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --lib confirmation_queue_predicate`
Expected: FAIL(方法不存在)。

- [ ] **Step 3: 实现三个方法**

```rust
    /// Side-effecting runs that ended in an unknown terminal state and haven't
    /// been confirmed yet — the human confirmation queue (spec §4.2).
    /// Owner-scoped via JOIN to config.
    pub fn confirmation_queue(&self, owner_id: &str) -> Result<Vec<TaskRun>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT r.id,r.task_id,r.scheduled_for_ms,r.state,r.session_id,r.verdict,r.failure_kind,r.started_ms,r.ended_ms,r.input_snapshot,r.confirm_status,r.replay_of \
             FROM agent_task_runs r JOIN agent_runs_config c ON c.id = r.task_id \
             WHERE c.owner_id=?1 AND c.side_effects=1 AND r.state='aborted' \
               AND r.failure_kind IN ('watchdog_timeout','orphaned_restart') \
               AND r.confirm_status IS NULL \
             ORDER BY r.ended_ms DESC").map_err(|e| e.to_string())?;
        let rows = stmt.query_map(params![owner_id], |r| Ok(TaskRun {
            id: r.get(0)?, task_id: r.get(1)?, scheduled_for_ms: r.get(2)?, state: r.get(3)?,
            session_id: r.get(4)?, verdict: r.get(5)?, failure_kind: r.get(6)?, started_ms: r.get(7)?, ended_ms: r.get(8)?,
            input_snapshot: r.get(9)?, confirm_status: r.get(10)?, replay_of: r.get(11)?,
        })).map_err(|e| e.to_string())?;
        rows.collect::<Result<_,_>>().map_err(|e| e.to_string())
    }

    pub fn confirmation_count(&self, owner_id: &str) -> Result<i64, String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT COUNT(*) FROM agent_task_runs r JOIN agent_runs_config c ON c.id = r.task_id \
             WHERE c.owner_id=?1 AND c.side_effects=1 AND r.state='aborted' \
               AND r.failure_kind IN ('watchdog_timeout','orphaned_restart') AND r.confirm_status IS NULL",
            params![owner_id], |row| row.get(0)).map_err(|e| e.to_string())
    }

    /// Set confirm_status. Bypasses set_run_state's terminal guard on purpose:
    /// it mutates an already-aborted row's confirm_status, not its state.
    /// Idempotent first-writer-wins via WHERE confirm_status IS NULL.
    pub fn set_confirm_status(&self, run_id: &str, status: &str) -> Result<bool, String> {
        let conn = self.conn.lock().unwrap();
        let n = conn.execute(
            "UPDATE agent_task_runs SET confirm_status=?2 WHERE id=?1 AND confirm_status IS NULL",
            params![run_id, status]).map_err(|e| e.to_string())?;
        Ok(n == 1)
    }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cargo test --lib confirmation_queue_predicate`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/scheduled_tasks.rs
git commit -m "feat(sched): confirmation queue query + count + set_confirm_status (first-writer-wins)"
```

---

## Task 7: retention 剪枝删 run 目录 + 队列待处理豁免

**Files:**
- Modify: `src/scheduled_tasks.rs`(找到/新增 retention 剪枝逻辑)
- Test: `src/scheduled_tasks.rs`(inline)

> 先确认现有 retention 剪枝在哪:`grep -n "retention_n\|prune\|DELETE FROM agent_task_runs" src/scheduled_tasks.rs`。spec §5.3 要求剪枝删 `~/.zeromux/runs/<run_id>/` 目录,且**队列待处理运行(`confirm_status IS NULL` + 副作用未知)豁免**。

- [ ] **Step 1: 写失败测试**

```rust
#[test]
fn prune_exempts_pending_confirmation() {
    let dir = tempfile::tempdir().unwrap();
    let s = ScheduledStore::open(dir.path()).unwrap();
    let cfg = TaskConfig { id: "t".into(), owner_id: "u".into(), name: "n".into(), trigger_type: "cron".into(),
        trigger_spec: "0 0 * * * *".into(), tz: "Asia/Shanghai".into(), agent_type: "claude".into(),
        work_dir: ".".into(), prompt: "p".into(), enabled: true, retention_n: 1, created_ms: 1,
        side_effects: true, max_runtime_min: None };
    s.upsert_config(&cfg).unwrap();
    let mk = |id: &str, sched: i64, kind: Option<&str>, state: &str| {
        let run = TaskRun { id: id.into(), task_id: "t".into(), scheduled_for_ms: sched, state: "claimed".into(),
            session_id: None, verdict: None, failure_kind: None, started_ms: Some(sched), ended_ms: None,
            input_snapshot: None, confirm_status: None, replay_of: None };
        s.claim_run(&run).unwrap();
        s.set_run_state(id, state, None, None, kind, Some(sched)).unwrap();
    };
    // 旧的待确认运行(副作用未知)+ 两个新的成功运行。retention_n=1。
    mk("r_pending", 1, Some("watchdog_timeout"), "aborted");
    mk("r_new1", 100, None, "succeeded");
    mk("r_new2", 200, None, "succeeded");
    s.prune_runs("t", 1).unwrap();
    let ids: Vec<String> = s.runs_for_task("t", 50).unwrap().into_iter().map(|r| r.id).collect();
    assert!(ids.contains(&"r_pending".to_string()), "pending-confirmation run must survive prune");
    assert!(ids.contains(&"r_new2".to_string()), "newest run kept");
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --lib prune_exempts_pending_confirmation`
Expected: FAIL(`prune_runs` 不存在或未豁免)。

- [ ] **Step 3: 实现/改 `prune_runs`**

若已有剪枝逻辑,改其 DELETE 加豁免子句;否则新增。删行前先删对应 run 目录(best-effort):

```rust
    /// Keep the newest `keep` runs per task; delete older rows AND their
    /// ~/.zeromux/runs/<id>/ dir. Runs awaiting confirmation (side-effecting,
    /// unknown terminal, confirm_status IS NULL) are EXEMPT (spec §5.3).
    pub fn prune_runs(&self, task_id: &str, keep: i64) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        // ids to delete: older than the newest `keep`, excluding pending-confirmation.
        let mut stmt = conn.prepare(
            "SELECT id FROM agent_task_runs WHERE task_id=?1 \
               AND NOT (state='aborted' AND failure_kind IN ('watchdog_timeout','orphaned_restart') AND confirm_status IS NULL) \
               AND id NOT IN ( \
                 SELECT id FROM agent_task_runs WHERE task_id=?1 ORDER BY scheduled_for_ms DESC LIMIT ?2 ) \
             ").map_err(|e| e.to_string())?;
        let ids: Vec<String> = stmt.query_map(params![task_id, keep], |r| r.get::<_,String>(0))
            .map_err(|e| e.to_string())?.collect::<Result<_,_>>().map_err(|e| e.to_string())?;
        drop(stmt);
        let home = std::env::var("HOME").unwrap_or_else(|_| "/home/ubuntu".to_string());
        for id in &ids {
            let _ = std::fs::remove_dir_all(std::path::Path::new(&home).join(".zeromux").join("runs").join(id));
            let _ = conn.execute("DELETE FROM agent_task_runs WHERE id=?1", params![id]);
        }
        Ok(())
    }
```

> 注:home 解析用 `std::env::var("HOME")`(同 `append_run_event`,不引入 `dirs`)。**已核实 `retention_n` 当前完全没有剪枝调用点**(只存不用),故本 task 是**新增**剪枝方法 + 测试;接到 finalize 后自动调用属 NOT-in-scope 的后续小 task。

- [ ] **Step 4: 跑测试确认通过**

Run: `cargo test --lib prune_exempts_pending_confirmation`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/scheduled_tasks.rs
git commit -m "feat(sched): prune_runs deletes run dir + exempts pending-confirmation runs"
```

---

## Task 8: replay helper + 3 个 HTTP 端点

**Files:**
- Modify: `src/session_manager.rs`(`replay_run()` helper)
- Modify: `src/web.rs:44-47`(路由)+ 新 handler + create/update 收新字段
- Modify: `frontend/src/lib/api.ts`(类型 + 函数)
- Test: `src/scheduled_tasks.rs`(replay 行为)

- [ ] **Step 1: 写失败测试 —— replay 建链接行、不动原行、注入快照**

```rust
#[test]
fn replay_creates_linked_row_from_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let s = ScheduledStore::open(dir.path()).unwrap();
    let cfg = TaskConfig { id: "t".into(), owner_id: "u".into(), name: "n".into(), trigger_type: "cron".into(),
        trigger_spec: "0 0 * * * *".into(), tz: "Asia/Shanghai".into(), agent_type: "claude".into(),
        work_dir: ".".into(), prompt: "NEW prompt".into(), enabled: true, retention_n: 20, created_ms: 1,
        side_effects: true, max_runtime_min: None };
    s.upsert_config(&cfg).unwrap();
    let run = TaskRun { id: "r_orig".into(), task_id: "t".into(), scheduled_for_ms: 1, state: "claimed".into(),
        session_id: None, verdict: None, failure_kind: None, started_ms: Some(1), ended_ms: None,
        input_snapshot: None, confirm_status: None, replay_of: None };
    s.claim_run(&run).unwrap();
    s.set_input_snapshot("r_orig", r#"{"prompt":"OLD prompt","work_dir":".","agent_type":"claude","secrets":[]}"#).unwrap();
    s.set_run_state("r_orig", "aborted", None, None, Some("watchdog_timeout"), Some(2)).unwrap();

    // claim_replay 建新行,replay_of=r_orig,载原快照(非 cfg 的 NEW prompt)
    let (new_id, snap) = s.claim_replay("r_orig").unwrap();
    let new = s.runs_for_task("t", 10).unwrap().into_iter().find(|r| r.id == new_id).unwrap();
    assert_eq!(new.replay_of.as_deref(), Some("r_orig"));
    assert_eq!(new.state, "claimed");
    assert!(snap.contains("OLD prompt"));                    // 注入的是旧快照
    // 原行不变(除将被 confirm_status='replayed' 标记,那在端点层做)
    let orig = s.runs_for_task("t", 10).unwrap().into_iter().find(|r| r.id == "r_orig").unwrap();
    assert_eq!(orig.state, "aborted");
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --lib replay_creates_linked_row_from_snapshot`
Expected: FAIL(`claim_replay` 不存在)。

- [ ] **Step 3: 实现 `claim_replay`(store 层)**

```rust
    /// Create a new claimed run linked to the original via replay_of, carrying
    /// the ORIGINAL input_snapshot (spec §5.2: reproduce that run's input, not
    /// current config). Returns (new_run_id, snapshot_json). Errors if the
    /// original has no snapshot (replay impossible).
    pub fn claim_replay(&self, orig_run_id: &str) -> Result<(String, String), String> {
        let conn = self.conn.lock().unwrap();
        let (task_id, snap): (String, Option<String>) = conn.query_row(
            "SELECT task_id, input_snapshot FROM agent_task_runs WHERE id=?1",
            params![orig_run_id], |r| Ok((r.get(0)?, r.get(1)?))).map_err(|e| e.to_string())?;
        let snap = snap.ok_or_else(|| "no input snapshot — cannot replay".to_string())?;
        let new_id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now().timestamp_millis();
        conn.execute(
            "INSERT INTO agent_task_runs (id,task_id,scheduled_for_ms,state,started_ms,input_snapshot,replay_of) \
             VALUES (?1,?2,?3,'claimed',?3,?4,?5)",
            params![new_id, task_id, now, snap, orig_run_id]).map_err(|e| e.to_string())?;
        Ok((new_id, snap))
    }
```

> 注：避免 `claim_replay` 与 `set_run_state` 终态守卫冲突——它直接 INSERT 新行。`scheduled_for_ms=now` 避免撞 `UNIQUE(task_id, scheduled_for_ms)`(理论上同毫秒两次 replay 会撞,概率极低;若撞 INSERT 报错向上抛,端点返回 500,可接受)。

- [ ] **Step 4: 跑 store 测试确认通过**

Run: `cargo test --lib replay_creates_linked_row_from_snapshot`
Expected: PASS。

- [ ] **Step 5: `replay_run` helper(session_manager 层,注入快照走 trigger 路径)**

`session_manager.rs` 加方法:解析快照 JSON 取 prompt/work_dir,复用 `trigger_run` 的 spawn 路径(它已含 `work_dir_under_home` TOCTOU 门)。`claim_replay` 已建行,故 `replay_run` 接 `(new_id, snap)` 直接 spawn:

```rust
    /// Replay: spawn a run from a snapshot's prompt/work_dir. Reuses trigger_run's
    /// spawn path (incl. work_dir_under_home TOCTOU gate). new_run_id already
    /// claimed by claim_replay.
    pub async fn replay_run(&self, new_run_id: &str, task_id: &str, owner_id: &str,
                            name: String, snapshot_json: &str) -> Result<String, String> {
        let v: serde_json::Value = serde_json::from_str(snapshot_json)
            .map_err(|e| format!("bad snapshot: {e}"))?;
        let prompt = v["prompt"].as_str().unwrap_or("").to_string();
        let work_dir = v["work_dir"].as_str().unwrap_or(".").to_string();
        self.trigger_run(new_run_id, name, &work_dir, owner_id, task_id, prompt).await
    }
```

- [ ] **Step 6: 3 个端点 + 路由 + create/update 收字段**

`web.rs:44-47` 路由组加:

```rust
        .route("/api/scheduled-tasks/confirmations", get(list_confirmations))
        .route("/api/scheduled-tasks/runs/{run_id}/confirm-done", post(confirm_run_done))
        .route("/api/scheduled-tasks/runs/{run_id}/replay", post(replay_run_handler))
```

`ScheduledTaskReq` 加字段:

```rust
    #[serde(default)]
    side_effects: bool,
    #[serde(default)]
    max_runtime_min: Option<i64>,
```

`create_scheduled` / `update_scheduled` 构造 `TaskConfig` 时:钳 `max_runtime_min` 到 1–1440,带上 `side_effects`:

```rust
        side_effects: req.side_effects,
        max_runtime_min: req.max_runtime_min.map(|m| m.clamp(1, 1440)),
```

新 handler(全部 owner-scoped):

```rust
/// GET /api/scheduled-tasks/confirmations — caller's pending-confirmation runs.
async fn list_confirmations(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let runs = state.scheduled_tasks.confirmation_queue(&user.id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(serde_json::json!({ "runs": runs, "count": runs.len() })))
}

/// helper: load run + its task, enforce ownership; returns (task_id, cfg).
async fn owned_run_task(state: &AppState, user_id: &str, run_id: &str)
    -> Result<crate::scheduled_tasks::TaskConfig, (StatusCode, String)> {
    let task_id = state.scheduled_tasks.task_id_of_run(run_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .ok_or((StatusCode::NOT_FOUND, "Run not found".into()))?;
    let cfg = state.scheduled_tasks.get_config(&task_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .ok_or((StatusCode::NOT_FOUND, "Task not found".into()))?;
    if cfg.owner_id != user_id { return Err((StatusCode::FORBIDDEN, "Forbidden".into())); }
    Ok(cfg)
}

/// POST /api/scheduled-tasks/runs/{run_id}/confirm-done — mark done, no replay.
async fn confirm_run_done(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
    axum::extract::Path(run_id): axum::extract::Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    owned_run_task(&state, &user.id, &run_id).await?;
    let ok = state.scheduled_tasks.set_confirm_status(&run_id, "confirmed_done")
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(serde_json::json!({ "ok": ok })))
}

/// POST /api/scheduled-tasks/runs/{run_id}/replay — replay snapshot as a new run.
/// Server-enforced gate: a side-effecting unknown run with confirm_status NULL
/// must go through confirm first — refuse plain replay (spec §5.2, decision C).
async fn replay_run_handler(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
    axum::extract::Path(run_id): axum::extract::Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let cfg = owned_run_task(&state, &user.id, &run_id).await?;
    // gate: refuse plain replay of an unconfirmed side-effecting unknown run.
    if state.scheduled_tasks.is_unconfirmed_side_effect_unknown(&run_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))? {
        return Err((StatusCode::CONFLICT, "must confirm via queue before replay".into()));
    }
    // overlap guard
    let active = state.scheduled_tasks.active_states_for_task(&cfg.id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let refs: Vec<&str> = active.iter().map(|s| s.as_str()).collect();
    if crate::scheduled_tasks::should_skip_overlap(&refs) {
        return Ok(Json(serde_json::json!({ "skipped": true, "reason": "overlap" })));
    }
    let (new_id, snap) = state.scheduled_tasks.claim_replay(&run_id)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    let name = format!("{} · replay", cfg.name);
    state.sessions.replay_run(&new_id, &cfg.id, &cfg.owner_id, name, &snap).await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(serde_json::json!({ "run_id": new_id, "replay_of": run_id })))
}
```

需在 store 加两个小 helper:

```rust
    pub fn task_id_of_run(&self, run_id: &str) -> Result<Option<String>, String> {
        let conn = self.conn.lock().unwrap();
        match conn.query_row("SELECT task_id FROM agent_task_runs WHERE id=?1", params![run_id], |r| r.get(0)) {
            Ok(s) => Ok(Some(s)), Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None), Err(e) => Err(e.to_string()),
        }
    }
    /// True iff run is side-effecting + unknown terminal + confirm_status NULL.
    pub fn is_unconfirmed_side_effect_unknown(&self, run_id: &str) -> Result<bool, String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT COUNT(*) FROM agent_task_runs r JOIN agent_runs_config c ON c.id=r.task_id \
             WHERE r.id=?1 AND c.side_effects=1 AND r.state='aborted' \
               AND r.failure_kind IN ('watchdog_timeout','orphaned_restart') AND r.confirm_status IS NULL",
            params![run_id], |row| row.get::<_,i64>(0)).map(|n| n > 0).map_err(|e| e.to_string())
    }
```

> 队列的「确认未完成→重放」走前端两步:先 `confirm-done`?**不**——它要标 `replayed` 不是 `confirmed_done`。前端那个动作先 `set_confirm_status(replayed)`(经一个小端点或复用),再调 replay。简化:在 `replay_run_handler` 里,若该 run 当前是 unconfirmed side-effect-unknown,**经队列路径**应先把它标 `replayed` 再放行。为避免双端点,**队列动作传 `?from_queue=1`**:带该参数时,handler 先 `set_confirm_status(run_id,"replayed")` 再继续(绕过 gate)。普通 run-history 重放不带该参数,受 gate 拦。实现时给 `replay_run_handler` 加 `Query` 参数 `from_queue: bool`,`from_queue` 为真时跳过 gate 并先标 `replayed`。

- [ ] **Step 7: api.ts 加类型与函数**

`TaskRun` interface 的 `state` union 不变,加字段:

```ts
  input_snapshot: string | null
  confirm_status: 'confirmed_done' | 'replayed' | null
  replay_of: string | null
```

`ScheduledTask` interface 加:

```ts
  side_effects: boolean
  max_runtime_min: number | null
```

`ScheduledTaskReq` 加:

```ts
  side_effects?: boolean
  max_runtime_min?: number | null
```

新函数:

```ts
export async function listConfirmations(): Promise<{ runs: TaskRun[]; count: number }> {
  const res = await api('/api/scheduled-tasks/confirmations')
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}
export async function confirmRunDone(runId: string): Promise<void> {
  const res = await api(`/api/scheduled-tasks/runs/${runId}/confirm-done`, { method: 'POST' })
  if (!res.ok) throw new Error(await res.text())
}
export async function replayRun(runId: string, fromQueue = false): Promise<{ run_id?: string; skipped?: boolean; reason?: string }> {
  const res = await api(`/api/scheduled-tasks/runs/${runId}/replay${fromQueue ? '?from_queue=1' : ''}`, { method: 'POST' })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}
```

- [ ] **Step 8: 跑后端测试 + 编译前端**

Run: `cargo test --lib && cd frontend && npx tsc -b`
Expected: 后端 PASS,前端类型通过。

- [ ] **Step 9: Commit**

```bash
git add src/scheduled_tasks.rs src/session_manager.rs src/web.rs frontend/src/lib/api.ts
git commit -m "feat(sched): replay endpoint (snapshot-based, server gate) + confirm-done + confirmations API"
```

---

## Task 9: events.ndjson tee 测试 + 前端 UI(确认区/replay 按钮/会话列表徽标)

**Files:**
- Test: `src/session_manager.rs`(inline,tee 行为)
- Modify: `frontend/src/components/ScheduledTasksPanel.tsx`(表单字段、待确认区、replay 按钮、STATE 用 failure_kind 细分)
- Modify: `frontend/src/App.tsx`(会话列表浮 confirmations 计数)
- Test: `frontend/src/components/__tests__/ScheduledTasksPanel.test.tsx`(新建)

- [ ] **Step 1: 写 events.ndjson tee 失败测试(Rust)**

在 `session_manager.rs` `#[cfg(test)]` 加(若 `append_run_event` 是自由函数,可直接测它 + 文件读回):

```rust
#[test]
fn append_run_event_writes_and_isolates() {
    // 用临时 HOME 隔离
    let tmp = tempfile::tempdir().unwrap();
    std::env::set_var("HOME", tmp.path());
    append_run_event("run_abc", "{\"a\":1}");
    append_run_event("run_abc", "{\"b\":2}");
    let p = tmp.path().join(".zeromux/runs/run_abc/events.ndjson");
    let content = std::fs::read_to_string(&p).unwrap();
    assert_eq!(content.lines().count(), 2);
    assert!(content.contains("\"a\":1") && content.contains("\"b\":2"));
}
```

> 若 `append_run_event` 用 `dirs::home_dir()`(读 `$HOME`),`set_var("HOME")` 生效。tee 的"绑 active_run_id 窗口、终态后停止"由 Task 5 Step 6 的 `is_some()` 分支保证;此测试覆盖写入与目录隔离。写失败降级(目录不可写不 panic)可加第二个 case:对一个只读父目录调用,断言不 panic 且函数返回。

- [ ] **Step 2: 跑测试确认失败/通过**

Run: `cargo test --lib append_run_event_writes_and_isolates`
Expected: Task 5 已实现 `append_run_event` → PASS;若放在 Task 5 后此处应直接通过(本步等于回归锁定)。

- [ ] **Step 3: 前端 STATE 细分 —— failed_transport 视觉**

`ScheduledTasksPanel.tsx:31-46` 的 `STATE_LABELS`/`STATE_COLORS` 是按 `state` 的。`aborted` 现在要按 `failure_kind` 细分显示原因。新增一个辅助函数,run-history 行用它:

```tsx
function runReason(r: TaskRun): { label: string; color: string } {
  if (r.state === 'aborted') {
    if (r.failure_kind === 'watchdog_timeout')
      return { label: '超时中止', color: 'text-[var(--accent-red)]' }
    if (r.failure_kind === 'orphaned_restart')
      return { label: '重启中断', color: 'text-[var(--accent-red)]' }
    return { label: STATE_LABELS.aborted, color: STATE_COLORS.aborted }
  }
  return { label: STATE_LABELS[r.state], color: STATE_COLORS[r.state] }
}
```

- [ ] **Step 4: 表单加 side_effects / max_runtime_min 字段**

表单(`TaskForm`,~245 起)的保存 payload 与 `handleToggle`(:62)都要带新字段。表单 UI 加:

```tsx
<label className="flex items-center gap-2 text-xs text-[var(--text-secondary)] cursor-pointer">
  <input type="checkbox" checked={sideEffects} onChange={e => setSideEffects(e.target.checked)}
    className="accent-[var(--accent-blue)]" />
  有外部副作用(提 PR / push / 改文件)—— 失败状态未知时进待确认队列
</label>
<div className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
  <span>最长运行(分钟,留空=30)</span>
  <input type="number" min={1} max={1440} value={maxRuntime ?? ''} 
    onChange={e => setMaxRuntime(e.target.value ? Number(e.target.value) : null)}
    className="w-20 ..." />
</div>
```

保存时 `createScheduledTask`/`updateScheduledTask` body 带 `side_effects: sideEffects, max_runtime_min: maxRuntime`。`handleToggle` 同样补这两个字段(否则 toggle 会清空它们)。

- [ ] **Step 5: 待确认区 + replay 按钮**

list 视图(:129 起)顶部加一个待确认折叠区:`listConfirmations()` 拉数据,>0 时渲染卡片(任务名、原因、verdict、两个按钮)。按钮:

```tsx
// 确认已完成
onClick={async () => { await confirmRunDone(run.id); reloadConfirmations() }}
// 确认未完成 → 重放
onClick={async () => { await replayRun(run.id, true); reloadConfirmations() }}
```

run-history 视图(history)每行加「重放」按钮,对 `succeeded`/`failed`/非副作用 `aborted` 可点(`replayRun(run.id, false)`);服务端 gate 会拦副作用未知的普通重放,前端对这类行禁用按钮 + tooltip「请经待确认队列处理」。

- [ ] **Step 6: App.tsx 会话列表浮计数(Finding 1)**

`App.tsx` 拥有会话列表。加一个轻量轮询(复用现有定时/心跳 tick 或 `useEffect` + interval)调 `listConfirmations()`,把 `count` 存 state,>0 时在会话列表区域(定时任务入口旁)显示一个红点 + 数字徽标。点击打开 `ScheduledTasksPanel`。

```tsx
const [confirmCount, setConfirmCount] = useState(0)
useEffect(() => {
  const tick = () => listConfirmations().then(r => setConfirmCount(r.count)).catch(() => {})
  tick(); const h = setInterval(tick, 30000); return () => clearInterval(h)
}, [])
// 渲染:{confirmCount > 0 && <span className="...badge">{confirmCount}</span>}
```

- [ ] **Step 7: 前端测试(vitest)**

新建 `frontend/src/components/__tests__/ScheduledTasksPanel.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
// mock api
vi.mock('../../lib/api', () => ({
  listScheduledTasks: vi.fn().mockResolvedValue([]),
  listConfirmations: vi.fn().mockResolvedValue({ runs: [
    { id: 'r1', task_id: 't', scheduled_for_ms: 1, state: 'aborted', failure_kind: 'watchdog_timeout',
      verdict: null, session_id: null, started_ms: 1, ended_ms: 2, input_snapshot: '{}', confirm_status: null, replay_of: null }
  ], count: 1 }),
}))
import ScheduledTasksPanel from '../ScheduledTasksPanel'

describe('confirmation queue', () => {
  it('renders pending-confirmation runs with reason', async () => {
    render(<ScheduledTasksPanel onClose={() => {}} />)
    expect(await screen.findByText(/超时中止|待确认/)).toBeInTheDocument()
  })
})
```

> 按面板实际渲染文案调整断言。若组件结构不便测,至少测 `runReason()` 纯函数(导出它)对 `watchdog_timeout`/`orphaned_restart`/普通 state 的输出。

- [ ] **Step 8: 跑前端测试 + lint + 构建**

Run: `cd frontend && npx vitest run src/components/__tests__/ScheduledTasksPanel.test.tsx && npm run lint && npm run build`
Expected: 测试 PASS,lint 干净,build 成功(rust-embed 需要 dist)。

- [ ] **Step 9: 跑后端全量回归**

Run: `cargo test`
Expected: 全 PASS。

- [ ] **Step 10: Commit**

```bash
git add src/session_manager.rs frontend/src/components/ScheduledTasksPanel.tsx frontend/src/App.tsx frontend/src/components/__tests__/ScheduledTasksPanel.test.tsx
git commit -m "feat(sched): confirmation-queue UI + replay buttons + session-list badge + events-tee test"
```

---

## 手动冒烟(文档化,不自动化,spec §8.3)

建一个 `side_effects:true` + `max_runtime_min:1` 的任务,prompt 让 agent sleep 2 分钟。等 watchdog(60s tick)切它 → 验证:run-history 显示「超时中止」、待确认区出现该 run + 会话列表红点计数为 1。点「确认未完成→重放」→ 验证生成 `replay_of` 链接的新 run、计数归零。再建一个只读任务同样超时 → 验证它**不**进队列。

---

## NOT in scope(明确不做)

- **PWA + web-push 推送**:无人值守失败推到手机锁屏,独立 feature(spec §10)。本计划只做会话列表浮计数。
- **keepalive 心跳**:让"静默 vs 卡死"可区分,需改三个 ACP 后端(spec §10)。
- **content-hash 去重快照**:v1 快照极小不值得(spec §10)。
- **retention 自动触发接线**:若现有代码无 retention 剪枝调用点,本计划只提供 `prune_runs` 方法 + 测试,不强求接到 finalize 后自动调用(Task 7 Step 3 注)。接线作为后续小 task。
- **AgentCore / 云端 placement**:本体缓议(spec §10)。

## What already exists(复用,不重建)

- `claim_run`(原子 INSERT OR IGNORE)、`should_skip_overlap`、`active_states_for_task` —— replay 与队列直接复用。
- `trigger_run` 的 `work_dir_under_home` TOCTOU 门 —— replay 经它,无需新校验。
- fanout 事件序列化(scrollback 用)—— events.ndjson tee 复用同一份序列化结果。
- owner 鉴权 `cfg.owner_id != user.id → 403` —— 新端点照抄。
- B-1 持久化的"文件为事实源"模式 —— run 目录落盘沿用。

## 失败模式(每条新 codepath)

| codepath | 失败方式 | 有测试? | 有错误处理? | 用户可见? |
|---|---|---|---|---|
| ALTER 加列 | 重复执行 duplicate column | ✅ Task1 | ✅ 吞特定错 | 否(启动期) |
| events.ndjson tee | 磁盘满/目录不可写 | ✅ Task9(降级) | ✅ best-effort log | 队列卡片"部分输出不可用" |
| 迟到 finalize | 覆盖 aborted | ✅ Task4 | ✅ 终态守卫 | 否(行保持 aborted) |
| replay 撞 UNIQUE | 同毫秒两次 replay | ⚠️ 未测(概率极低) | INSERT 报错→500 | 错误提示 |
| replay 无快照 | 老 run 无 input_snapshot | ✅ Task8(端点 BAD_REQUEST) | ✅ | "无输入快照——无法重放" |
| 双人点同卡片 | confirm_status race | ✅ Task6(first-writer-wins) | ✅ WHERE NULL | 第二次无效 |

## 并行化策略

Task 1 是所有后端任务的地基(列+struct),必须先做。之后:
- **Lane A(后端 store/逻辑,顺序,全在 scheduled_tasks.rs)**:Task 2 → 3 → 4 → 6 → 7(共享同一文件,顺序做避免冲突)。
- **Lane B(session_manager.rs,依赖 Task1)**:Task 5(快照写+tee)可与 Lane A 部分并行,但 Task 8 依赖 Task 5+6,需等。
- **Task 8/9 收尾**:依赖前面全部,顺序做。
实际多为顺序(store 逻辑集中在一个文件),并行收益有限。建议:Task 1 → (2,3,4,6,7 顺序) → 5 → 8 → 9。
