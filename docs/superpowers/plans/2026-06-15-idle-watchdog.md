# 无人值守 run 空闲看门狗(idle-watchdog)实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把定时任务看门狗从"按总运行时长一刀切"改成"空闲时长(events.ndjson mtime) OR 总时长硬上限"双判,空闲超时进确认队列且 UI 可区分,让无人值守的健康慢任务不被误杀。

**Architecture:** 复用 Sprint 2 已落盘的 `~/.zeromux/runs/<id>/events.ndjson`(每事件已写)——其文件 mtime 天然是"最后活动时刻",零新增写。看门狗从单条 set-based UPDATE 改为"查活跃 run → stat mtime → 纯函数 `stale_verdict` 判定 → abort"。新增一个 per-task 列 `idle_timeout_min`;新增 `failure_kind='idle_timeout'` 与现有 `watchdog_timeout` 区分,并加入确认队列 5 处白名单。

**Tech Stack:** Rust(rusqlite + tokio + chrono)、React/TypeScript(Vite + vitest)。

**Spec:** `docs/superpowers/specs/2026-06-15-idle-watchdog-design.md`

---

## 文件结构

| 文件 | 职责 | 改动 |
|---|---|---|
| `src/scheduled_tasks.rs` | 调度存储 + 看门狗 | 迁移、`TaskConfig` 加字段、纯函数 `stale_verdict`、改写 `reconcile_timeouts_per_task`、5 处白名单、测试 |
| `src/web.rs` | HTTP 请求体 | `ScheduledTaskReq` 加 `idle_timeout_min` + clamp + 2 处 `TaskConfig` 构造 |
| `frontend/src/lib/api.ts` | 前端类型 | `ScheduledTask`/`ScheduledTaskReq` 加 `idle_timeout_min` |
| `frontend/src/components/ScheduledTasksPanel.tsx` | 任务表单 + 确认卡片 | 加输入框、`runReason` 加 label、`:581` 白名单 |
| `src/session_manager.rs` | 事件 tee | **不改**(mtime 天然刷新) |

**关键不变量:** `stale_verdict` 是纯函数(不碰 FS/DB),核心判定逻辑全靠它单测锁死;FS/DB 只在看门狗集成测里碰一次。

---

## Task 1: 纯函数 `stale_verdict` —— 判定逻辑(TDD 核心)

**Files:**
- Modify: `src/scheduled_tasks.rs`(在 `run_dir` 函数附近,约 `:638` 之后,模块级新增函数 + 测试)

- [ ] **Step 1: 写失败测试**

在 `src/scheduled_tasks.rs` 的 `#[cfg(test)] mod tests` 块内(文件末尾 `}` 前)加入。这 6 条覆盖 spec §9 的纯函数测试 1-6:

