use chrono::{DateTime, Utc};
use chrono_tz::Asia::Shanghai;
use rusqlite::{params, Connection};
use std::path::Path;
use std::str::FromStr;
use std::sync::Mutex;

/// Idle threshold after which a silent *interactive* (non-scheduled) agent
/// session is assumed wedged and gets a TimeoutKill. Scheduled runs use their
/// own per-task `idle_timeout_min`; this is a conservative fixed value for
/// interactive sessions, which today have no kill/timeout detection at all.
/// Constant for now — per-session/self-tuning thresholds are a documented future
/// seam (spec §8).
const INTERACTIVE_IDLE_MS: i64 = 30 * 60_000; // 30 minutes

/// Return scheduled fire points in the half-open interval (last_seen, now],
/// evaluated in Asia/Shanghai, oldest -> newest. The scheduler caller uses
/// `.last()` to fire only the most recent due point (no backfill of older ones).
///
/// Pure: time is injected via `last_seen`/`now`; this never reads the clock.
/// cron fields are evaluated in Shanghai local time (verified: the `cron` crate
/// evaluates in the passed datetime's timezone), so "0 0 9 * * *" means
/// 09:00 Shanghai == 01:00 UTC — no manual offset.
pub fn due_fire_points(
    cron_spec: &str,
    last_seen: DateTime<Utc>,
    now: DateTime<Utc>,
) -> Result<Vec<DateTime<Utc>>, String> {
    let schedule = cron::Schedule::from_str(cron_spec)
        .map_err(|e| format!("bad cron '{}': {}", cron_spec, e))?;
    let after = last_seen.with_timezone(&Shanghai);
    let mut out = Vec::new();
    for t in schedule.after(&after) {
        let t_utc = t.with_timezone(&Utc);
        if t_utc > now {
            break;
        }
        out.push(t_utc);
        if out.len() > 1000 {
            break; // safety bound against pathological specs
        }
    }
    Ok(out)
}

/// Extract the last well-formed <<<VERDICT>>>..<<<END>>> payload from an agent's
/// final text. Returns None if absent or empty. Taking the LAST marker defeats
/// prompt-injection that embeds a fake earlier marker in the user's goal text.
pub fn extract_verdict(result_text: &str) -> Option<String> {
    let mut found = None;
    let mut rest = result_text;
    while let Some(start) = rest.find("<<<VERDICT>>>") {
        let after = &rest[start + "<<<VERDICT>>>".len()..];
        if let Some(end) = after.find("<<<END>>>") {
            found = Some(after[..end].trim().to_string());
            rest = &after[end + "<<<END>>>".len()..];
        } else {
            break;
        }
    }
    found.filter(|s| !s.is_empty())
}

/// A new trigger is blocked by overlap iff the task has any run still
/// claimed or running. `active_states` are the `state` strings of the task's
/// non-terminal runs (typically queried as state IN ('claimed','running')).
pub fn should_skip_overlap(active_states: &[&str]) -> bool {
    active_states.iter().any(|s| *s == "claimed" || *s == "running")
}