```rust
#[test]
fn stale_verdict_idle_triggers() {
    // last_activity 距今 90min > idle 60min;started 距今 90min < total 300min
    let now = 100_000_000i64;
    let v = super::stale_verdict(now, now - 90*60_000, Some(now - 90*60_000), 60, 300);
    assert_eq!(v, Some("idle_timeout"));
}

#[test]
fn stale_verdict_recent_activity_survives() {
    // 核心价值:started 远超旧 30min 默认(45min 前),但 last_activity 很新(1min 前)→ 不杀
    let now = 100_000_000i64;
    let v = super::stale_verdict(now, now - 45*60_000, Some(now - 1*60_000), 60, 300);
    assert_eq!(v, None, "健康慢任务:有近期活动,过去会被 30min 默认误杀,现在活下来");
}

#[test]
fn stale_verdict_total_hard_cap() {
    // 刷屏死循环:last_activity 一直很新(1min 前),但 started 距今 310min > total 300min → 杀
    let now = 100_000_000i64;
    let v = super::stale_verdict(now, now - 310*60_000, Some(now - 1*60_000), 60, 300);
    assert_eq!(v, Some("watchdog_timeout"));
}

#[test]
fn stale_verdict_idle_wins_when_both_exceed() {
    // started 200min(< 300 total)但 last_activity 90min 前(> 60 idle)→ idle 先到
    let now = 100_000_000i64;
    let v = super::stale_verdict(now, now - 200*60_000, Some(now - 90*60_000), 60, 300);
    assert_eq!(v, Some("idle_timeout"), "先判空闲");
}

#[test]
fn stale_verdict_none_mtime_falls_back_to_started() {
    let now = 100_000_000i64;
    // mtime=None 且 started 老于 idle → idle_timeout
    assert_eq!(super::stale_verdict(now, now - 90*60_000, None, 60, 300), Some("idle_timeout"));
    // mtime=None 且 started 新于 idle 与 total → None,不 panic
    assert_eq!(super::stale_verdict(now, now - 5*60_000, None, 60, 300), None);
}

#[test]
fn stale_verdict_zero_idle_kills_immediately() {
    // 证明 idle=0 会秒杀 → 解释了为何 web.rs 必须 clamp 下限为 1(Task 5)
    let now = 100_000_000i64;
    let v = super::stale_verdict(now, now, Some(now), 0, 300);
    assert_eq!(v, Some("idle_timeout"), "idle=0 → now-last(0) > 0 恒真 → 全员秒杀");
}
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `cargo test stale_verdict 2>&1 | tail -20`
Expected: FAIL —— `cannot find function `stale_verdict` in module `super``

- [ ] **Step 3: 写最小实现**

在 `src/scheduled_tasks.rs` 的 `fn run_dir(...)` 之后(约 `:644` 后)加入模块级函数:

```rust
/// 看门狗判定(纯函数,便于单测):返回 Some(failure_kind) 表示应 abort。
/// last_activity_ms: events.ndjson 的 mtime(epoch ms);无文件传 None → 退化按 started_ms。
/// 先判空闲(更常见、更需早发现),再判总时长硬上限。
fn stale_verdict(
    now_ms: i64,
    started_ms: i64,
    last_activity_ms: Option<i64>,
    idle_timeout_min: i64,
    max_runtime_min: i64,
) -> Option<&'static str> {
    let last = last_activity_ms.unwrap_or(started_ms);
    if now_ms - last > idle_timeout_min * 60_000 {
        return Some("idle_timeout");
    }
    if now_ms - started_ms > max_runtime_min * 60_000 {
        return Some("watchdog_timeout");
    }
    None
}
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `cargo test stale_verdict 2>&1 | tail -20`
Expected: PASS(6 个 test 全过)

> 注:此时 `stale_verdict` 尚无调用方,会有 `dead_code` 警告——Task 4 接上后消失。无需加 `#[allow]`。

- [ ] **Step 5: 提交**

```bash
git add src/scheduled_tasks.rs
git commit -m "feat(sched): stale_verdict pure fn — idle-OR-total timeout decision"
```

---

## Task 2: 迁移 + `TaskConfig` 加 `idle_timeout_min` 字段

**Files:**
- Modify: `src/scheduled_tasks.rs:296-314`(struct)、`:361-374`(迁移)、`:378-390`(upsert)、`:398-409`(query)

- [ ] **Step 1: `TaskConfig` 结构体加字段**

`src/scheduled_tasks.rs:312-313`,在 `max_runtime_min` 后加:

```rust
    #[serde(default)]
    pub max_runtime_min: Option<i64>,
    #[serde(default)]
    pub idle_timeout_min: Option<i64>,
}
```

- [ ] **Step 2: 加迁移**

`src/scheduled_tasks.rs:361-367` 的 `for stmt in [...]` 数组里,在 `max_runtime_min` 那行后加一行:

```rust
            "ALTER TABLE agent_runs_config ADD COLUMN max_runtime_min INTEGER",
            "ALTER TABLE agent_runs_config ADD COLUMN idle_timeout_min INTEGER",
            "ALTER TABLE agent_task_runs ADD COLUMN input_snapshot TEXT",
```

- [ ] **Step 3: `upsert_config` 加列**

`src/scheduled_tasks.rs:378-389`,改 INSERT 列、VALUES、ON CONFLICT、params(整体替换该函数体的 SQL 与 params):

```rust
    pub fn upsert_config(&self, c: &TaskConfig) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO agent_runs_config
             (id,owner_id,name,trigger_type,trigger_spec,tz,agent_type,work_dir,prompt,enabled,retention_n,created_ms,side_effects,max_runtime_min,idle_timeout_min)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)
             ON CONFLICT(id) DO UPDATE SET name=?3,trigger_spec=?5,work_dir=?8,prompt=?9,enabled=?10,retention_n=?11,side_effects=?13,max_runtime_min=?14,idle_timeout_min=?15",
            params![c.id,c.owner_id,c.name,c.trigger_type,c.trigger_spec,c.tz,c.agent_type,
                    c.work_dir,c.prompt,c.enabled as i64,c.retention_n,c.created_ms,
                    c.side_effects as i64, c.max_runtime_min, c.idle_timeout_min],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }
```

- [ ] **Step 4: `query_configs` 加列**

`src/scheduled_tasks.rs:400`(SELECT 列)末尾 `max_runtime_min` 后加 `,idle_timeout_min`:

```rust
        let sql = format!("SELECT id,owner_id,name,trigger_type,trigger_spec,tz,agent_type,work_dir,prompt,enabled,retention_n,created_ms,side_effects,max_runtime_min,idle_timeout_min FROM agent_runs_config {}", where_clause);
```

`src/scheduled_tasks.rs:405-406`(row mapping),`max_runtime_min: r.get(13)?,` 后加:

```rust
            side_effects: r.get::<_, i64>(12)? != 0, max_runtime_min: r.get(13)?,
            idle_timeout_min: r.get(14)?,
        })).map_err(|e| e.to_string())?;
```

- [ ] **Step 5: 编译失败 → 修所有 `TaskConfig {...}` 构造点**

Run: `cargo build 2>&1 | grep -E "missing field|error\[" | head -30`
Expected: FAIL —— 多处 `missing field `idle_timeout_min` in initializer of `TaskConfig``

逐个在这些测试构造点(行号会因前面编辑略有偏移,按 grep 实际定位)的 `max_runtime_min: ...` 后补 `idle_timeout_min: None,`:
- `confirmation_queue_predicate`(mk_cfg)
- `per_task_timeout_respects_max_runtime_min`(mk_cfg)
- `prune_*` 系列测试(约 3 处 cfg)
- `set_confirm_status_only_stamps_queue_runs`(mk_cfg)
- 任何其它 `TaskConfig {` 字面量

用此命令定位全部:

```bash
grep -n "max_runtime_min:" src/scheduled_tasks.rs
```

对每个**非 struct 定义、非 upsert/query** 的 `max_runtime_min: <expr>` 行,其后补一行 `idle_timeout_min: None,`(注意 mk_cfg 闭包里若 max 是参数 `max_runtime_min: max` 也同样补 `idle_timeout_min: None,`)。

- [ ] **Step 6: web.rs 的 2 处构造点(暂置 None,Task 5 再接线)**

Run: `cargo build 2>&1 | grep "missing field" | head`
若报 `src/web.rs` 的 `TaskConfig` 构造缺字段,在 `:1369` 和 `:1414` 一带两处 `max_runtime_min: req.max_runtime_min.map(...)` 后各补:

```rust
        max_runtime_min: req.max_runtime_min.map(|m| m.clamp(1, 1440)),
        idle_timeout_min: None,
```

(真正接线在 Task 5;此处先 None 让编译过。)

- [ ] **Step 7: 编译通过**

Run: `cargo build 2>&1 | tail -5`
Expected: 编译成功(可有 `stale_verdict` dead_code 警告)