/// Reclaim (delete) a scheduled run's worktree session only when ALL hold:
/// the path is inside the expected `.zeromux-worktrees/` root, the process is
/// dead, and there are no uncommitted git changes (don't destroy unmerged work).
pub fn is_safe_to_reclaim(
    path_under_worktree_root: bool,
    process_alive: bool,
    has_uncommitted: bool,
) -> bool {
    path_under_worktree_root && !process_alive && !has_uncommitted
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ScheduleInput {
    Daily { hour: u32, minute: u32 },
    Weekly { weekdays: Vec<u32>, hour: u32, minute: u32 }, // 0=Sun..6=Sat
    Cron { expr: String },
}

/// Build a 6-field cron string (sec min hour dom mon dow), evaluated by the
/// scheduler in Asia/Shanghai. No UTC offset baked in. Weekly weekdays use the
/// cron crate convention (0/7=Sun, 1=Mon..6=Sat).
pub fn schedule_to_cron(s: &ScheduleInput) -> String {
    match s {
        ScheduleInput::Daily { hour, minute } => format!("0 {} {} * * *", minute, hour),
        ScheduleInput::Weekly { weekdays, hour, minute } => {
            let dows = weekdays.iter().map(|d| d.to_string()).collect::<Vec<_>>().join(",");
            format!("0 {} {} * * {}", minute, hour, if dows.is_empty() { "*".to_string() } else { dows })
        }
        ScheduleInput::Cron { expr } => expr.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    // 6-field cron: sec min hour dom mon dow. "0 0 9 * * *" = 09:00 daily,
    // evaluated in the after-datetime's tz (Shanghai) -> 01:00 UTC.
    const DAILY_0900: &str = "0 0 9 * * *";

    #[test]
    fn fires_once_for_daily_at_0900_shanghai() {
        // window: 00:59 UTC (08:59 CST) .. 01:01 UTC (09:01 CST)
        let last = Utc.with_ymd_and_hms(2026, 6, 6, 0, 59, 0).unwrap();
        let now = Utc.with_ymd_and_hms(2026, 6, 6, 1, 1, 0).unwrap();
        let fires = due_fire_points(DAILY_0900, last, now).unwrap();
        assert_eq!(fires.len(), 1, "exactly one 09:00 fire in window");
        // Proves no 8h skew: fire is 01:00 UTC == 09:00 Shanghai.
        assert_eq!(fires[0], Utc.with_ymd_and_hms(2026, 6, 6, 1, 0, 0).unwrap());
    }

    #[test]
    fn empty_when_no_fire_in_window() {
        let last = Utc.with_ymd_and_hms(2026, 6, 6, 2, 0, 0).unwrap();
        let now = Utc.with_ymd_and_hms(2026, 6, 6, 3, 0, 0).unwrap();
        assert!(due_fire_points(DAILY_0900, last, now).unwrap().is_empty());
    }

    #[test]
    fn multiple_due_points_when_loop_stalled() {
        // hourly at :00; 3-hour window -> 3 due points; caller takes last.
        let hourly = "0 0 * * * *";
        let last = Utc.with_ymd_and_hms(2026, 6, 6, 0, 30, 0).unwrap();
        let now = Utc.with_ymd_and_hms(2026, 6, 6, 3, 30, 0).unwrap();
        let fires = due_fire_points(hourly, last, now).unwrap();
        assert_eq!(fires.len(), 3);
    }

    #[test]
    fn weekday_cron_skips_weekend() {
        // "0 0 9 * * 1-5" = 09:00 Mon-Fri. 2026-06-06 is a Saturday;
        // a window over Sat 09:00 Shanghai must yield no fire.
        let weekday = "0 0 9 * * 1-5";
        let last = Utc.with_ymd_and_hms(2026, 6, 6, 0, 59, 0).unwrap(); // Sat 08:59 CST
        let now = Utc.with_ymd_and_hms(2026, 6, 6, 1, 1, 0).unwrap();   // Sat 09:01 CST
        assert!(due_fire_points(weekday, last, now).unwrap().is_empty(),
            "no fire on Saturday for a Mon-Fri schedule");
    }

    #[test]
    fn bad_cron_is_error_not_panic() {
        let now = Utc.with_ymd_and_hms(2026, 6, 6, 1, 1, 0).unwrap();
        assert!(due_fire_points("not a cron", now, now).is_err());
        // 5-field standard cron also errors in this crate (needs 6/7 fields).
        assert!(due_fire_points("* * * * *", now, now).is_err());
    }

    #[test]
    fn verdict_basic() {
        assert_eq!(extract_verdict("blah\n<<<VERDICT>>>2 issues<<<END>>>"), Some("2 issues".into()));
    }
    #[test]
    fn verdict_takes_last_marker() {
        let t = "<<<VERDICT>>>fake<<<END>>> ... real run <<<VERDICT>>>3 high<<<END>>>";
        assert_eq!(extract_verdict(t), Some("3 high".into()));
    }
    #[test]
    fn verdict_none_when_absent_or_empty() {
        assert_eq!(extract_verdict("no marker here"), None);
        assert_eq!(extract_verdict("<<<VERDICT>>>  <<<END>>>"), None);
    }
    #[test]
    fn overlap_blocks_on_active() {
        assert!(should_skip_overlap(&["succeeded", "running"]));
        assert!(should_skip_overlap(&["claimed"]));
        assert!(!should_skip_overlap(&["succeeded", "failed"]));
        assert!(!should_skip_overlap(&[]));
    }
    #[test]
    fn daily_to_cron() {
        assert_eq!(schedule_to_cron(&ScheduleInput::Daily { hour: 9, minute: 0 }), "0 0 9 * * *");
    }
    #[test]
    fn weekly_to_cron() {
        assert_eq!(schedule_to_cron(&ScheduleInput::Weekly { weekdays: vec![1,2,3,4,5], hour: 9, minute: 0 }), "0 0 9 * * 1,2,3,4,5");
    }
    #[test]
    fn reclaim_gates() {
        assert!(is_safe_to_reclaim(true, false, false));
        assert!(!is_safe_to_reclaim(false, false, false)); // outside worktree root
        assert!(!is_safe_to_reclaim(true, true, false));   // process alive
        assert!(!is_safe_to_reclaim(true, false, true));   // uncommitted changes
    }

    #[test]
    fn prune_exempts_pending_confirmation() {
        let dir = tempfile::tempdir().unwrap();
        let s = ScheduledStore::open(dir.path()).unwrap();
        let cfg = TaskConfig { id: "t".into(), owner_id: "u".into(), name: "n".into(), trigger_type: "cron".into(),
            trigger_spec: "0 0 * * * *".into(), tz: "Asia/Shanghai".into(), agent_type: "claude".into(),
            work_dir: ".".into(), prompt: "p".into(), enabled: true, retention_n: 1, created_ms: 1,
            side_effects: true, max_runtime_min: None, idle_timeout_min: None };
        s.upsert_config(&cfg).unwrap();
        let mk = |id: &str, sched: i64, kind: Option<&str>, state: &str| {
            let run = TaskRun { id: id.into(), task_id: "t".into(), scheduled_for_ms: sched, state: "claimed".into(),
                session_id: None, verdict: None, failure_kind: None, started_ms: Some(sched), ended_ms: None,
                input_snapshot: None, confirm_status: None, replay_of: None };
            s.claim_run(&run).unwrap();
            s.set_run_state(id, state, None, None, kind, Some(sched)).unwrap();
        };
        // old pending-confirmation run (side-effecting unknown) + two newer succeeded runs. keep=1.
        mk("r_pending", 1, Some("watchdog_timeout"), "aborted");
        mk("r_new1", 100, None, "succeeded");
        mk("r_new2", 200, None, "succeeded");
        s.prune_runs("t", 1).unwrap();
        let ids: Vec<String> = s.runs_for_task("t", 50).unwrap().into_iter().map(|r| r.id).collect();
        assert!(ids.contains(&"r_pending".to_string()), "pending-confirmation run must survive prune");
        assert!(ids.contains(&"r_new2".to_string()), "newest run kept");
        assert!(!ids.contains(&"r_new1".to_string()), "older non-pending run pruned");
    }

    #[test]
    fn prune_does_not_exempt_non_side_effecting_unknown() {
        // A read-only task's aborted/unknown runs never enter the confirmation
        // queue, so they must stay prunable — not accumulate forever.
        let dir = tempfile::tempdir().unwrap();
        let s = ScheduledStore::open(dir.path()).unwrap();
        let cfg = TaskConfig { id: "t".into(), owner_id: "u".into(), name: "n".into(), trigger_type: "cron".into(),
            trigger_spec: "0 0 * * * *".into(), tz: "Asia/Shanghai".into(), agent_type: "claude".into(),
            work_dir: ".".into(), prompt: "p".into(), enabled: true, retention_n: 1, created_ms: 1,
            side_effects: false, max_runtime_min: None, idle_timeout_min: None };   // NOT side-effecting
        s.upsert_config(&cfg).unwrap();
        let mk = |id: &str, sched: i64, kind: Option<&str>, state: &str| {
            let run = TaskRun { id: id.into(), task_id: "t".into(), scheduled_for_ms: sched, state: "claimed".into(),
                session_id: None, verdict: None, failure_kind: None, started_ms: Some(sched), ended_ms: None,
                input_snapshot: None, confirm_status: None, replay_of: None };
            s.claim_run(&run).unwrap();
            s.set_run_state(id, state, None, None, kind, Some(sched)).unwrap();
        };
        mk("r_old_aborted", 1, Some("watchdog_timeout"), "aborted");   // unknown, but read-only task
        mk("r_new", 200, None, "succeeded");
        s.prune_runs("t", 1).unwrap();
        let ids: Vec<String> = s.runs_for_task("t", 50).unwrap().into_iter().map(|r| r.id).collect();
        assert!(!ids.contains(&"r_old_aborted".to_string()), "read-only aborted/unknown run must be prunable");
        assert!(ids.contains(&"r_new".to_string()), "newest run kept");
    }

    #[test]
    fn set_confirm_status_only_stamps_queue_runs() {
        // Guards against stamping confirm_status on a run that isn't in the
        // queue (succeeded, or non-side-effecting) — which would otherwise be a
        // silent no-op-but-true, or worse pre-empt a future timeout.
        let dir = tempfile::tempdir().unwrap();
        let s = ScheduledStore::open(dir.path()).unwrap();
        let mk_cfg = |id: &str, se: bool| TaskConfig {
            id: id.into(), owner_id: "u".into(), name: id.into(), trigger_type: "cron".into(),
            trigger_spec: "0 0 * * * *".into(), tz: "Asia/Shanghai".into(), agent_type: "claude".into(),
            work_dir: ".".into(), prompt: "p".into(), enabled: true, retention_n: 20, created_ms: 1,
            side_effects: se, max_runtime_min: None, idle_timeout_min: None };
        s.upsert_config(&mk_cfg("t_se", true)).unwrap();
        s.upsert_config(&mk_cfg("t_ro", false)).unwrap();
        // distinct scheduled_for_ms per run — UNIQUE(task_id, scheduled_for_ms)
        // would otherwise make a same-task second claim a silent no-op.
        let mk_run = |id: &str, task: &str, sched: i64| TaskRun { id: id.into(), task_id: task.into(),
            scheduled_for_ms: sched, state: "claimed".into(), session_id: None, verdict: None, failure_kind: None,
            started_ms: Some(sched), ended_ms: None, input_snapshot: None, confirm_status: None, replay_of: None };
        // succeeded side-effecting run — NOT in queue
        s.claim_run(&mk_run("r_ok", "t_se", 1)).unwrap();
        s.set_run_state("r_ok", "succeeded", None, None, None, Some(2)).unwrap();
        assert!(!s.set_confirm_status("r_ok", "confirmed_done").unwrap(), "succeeded run is not in queue");
        // aborted/unknown but read-only — NOT in queue
        s.claim_run(&mk_run("r_ro", "t_ro", 2)).unwrap();
        s.set_run_state("r_ro", "aborted", None, None, Some("watchdog_timeout"), Some(2)).unwrap();
        assert!(!s.set_confirm_status("r_ro", "confirmed_done").unwrap(), "read-only aborted run is not in queue");
        // genuine queue run — accepts the stamp once
        s.claim_run(&mk_run("r_q", "t_se", 3)).unwrap();
        s.set_run_state("r_q", "aborted", None, None, Some("orphaned_restart"), Some(2)).unwrap();
        assert!(s.set_confirm_status("r_q", "confirmed_done").unwrap(), "queue run accepts stamp");
        assert!(!s.set_confirm_status("r_q", "replayed").unwrap(), "second stamp refused");
    }

    #[test]
    fn add_columns_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        // open twice: second open must NOT panic on "duplicate column"
        { let _s = ScheduledStore::open(dir.path()).unwrap(); }
        let s = ScheduledStore::open(dir.path()).unwrap();
        let c = TaskConfig {
            id: "t1".into(), owner_id: "u1".into(), name: "n".into(),
            trigger_type: "cron".into(), trigger_spec: "0 0 * * * *".into(),
            tz: "Asia/Shanghai".into(), agent_type: "claude".into(),
            work_dir: ".".into(), prompt: "p".into(), enabled: true,
            retention_n: 20, created_ms: 1, side_effects: true, max_runtime_min: Some(60),
            idle_timeout_min: None,
        };
        s.upsert_config(&c).unwrap();
        let got = s.get_config("t1").unwrap().unwrap();
        assert!(got.side_effects);
        assert_eq!(got.max_runtime_min, Some(60));
    }

    #[test]
    fn stale_verdict_idle_triggers() {
        let now = 100_000_000i64;
        let v = super::stale_verdict(now, now - 90*60_000, Some(now - 90*60_000), 60, 300);
        assert_eq!(v, Some("idle_timeout"));
    }

    #[test]
    fn stale_verdict_recent_activity_survives() {
        let now = 100_000_000i64;
        let v = super::stale_verdict(now, now - 45*60_000, Some(now - 1*60_000), 60, 300);
        assert_eq!(v, None, "健康慢任务:有近期活动,过去会被 30min 默认误杀,现在活下来");
    }

    #[test]
    fn stale_verdict_total_hard_cap() {
        let now = 100_000_000i64;
        let v = super::stale_verdict(now, now - 310*60_000, Some(now - 1*60_000), 60, 300);
        assert_eq!(v, Some("watchdog_timeout"));
    }

    #[test]
    fn stale_verdict_idle_wins_when_both_exceed() {
        let now = 100_000_000i64;
        let v = super::stale_verdict(now, now - 200*60_000, Some(now - 90*60_000), 60, 300);
        assert_eq!(v, Some("idle_timeout"), "先判空闲");
    }

    #[test]
    fn stale_verdict_none_mtime_falls_back_to_started() {
        let now = 100_000_000i64;
        assert_eq!(super::stale_verdict(now, now - 90*60_000, None, 60, 300), Some("idle_timeout"));
        assert_eq!(super::stale_verdict(now, now - 5*60_000, None, 60, 300), None);
    }

    #[test]
    fn stale_verdict_zero_idle_kills_immediately() {
        let now = 100_000_000i64;
        let v = super::stale_verdict(now, now, Some(now), 0, 300);
        assert_eq!(v, Some("idle_timeout"), "idle=0 → now-last(0) >= 0 恒真 → 全员秒杀");
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TaskConfig {
    pub id: String,
    pub owner_id: String,
    pub name: String,
    pub trigger_type: String, // "cron"
    pub trigger_spec: String, // cron string
    pub tz: String,           // "Asia/Shanghai"
    pub agent_type: String,   // "claude"
    pub work_dir: String,
    pub prompt: String,
    pub enabled: bool,
    pub retention_n: i64,
    pub created_ms: i64,
    #[serde(default)]
    pub side_effects: bool,
    #[serde(default)]
    pub max_runtime_min: Option<i64>,
    #[serde(default)]
    pub idle_timeout_min: Option<i64>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct TaskRun {
    pub id: String,
    pub task_id: String,
    pub scheduled_for_ms: i64,
    pub state: String, // claimed|running|succeeded|failed|skipped|aborted
    pub session_id: Option<String>,
    pub verdict: Option<String>,
    pub failure_kind: Option<String>,
    pub started_ms: Option<i64>,
    pub ended_ms: Option<i64>,
    #[serde(default)]
    pub input_snapshot: Option<String>,
    #[serde(default)]
    pub confirm_status: Option<String>,
    #[serde(default)]
    pub replay_of: Option<String>,
}

pub struct ScheduledStore {
    conn: Mutex<Connection>,
}

impl ScheduledStore {
    pub fn open(data_dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
        let conn = Connection::open(data_dir.join("scheduled.db")).map_err(|e| e.to_string())?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS agent_runs_config (
                id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL,
                trigger_type TEXT NOT NULL, trigger_spec TEXT NOT NULL, tz TEXT NOT NULL,
                agent_type TEXT NOT NULL, work_dir TEXT NOT NULL, prompt TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1, retention_n INTEGER NOT NULL DEFAULT 20,
                created_ms INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS agent_task_runs (
                id TEXT PRIMARY KEY, task_id TEXT NOT NULL, scheduled_for_ms INTEGER NOT NULL,
                state TEXT NOT NULL, session_id TEXT, verdict TEXT, failure_kind TEXT,
                started_ms INTEGER, ended_ms INTEGER,
                UNIQUE(task_id, scheduled_for_ms));
            CREATE INDEX IF NOT EXISTS idx_runs_task_state ON agent_task_runs(task_id, state);",
        ).map_err(|e| e.to_string())?;
        // No migration system: tables are CREATE IF NOT EXISTS, so new columns
        // must be added via ALTER on already-existing DBs. SQLite has no
        // "ADD COLUMN IF NOT EXISTS" — swallow the duplicate-column error so
        // repeated opens are idempotent.
        for stmt in [
            "ALTER TABLE agent_runs_config ADD COLUMN side_effects INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE agent_runs_config ADD COLUMN max_runtime_min INTEGER",
            "ALTER TABLE agent_runs_config ADD COLUMN idle_timeout_min INTEGER",
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
        Ok(Self { conn: Mutex::new(conn) })
    }

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

    pub fn list_enabled(&self) -> Result<Vec<TaskConfig>, String> {
        self.query_configs("WHERE enabled=1", params![])
    }
    pub fn list_for_owner(&self, owner: &str) -> Result<Vec<TaskConfig>, String> {
        self.query_configs("WHERE owner_id=?1", params![owner])
    }
    fn query_configs(&self, where_clause: &str, p: impl rusqlite::Params) -> Result<Vec<TaskConfig>, String> {
        let conn = self.conn.lock().unwrap();
        let sql = format!("SELECT id,owner_id,name,trigger_type,trigger_spec,tz,agent_type,work_dir,prompt,enabled,retention_n,created_ms,side_effects,max_runtime_min,idle_timeout_min FROM agent_runs_config {}", where_clause);
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt.query_map(p, |r| Ok(TaskConfig {
            id: r.get(0)?, owner_id: r.get(1)?, name: r.get(2)?, trigger_type: r.get(3)?,
            trigger_spec: r.get(4)?, tz: r.get(5)?, agent_type: r.get(6)?, work_dir: r.get(7)?,
            prompt: r.get(8)?, enabled: r.get::<_, i64>(9)? != 0, retention_n: r.get(10)?, created_ms: r.get(11)?,
            side_effects: r.get::<_, i64>(12)? != 0, max_runtime_min: r.get(13)?, idle_timeout_min: r.get(14)?,
        })).map_err(|e| e.to_string())?;
        rows.collect::<Result<_,_>>().map_err(|e| e.to_string())
    }

    pub fn get_config(&self, id: &str) -> Result<Option<TaskConfig>, String> {
        Ok(self.query_configs("WHERE id=?1", params![id])?.into_iter().next())
    }
    pub fn delete_config(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        // Remove on-disk run records before dropping the rows, else the
        // ~/.zeromux/runs/<id>/ dirs leak with no DB row left to find them by.
        let run_ids: Vec<String> = {
            let mut stmt = conn.prepare("SELECT id FROM agent_task_runs WHERE task_id=?1")
                .map_err(|e| e.to_string())?;
            let rows = stmt.query_map(params![id], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<_,_>>().map_err(|e| e.to_string())?
        };
        for rid in &run_ids {
            let _ = std::fs::remove_dir_all(run_dir(rid));
        }
        // No FK cascade on this schema — drop the run rows explicitly, else they
        // outlive the deleted task as orphans.
        conn.execute("DELETE FROM agent_task_runs WHERE task_id=?1", params![id]).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM agent_runs_config WHERE id=?1", params![id]).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Atomic claim: INSERT OR IGNORE. Returns true iff this caller inserted
    /// (won the scheduled_for slot). Side effects (session spawn) happen only
    /// after a successful claim.
    pub fn claim_run(&self, run: &TaskRun) -> Result<bool, String> {
        let conn = self.conn.lock().unwrap();
        let n = conn.execute(
            "INSERT OR IGNORE INTO agent_task_runs
             (id,task_id,scheduled_for_ms,state,started_ms) VALUES (?1,?2,?3,'claimed',?4)",
            params![run.id, run.task_id, run.scheduled_for_ms, run.started_ms],
        ).map_err(|e| e.to_string())?;
        Ok(n == 1)
    }

    pub fn set_run_state(&self, run_id: &str, state: &str, session_id: Option<&str>,
                         verdict: Option<&str>, failure_kind: Option<&str>, ended_ms: Option<i64>) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE agent_task_runs SET state=?2, session_id=COALESCE(?3,session_id),
             verdict=COALESCE(?4,verdict), failure_kind=COALESCE(?5,failure_kind),
             ended_ms=COALESCE(?6,ended_ms) WHERE id=?1 AND state IN ('claimed','running')",
            params![run_id, state, session_id, verdict, failure_kind, ended_ms],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn active_states_for_task(&self, task_id: &str) -> Result<Vec<String>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT state FROM agent_task_runs WHERE task_id=?1 AND state IN ('claimed','running')").map_err(|e| e.to_string())?;
        let rows = stmt.query_map(params![task_id], |r| r.get::<_,String>(0)).map_err(|e| e.to_string())?;
        rows.collect::<Result<_,_>>().map_err(|e| e.to_string())
    }

    /// Startup + watchdog: mark claimed/running as aborted with a failure_kind.
    /// cutoff_ms=None at startup (all orphans → `orphaned_restart`);
    /// Some(cutoff) for the timeout watchdog (only runs whose started_ms is older
    /// than cutoff → `watchdog_timeout`).
    pub fn reconcile_orphans(&self, cutoff_ms: Option<i64>) -> Result<usize, String> {
        let conn = self.conn.lock().unwrap();
        // Stamp ended_ms too: the confirmation queue orders by it and the card
        // renders it, so an orphaned/aborted run with NULL ended_ms sorts last
        // and shows no timestamp. (reconcile_timeouts_per_task already does this;
        // both abort paths must agree.)
        let now = chrono::Utc::now().timestamp_millis();
        let n = match cutoff_ms {
            None => conn.execute(
                "UPDATE agent_task_runs SET state='aborted', failure_kind='orphaned_restart', ended_ms=?1 \
                 WHERE state IN ('claimed','running')", params![now]),
            Some(c) => conn.execute(
                "UPDATE agent_task_runs SET state='aborted', failure_kind='watchdog_timeout', ended_ms=?2 \
                 WHERE state IN ('claimed','running') AND started_ms < ?1", params![c, now]),
        }.map_err(|e| e.to_string())?;
        Ok(n)
    }

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

    pub fn set_input_snapshot(&self, run_id: &str, snapshot: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute("UPDATE agent_task_runs SET input_snapshot=?2 WHERE id=?1",
            params![run_id, snapshot]).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn runs_for_task(&self, task_id: &str, limit: i64) -> Result<Vec<TaskRun>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT id,task_id,scheduled_for_ms,state,session_id,verdict,failure_kind,started_ms,ended_ms,input_snapshot,confirm_status,replay_of FROM agent_task_runs WHERE task_id=?1 ORDER BY scheduled_for_ms DESC LIMIT ?2").map_err(|e| e.to_string())?;
        let rows = stmt.query_map(params![task_id, limit], |r| Ok(TaskRun {
            id: r.get(0)?, task_id: r.get(1)?, scheduled_for_ms: r.get(2)?, state: r.get(3)?,
            session_id: r.get(4)?, verdict: r.get(5)?, failure_kind: r.get(6)?, started_ms: r.get(7)?, ended_ms: r.get(8)?,
            input_snapshot: r.get(9)?, confirm_status: r.get(10)?, replay_of: r.get(11)?,
        })).map_err(|e| e.to_string())?;
        rows.collect::<Result<_,_>>().map_err(|e| e.to_string())
    }

    /// Side-effecting runs that ended in an unknown terminal state and haven't
    /// been confirmed yet — the human confirmation queue. Owner-scoped via JOIN.
    /// Each entry pairs the run with its task name (the card needs to show WHICH
    /// task is pending; TaskRun itself only carries task_id).
    pub fn confirmation_queue(&self, owner_id: &str) -> Result<Vec<(TaskRun, String)>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT r.id,r.task_id,r.scheduled_for_ms,r.state,r.session_id,r.verdict,r.failure_kind,r.started_ms,r.ended_ms,r.input_snapshot,r.confirm_status,r.replay_of,c.name \
             FROM agent_task_runs r JOIN agent_runs_config c ON c.id = r.task_id \
             WHERE c.owner_id=?1 AND c.side_effects=1 AND r.state='aborted' \
               AND r.failure_kind IN ('watchdog_timeout','orphaned_restart','idle_timeout') \
               AND r.confirm_status IS NULL \
             ORDER BY r.ended_ms DESC").map_err(|e| e.to_string())?;
        let rows = stmt.query_map(params![owner_id], |r| Ok((TaskRun {
            id: r.get(0)?, task_id: r.get(1)?, scheduled_for_ms: r.get(2)?, state: r.get(3)?,
            session_id: r.get(4)?, verdict: r.get(5)?, failure_kind: r.get(6)?, started_ms: r.get(7)?, ended_ms: r.get(8)?,
            input_snapshot: r.get(9)?, confirm_status: r.get(10)?, replay_of: r.get(11)?,
        }, r.get::<_, String>(12)?))).map_err(|e| e.to_string())?;
        rows.collect::<Result<_,_>>().map_err(|e| e.to_string())
    }

    pub fn confirmation_count(&self, owner_id: &str) -> Result<i64, String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT COUNT(*) FROM agent_task_runs r JOIN agent_runs_config c ON c.id = r.task_id \
             WHERE c.owner_id=?1 AND c.side_effects=1 AND r.state='aborted' \
               AND r.failure_kind IN ('watchdog_timeout','orphaned_restart','idle_timeout') AND r.confirm_status IS NULL",
            params![owner_id], |row| row.get(0)).map_err(|e| e.to_string())
    }

    /// Set confirm_status. Bypasses set_run_state's terminal guard on purpose:
    /// mutates an already-aborted row's confirm_status, not its state.
    /// First-writer-wins via WHERE confirm_status IS NULL. The WHERE also pins
    /// the full confirmation-queue predicate (side-effecting + unknown terminal),
    /// so a stray call can't stamp a succeeded/active run and pre-empt a future
    /// timeout from ever entering the queue. Returns true iff this call set it.
    pub fn set_confirm_status(&self, run_id: &str, status: &str) -> Result<bool, String> {
        let conn = self.conn.lock().unwrap();
        let n = conn.execute(
            "UPDATE agent_task_runs SET confirm_status=?2 \
             WHERE id=?1 AND confirm_status IS NULL AND state='aborted' \
               AND failure_kind IN ('watchdog_timeout','orphaned_restart','idle_timeout') \
               AND EXISTS (SELECT 1 FROM agent_runs_config c \
                           WHERE c.id = agent_task_runs.task_id AND c.side_effects=1)",
            params![run_id, status]).map_err(|e| e.to_string())?;
        Ok(n == 1)
    }

    /// Create a new claimed run linked to the original via replay_of, carrying
    /// the ORIGINAL input_snapshot (reproduce that run's input, not current
    /// config). Returns (new_run_id, snapshot_json). Errors if no snapshot.
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

    pub fn task_id_of_run(&self, run_id: &str) -> Result<Option<String>, String> {
        let conn = self.conn.lock().unwrap();
        match conn.query_row("SELECT task_id FROM agent_task_runs WHERE id=?1", params![run_id], |r| r.get(0)) {
            Ok(s) => Ok(Some(s)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    /// True iff run is side-effecting + unknown terminal + confirm_status NULL.
    pub fn is_unconfirmed_side_effect_unknown(&self, run_id: &str) -> Result<bool, String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT COUNT(*) FROM agent_task_runs r JOIN agent_runs_config c ON c.id=r.task_id \
             WHERE r.id=?1 AND c.side_effects=1 AND r.state='aborted' \
               AND r.failure_kind IN ('watchdog_timeout','orphaned_restart','idle_timeout') AND r.confirm_status IS NULL",
            params![run_id], |row| row.get::<_,i64>(0)).map(|n| n > 0).map_err(|e| e.to_string())
    }

    /// Keep the newest `keep` runs per task; delete older rows AND their
    /// ~/.zeromux/runs/<id>/ dir. Runs awaiting confirmation (side-effecting,
    /// unknown terminal, confirm_status IS NULL) are EXEMPT — never dropped
    /// while a human still needs to decide. The exemption is gated on the task
    /// actually being side-effecting (EXISTS on config): a non-side-effecting
    /// task's aborted/unknown runs never enter the queue, so they must remain
    /// prunable rather than accumulate forever.
    pub fn prune_runs(&self, task_id: &str, keep: i64) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        let ids: Vec<String> = {
            let mut stmt = conn.prepare(
                "SELECT r.id FROM agent_task_runs r \
                 WHERE r.task_id=?1 \
                   AND NOT (r.state='aborted' AND r.failure_kind IN ('watchdog_timeout','orphaned_restart','idle_timeout') \
                            AND r.confirm_status IS NULL \
                            AND EXISTS (SELECT 1 FROM agent_runs_config c WHERE c.id=r.task_id AND c.side_effects=1)) \
                   AND r.id NOT IN ( \
                     SELECT id FROM agent_task_runs WHERE task_id=?1 ORDER BY scheduled_for_ms DESC LIMIT ?2 )",
                ).map_err(|e| e.to_string())?;
            let rows = stmt.query_map(params![task_id, keep], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<_,_>>().map_err(|e| e.to_string())?
        };
        for id in &ids {
            let _ = std::fs::remove_dir_all(run_dir(id));
            let _ = conn.execute("DELETE FROM agent_task_runs WHERE id=?1", params![id]);
        }
        Ok(())
    }
}

/// Path to a run's on-disk record dir (~/.zeromux/runs/<run_id>/). Mirrors
/// append_run_event in session_manager.rs — both resolve HOME the same way.
fn run_dir(run_id: &str) -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/home/ubuntu".to_string());
    std::path::Path::new(&home).join(".zeromux").join("runs").join(run_id)
}

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
    if now_ms - last >= idle_timeout_min * 60_000 {
        return Some("idle_timeout");
    }
    if now_ms - started_ms > max_runtime_min * 60_000 {
        return Some("watchdog_timeout");
    }
    None
}

/// Last `max_lines` human-readable text snippets from a run's events.ndjson —
/// the partial output a person uses to judge whether a side effect (PR/push)
/// actually landed before the run was aborted (spec §4.4/§5.1). Pulls prose out
/// of content_block/result/error/system events; raw tool-call JSON is skipped to
/// keep the preview readable. Best-effort: a missing/unreadable file yields an
/// empty Vec, never an error (output capture is best-effort, spec §6.1).
pub fn run_output_tail(run_id: &str, max_lines: usize) -> Vec<String> {
    let path = run_dir(run_id).join("events.ndjson");
    let Ok(content) = std::fs::read_to_string(&path) else { return Vec::new() };
    let mut out: Vec<String> = Vec::new();
    for line in content.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        let snippet = match v.get("type").and_then(|t| t.as_str()) {
            Some("content_block") => v.get("text").and_then(|t| t.as_str()).map(|s| s.to_string()),
            Some("result") => v.get("text").and_then(|t| t.as_str()).map(|s| s.to_string()),
            Some("error") => v.get("message").and_then(|m| m.as_str()).map(|s| format!("[error] {s}")),
            Some("exit") => v.get("code").and_then(|c| c.as_i64()).map(|c| format!("[exit {c}]")),
            _ => None,
        };
        if let Some(s) = snippet {
            let s = s.trim();
            if !s.is_empty() { out.push(s.to_string()); }
        }
    }
    if out.len() > max_lines { out.split_off(out.len() - max_lines) } else { out }
}

use std::sync::atomic::{AtomicI64, Ordering};

/// Spawn the supervised scheduler. The outer task respawns the inner loop if it
/// panics (so a single bad tick can't silently kill scheduling), updates a
/// heartbeat each tick (frontend health), runs a timeout watchdog, and triggers
/// due tasks. last_seen lives in the inner loop; on respawn it resets to now
/// (missed fires during downtime are skipped, matching the no-backfill policy).
pub fn spawn_scheduler(
    mgr: std::sync::Arc<crate::session_manager::SessionManager>,
    store: std::sync::Arc<ScheduledStore>,
    heartbeat: std::sync::Arc<AtomicI64>,
) {
    tokio::spawn(async move {
        loop {
            let m = mgr.clone();
            let s = store.clone();
            let hb = heartbeat.clone();
            let inner = tokio::spawn(async move {
                let mut last_seen = chrono::Utc::now();
                let mut tick = tokio::time::interval(std::time::Duration::from_secs(60));
                loop {
                    tick.tick().await;
                    let now = chrono::Utc::now();
                    hb.store(now.timestamp_millis(), Ordering::Relaxed);
                    // watchdog: abort runs idle past idle_timeout_min (default 60) or
                    // exceeding max_runtime_min total (default 300)
                    let _ = s.reconcile_timeouts_per_task(now.timestamp_millis());
                    // interactive (non-scheduled) wedge protection (review high-leverage
                    // point): sessions silent past INTERACTIVE_IDLE_MS get a TimeoutKill,
                    // so run_metrics records a Timeout instead of the session hanging
                    // forever. Scheduled runs are excluded — reconcile_timeouts_per_task
                    // above already handles them.
                    let stale = m.running_idle_too_long(now.timestamp_millis(), INTERACTIVE_IDLE_MS);
                    for sid in stale {
                        m.send_timeout_kill(&sid, None).await;
                    }
                    let tasks = match s.list_enabled() { Ok(t) => t, Err(_) => { continue; } };
                    // retention: bound run history (rows + on-disk run dirs) per task.
                    // prune_runs exempts pending-confirmation runs, so this never
                    // drops anything still awaiting a human decision.
                    for task in &tasks {
                        let _ = s.prune_runs(&task.id, task.retention_n);
                    }
                    for task in tasks {
                        let fires = match due_fire_points(&task.trigger_spec, last_seen, now) {
                            Ok(f) => f,
                            Err(err) => { tracing::warn!("cron {} bad: {}", task.id, err); continue; }
                        };
                        if let Some(fire) = fires.last() {
                            let active = s.active_states_for_task(&task.id).unwrap_or_default();
                            let active_refs: Vec<&str> = active.iter().map(|x| x.as_str()).collect();
                            if should_skip_overlap(&active_refs) { continue; }
                            let run = TaskRun {
                                id: uuid::Uuid::new_v4().to_string(),
                                task_id: task.id.clone(),
                                scheduled_for_ms: fire.timestamp_millis(),
                                state: "claimed".into(), session_id: None, verdict: None,
                                failure_kind: None, started_ms: Some(now.timestamp_millis()), ended_ms: None,
                                input_snapshot: None, confirm_status: None, replay_of: None,
                            };
                            match s.claim_run(&run) {
                                Ok(true) => {
                                    let nm = format!("{} · {}", task.name,
                                        fire.with_timezone(&Shanghai).format("%H:%M"));
                                    if let Err(err) = m.trigger_run(&run.id, nm, &task.work_dir, &task.owner_id, &task.id, task.prompt.clone()).await {
                                        let _ = s.set_run_state(&run.id, "failed", None, None, Some("spawn_failed"), Some(now.timestamp_millis()));
                                        tracing::warn!("trigger {} failed: {}", task.id, err);
                                    }
                                }
                                _ => {} // not claimed (dup) or error — skip
                            }
                        }
                    }
                    last_seen = now;
                }
            });
            match inner.await {
                Ok(_) => break, // inner returned without panic (shouldn't happen); stop supervising
                Err(_) => {
                    tracing::error!("scheduler loop panicked; reconciling orphans + respawning");
                    let _ = store.reconcile_orphans(None);
                }
            }
        }
    });
}

#[cfg(test)]
mod store_tests {
    use super::*;
    // Return the TempDir guard alongside the store: if we dropped it here the
    // temp directory would be removed before the test writes, and SQLite would
    // fail with "attempt to write a readonly database".
    fn store() -> (ScheduledStore, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let s = ScheduledStore::open(dir.path()).unwrap();
        (s, dir)
    }

    #[test]
    fn claim_is_unique_per_scheduled_for() {
        let (s, _dir) = store();
        let run = TaskRun { id: "r1".into(), task_id: "t1".into(), scheduled_for_ms: 1000,
            state: "claimed".into(), session_id: None, verdict: None, failure_kind: None, started_ms: Some(1), ended_ms: None,
            input_snapshot: None, confirm_status: None, replay_of: None };
        assert!(s.claim_run(&run).unwrap(), "first claim wins");
        let dup = TaskRun { id: "r2".into(), ..run.clone() };
        assert!(!s.claim_run(&dup).unwrap(), "same scheduled_for second claim ignored");
    }

    #[test]
    fn reconcile_marks_orphans_aborted() {
        let (s, _dir) = store();
        s.claim_run(&TaskRun { id:"r1".into(),task_id:"t1".into(),scheduled_for_ms:1,state:"claimed".into(),session_id:None,verdict:None,failure_kind:None,started_ms:Some(1),ended_ms:None,input_snapshot:None,confirm_status:None,replay_of:None }).unwrap();
        assert_eq!(s.reconcile_orphans(None).unwrap(), 1);
        assert!(s.active_states_for_task("t1").unwrap().is_empty());
    }

    #[test]
    fn config_roundtrip_and_owner_filter() {
        let (s, _dir) = store();
        let c = TaskConfig { id:"t1".into(), owner_id:"alice".into(), name:"daily".into(),
            trigger_type:"cron".into(), trigger_spec:"0 0 9 * * *".into(), tz:"Asia/Shanghai".into(),
            agent_type:"claude".into(), work_dir:"/tmp".into(), prompt:"review".into(),
            enabled:true, retention_n:20, created_ms:123, side_effects:false, max_runtime_min:None, idle_timeout_min:None };
        s.upsert_config(&c).unwrap();
        assert_eq!(s.list_for_owner("alice").unwrap().len(), 1);
        assert_eq!(s.list_for_owner("bob").unwrap().len(), 0);
        assert_eq!(s.list_enabled().unwrap().len(), 1);
        assert_eq!(s.get_config("t1").unwrap().unwrap().name, "daily");
    }

    #[test]
    fn run_state_transition_and_history() {
        let (s, _dir) = store();
        let run = TaskRun { id:"r1".into(),task_id:"t1".into(),scheduled_for_ms:1,state:"claimed".into(),session_id:None,verdict:None,failure_kind:None,started_ms:Some(1),ended_ms:None,input_snapshot:None,confirm_status:None,replay_of:None };
        s.claim_run(&run).unwrap();
        s.set_run_state("r1","running",Some("sess1"),None,None,None).unwrap();
        s.set_run_state("r1","succeeded",None,Some("2 issues"),None,Some(99)).unwrap();
        let runs = s.runs_for_task("t1", 10).unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].state, "succeeded");
        assert_eq!(runs[0].session_id.as_deref(), Some("sess1"));
        assert_eq!(runs[0].verdict.as_deref(), Some("2 issues"));
        assert!(s.active_states_for_task("t1").unwrap().is_empty(), "succeeded is not active");
    }

    #[test]
    fn reconcile_stamps_failure_kind() {
        let dir = tempfile::tempdir().unwrap();
        let s = ScheduledStore::open(dir.path()).unwrap();
        let mk = |id: &str, started: i64| TaskRun {
            id: id.into(), task_id: "t1".into(), scheduled_for_ms: started, state: "claimed".into(),
            session_id: None, verdict: None, failure_kind: None, started_ms: Some(started), ended_ms: None,
            input_snapshot: None, confirm_status: None, replay_of: None };
        s.claim_run(&mk("r_old", 1)).unwrap();
        s.set_run_state("r_old", "running", None, None, None, None).unwrap();
        s.claim_run(&mk("r_new", 1_000_000)).unwrap();
        s.set_run_state("r_new", "running", None, None, None, None).unwrap();

        s.reconcile_orphans(Some(100)).unwrap();   // watchdog cutoff=100: only r_old is older
        let old = s.runs_for_task("t1", 10).unwrap().into_iter().find(|r| r.id == "r_old").unwrap();
        let new = s.runs_for_task("t1", 10).unwrap().into_iter().find(|r| r.id == "r_new").unwrap();
        assert_eq!(old.state, "aborted");
        assert_eq!(old.failure_kind.as_deref(), Some("watchdog_timeout"));
        assert!(old.ended_ms.is_some(), "aborted run must carry ended_ms for queue ordering/display");
        assert_eq!(new.state, "running");

        s.reconcile_orphans(None).unwrap();        // startup sweep: remaining running → orphaned_restart
        let new2 = s.runs_for_task("t1", 10).unwrap().into_iter().find(|r| r.id == "r_new").unwrap();
        assert_eq!(new2.state, "aborted");
        assert_eq!(new2.failure_kind.as_deref(), Some("orphaned_restart"));
        assert!(new2.ended_ms.is_some(), "orphaned_restart run must carry ended_ms (Finding A)");
    }

    #[test]
    fn per_task_timeout_respects_max_runtime_min() {
        let _guard = crate::session_manager::HOME_ENV_LOCK.lock().unwrap();
        let prev = std::env::var("HOME").ok();
        let home_tmp = tempfile::tempdir().unwrap();
        std::env::set_var("HOME", home_tmp.path());
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

    #[test]
    fn set_run_state_does_not_overwrite_terminal() {
        let dir = tempfile::tempdir().unwrap();
        let s = ScheduledStore::open(dir.path()).unwrap();
        let run = TaskRun { id: "r1".into(), task_id: "t1".into(), scheduled_for_ms: 1, state: "claimed".into(),
            session_id: None, verdict: None, failure_kind: None, started_ms: Some(1), ended_ms: None,
            input_snapshot: None, confirm_status: None, replay_of: None };
        s.claim_run(&run).unwrap();
        s.set_run_state("r1", "running", Some("sess1"), None, None, None).unwrap();
        s.set_run_state("r1", "aborted", None, None, Some("watchdog_timeout"), Some(50)).unwrap();
        // late finalize tries to flip to succeeded — must be refused
        s.set_run_state("r1", "succeeded", None, Some("done"), None, Some(99)).unwrap();
        let r = s.runs_for_task("t1", 1).unwrap().into_iter().next().unwrap();
        assert_eq!(r.state, "aborted");                           // not overwritten
        assert_eq!(r.failure_kind.as_deref(), Some("watchdog_timeout"));
        assert!(r.verdict.is_none());                             // late verdict not written either
    }

    #[test]
    fn input_snapshot_roundtrips() {
        let dir = tempfile::tempdir().unwrap();
        let s = ScheduledStore::open(dir.path()).unwrap();
        let run = TaskRun { id: "r1".into(), task_id: "t1".into(), scheduled_for_ms: 1, state: "claimed".into(),
            session_id: None, verdict: None, failure_kind: None, started_ms: Some(1), ended_ms: None,
            input_snapshot: None, confirm_status: None, replay_of: None };
        s.claim_run(&run).unwrap();
        let snap = r#"{"prompt":"do x","work_dir":"/home/u/p","agent_type":"claude","secrets":[]}"#;
        s.set_input_snapshot("r1", snap).unwrap();
        let r = s.runs_for_task("t1", 1).unwrap().into_iter().next().unwrap();
        assert_eq!(r.input_snapshot.as_deref(), Some(snap));
    }

    #[test]
    fn confirmation_queue_predicate() {
        let dir = tempfile::tempdir().unwrap();
        let s = ScheduledStore::open(dir.path()).unwrap();
        let mk_cfg = |id: &str, se: bool| TaskConfig {
            id: id.into(), owner_id: "u".into(), name: id.into(), trigger_type: "cron".into(),
            trigger_spec: "0 0 * * * *".into(), tz: "Asia/Shanghai".into(), agent_type: "claude".into(),
            work_dir: ".".into(), prompt: "p".into(), enabled: true, retention_n: 20, created_ms: 1,
            side_effects: se, max_runtime_min: None, idle_timeout_min: None };
        s.upsert_config(&mk_cfg("t_se", true)).unwrap();
        s.upsert_config(&mk_cfg("t_ro", false)).unwrap();
        let mk_run = |id: &str, task: &str| TaskRun { id: id.into(), task_id: task.into(), scheduled_for_ms: 1,
            state: "claimed".into(), session_id: None, verdict: None, failure_kind: None, started_ms: Some(1),
            ended_ms: None, input_snapshot: None, confirm_status: None, replay_of: None };
        s.claim_run(&mk_run("r_se", "t_se")).unwrap();
        s.set_run_state("r_se", "aborted", None, None, Some("watchdog_timeout"), Some(2)).unwrap();
        s.claim_run(&mk_run("r_ro", "t_ro")).unwrap();
        s.set_run_state("r_ro", "aborted", None, None, Some("watchdog_timeout"), Some(2)).unwrap();

        let q = s.confirmation_queue("u").unwrap();
        assert_eq!(q.len(), 1);
        assert_eq!(q[0].0.id, "r_se");
        assert_eq!(q[0].1, "t_se", "queue entry carries its task name (Finding B)");
        assert_eq!(s.confirmation_count("u").unwrap(), 1);

        assert!(s.set_confirm_status("r_se", "confirmed_done").unwrap());  // first writer wins → true
        assert_eq!(s.confirmation_queue("u").unwrap().len(), 0);
        assert_eq!(s.confirmation_count("u").unwrap(), 0);
        let r = s.runs_for_task("t_se", 1).unwrap().into_iter().next().unwrap();
        assert_eq!(r.state, "aborted");                          // confirm didn't change state
        assert_eq!(r.confirm_status.as_deref(), Some("confirmed_done"));
        assert!(!s.set_confirm_status("r_se", "replayed").unwrap()); // already set → false (idempotent guard)
    }

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

    #[test]
    fn replay_creates_linked_row_from_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let s = ScheduledStore::open(dir.path()).unwrap();
        let cfg = TaskConfig { id: "t".into(), owner_id: "u".into(), name: "n".into(), trigger_type: "cron".into(),
            trigger_spec: "0 0 * * * *".into(), tz: "Asia/Shanghai".into(), agent_type: "claude".into(),
            work_dir: ".".into(), prompt: "NEW prompt".into(), enabled: true, retention_n: 20, created_ms: 1,
            side_effects: true, max_runtime_min: None, idle_timeout_min: None };
        s.upsert_config(&cfg).unwrap();
        let run = TaskRun { id: "r_orig".into(), task_id: "t".into(), scheduled_for_ms: 1, state: "claimed".into(),
            session_id: None, verdict: None, failure_kind: None, started_ms: Some(1), ended_ms: None,
            input_snapshot: None, confirm_status: None, replay_of: None };
        s.claim_run(&run).unwrap();
        s.set_input_snapshot("r_orig", r#"{"prompt":"OLD prompt","work_dir":".","agent_type":"claude","secrets":[]}"#).unwrap();
        s.set_run_state("r_orig", "aborted", None, None, Some("watchdog_timeout"), Some(2)).unwrap();

        let (new_id, snap) = s.claim_replay("r_orig").unwrap();
        let new = s.runs_for_task("t", 10).unwrap().into_iter().find(|r| r.id == new_id).unwrap();
        assert_eq!(new.replay_of.as_deref(), Some("r_orig"));
        assert_eq!(new.state, "claimed");
        assert!(snap.contains("OLD prompt"));
        let orig = s.runs_for_task("t", 10).unwrap().into_iter().find(|r| r.id == "r_orig").unwrap();
        assert_eq!(orig.state, "aborted");

        // helpers
        assert_eq!(s.task_id_of_run("r_orig").unwrap().as_deref(), Some("t"));
        assert!(s.task_id_of_run("nope").unwrap().is_none());
        assert!(s.is_unconfirmed_side_effect_unknown("r_orig").unwrap()); // side-effecting + watchdog_timeout + confirm NULL
    }

    #[test]
    fn delete_config_removes_run_rows() {
        // delete_config must not orphan run rows (no FK cascade on this schema).
        let (s, _dir) = store();
        let cfg = TaskConfig { id: "t".into(), owner_id: "u".into(), name: "n".into(), trigger_type: "cron".into(),
            trigger_spec: "0 0 * * * *".into(), tz: "Asia/Shanghai".into(), agent_type: "claude".into(),
            work_dir: ".".into(), prompt: "p".into(), enabled: true, retention_n: 20, created_ms: 1,
            side_effects: false, max_runtime_min: None, idle_timeout_min: None };
        s.upsert_config(&cfg).unwrap();
        let run = TaskRun { id: "r1".into(), task_id: "t".into(), scheduled_for_ms: 1, state: "claimed".into(),
            session_id: None, verdict: None, failure_kind: None, started_ms: Some(1), ended_ms: None,
            input_snapshot: None, confirm_status: None, replay_of: None };
        s.claim_run(&run).unwrap();
        s.set_run_state("r1", "succeeded", None, None, None, Some(2)).unwrap();
        assert_eq!(s.runs_for_task("t", 10).unwrap().len(), 1);
        s.delete_config("t").unwrap();
        assert!(s.get_config("t").unwrap().is_none());
        assert_eq!(s.runs_for_task("t", 10).unwrap().len(), 0, "run rows must not outlive the deleted task");
    }

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

    #[test]
    fn run_output_tail_extracts_readable_text() {
        // HOME is process-global; serialize against the other HOME-mutating tests.
        let _guard = crate::session_manager::HOME_ENV_LOCK.lock().unwrap();
        let prev = std::env::var("HOME").ok();
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("HOME", tmp.path());
        let dir = tmp.path().join(".zeromux/runs/r_tail");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("events.ndjson"),
            "{\"type\":\"system\",\"subtype\":\"task_updated\"}\n\
             {\"type\":\"content_block\",\"block_type\":\"text\",\"text\":\"opening a PR\"}\n\
             {\"type\":\"content_block\",\"block_type\":\"tool_use\",\"name\":\"bash\"}\n\
             {\"type\":\"result\",\"text\":\"PR #42 opened\",\"turn_id\":0,\"session_id\":\"s\"}\n").unwrap();
        let tail = super::run_output_tail("r_tail", 10);
        // restore HOME before assertions so a panic can't leak the tempdir
        match prev { Some(h) => std::env::set_var("HOME", h), None => std::env::remove_var("HOME") }
        assert_eq!(tail, vec!["opening a PR".to_string(), "PR #42 opened".to_string()],
            "tail pulls prose from content_block/result, skips tool_use + system");
        // missing file → empty, never an error (best-effort, spec §6.1)
        assert!(super::run_output_tail("nope_missing", 10).is_empty());
    }
}