- [ ] **Step 8: 提交**

```bash
git add src/scheduled_tasks.rs src/web.rs
git commit -m "feat(sched): add idle_timeout_min column + TaskConfig field (migration)"
```

---

## Task 3: events.ndjson mtime 读取辅助

**Files:**
- Modify: `src/scheduled_tasks.rs`(`run_dir` 附近新增 + 测试)

- [ ] **Step 1: 写失败测试**

在 `#[cfg(test)] mod tests` 内加入(仿 `run_output_tail_extracts_readable_text` 的 HOME-override 写法,`:985`):

```rust
#[test]
fn events_mtime_reads_existing_and_missing() {
    let _guard = crate::session_manager::HOME_ENV_LOCK.lock().unwrap();
    let prev = std::env::var("HOME").ok();
    let tmp = tempfile::tempdir().unwrap();
    std::env::set_var("HOME", tmp.path());
    let dir = tmp.path().join(".zeromux/runs/r_mt");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("events.ndjson"), "x\n").unwrap();

    let got = super::events_mtime_ms("r_mt");
    let missing = super::events_mtime_ms("nope_missing");

    match prev { Some(h) => std::env::set_var("HOME", h), None => std::env::remove_var("HOME") }
    assert!(got.is_some(), "existing file → Some(mtime)");
    assert!(got.unwrap() > 0);
    assert_eq!(missing, None, "missing file → None");
}
```

- [ ] **Step 2: 运行,确认失败**

Run: `cargo test events_mtime 2>&1 | tail -15`
Expected: FAIL —— `cannot find function `events_mtime_ms``

- [ ] **Step 3: 实现**

在 `fn run_dir(...)` 之后加入:

```rust
/// events.ndjson 的 mtime(epoch ms)作为 run 的"最后活动时刻"。
/// append_run_event 每事件 append 该文件,故 mtime 天然随活动刷新。
/// 文件缺失/不可读 → None(看门狗退化按 started_ms 判)。Best-effort,不返回错误。
fn events_mtime_ms(run_id: &str) -> Option<i64> {
    let path = run_dir(run_id).join("events.ndjson");
    let meta = std::fs::metadata(&path).ok()?;
    let mtime = meta.modified().ok()?;
    let dur = mtime.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(dur.as_millis() as i64)
}
```

- [ ] **Step 4: 运行,确认通过**

Run: `cargo test events_mtime 2>&1 | tail -15`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/scheduled_tasks.rs
git commit -m "feat(sched): events_mtime_ms — read run activity from events.ndjson mtime"
```

---

## Task 4: 改写 `reconcile_timeouts_per_task`(查询+stat+循环)+ 更新现存测试

**Files:**
- Modify: `src/scheduled_tasks.rs:489-503`(看门狗)、现存测试 `per_task_timeout_respects_max_runtime_min`

- [ ] **Step 1: 改写看门狗函数**

整体替换 `src/scheduled_tasks.rs:489-503`:

```rust
    /// Watchdog: abort runs whose events.ndjson has been silent longer than the
    /// task's idle_timeout_min (default 60), OR which exceeded max_runtime_min
    /// (default 300) total. Idle wins → failure_kind='idle_timeout'; total cap →
    /// 'watchdog_timeout'. Not a set-based UPDATE: SQLite can't stat files, so we
    /// query active runs, stat each events.ndjson mtime, judge via stale_verdict.
    /// Active scheduled runs are few + this ticks every 60s, so the loop is cheap.
    pub fn reconcile_timeouts_per_task(&self, now_ms: i64) -> Result<usize, String> {
        let candidates: Vec<(String, i64, Option<i64>, Option<i64>)> = {
            let conn = self.conn.lock().unwrap();
            let mut stmt = conn.prepare(
                "SELECT r.id, r.started_ms, c.idle_timeout_min, c.max_runtime_min \
                 FROM agent_task_runs r JOIN agent_runs_config c ON c.id = r.task_id \
                 WHERE r.state IN ('claimed','running')").map_err(|e| e.to_string())?;
            let rows = stmt.query_map(params![], |r| Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<i64>>(1)?.unwrap_or(now_ms),
                r.get::<_, Option<i64>>(2)?,
                r.get::<_, Option<i64>>(3)?,
            ))).map_err(|e| e.to_string())?;
            rows.collect::<Result<_,_>>().map_err(|e| e.to_string())?
        };
        let mut n = 0usize;
        for (id, started_ms, idle_cfg, max_cfg) in candidates {
            let last = events_mtime_ms(&id);
            if let Some(kind) = stale_verdict(
                now_ms, started_ms, last,
                idle_cfg.unwrap_or(60), max_cfg.unwrap_or(300),
            ) {
                // set_run_state 的 state IN ('claimed','running') 终态守卫保证
                // 与 fanout 正常 finalize 不双写(spec §11 竞态:先到者赢)。
                self.set_run_state(&id, "aborted", None, None, Some(kind), Some(now_ms))?;
                n += 1;
            }
        }
        Ok(n)
    }
```

> 注:`set_run_state` 内部自己 `self.conn.lock()`,所以候选查询的锁必须先释放(上面用块作用域 `{...}` 确保)——否则重入死锁。

- [ ] **Step 2: 更新现存测试 `per_task_timeout_respects_max_runtime_min`(CTO P0)**

该测试现断言 `r_def`(started 45min 前、max=None)→ aborted,依赖旧默认 30。新默认 300 下 45<300,且无 events.ndjson → mtime=None → 退化按 started 判 idle(45min < 60min 默认)→ **不再 aborted**。需重写该测试,显式覆盖新双判据。整体替换该测试函数:

```rust
    #[test]
    fn per_task_timeout_respects_max_runtime_min() {
        let _guard = crate::session_manager::HOME_ENV_LOCK.lock().unwrap();
        let prev = std::env::var("HOME").ok();
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("HOME", tmp.path());
        let dir = tempfile::tempdir().unwrap();
        let s = ScheduledStore::open(dir.path()).unwrap();
        // 无 events.ndjson 文件 → mtime=None → 退化按 started_ms 判 idle。
        let mk_cfg = |id: &str, idle: Option<i64>, max: Option<i64>| TaskConfig {
            id: id.into(), owner_id: "u".into(), name: "n".into(), trigger_type: "cron".into(),
            trigger_spec: "0 0 * * * *".into(), tz: "Asia/Shanghai".into(), agent_type: "claude".into(),
            work_dir: ".".into(), prompt: "p".into(), enabled: true, retention_n: 20, created_ms: 1,
            side_effects: false, max_runtime_min: max, idle_timeout_min: idle };
        // t_patient: idle=120min → 90min 静默不杀;t_def: idle=None(默认60) → 90min 静默杀
        s.upsert_config(&mk_cfg("t_patient", Some(120), Some(300))).unwrap();
        s.upsert_config(&mk_cfg("t_def", None, None)).unwrap();
        let now = 100_000_000i64;
        let mk_run = |id: &str, task: &str, started: i64| TaskRun {
            id: id.into(), task_id: task.into(), scheduled_for_ms: started, state: "running".into(),
            session_id: None, verdict: None, failure_kind: None, started_ms: Some(started), ended_ms: None,
            input_snapshot: None, confirm_status: None, replay_of: None };
        s.claim_run(&mk_run("r_patient", "t_patient", now - 90*60*1000)).unwrap();
        s.set_run_state("r_patient", "running", None, None, None, None).unwrap();
        s.claim_run(&mk_run("r_def", "t_def", now - 90*60*1000)).unwrap();
        s.set_run_state("r_def", "running", None, None, None, None).unwrap();

        s.reconcile_timeouts_per_task(now).unwrap();
        match prev { Some(h) => std::env::set_var("HOME", h), None => std::env::remove_var("HOME") }
        let patient = s.runs_for_task("t_patient", 10).unwrap().into_iter().find(|r| r.id=="r_patient").unwrap();
        let def = s.runs_for_task("t_def", 10).unwrap().into_iter().find(|r| r.id=="r_def").unwrap();
        assert_eq!(patient.state, "running", "90min 静默 < idle 120min → 存活");
        assert_eq!(def.state, "aborted", "90min 静默 > idle 默认 60min → 中止");
        assert_eq!(def.failure_kind.as_deref(), Some("idle_timeout"));
    }
```

- [ ] **Step 3: 运行全部看门狗相关测试,确认通过**

Run: `cargo test -- scheduled_tasks 2>&1 | tail -25` (或 `cargo test reconcile; cargo test per_task; cargo test stale_verdict`)
Expected: PASS,无 dead_code 警告(`stale_verdict`/`events_mtime_ms` 现已被调用)

- [ ] **Step 4: 提交**

```bash
git add src/scheduled_tasks.rs
git commit -m "feat(sched): watchdog judges by silence (mtime) not total runtime; update test"
```

---

## Task 5: 确认队列 5 处白名单 + 集成测试

**Files:**
- Modify: `src/scheduled_tasks.rs:533,549,564,604,621`、新增集成测试

- [ ] **Step 1: 写失败的集成测试**

在 `#[cfg(test)] mod tests` 内加入(仿 `confirmation_queue_predicate`):

```rust
#[test]
fn idle_timeout_side_effect_enters_confirm_queue() {
    let dir = tempfile::tempdir().unwrap();
    let s = ScheduledStore::open(dir.path()).unwrap();
    let cfg = TaskConfig {
        id: "t_se".into(), owner_id: "u".into(), name: "t_se".into(), trigger_type: "cron".into(),
        trigger_spec: "0 0 * * * *".into(), tz: "Asia/Shanghai".into(), agent_type: "claude".into(),
        work_dir: ".".into(), prompt: "p".into(), enabled: true, retention_n: 20, created_ms: 1,
        side_effects: true, max_runtime_min: None, idle_timeout_min: None };
    s.upsert_config(&cfg).unwrap();
    let run = TaskRun { id: "r_idle".into(), task_id: "t_se".into(), scheduled_for_ms: 1,
        state: "claimed".into(), session_id: None, verdict: None, failure_kind: None, started_ms: Some(1),
        ended_ms: None, input_snapshot: None, confirm_status: None, replay_of: None };
    s.claim_run(&run).unwrap();
    // 模拟被空闲超时 abort
    s.set_run_state("r_idle", "aborted", None, None, Some("idle_timeout"), Some(2)).unwrap();

    let q = s.confirmation_queue("u").unwrap();
    assert_eq!(q.len(), 1, "idle_timeout 的副作用任务必须进确认队列");
    assert_eq!(q[0].0.failure_kind.as_deref(), Some("idle_timeout"));
    assert_eq!(s.confirmation_count("u").unwrap(), 1);
}
```

- [ ] **Step 2: 运行,确认失败**

Run: `cargo test idle_timeout_side_effect_enters_confirm_queue 2>&1 | tail -15`
Expected: FAIL —— `assertion `left == right` failed: idle_timeout 的副作用任务必须进确认队列`(队列为 0,因白名单还没 `idle_timeout`)

- [ ] **Step 3: 5 处白名单加 `idle_timeout`**

把 `src/scheduled_tasks.rs` 中全部 5 处
`failure_kind IN ('watchdog_timeout','orphaned_restart')`
替换为
`failure_kind IN ('watchdog_timeout','orphaned_restart','idle_timeout')`

定位:

```bash
grep -n "failure_kind IN ('watchdog_timeout','orphaned_restart')" src/scheduled_tasks.rs
```

应有 5 处(约 `:533` confirmation_queue、`:549` confirmation_count、`:564` is_unconfirmed_side_effect_unknown、`:604` replay gate、`:621` prune 豁免)。逐一替换。

- [ ] **Step 4: 运行,确认通过**

Run: `cargo test idle_timeout_side_effect_enters_confirm_queue 2>&1 | tail -15`
Expected: PASS

- [ ] **Step 5: 跑全量 Rust 测试,确认无回归**

Run: `cargo test 2>&1 | tail -15`
Expected: 全部 PASS

- [ ] **Step 6: 提交**

```bash
git add src/scheduled_tasks.rs
git commit -m "feat(sched): idle_timeout joins confirm-queue/replay/prune whitelist (5 sites)"
```

---

## Task 6: web.rs 请求体接线 idle_timeout_min + clamp

**Files:**
- Modify: `src/web.rs:1315-1323`(req struct)、`:1369` 与 `:1414`(两处 TaskConfig 构造)

- [ ] **Step 1: 请求体加字段**

`src/web.rs` 的 `ScheduledTaskReq` 结构体(`:1322` 一带,`max_runtime_min` 后):

```rust
    #[serde(default)]
    max_runtime_min: Option<i64>,
    #[serde(default)]
    idle_timeout_min: Option<i64>,
}
```

- [ ] **Step 2: 两处 TaskConfig 构造接线 + clamp**

把 Task 2 Step 6 临时写的 `idle_timeout_min: None,`(`create_scheduled` 与 `update_scheduled` 两处)改成:

```rust
        max_runtime_min: req.max_runtime_min.map(|m| m.clamp(1, 1440)),
        idle_timeout_min: req.idle_timeout_min.map(|m| m.clamp(1, 1440)),
```

- [ ] **Step 3: 编译 + 测试**

Run: `cargo build 2>&1 | tail -5 && cargo test 2>&1 | tail -8`
Expected: 编译成功,全部测试 PASS

- [ ] **Step 4: 提交**

```bash
git add src/web.rs
git commit -m "feat(web): wire idle_timeout_min into scheduled-task req (clamp 1..1440)"
```

---

## Task 7: 前端类型 + 表单输入 + 确认卡片文案

**Files:**
- Modify: `frontend/src/lib/api.ts:423,453`、`frontend/src/components/ScheduledTasksPanel.tsx`(类型、表单、`runReason`、`:581`)

- [ ] **Step 1: api.ts 类型加字段**

`frontend/src/lib/api.ts:423`(`ScheduledTask` interface)`max_runtime_min: number | null` 后:

```ts
  max_runtime_min: number | null
  idle_timeout_min: number | null
}
```

`:453`(`ScheduledTaskReq`)`max_runtime_min?: number | null` 后:

```ts
  max_runtime_min?: number | null
  idle_timeout_min?: number | null
}
```

- [ ] **Step 2: ScheduledTasksPanel state + 提交体**

`ScheduledTasksPanel.tsx:368`(`maxRuntime` state)后加:

```tsx
  const [maxRuntime, setMaxRuntime] = useState<number | null>(task?.max_runtime_min ?? null)
  const [idleTimeout, setIdleTimeout] = useState<number | null>(task?.idle_timeout_min ?? null)
```

`:397-398`(提交体 req)`max_runtime_min: maxRuntime,` 后加:

```tsx
      max_runtime_min: maxRuntime,
      idle_timeout_min: idleTimeout,
```

- [ ] **Step 3: 表单加输入框(放在 `:507-518` 最长运行框后,文案折叠语义见 spec §7.1)**

在 `最长运行(分钟...)` 那个 `<div>`(`:507-518`)之后插入:

```tsx
      <div>
        <label className={labelCls} title="若任务会运行长时间无输出的命令(全量测试/CI/大型 build),请把空闲超时设得高于该命令的预期时长,否则会被误判为卡死">
          空闲超时(分钟,留空=60)
        </label>
        <input
          type="number"
          min={1}
          max={1440}
          value={idleTimeout ?? ''}
          onChange={e => setIdleTimeout(e.target.value === '' ? null : Number(e.target.value))}
          className={inputCls}
          placeholder="60"
        />
      </div>
```

并把现有 `:508` 最长运行的 label 文案默认值改准:`最长运行(分钟,留空=300)`,placeholder 改 `300`。

- [ ] **Step 4: `runReason` 加 idle_timeout label**

`ScheduledTasksPanel.tsx:55-56`,把 `watchdog_timeout` 文案收窄并新增 `idle_timeout`:

```tsx
    if (r.failure_kind === 'idle_timeout') return { label: '静默超时(无输出)', color: 'text-[var(--accent-red)]' }
    if (r.failure_kind === 'watchdog_timeout') return { label: '超过最长运行时长', color: 'text-[var(--accent-red)]' }
    if (r.failure_kind === 'orphaned_restart') return { label: '重启中断', color: 'text-[var(--accent-red)]' }
```

- [ ] **Step 5: `:581` 确认按钮判断加 idle_timeout**

`ScheduledTasksPanel.tsx:581`:

```tsx
          (r.failure_kind === 'watchdog_timeout' || r.failure_kind === 'orphaned_restart' || r.failure_kind === 'idle_timeout') &&
```

- [ ] **Step 6: lint + 构建**

Run: `cd frontend && npm run lint 2>&1 | tail -15 && npm run build 2>&1 | tail -8`
Expected: lint 无新增错误(既存 error 非本次引入则忽略);`tsc -b && vite build` 成功

> 若 `npm run build` 因 `frontend/dist` 缺失影响后续 `cargo build`,这是预期(rust-embed)——本计划后端测试用 `cargo test` 不读 dist,不受影响。

- [ ] **Step 7: 提交**

```bash
git add frontend/src/lib/api.ts frontend/src/components/ScheduledTasksPanel.tsx
git commit -m "feat(fe): idle_timeout_min form field + distinct idle/total timeout labels"
```

---

## Task 8: 端到端验证 + 收尾

- [ ] **Step 1: 全量后端测试**

Run: `cargo test 2>&1 | tail -15`
Expected: 全部 PASS(含新增 8 个测试 + 改写的 1 个)

- [ ] **Step 2: 前端测试 + lint**

Run: `cd frontend && npm test 2>&1 | tail -15 && npm run lint 2>&1 | tail -10`
Expected: vitest 全过;lint 无本次新增错误

- [ ] **Step 3: 人工冒烟检查清单(spec 验收)**

确认以下逻辑闭环(读代码核对即可,无需真跑定时任务):
- [ ] 一个 60min 无 events.ndjson 写入的 run → 被判 `idle_timeout`(Task 1/4 测试已锁)
- [ ] 持续产出的慢任务 → 不被误杀(Task 1 `recent_activity_survives` 已锁)
- [ ] 5h 总上限刷屏死循环 → `watchdog_timeout`(Task 1 `total_hard_cap` 已锁)
- [ ] side_effects + idle_timeout → 进确认队列(Task 5 已锁)
- [ ] 确认卡片能区分「静默超时」vs「超过最长运行时长」(Task 7 `runReason`)
- [ ] 表单两个 timeout 输入框 + 空闲超时 tooltip 提示长命令边界(Task 7)

- [ ] **Step 4: 最终提交(若有遗留)**

```bash
git status
# 若 working tree 干净则跳过;否则 git add -A && git commit -m "chore(sched): idle-watchdog finalize"
```

---

## 完成标准

- 8 个新测试 + 1 个改写测试全绿,`cargo test` / `npm test` 无回归。
- 看门狗按"空闲(mtime) OR 总时长"双判,`idle_timeout`/`watchdog_timeout` 两种 failure_kind 在确认队列与前端均可区分。
- 无新增 schema 列除 `idle_timeout_min`;`session_manager.rs` 未改;事件路径零新增写。
- spec §9 的全部 7 条 + CTO P0 改写测试均有对应任务实现。
</content>
