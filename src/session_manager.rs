use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};
use tokio::sync::{broadcast, mpsc};

use crate::events::{CreateEventReq, EventStore};
use crate::session_store::{PersistedSession, SessionStore};

/// Max scrollback buffer size in bytes (2MB of encoded data)
const SCROLLBACK_MAX_BYTES: usize = 2 * 1024 * 1024;

/// Broadcast channel capacity — slow clients that fall behind will get Lagged error
const BROADCAST_CAPACITY: usize = 512;

use crate::acp::kiro_process::KiroProcess;
use crate::acp::process::{AcpEvent, AcpProcess};
use crate::pty_bridge::PtyHandle;

#[derive(Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionMeta {
    Running,
    Done,
    Blocked,
    Idle,
}

impl Default for SessionMeta {
    fn default() -> Self {
        Self::Running
    }
}

impl std::fmt::Display for SessionMeta {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SessionMeta::Running => write!(f, "running"),
            SessionMeta::Done => write!(f, "done"),
            SessionMeta::Blocked => write!(f, "blocked"),
            SessionMeta::Idle => write!(f, "idle"),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionType {
    Tmux,
    Claude,
    Kiro,
    Codex,
}

/// 自动命名器后端：决定 auto-titler 调用哪个 CLI。
#[derive(Debug, Clone, Copy)]
pub enum TitlerBackend { Claude, Kiro, Codex }

impl std::fmt::Display for SessionType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SessionType::Tmux => write!(f, "tmux"),
            SessionType::Claude => write!(f, "claude"),
            SessionType::Kiro => write!(f, "kiro"),
            SessionType::Codex => write!(f, "codex"),
        }
    }
}

impl SessionType {
    /// 从持久化字符串还原；未知值回落 Tmux（最保守，PTY 无 resume 副作用）。
    pub fn from_str_lenient(s: &str) -> Self {
        match s {
            "claude" => SessionType::Claude,
            "kiro" => SessionType::Kiro,
            "codex" => SessionType::Codex,
            _ => SessionType::Tmux,
        }
    }
}

/// 跨进程恢复会话上下文的令牌，按后端区分。持久化为 (kind, value) 两列。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResumeToken {
    Claude(String), // --resume <session_id>
    Kiro(String),   // session/load <sessionId>
    Codex(String),  // codex-reply threadId
    Tmux(String),   // tmux attach -t <target>
}

impl ResumeToken {
    /// 拆成持久化用的 (kind, value)。
    pub fn to_kind_value(&self) -> (&'static str, String) {
        match self {
            ResumeToken::Claude(v) => ("claude", v.clone()),
            ResumeToken::Kiro(v) => ("kiro", v.clone()),
            ResumeToken::Codex(v) => ("codex", v.clone()),
            ResumeToken::Tmux(v) => ("tmux", v.clone()),
        }
    }

    /// 从持久化的 (kind, value) 还原。未知 kind 返回 None。
    pub fn from_kind_value(kind: &str, value: &str) -> Option<Self> {
        match kind {
            "claude" => Some(ResumeToken::Claude(value.to_string())),
            "kiro" => Some(ResumeToken::Kiro(value.to_string())),
            "codex" => Some(ResumeToken::Codex(value.to_string())),
            "tmux" => Some(ResumeToken::Tmux(value.to_string())),
            _ => None,
        }
    }
}

/// Input commands from WS clients to the session process
pub enum SessionInput {
    /// PTY: raw bytes (base64-decoded by WS handler)
    PtyData(Vec<u8>),
    /// PTY: resize
    PtyResize(u16, u16),
    /// ACP/Kiro: prompt text + optional scheduled-run id for exactly-once
    /// finalization (None for manual user prompts). `client_id` is the optional
    /// browser-generated id used to dedupe the optimistic user bubble against the
    /// server echo (G3, T1); None for scheduled runs.
    Prompt { text: String, run_id: Option<String>, client_id: Option<String> },
    /// ACP/Kiro: cancel/kill
    Cancel,
    /// ACP/Kiro: turn-level interrupt (abort current turn, keep process alive)
    Interrupt,
    /// ACP/Kiro/Codex: switch the per-session queue handling mode for
    /// multiple in-flight prompts (collect / interrupt / passthrough).
    SetQueueMode(QueueMode),
    /// Watchdog→fan-out: 超时终结当前 run。让超时和完成/错/取消一样从 fan-out
    /// 单一出口走,run_metrics 与 finalize_run 天然一致(评审 P0)。
    TimeoutKill { run_id: Option<String> },
}

/// How a fan-out handles a new prompt that arrives while a turn is running.
/// Per-session, switchable from the UI (G2b). Default Collect (debounce-merge).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QueueMode {
    /// Debounce-merge appended prompts into one follow-up turn (existing behavior).
    Collect,
    /// Interrupt the running turn and immediately send the new prompt.
    Interrupt,
    /// Send the new prompt immediately without interrupting (concurrent turns).
    Passthrough,
}

impl QueueMode {
    pub fn from_str(s: &str) -> Self {
        match s {
            "interrupt" => QueueMode::Interrupt,
            "passthrough" => QueueMode::Passthrough,
            _ => QueueMode::Collect,
        }
    }

    /// Passthrough cannot work under the current single-`turn_seq` /
    /// `boundary_count` fan-out machinery on ANY backend:
    /// - Codex (codex_process.rs): drops a prompt that arrives mid-turn, so the
    ///   2nd prompt is lost AND `turn_seq` was already bumped → `boundary_count`
    ///   can never catch up → the session wedges in Running ("thinking…") forever.
    /// - Claude/Kiro: the single `turn_seq` stamps the still-streaming prior
    ///   turn's trailing ContentBlocks with the new turn's id → mis-grouping.
    /// So Passthrough degrades to Collect everywhere (review 2026-06-11). The UI
    /// no longer offers it; this is the server-side backstop for a stale client
    /// or a direct WS sending `passthrough`. `Interrupt` and `Collect` are sound.
    fn effective(self) -> QueueMode {
        if self == QueueMode::Passthrough { QueueMode::Collect } else { self }
    }
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum TurnState { Idle, Running }

/// 自动更新 idle-gate 用:区分交互 turn 与调度运行。见 auto_update.rs。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct RunningSummary {
    /// 交互 agent 会话(无 source_task)当前 turn 为 Running 的数量。
    pub interactive: usize,
    /// in-flight 调度 run 计数(调度库 `claimed`/`running`)。这是「调度 agent 进程
    /// 在 cgroup 内存活」的权威信号,前闭 spawn 窗口、后随 run 终态释放;绝不强制
    /// 升级穿透它(评审 E1)。见 `running_summary`。
    pub scheduled: usize,
}

/// 一个会话的运行态：仅当进程存活时存在。fan-out 任务独占其中的进程句柄
/// （通过 channel）。Drop 此结构 → channel 关闭 → fan-out 退出 → 进程死。
struct RunningProcess {
    /// Broadcast channel: fan-out task writes, all WS clients subscribe
    event_tx: broadcast::Sender<String>,
    /// Input channel: any WS client writes, fan-out task forwards to process
    input_tx: mpsc::Sender<SessionInput>,
    /// PTY child PID kept for /proc lookup (PTY sessions only)
    pty_pid: Option<u32>,
    turn_state: TurnState,
    turn_started_ms: Option<i64>,
    turn_seq: u64,
}

fn now_millis() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub struct Session {
    pub id: String,
    pub name: String,
    pub session_type: SessionType,
    pub cols: u16,
    pub rows: u16,
    pub work_dir: String,
    pub owner_id: String,
    pub description: String,
    /// true = 名字是占位名/自动命名,可被 auto-titler 覆盖;
    /// false = 用户已手动改名(或已自动命名一次),永不再自动命名。
    pub name_is_auto: bool,
    pub status: SessionMeta,
    resume_token: Option<ResumeToken>,
    /// Git worktree path for ACP sessions (cleaned up on delete)
    worktree_path: Option<PathBuf>,
    created_ms: i64,
    /// Set for sessions auto-created by a scheduled task; None for manual ones.
    source_task_id: Option<String>,
    /// 并发重生互斥（仅锁内访问）。
    spawning: bool,
    last_activity_ms: i64,
    turns_completed: u32,
    /// 本会话最近的 per-run 度量历史(cap 50, GC 30d)。进程死后仍保留供重连查看。
    run_metrics: std::collections::VecDeque<crate::run_metrics::RunMetric>,
    /// 会话级单调累计(不受 run_metrics cap-50 截断;三维度同源,统一在
    /// record_run_metric 累加,含后台调度运行)。
    lifetime_turns: u64,
    lifetime_duration_ms: i64,
    lifetime_cost_usd: f64,
    /// 运行态；None = 未运行（可按 resume_token 重生）。
    running: Option<RunningProcess>,
    /// Output history for replay on reconnect (base64 for PTY, JSON for ACP/Kiro)
    scrollback: VecDeque<String>,
    scrollback_bytes: usize,
}

pub struct SessionManager {
    sessions: Mutex<HashMap<String, Session>>,
    /// Shared event store — agent fan-out tasks auto-log a `task_done` event
    /// here when their process emits an `AcpEvent::Result`.
    events: Arc<EventStore>,
    /// Persistent session metadata store (SQLite). Always open.
    store: Arc<SessionStore>,
    /// Self-reference so fan-out tasks can call back without an Arc cycle.
    self_weak: Mutex<Weak<SessionManager>>,
    /// Spawn config captured at construction so `ensure_running` can respawn a
    /// session without re-receiving CLI paths (it only has the session id +
    /// stored metadata). `create_*` still take the path as a param and forward
    /// it to the `spawn_<kind>` helper.
    claude_path: String,
    kiro_path: String,
    codex_path: String,
    codex_reasoning: String,
    shell: String,
    /// Whether agent sessions get an isolated git worktree. Off by default —
    /// `git worktree add` is prohibitively slow on JuiceFS / S3-backed FS.
    worktree_isolation: bool,
    /// Scheduled-tasks store, set at startup after construction. Fan-out tasks
    /// use it to finalize scheduled runs. None when no scheduler is wired.
    scheduled: Mutex<Option<Arc<crate::scheduled_tasks::ScheduledStore>>>,
    /// Push notification service, wired at startup. None when push is disabled
    /// (VAPID key generation failed or no subscriptions configured).
    push: Mutex<Option<Arc<crate::push::PushService>>>,
    /// Per-run metrics writer channel. `record_run_metric` pushes into the
    /// session's in-memory VecDeque (under lock) and then `try_send`s here
    /// (outside the lock) so the async writer fsyncs off the conversation path.
    run_metrics_tx: tokio::sync::mpsc::Sender<crate::run_metrics::RunMetric>,
}

#[derive(serde::Serialize)]
pub struct SessionInfo {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub session_type: SessionType,
    pub cols: u16,
    pub rows: u16,
    pub work_dir: String,
    pub description: String,
    pub status: SessionMeta,
    pub running: bool,
    pub turn_state: Option<&'static str>,
    pub turn_started_ms: Option<i64>,
    pub last_activity_ms: i64,
    pub turns_completed: u32,
    pub source_task_id: Option<String>,
}

// ── Git worktree helpers ──

/// Check if a directory is inside a git repo
fn is_git_repo(dir: &Path) -> bool {
    std::process::Command::new("git")
        .args(["rev-parse", "--git-dir"])
        .current_dir(dir)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Create a git worktree. Returns the worktree path on success.
fn create_worktree(repo_dir: &Path, session_id: &str) -> Result<PathBuf, String> {
    let worktrees_dir = repo_dir.join(".zeromux-worktrees");
    std::fs::create_dir_all(&worktrees_dir)
        .map_err(|e| format!("Failed to create worktrees dir: {}", e))?;

    let short_id = &session_id[..8.min(session_id.len())];
    let wt_path = worktrees_dir.join(short_id);

    let output = std::process::Command::new("git")
        .args(["worktree", "add", "--detach"])
        .arg(&wt_path)
        .current_dir(repo_dir)
        .output()
        .map_err(|e| format!("Failed to run git worktree add: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git worktree add failed: {}", stderr));
    }

    tracing::info!("Created git worktree at {}", wt_path.display());
    Ok(wt_path)
}

/// Remove a git worktree
fn remove_worktree(repo_dir: &Path, wt_path: &Path) {
    let result = std::process::Command::new("git")
        .args(["worktree", "remove", "--force"])
        .arg(wt_path)
        .current_dir(repo_dir)
        .output();

    match result {
        Ok(output) if output.status.success() => {
            tracing::info!("Removed git worktree at {}", wt_path.display());
        }
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            tracing::warn!("git worktree remove failed: {}", stderr);
            let _ = std::fs::remove_dir_all(wt_path);
        }
        Err(e) => {
            tracing::warn!("Failed to run git worktree remove: {}", e);
            let _ = std::fs::remove_dir_all(wt_path);
        }
    }
}

/// Resolve the effective work directory: create a worktree if inside a git repo,
/// otherwise return the original path.
/// Security: a work_dir must canonicalize to a path under HOME. The HTTP layer
/// checks this at task create/update, but scheduled runs spawn long after that:
/// pre-existing DB rows (written before the check existed) and TOCTOU symlink
/// swaps both bypass the create-time gate. This is the last gate before a real
/// process + git worktree land on disk, so it must re-validate the stored path.
///
/// Returns the *canonical* path on success. The caller MUST spawn from this
/// returned path, not from the raw `work_dir` string: validating a canonicalized
/// copy while spawning from the unresolved string reopens the very TOCTOU this
/// gate closes (a symlink component swapped between canonicalize() here and the
/// later `PathBuf::from(work_dir)` in resolve_work_dir would escape HOME).
fn work_dir_under_home(work_dir: &str) -> Result<PathBuf, String> {
    let canonical = Path::new(work_dir)
        .canonicalize()
        .map_err(|e| format!("invalid work_dir {work_dir}: {e}"))?;
    let home = std::env::var("HOME").unwrap_or_else(|_| "/home/ubuntu".to_string());
    let home_path = Path::new(&home)
        .canonicalize()
        .map_err(|e| format!("home dir error: {e}"))?;
    if !canonical.starts_with(&home_path) {
        return Err(format!("work_dir must be under home directory: {work_dir}"));
    }
    Ok(canonical)
}

fn resolve_work_dir(work_dir: &str, session_id: &str, isolation: bool) -> (PathBuf, Option<PathBuf>) {
    let base = if work_dir == "." {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
    } else {
        PathBuf::from(work_dir)
    };

    // Worktree isolation is opt-in: on JuiceFS / S3-backed filesystems a single
    // `git worktree add` checks out the whole tree over high-latency FUSE round
    // trips (~24s here), which is the dominant New Session latency. When off,
    // agent sessions run directly in the base dir (like tmux already does).
    if isolation && is_git_repo(&base) {
        match create_worktree(&base, session_id) {
            Ok(wt_path) => (wt_path.clone(), Some(wt_path)),
            Err(e) => {
                tracing::warn!("Worktree creation failed, using base dir: {}", e);
                (base, None)
            }
        }
    } else {
        (base, None)
    }
}

/// What `ensure_running` should do for one session, decided under the lock.
struct SpawnPlan {
    stype: SessionType,
    resume_token: Option<ResumeToken>,
    work_dir: String,
    owner_id: String,
    cols: u16,
    rows: u16,
}

enum SpawnDecision {
    /// Live process already present — nothing to do.
    AlreadyRunning,
    /// Another caller holds `spawning` — poll until it finishes.
    Wait,
    /// This caller claimed `spawning` (now set true) — spawn per the plan.
    Spawn(SpawnPlan),
}

/// Resets `spawning=false` if dropped before being disarmed — covers the case
/// where the `ensure_running` future is cancelled (WS dropped) mid-spawn, which
/// would otherwise leave the session permanently stuck in `spawning=true`.
struct SpawningGuard {
    mgr: Weak<SessionManager>,
    id: String,
    armed: bool,
}

impl Drop for SpawningGuard {
    fn drop(&mut self) {
        if self.armed {
            if let Some(mgr) = self.mgr.upgrade() {
                if let Some(s) = mgr.sessions.lock().unwrap().get_mut(&self.id) {
                    s.spawning = false;
                }
            }
        }
    }
}

/// Pure phase-1 decision for `ensure_running`. Mutates only `spawning` (sets it
/// true on the `Spawn` path so a concurrent caller sees `Wait`). Kept free of
/// any spawning/IO so it is unit-testable without real CLI processes.
fn decide_spawn(s: &mut Session) -> SpawnDecision {
    if s.running.is_some() {
        SpawnDecision::AlreadyRunning
    } else if s.spawning {
        SpawnDecision::Wait
    } else {
        s.spawning = true;
        SpawnDecision::Spawn(SpawnPlan {
            stype: s.session_type,
            resume_token: s.resume_token.clone(),
            work_dir: s.work_dir.clone(),
            owner_id: s.owner_id.clone(),
            cols: s.cols,
            rows: s.rows,
        })
    }
}

/// turn 边界状态变更（纯函数，便于单测）。Running 置 started_ms 并采纳新 seq；
/// Idle 仅当 seq 与当前一致才生效（忽略被中断旧 turn 的迟到事件）并 +1 完成计数。
fn apply_turn(session: &mut Session, state: TurnState, seq: u64) {
    let now = now_millis();
    session.last_activity_ms = now;
    if let Some(rp) = session.running.as_mut() {
        match state {
            TurnState::Running => {
                rp.turn_state = TurnState::Running;
                rp.turn_started_ms = Some(now);
                rp.turn_seq = seq;
            }
            TurnState::Idle => {
                // Idempotent: a single turn can emit two boundaries (Claude
                // Error+Exit, Codex Error+Result), both of which now settle with
                // the live turn_seq. Only the first (Running→Idle) transition
                // counts a completed turn; a repeat Idle at the same seq must not
                // double-increment turns_completed.
                if rp.turn_seq == seq && rp.turn_state != TurnState::Idle {
                    rp.turn_state = TurnState::Idle;
                    rp.turn_started_ms = None;
                    session.turns_completed = session.turns_completed.wrapping_add(1);
                }
            }
        }
    }
}

/// 应用 meta 改动到内存 Session，返回需落盘的 (name, description)。纯函数，便于单测。
fn apply_meta(
    session: &mut Session,
    name: Option<String>,
    description: Option<String>,
    status: Option<SessionMeta>,
) -> (Option<String>, Option<String>) {
    let mut pn = None;
    let mut pd = None;
    if let Some(n) = name {
        session.name = n.clone();
        pn = Some(n);
    }
    if let Some(d) = description {
        session.description = d.clone();
        pd = Some(d);
    }
    if let Some(s) = status {
        session.status = s;
    }
    (pn, pd)
}

fn session_info_of(s: &Session) -> SessionInfo {
    SessionInfo {
        id: s.id.clone(),
        name: s.name.clone(),
        session_type: s.session_type,
        cols: s.cols,
        rows: s.rows,
        work_dir: s.work_dir.clone(),
        description: s.description.clone(),
        status: s.status,
        running: s.running.is_some(),
        turn_state: s.running.as_ref().map(|rp| match rp.turn_state {
            TurnState::Idle => "idle",
            TurnState::Running => "running",
        }),
        turn_started_ms: s.running.as_ref().and_then(|rp| rp.turn_started_ms),
        last_activity_ms: s.last_activity_ms,
        turns_completed: s.turns_completed,
        source_task_id: s.source_task_id.clone(),
    }
}

impl SessionManager {
    pub fn new(
        events: Arc<EventStore>,
        store: Arc<SessionStore>,
        claude_path: String,
        kiro_path: String,
        codex_path: String,
        codex_reasoning: String,
        shell: String,
        worktree_isolation: bool,
    ) -> Arc<Self> {
        let mgr = Arc::new(Self {
            sessions: Mutex::new(HashMap::new()),
            events,
            store,
            self_weak: Mutex::new(Weak::new()),
            claude_path,
            kiro_path,
            codex_path,
            codex_reasoning,
            shell,
            worktree_isolation,
            scheduled: Mutex::new(None),
            push: Mutex::new(None),
            run_metrics_tx: crate::run_metrics::spawn_writer(),
        });
        *mgr.self_weak.lock().unwrap() = Arc::downgrade(&mgr);
        mgr
    }

    fn weak(&self) -> Weak<SessionManager> {
        self.self_weak.lock().unwrap().clone()
    }

    /// Wire the scheduled-tasks store (called once at startup).
    pub fn set_scheduled_store(&self, store: Arc<crate::scheduled_tasks::ScheduledStore>) {
        *self.scheduled.lock().unwrap() = Some(store);
    }

    /// Wire push notification service (called once at startup). None = disabled.
    pub fn set_push(&self, p: Arc<crate::push::PushService>) {
        *self.push.lock().unwrap() = Some(p);
    }

    /// Clone push handle (lock-in / lock-out pattern): acquire lock, clone Arc, release lock.
    /// Never hold the lock across an await.
    fn push_handle(&self) -> Option<Arc<crate::push::PushService>> {
        self.push.lock().unwrap().clone()
    }

    /// Look up a session's display name. Returns None if the session doesn't exist.
    pub fn session_name(&self, id: &str) -> Option<String> {
        self.sessions.lock().unwrap().get(id).map(|s| s.name.clone())
    }

    /// True iff the session currently has an in-flight turn (turn_state ==
    /// Running). Used by the ACP WS replay to tell a reconnecting client whether
    /// the turn it's rejoining is still live, so the frontend doesn't clobber its
    /// busy indicator (and the interrupt affordance) to false on `replay_done`
    /// for a turn that is still running but momentarily silent.
    pub fn turn_is_running(&self, id: &str) -> bool {
        self.sessions
            .lock()
            .unwrap()
            .get(id)
            .and_then(|s| s.running.as_ref())
            .map(|rp| rp.turn_state == TurnState::Running)
            .unwrap_or(false)
    }

    /// Authoritative last-activity timestamp (epoch ms) for a session — the same
    /// value the idle/stuck watchdogs use. Sent in `replay_done` so a reconnecting
    /// client can seed its silence baseline from the REAL accumulated silence
    /// rather than "now": the `stuck` heuristic (and thus the 中断 button, which is
    /// gated on `stuck`) must reflect true agent silence immediately after a
    /// mid-turn reconnect, not restart a fresh 180s window each time the socket
    /// drops. `None` if the session is unknown.
    pub fn last_activity_ms(&self, id: &str) -> Option<i64> {
        self.sessions.lock().unwrap().get(id).map(|s| s.last_activity_ms)
    }

    /// Finalize a scheduled run exactly once (called by the agent fan-out on the
    /// terminal event for that run). No-op if no scheduled store is wired.
    pub fn finalize_run(&self, run_id: &str, state: &str, verdict: Option<&str>, failure_kind: Option<&str>) {
        let store = { self.scheduled.lock().unwrap().clone() };
        if let Some(store) = store {
            if let Err(e) = store.set_run_state(run_id, state, None, verdict, failure_kind, Some(now_millis())) {
                tracing::warn!("finalize_run {} failed: {}", run_id, e);
            }
        }
    }

    /// Record one per-run metric: push into the session's bounded in-memory ring
    /// (cap 50) under the sessions lock, then — outside the lock — `try_send` to
    /// the async writer. No I/O is done while the lock is held; a full writer
    /// queue is best-effort dropped (metrics are advisory, not load-bearing).
    pub fn record_run_metric(&self, sid: &str, m: crate::run_metrics::RunMetric) {
        {
            let mut map = self.sessions.lock().unwrap();
            if let Some(s) = map.get_mut(sid) {
                s.run_metrics.push_back(m.clone());
                while s.run_metrics.len() > 50 {
                    s.run_metrics.pop_front();
                }
                s.lifetime_turns += 1;
                s.lifetime_duration_ms += m.duration_ms;
                s.lifetime_cost_usd += m.cost_usd.unwrap_or(0.0);
            }
        } // lock released before any send
        let _ = self.run_metrics_tx.try_send(m);
    }

    /// Owner-scoped read of a session's run history. Returns `None` if the
    /// session is missing OR the caller is not the owner (don't leak existence).
    /// Stats are computed over the FULL history; `before_ms`/`limit` only shape
    /// the returned page (newest-first).
    pub fn runs_for_session(
        &self,
        sid: &str,
        owner_id: &str,
        limit: Option<usize>,
        before_ms: Option<i64>,
    ) -> Option<(Vec<crate::run_metrics::RunMetric>, crate::run_metrics::SessionRunStats)> {
        let map = self.sessions.lock().unwrap();
        let s = map.get(sid)?;
        if s.owner_id != owner_id {
            return None;
        }
        let stats = crate::run_metrics::compute_stats(&s.run_metrics);
        let mut runs: Vec<_> = s
            .run_metrics
            .iter()
            .filter(|r| before_ms.map(|b| r.ended_ms < b).unwrap_or(true))
            .cloned()
            .collect();
        runs.reverse(); // newest first
        if let Some(n) = limit {
            runs.truncate(n);
        }
        Some((runs, stats))
    }

    /// 会话级累计 (turns, duration_ms, cost_usd)。owner 校验留给调用方/上层端点。
    pub fn session_lifetime(&self, sid: &str) -> Option<(u64, i64, f64)> {
        let map = self.sessions.lock().unwrap();
        let s = map.get(sid)?;
        Some((s.lifetime_turns, s.lifetime_duration_ms, s.lifetime_cost_usd))
    }

    /// Owner-scoped set of a human 👍/👎 verdict on one run. Returns `false` if
    /// the session is missing, owner mismatches, or the run_id is not found.
    /// Note: only the in-memory VecDeque is updated; rewriting the persisted
    /// ndjson history is a documented future seam (MVP does not touch disk).
    pub fn set_human_verdict(&self, sid: &str, owner_id: &str, run_id: &str, verdict: &str) -> bool {
        let mut map = self.sessions.lock().unwrap();
        let Some(s) = map.get_mut(sid) else {
            return false;
        };
        if s.owner_id != owner_id {
            return false;
        }
        if let Some(r) = s.run_metrics.iter_mut().find(|r| r.run_id == run_id) {
            r.verdict = Some(verdict.to_string());
            r.verdict_source = crate::run_metrics::VerdictSource::Human;
            return true;
        }
        false
    }

    /// Watchdog: find *interactive* sessions (no `source_task_id`) that are
    /// Running and have emitted no event for at least `idle_ms` — true silence
    /// detection. `last_activity_ms` is bumped on every persisted event in
    /// `record_and_broadcast`, so an actively-streaming long turn is NOT killed;
    /// only a genuinely silent (wedged) one is.
    /// Scheduled runs (`source_task_id.is_some()`) are excluded — they have their
    /// own reconcile path in scheduled_tasks.rs and must not be double-handled.
    /// Pure filter over the in-memory map; the caller sends TimeoutKill.
    pub fn running_idle_too_long(&self, now_ms: i64, idle_ms: i64) -> Vec<String> {
        let map = self.sessions.lock().unwrap();
        map.values()
            .filter(|s| s.source_task_id.is_none())
            .filter(|s| s.running.as_ref().map(|rp| rp.turn_state == TurnState::Running).unwrap_or(false))
            .filter(|s| now_ms - s.last_activity_ms >= idle_ms)
            .map(|s| s.id.clone())
            .collect()
    }

    /// Candidates for a stuck-push: interactive (non-scheduled) sessions whose
    /// current turn is Running but silent for >= idle_ms. Returns
    /// (session_id, owner_id, name) so the caller can push without re-locking.
    /// Mirrors running_idle_too_long's filter; that one kills, this one notifies.
    pub fn stuck_push_candidates(&self, now_ms: i64, idle_ms: i64) -> Vec<(String, String, String)> {
        let map = self.sessions.lock().unwrap();
        map.values()
            .filter(|s| s.source_task_id.is_none())
            .filter(|s| s.running.as_ref().map(|rp| rp.turn_state == TurnState::Running).unwrap_or(false))
            .filter(|s| now_ms - s.last_activity_ms >= idle_ms)
            .map(|s| (s.id.clone(), s.owner_id.clone(), s.name.clone()))
            .collect()
    }

    /// Send a `TimeoutKill` to a session's fan-out so a silent/wedged run is
    /// terminated through the single fan-out exit (→ recorded as a Timeout metric,
    /// consistent with normal finalize). Clone the `input_tx` under the lock, then
    /// `.send()` outside it — never hold the sessions lock across an await.
    pub async fn send_timeout_kill(&self, sid: &str, run_id: Option<String>) {
        let tx = {
            let map = self.sessions.lock().unwrap();
            map.get(sid).and_then(|s| s.running.as_ref().map(|rp| rp.input_tx.clone()))
        };
        if let Some(tx) = tx {
            let _ = tx.send(SessionInput::TimeoutKill { run_id }).await;
        }
    }

    /// Persist a session's metadata to the store (insert or update).
    fn persist_meta(&self, s: &Session) {
        let pj = PersistedSession {
            id: s.id.clone(),
            name: s.name.clone(),
            session_type: s.session_type,
            work_dir: s.work_dir.clone(),
            owner_id: s.owner_id.clone(),
            description: s.description.clone(),
            resume_token: s.resume_token.clone(),
            worktree_path: s.worktree_path.as_ref().map(|p| p.to_string_lossy().to_string()),
            created_ms: s.created_ms,
            source_task_id: s.source_task_id.clone(),
            name_is_auto: s.name_is_auto,
        };
        if let Err(e) = self.store.upsert(&pj) {
            tracing::warn!("persist session {} failed: {}", s.id, e);
        }
    }

    /// Spawn a tmux/PTY process for `id` rooted at `work_dir`, start its fan-out
    /// task, and return the live handle. `target` Some → `tmux attach -t <target>`
    /// (restart-survival via existing tmux server), None → plain `self.shell`.
    /// Shared by `create_pty_session` and `ensure_running`.
    fn spawn_tmux(
        &self,
        id: &str,
        work_dir: &str,
        cols: u16,
        rows: u16,
        target: Option<&str>,
    ) -> Result<RunningProcess, String> {
        let cwd = if work_dir.is_empty() || work_dir == "." {
            None
        } else {
            Some(work_dir)
        };
        let (cmd, args): (&str, Vec<&str>) = if let Some(target) = target {
            ("tmux", vec!["attach", "-t", target])
        } else {
            (self.shell.as_str(), vec![])
        };
        let (pty, mut output_rx) = PtyHandle::spawn(cmd, &args, &[], cols, rows, cwd)
            .map_err(|e| format!("Failed to spawn PTY: {}", e))?;

        let (event_tx, _) = broadcast::channel(BROADCAST_CAPACITY);
        let (input_tx, mut input_rx) = mpsc::channel::<SessionInput>(64);

        let pid = pty.pid();
        let event_tx_clone = event_tx.clone();
        let sid = id.to_string();
        let mgr_weak = self.weak();
        let sid_for_exit = id.to_string();

        // Spawn fan-out task: owns the PtyHandle, reads output, handles input
        tokio::spawn(async move {
            let mut pty = pty; // move pty into task
            loop {
                tokio::select! {
                    data = output_rx.recv() => {
                        match data {
                            Some(bytes) => {
                                let b64 = base64::Engine::encode(
                                    &base64::engine::general_purpose::STANDARD, &bytes);
                                // Sole scrollback writer — mirror the ACP fan-out (emit →
                                // record_and_broadcast). Persist ONCE here, independent of
                                // subscribers, then broadcast under the same lock. The PTY WS
                                // handler MUST NOT also push_scrollback: per-connection writes
                                // duplicated scrollback N× under multi-client (evicting the 2MB
                                // ring N× faster → corrupted replay) and lost output entirely
                                // when zero clients were attached (broadcast Err dropped, nothing
                                // persisted) — the D2 anti-pattern the ACP handler forbids.
                                // Bumping last_activity_ms is benign: PTY sessions never enter
                                // TurnState::Running, so both turn watchdogs skip them.
                                if let Some(m) = mgr_weak.upgrade() {
                                    m.record_and_broadcast(&sid, b64);
                                } else {
                                    let _ = event_tx_clone.send(b64); // manager gone: best-effort
                                }
                            }
                            None => {
                                tracing::info!("PTY output closed for session {}", sid);
                                break;
                            }
                        }
                    }
                    input = input_rx.recv() => {
                        match input {
                            Some(SessionInput::PtyData(bytes)) => {
                                let _ = pty.write_input(&bytes);
                            }
                            Some(SessionInput::PtyResize(cols, rows)) => {
                                let _ = pty.resize(cols, rows);
                            }
                            None => break,
                            _ => {}
                        }
                    }
                }
            }
            // Fan-out exiting: keep session metadata, clear running state so it
            // can be respawned from its resume_token (Task 5+).
            mark_fanout_ended(&mgr_weak, &sid_for_exit);
        });

        Ok(RunningProcess {
            event_tx,
            input_tx,
            pty_pid: pid,
            turn_state: TurnState::Idle,
            turn_started_ms: None,
            turn_seq: 0,
        })
    }

    pub fn create_pty_session(
        &self,
        name: String,
        _shell: &str,
        work_dir: &str,
        cols: u16,
        rows: u16,
        owner_id: &str,
        tmux_target: Option<&str>,
    ) -> Result<String, String> {
        let effective_dir = if work_dir.is_empty() || work_dir == "." {
            std::env::current_dir().unwrap_or_default().to_string_lossy().to_string()
        } else {
            work_dir.to_string()
        };

        let id = uuid::Uuid::new_v4().to_string();

        let running = self.spawn_tmux(&id, work_dir, cols, rows, tmux_target)?;

        let session = Session {
            id: id.clone(),
            name,
            session_type: SessionType::Tmux,
            cols,
            rows,
            work_dir: effective_dir,
            owner_id: owner_id.to_string(),
            description: String::new(),
            name_is_auto: true,
            status: SessionMeta::Running,
            resume_token: tmux_target.map(|t| ResumeToken::Tmux(t.to_string())),
            worktree_path: None,
            created_ms: now_millis(),
            source_task_id: None,
            spawning: false,
            last_activity_ms: now_millis(),
            turns_completed: 0,
            run_metrics: VecDeque::new(),
            lifetime_turns: 0,
            lifetime_duration_ms: 0,
            lifetime_cost_usd: 0.0,
            running: Some(running),
            scrollback: VecDeque::new(),
            scrollback_bytes: 0,
        };

        self.persist_meta(&session);
        self.sessions.lock().unwrap().insert(id.clone(), session);
        Ok(id)
    }

    /// Spawn a Claude (ACP) process for `id` at `work_dir`, start its fan-out,
    /// and return the live handle. `_resume` is unused in Task 5 (always fresh);
    /// Task 6 wires `--resume`. Worktree creation/cleanup stays with the caller.
    async fn spawn_claude(
        &self,
        id: &str,
        work_dir: &str,
        owner_id: &str,
        resume: Option<&str>,
    ) -> Result<RunningProcess, String> {
        let process = AcpProcess::spawn(&self.claude_path, work_dir, resume)
            .await
            .map_err(|e| format!("Failed to spawn Claude: {}", e))?;

        let (event_tx, _) = broadcast::channel(BROADCAST_CAPACITY);
        let (input_tx, input_rx) = mpsc::channel::<SessionInput>(64);

        spawn_acp_fanout(
            id.to_string(),
            process,
            event_tx.clone(),
            input_rx,
            self.events.clone(),
            "claude-code",
            resume.is_some(),
            work_dir.to_string(),
            owner_id.to_string(),
            self.weak(),
        );

        Ok(RunningProcess {
            event_tx,
            input_tx,
            pty_pid: None,
            turn_state: TurnState::Idle,
            turn_started_ms: None,
            turn_seq: 0,
        })
    }

    pub async fn create_acp_session(
        &self,
        name: String,
        _claude_path: &str,
        work_dir: &str,
        cols: u16,
        rows: u16,
        owner_id: &str,
    ) -> Result<String, String> {
        self.create_acp_session_tagged(name, work_dir, cols, rows, owner_id, None)
            .await
    }

    /// Like `create_acp_session` but tags the session with an optional
    /// `source_task_id` (set for scheduled-task runs so the fan-out can finalize
    /// the run when the turn completes).
    pub async fn create_acp_session_tagged(
        &self,
        name: String,
        work_dir: &str,
        cols: u16,
        rows: u16,
        owner_id: &str,
        source_task_id: Option<String>,
    ) -> Result<String, String> {
        let id = uuid::Uuid::new_v4().to_string();
        let (effective_dir, worktree_path) = resolve_work_dir(work_dir, &id, self.worktree_isolation);

        let running = self
            .spawn_claude(&id, &effective_dir.to_string_lossy(), owner_id, None)
            .await
            .map_err(|e| {
                if let Some(wt) = &worktree_path {
                    let base = PathBuf::from(work_dir);
                    remove_worktree(&base, wt);
                }
                e
            })?;

        let session = Session {
            id: id.clone(),
            name,
            session_type: SessionType::Claude,
            cols,
            rows,
            work_dir: effective_dir.to_string_lossy().to_string(),
            owner_id: owner_id.to_string(),
            description: String::new(),
            name_is_auto: true,
            status: SessionMeta::Running,
            resume_token: None,
            worktree_path,
            created_ms: now_millis(),
            source_task_id,
            spawning: false,
            last_activity_ms: now_millis(),
            turns_completed: 0,
            run_metrics: VecDeque::new(),
            lifetime_turns: 0,
            lifetime_duration_ms: 0,
            lifetime_cost_usd: 0.0,
            running: Some(running),
            scrollback: VecDeque::new(),
            scrollback_bytes: 0,
        };

        self.persist_meta(&session);
        self.sessions.lock().unwrap().insert(id.clone(), session);
        Ok(id)
    }

    /// True if a session with this id currently exists (process may be running).
    pub fn session_exists(&self, id: &str) -> bool {
        self.sessions.lock().unwrap().contains_key(id)
    }

    /// 统计正在运行的 agent 会话,供 auto_update 的 idle-gate 决定能否升级
    /// (评审 E1:scheduled>0 → 永不强制穿透)。
    ///
    /// - `interactive`: 内存中 turn_state==Running 的**非调度** agent 会话(tmux 跳过)。
    /// - `scheduled`: 取自调度库的 in-flight run 计数(`claimed`/`running`),而非内存
    ///   turn_state。这是权威信号且无竞态窗口:run 行在 spawn **之前** 就被 `claim_won`
    ///   置为 `claimed`,并在每条退出路径(turn 边界 finalize / 看门狗 / 启动 reconcile)
    ///   落终态。故它精确覆盖 `claude -p` 子进程在 cgroup 内存活的整段生命周期。
    ///
    ///   为何不再用内存 turn_state 判调度:调度会话在 `trigger_run` 中先以 turn_state=Idle
    ///   插入 map + prompt 入队,fan-out 之后才 mark(Running) —— 这段 startup 窗口里
    ///   进程已活但 turn 未 Running,若据 turn_state 判定 scheduled==0,auto-update 会
    ///   `systemctl stop` 连 cgroup 一起杀掉刚起的调度子进程(违反 E1)。也不能退回
    ///   "只要 source_task 会话存活就算":调度 run 结束后 `claude -p` 进程 Idle 常驻不
    ///   回收,会让 scheduled 永久 ≥1 死锁 auto-update(8a5dc74 修的正是这个)。DB 计数
    ///   两头都对:前闭窗口、后随 run 终态释放。
    pub fn running_summary(&self) -> RunningSummary {
        let scheduled = {
            let store = self.scheduled.lock().unwrap().clone();
            store
                .and_then(|s| s.active_run_count().ok())
                .unwrap_or(0)
                .max(0) as usize
        };
        let map = self.sessions.lock().unwrap();
        let mut interactive = 0;
        for s in map.values() {
            if !matches!(s.session_type, SessionType::Claude | SessionType::Kiro | SessionType::Codex) {
                continue; // tmux 无 turn 概念,不阻塞升级
            }
            // 调度会话由上面的 DB 计数负责,这里只数交互式(非 source_task)运行 turn。
            if s.source_task_id.is_some() {
                continue;
            }
            let Some(rp) = s.running.as_ref() else { continue };
            if rp.turn_state == TurnState::Running {
                interactive += 1;
            }
        }
        RunningSummary { interactive, scheduled }
    }

    /// Create a Claude session for a scheduled run, mark the run running, and
    /// inject the goal prompt carrying the run_id (so the fan-out finalizes it).
    pub async fn trigger_run(
        &self,
        run_id: &str,
        name: String,
        work_dir: &str,
        owner_id: &str,
        task_id: &str,
        prompt: String,
    ) -> Result<String, String> {
        // Last gate before a process + git worktree hit disk. The HTTP layer
        // validated work_dir at create/update, but stored paths can be pre-check
        // rows or symlink-swapped since (TOCTOU); re-validate here so the spawn
        // path is the sole authority. Finalize the run on rejection, else the
        // overlap guard wedges every future fire.
        let canonical_dir = match work_dir_under_home(work_dir) {
            Ok(p) => p,
            Err(e) => {
                if let Some(store) = self.scheduled.lock().unwrap().clone() {
                    let _ = store.set_run_state(
                        run_id,
                        "failed",
                        None,
                        None,
                        Some("work_dir_rejected"),
                        Some(now_millis()),
                    );
                }
                return Err(e);
            }
        };
        // Spawn from the canonical path the gate just verified — NOT the raw
        // `work_dir` string. Re-resolving the unvalidated string downstream would
        // let a symlink swapped in after the check escape HOME (the TOCTOU above).
        let canonical_str = canonical_dir.to_string_lossy();
        // default terminal size for unattended sessions
        let sid = self
            .create_acp_session_tagged(
                name,
                &canonical_str,
                80,
                24,
                owner_id,
                Some(task_id.to_string()),
            )
            .await?;
        if let Some(store) = self.scheduled.lock().unwrap().clone() {
            let _ = store.set_run_state(run_id, "running", Some(&sid), None, None, None);
        }
        // run-record: snapshot the exact input at trigger time so a later config
        // edit doesn't change what a replay of THIS run does. secrets: reference
        // names only, never raw values.
        if let Some(store) = self.scheduled.lock().unwrap().clone() {
            let snap = serde_json::json!({
                "prompt": prompt,
                "work_dir": canonical_str.as_ref(),
                "agent_type": "claude",
                "secrets": [],
            }).to_string();
            let _ = store.set_input_snapshot(run_id, &snap);
        }
        let goal = format!(
            "{}\n\n完成后，最后单独输出一行：\n<<<VERDICT>>>一句话结论<<<END>>>",
            prompt
        );
        if let Some(tx) = self.input_tx(&sid) {
            if let Err(e) = tx
                .send(SessionInput::Prompt {
                    text: goal,
                    run_id: Some(run_id.to_string()),
                    client_id: None,
                })
                .await
            {
                if let Some(store) = self.scheduled.lock().unwrap().clone() {
                    let _ = store.set_run_state(
                        run_id,
                        "failed",
                        None,
                        None,
                        Some("prompt_send_failed"),
                        Some(now_millis()),
                    );
                }
                return Err(format!("send prompt failed: {}", e));
            }
        } else {
            // No input channel means the session never registered one (spawn raced
            // or failed). Without this the run would sit in "running" forever and
            // the overlap guard would wedge every future fire of the task.
            if let Some(store) = self.scheduled.lock().unwrap().clone() {
                let _ = store.set_run_state(
                    run_id,
                    "failed",
                    None,
                    None,
                    Some("no_input_channel"),
                    Some(now_millis()),
                );
            }
            return Err("session has no input channel".to_string());
        }
        Ok(sid)
    }

    /// Replay: spawn a run from a snapshot's prompt/work_dir. Reuses trigger_run's
    /// spawn path (incl. the work_dir_under_home TOCTOU gate). new_run_id was
    /// already claimed by claim_replay.
    pub async fn replay_run(&self, new_run_id: &str, task_id: &str, owner_id: &str,
                            name: String, snapshot_json: &str) -> Result<String, String> {
        let v: serde_json::Value = serde_json::from_str(snapshot_json)
            .map_err(|e| format!("bad snapshot: {e}"))?;
        let prompt = v["prompt"].as_str().unwrap_or("").to_string();
        let work_dir = v["work_dir"].as_str().unwrap_or(".").to_string();
        self.trigger_run(new_run_id, name, &work_dir, owner_id, task_id, prompt).await
    }

    /// 交互式启动 prompt：把 `prompt` 作为第一条用户消息透传给 agent 会话。
    ///
    /// F1: 发 `run_id: None` —— 走 fan-out 的普通用户 prompt 路径（若会话空闲则
    /// 立即发送；若忙则进 fan-out 队列按 QueueMode 处理），**不是** trigger_run
    /// 的 `run_id: Some` 调度分支。切勿带 run_id，否则会把交互会话误判成调度运行
    /// （污染 active_run_id / 触发 verdict finalize）。
    ///
    /// best-effort：发送失败只记日志（session 已建好可用，用户可手动重发）。
    /// 调用方（web handler）负责 tmux 跳过与空白 prompt 过滤。
    pub async fn send_initial_prompt(&self, id: &str, prompt: &str) {
        if let Some(tx) = self.input_tx(id) {
            if let Err(e) = tx
                .send(SessionInput::Prompt {
                    text: prompt.to_string(),
                    run_id: None,
                    client_id: None,
                })
                .await
            {
                tracing::warn!("initial_prompt send failed for {}: {}", id, e);
            } else {
                // F3: 成功也留痕，否则线上排查"agent 没自动开跑"时，
                // "发了但 agent 没动" 与 "压根没进这段逻辑" 在日志里无法区分。
                tracing::info!("initial_prompt sent for {}", id);
            }
        } else {
            tracing::warn!("initial_prompt: no input channel for {}", id);
        }
    }

    /// Spawn a Kiro process for `id` at `work_dir`, start its fan-out, return the
    /// live handle. `resume: Some(sid)` issues `session/load` to restore context.
    async fn spawn_kiro(
        &self,
        id: &str,
        work_dir: &str,
        owner_id: &str,
        resume: Option<&str>,
    ) -> Result<RunningProcess, String> {
        let process = KiroProcess::spawn(&self.kiro_path, work_dir, resume)
            .await
            .map_err(|e| format!("Failed to spawn Kiro: {}", e))?;

        let (event_tx, _) = broadcast::channel(BROADCAST_CAPACITY);
        let (input_tx, input_rx) = mpsc::channel::<SessionInput>(64);

        spawn_kiro_fanout(
            id.to_string(),
            process,
            event_tx.clone(),
            input_rx,
            self.events.clone(),
            "kiro",
            work_dir.to_string(),
            owner_id.to_string(),
            self.weak(),
        );

        Ok(RunningProcess {
            event_tx,
            input_tx,
            pty_pid: None,
            turn_state: TurnState::Idle,
            turn_started_ms: None,
            turn_seq: 0,
        })
    }

    pub async fn create_kiro_session(
        &self,
        name: String,
        _kiro_path: &str,
        work_dir: &str,
        cols: u16,
        rows: u16,
        owner_id: &str,
    ) -> Result<String, String> {
        let id = uuid::Uuid::new_v4().to_string();
        let (effective_dir, worktree_path) = resolve_work_dir(work_dir, &id, self.worktree_isolation);

        let running = self
            .spawn_kiro(&id, &effective_dir.to_string_lossy(), owner_id, None)
            .await
            .map_err(|e| {
                if let Some(wt) = &worktree_path {
                    let base = PathBuf::from(work_dir);
                    remove_worktree(&base, wt);
                }
                e
            })?;

        let session = Session {
            id: id.clone(),
            name,
            session_type: SessionType::Kiro,
            cols,
            rows,
            work_dir: effective_dir.to_string_lossy().to_string(),
            owner_id: owner_id.to_string(),
            description: String::new(),
            name_is_auto: true,
            status: SessionMeta::Running,
            resume_token: None,
            worktree_path,
            created_ms: now_millis(),
            source_task_id: None,
            spawning: false,
            last_activity_ms: now_millis(),
            turns_completed: 0,
            run_metrics: VecDeque::new(),
            lifetime_turns: 0,
            lifetime_duration_ms: 0,
            lifetime_cost_usd: 0.0,
            running: Some(running),
            scrollback: VecDeque::new(),
            scrollback_bytes: 0,
        };

        self.persist_meta(&session);
        self.sessions.lock().unwrap().insert(id.clone(), session);
        Ok(id)
    }

    /// Spawn a Codex process for `id` at `work_dir`, start its fan-out, return
    /// the live handle. `_resume` unused in Task 5 (Task 6 wires `codex-reply`).
    /// Reasoning effort comes from the stored `self.codex_reasoning`.
    async fn spawn_codex(
        &self,
        id: &str,
        work_dir: &str,
        owner_id: &str,
        resume: Option<String>,
    ) -> Result<RunningProcess, String> {
        let reasoning = if self.codex_reasoning.is_empty() || self.codex_reasoning == "off" {
            None
        } else {
            Some(self.codex_reasoning.clone())
        };

        let process = crate::acp::codex_process::CodexProcess::spawn(
            &self.codex_path,
            work_dir,
            reasoning,
            resume,
        )
        .await
        .map_err(|e| format!("Failed to spawn Codex: {}", e))?;

        let (event_tx, _) = broadcast::channel(BROADCAST_CAPACITY);
        let (input_tx, input_rx) = mpsc::channel::<SessionInput>(64);

        spawn_codex_fanout(
            id.to_string(),
            process,
            event_tx.clone(),
            input_rx,
            self.events.clone(),
            "codex",
            work_dir.to_string(),
            owner_id.to_string(),
            self.weak(),
        );

        Ok(RunningProcess {
            event_tx,
            input_tx,
            pty_pid: None,
            turn_state: TurnState::Idle,
            turn_started_ms: None,
            turn_seq: 0,
        })
    }

    pub async fn create_codex_session(
        &self,
        name: String,
        _codex_path: &str,
        _codex_reasoning: &str,
        work_dir: &str,
        cols: u16,
        rows: u16,
        owner_id: &str,
    ) -> Result<String, String> {
        let id = uuid::Uuid::new_v4().to_string();
        let (effective_dir, worktree_path) = resolve_work_dir(work_dir, &id, self.worktree_isolation);

        let running = self
            .spawn_codex(&id, &effective_dir.to_string_lossy(), owner_id, None)
            .await
            .map_err(|e| {
                if let Some(wt) = &worktree_path {
                    let base = PathBuf::from(work_dir);
                    remove_worktree(&base, wt);
                }
                e
            })?;

        let session = Session {
            id: id.clone(),
            name,
            session_type: SessionType::Codex,
            cols,
            rows,
            work_dir: effective_dir.to_string_lossy().to_string(),
            owner_id: owner_id.to_string(),
            description: String::new(),
            name_is_auto: true,
            status: SessionMeta::Running,
            resume_token: None,
            worktree_path,
            created_ms: now_millis(),
            source_task_id: None,
            spawning: false,
            last_activity_ms: now_millis(),
            turns_completed: 0,
            run_metrics: VecDeque::new(),
            lifetime_turns: 0,
            lifetime_duration_ms: 0,
            lifetime_cost_usd: 0.0,
            running: Some(running),
            scrollback: VecDeque::new(),
            scrollback_bytes: 0,
        };

        self.persist_meta(&session);
        self.sessions.lock().unwrap().insert(id.clone(), session);
        Ok(id)
    }

    /// 确保 session 有活进程；未运行则按 type 重生（Task 5：一律全新，无 resume）。
    /// 并发安全：spawning 标志防止两个并发请求双 spawn 同一 session。
    pub async fn ensure_running(&self, id: &str) -> Result<(), String> {
        // 阶段 1：锁内决策（guard 在本块结束即释放，await 前无锁）。
        let plan = {
            let mut map = self.sessions.lock().unwrap();
            let s = map.get_mut(id).ok_or_else(|| "session not found".to_string())?;
            match decide_spawn(s) {
                SpawnDecision::AlreadyRunning => return Ok(()),
                SpawnDecision::Wait => None,
                SpawnDecision::Spawn(plan) => Some(plan),
            }
        };

        // 别人在 spawn：锁外轮询等待 running 出现（最多 ~30s）。
        let Some(SpawnPlan { stype, resume_token: token, work_dir, owner_id, cols, rows }) = plan else {
            for _ in 0..300 {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                let map = self.sessions.lock().unwrap();
                match map.get(id) {
                    Some(s) if s.running.is_some() => return Ok(()),
                    Some(s) if s.spawning => continue,
                    Some(_) => return Err("spawn aborted".into()),
                    None => return Err("session removed".into()),
                }
                // guard drops here at end of loop body, before next sleep().await
            }
            return Err("timed out waiting for concurrent spawn".into());
        };

        // We claimed `spawning=true` in phase 1. Arm a drop-guard so that if this
        // future is cancelled mid-spawn (WS dropped before phase 3), the flag is
        // reset rather than stuck true forever. Phase 3 disarms it on completion.
        let mut guard = SpawningGuard {
            mgr: self.weak(),
            id: id.to_string(),
            armed: true,
        };

        // 阶段 2：锁外 await spawn（Task 6/7：按 backend 传入 stored ResumeToken）。
        // Did we attempt a resume for THIS backend? (token present + matching kind)
        let attempted_resume = matches!(
            (stype, &token),
            (SessionType::Claude, Some(ResumeToken::Claude(_)))
                | (SessionType::Kiro, Some(ResumeToken::Kiro(_)))
                | (SessionType::Codex, Some(ResumeToken::Codex(_)))
                | (SessionType::Tmux, Some(ResumeToken::Tmux(_)))
        );
        let result = match stype {
            SessionType::Claude => {
                let r = match &token {
                    Some(ResumeToken::Claude(s)) => Some(s.as_str()),
                    _ => None,
                };
                self.spawn_claude(id, &work_dir, &owner_id, r).await
            }
            SessionType::Kiro => {
                let r = match &token {
                    Some(ResumeToken::Kiro(s)) => Some(s.as_str()),
                    _ => None,
                };
                self.spawn_kiro(id, &work_dir, &owner_id, r).await
            }
            SessionType::Codex => {
                let r = match &token {
                    Some(ResumeToken::Codex(t)) => Some(t.clone()),
                    _ => None,
                };
                self.spawn_codex(id, &work_dir, &owner_id, r).await
            }
            SessionType::Tmux => {
                let t = match &token {
                    Some(ResumeToken::Tmux(s)) => Some(s.as_str()),
                    _ => None,
                };
                self.spawn_tmux(id, &work_dir, cols, rows, t)
            }
        };

        // resume_failed safety net: if a resume was ATTEMPTED and it FAILED, retry
        // once with NO token (fresh session). On success, mark `fell_back` so we (a)
        // clear the stale token and (b) surface a `resume_failed` system event to the
        // user. Both are deferred to AFTER phase 3 releases the sessions lock — the
        // scrollback push (the channel that actually reaches the client) and the
        // SQLite clear both re-acquire/own locks and must not nest under it.
        let mut fell_back = false;
        let result = match result {
            Ok(rp) => Ok(rp),
            Err(e) if attempted_resume => {
                tracing::warn!(
                    "resume failed for {} ({}), falling back to fresh session",
                    id,
                    e
                );
                let fresh = match stype {
                    SessionType::Claude => self.spawn_claude(id, &work_dir, &owner_id, None).await,
                    SessionType::Kiro => self.spawn_kiro(id, &work_dir, &owner_id, None).await,
                    SessionType::Codex => self.spawn_codex(id, &work_dir, &owner_id, None).await,
                    SessionType::Tmux => self.spawn_tmux(id, &work_dir, cols, rows, None),
                };
                match fresh {
                    Ok(rp) => {
                        fell_back = true;
                        // Broadcast for any already-attached client (multi-tab). This
                        // is best-effort: the connecting WS subscribes only AFTER
                        // ensure_running returns, so it has zero subscribers in the
                        // common case — the scrollback push after phase 3 is what
                        // actually delivers resume_failed via replay.
                        let _ = rp.event_tx.send(
                            serde_json::json!({
                                "type": "system",
                                "subtype": "resume_failed"
                            })
                            .to_string(),
                        );
                        Ok(rp)
                    }
                    Err(e2) => Err(e2),
                }
            }
            Err(e) => Err(e),
        };

        // 阶段 3：锁内装回 + 清 spawning。
        let mut map = self.sessions.lock().unwrap();
        let outcome = match map.get_mut(id) {
            Some(s) => {
                s.spawning = false;
                match result {
                    Ok(rp) => {
                        if fell_back {
                            // Drop the stale resume token in memory before `running`
                            // is observable. The fresh fan-out re-backfills a new
                            // token on the new session's first id-bearing event.
                            s.resume_token = None;
                        }
                        s.running = Some(rp);
                        s.status = SessionMeta::Running;
                        Ok(())
                    }
                    Err(e) => Err(e),
                }
            }
            None => Err("session removed during spawn".into()),
        };
        // Phase 3 reached: we cleared spawning ourselves (under the lock we hold),
        // so disarm the guard to avoid a redundant re-lock on its Drop. Release
        // the sessions lock BEFORE the guard drops at fn end so SpawningGuard's
        // Drop never re-locks while we hold it (std::Mutex would deadlock).
        drop(map);
        guard.armed = false;

        // Post-phase-3 fallback bookkeeping — NO sessions lock held here, so it is
        // safe to call push_scrollback / store (which lock internally).
        if fell_back && outcome.is_ok() {
            // Deliver resume_failed through scrollback: the connecting WS replays
            // scrollback right after ensure_running returns (ws_handler ~line 79),
            // so this is the path that actually reaches the client (the earlier
            // broadcast had no subscribers yet).
            let evt_json = serde_json::json!({
                "type": "system",
                "subtype": "resume_failed"
            })
            .to_string();
            self.push_scrollback(id, evt_json);
            // Clear the stale token in SQLite. Done after phase 3 (not at fallback
            // time) to keep the SQLite + memory clears adjacent. Residual race: a
            // fast fresh fan-out may have already backfilled a NEW token into both
            // memory and SQLite before this line; this clear then wipes SQLite while
            // memory keeps the new token. Self-heals on next restart (SQLite is
            // authoritative) and is harmless in-session (the live process is fresh).
            let _ = self.store.update_resume_token(id, None);
        }
        outcome
    }

    /// List sessions, optionally filtered by owner. Pass None for all (admin).
    pub fn list_sessions(&self, owner_filter: Option<&str>) -> Vec<SessionInfo> {
        self.sessions
            .lock()
            .unwrap()
            .values()
            .filter(|s| {
                owner_filter
                    .map(|uid| s.owner_id == uid)
                    .unwrap_or(true)
            })
            .map(session_info_of)
            .collect()
    }

    /// Check if a user owns a session
    pub fn is_owner(&self, session_id: &str, user_id: &str) -> bool {
        self.sessions
            .lock()
            .unwrap()
            .get(session_id)
            .map(|s| s.owner_id == user_id)
            .unwrap_or(false)
    }

    pub fn remove_session(&self, id: &str) -> bool {
        let removed = self.sessions.lock().unwrap().remove(id);
        if let Some(session) = removed {
            let _ = self.store.delete(id);
            // If this was a scheduled session removed mid-turn, finalize its
            // in-flight DB run NOW. Dropping the session closes the input_tx so
            // the fan-out exits on channel-close WITHOUT reaching its boundary
            // block, so the normal `finalize_run` never fires. Since
            // `running_summary().scheduled` now counts in-flight DB runs, a
            // lingering `running` row would block auto-update until the next
            // startup reconcile. Only touches scheduled sessions (source_task_id).
            if session.source_task_id.is_some() {
                if let Some(store) = self.scheduled.lock().unwrap().clone() {
                    let _ = store.abort_active_run_for_session(id, "session_removed", now_millis());
                }
            }
            // Dropping session closes event_tx + input_tx → fan-out task exits
            if let Some(wt_path) = &session.worktree_path {
                if let Some(worktrees_dir) = wt_path.parent() {
                    if let Some(repo_dir) = worktrees_dir.parent() {
                        remove_worktree(repo_dir, wt_path);
                    }
                }
            }
            true
        } else {
            false
        }
    }

    // ── Broadcast API: subscribe to session events ──

    /// Atomically snapshot the scrollback AND subscribe to the live broadcast
    /// under a SINGLE lock, returning `(history, receiver)`. This closes the
    /// reconnect double-delivery race (review 2026-06-11): the old path called
    /// `subscribe()` then — after an `.await` — `get_scrollback()` as two
    /// separate locks. Since G0 made `emit` write scrollback *before*
    /// broadcasting (see `record_and_broadcast`), an event landing between the
    /// two locks was BOTH replayed and delivered live → a duplicated streaming
    /// chunk on reconnect-mid-stream. Taking the snapshot and the receiver in
    /// one lock makes every event fall on exactly one side of the boundary:
    /// either already in `history`, or delivered to `receiver`, never both.
    /// Returns None if the session has no running process.
    pub fn subscribe_with_history(
        &self,
        id: &str,
    ) -> Option<(Vec<String>, broadcast::Receiver<String>)> {
        let map = self.sessions.lock().unwrap();
        let s = map.get(id)?;
        let rx = s.running.as_ref()?.event_tx.subscribe();
        let history = s.scrollback.iter().cloned().collect();
        Some((history, rx))
    }

    /// Atomically push an event to scrollback AND broadcast it under a SINGLE
    /// lock (review 2026-06-11). Pairs with `subscribe_with_history`: because
    /// both the persist+broadcast here and the snapshot+subscribe there happen
    /// under the same `sessions` mutex, a reconnecting client can never observe
    /// an event in both its replay and its live stream. `broadcast::send` is
    /// synchronous, so holding the std mutex across it does not block on I/O.
    /// Returns the broadcast result (Err == zero live subscribers; persistence
    /// still happened — that is the whole point, see T2).
    fn record_and_broadcast(&self, id: &str, data: String) {
        let mut map = self.sessions.lock().unwrap();
        if let Some(s) = map.get_mut(id) {
            // Every persisted event (ContentBlock/Result/…) is real activity, so
            // bump last_activity_ms here. This makes it a true silence timestamp
            // (updated within a turn, not just at turn boundaries), which the
            // interactive watchdog (running_idle_too_long) relies on to avoid
            // killing healthy long-running turns. Lock already held; no await/I/O.
            s.last_activity_ms = now_millis();
            let data_len = data.len();
            s.scrollback.push_back(data.clone());
            s.scrollback_bytes += data_len;
            // Evict from the front until under the cap, but NEVER evict the frame
            // we just appended: `len() > 1` keeps the tail. A single frame larger
            // than the cap (e.g. a multi-MB tool_result — only user prompts are
            // pre-capped, agent content blocks are not) would otherwise pop itself
            // too, leaving scrollback EMPTY → a reconnecting client replays nothing
            // for that turn. Keeping the oversized tail means it still replays; the
            // ring simply runs slightly over cap until the next frames push it out.
            while s.scrollback_bytes > SCROLLBACK_MAX_BYTES && s.scrollback.len() > 1 {
                if let Some(removed) = s.scrollback.pop_front() {
                    s.scrollback_bytes -= removed.len();
                }
            }
            if let Some(rp) = s.running.as_ref() {
                let _ = rp.event_tx.send(data); // Err == zero subscribers; ignore (T2)
            }
        }
    }

    /// Subscribe to a session's event broadcast. Returns None if session not found.
    pub fn subscribe(&self, id: &str) -> Option<broadcast::Receiver<String>> {
        self.sessions
            .lock()
            .unwrap()
            .get(id)
            .and_then(|s| s.running.as_ref())
            .map(|rp| rp.event_tx.subscribe())
    }

    /// Get the input sender for a session. Returns None if session not found.
    pub fn input_tx(&self, id: &str) -> Option<mpsc::Sender<SessionInput>> {
        self.sessions
            .lock()
            .unwrap()
            .get(id)
            .and_then(|s| s.running.as_ref())
            .map(|rp| rp.input_tx.clone())
    }

    // (PTY write/resize now handled via input_tx → fan-out task)

    /// fan-out turn-boundary callback; locks sessions and applies the state change.
    #[allow(dead_code)]
    fn mark_turn(&self, sid: &str, state: TurnState, seq: u64) {
        let mut map = self.sessions.lock().unwrap();
        if let Some(s) = map.get_mut(sid) {
            apply_turn(s, state, seq);
        }
    }

    /// Update session metadata (description, status)
    pub fn update_session_meta(
        &self,
        id: &str,
        description: Option<String>,
        status: Option<SessionMeta>,
    ) -> bool {
        self.update_session_meta_named(id, None, description, status)
    }

    pub fn update_session_meta_named(
        &self,
        id: &str,
        name: Option<String>,
        description: Option<String>,
        status: Option<SessionMeta>,
    ) -> bool {
        // Apply in-memory under the lock, capturing what to persist (name/desc)
        // so we can write to the store AFTER releasing the sessions lock.
        let persist = {
            let mut map = self.sessions.lock().unwrap();
            map.get_mut(id)
                .map(|s| apply_meta(s, name, description, status))
        };
        match persist {
            Some((pn, pd)) => {
                if let Some(n) = pn {
                    let _ = self.store.update_name(id, &n);
                    // 用户显式改名 → 锁定,auto-titler 不再覆盖(E12 保护)
                    {
                        let mut map = self.sessions.lock().unwrap();
                        if let Some(s) = map.get_mut(id) {
                            s.name_is_auto = false;
                        }
                    }
                    let _ = self.store.update_name_is_auto(id, false);
                }
                if let Some(d) = pd {
                    let _ = self.store.update_description(id, &d);
                }
                true
            }
            None => false,
        }
    }

    /// 只读:该会话名字当前是否仍可被自动命名覆盖。
    pub fn session_name_is_auto(&self, id: &str) -> bool {
        self.sessions.lock().unwrap()
            .get(id)
            .map(|s| s.name_is_auto)
            .unwrap_or(false)
    }

    /// auto-titler 写回标题:仅当仍为 auto 时写入,写入后锁定(E12:一生只一次)。
    /// 返回 true 表示实际写入。与用户改名路径解耦——不复用 update_session_meta_named。
    pub fn set_auto_title(&self, id: &str, title: &str) -> bool {
        let wrote = {
            let mut map = self.sessions.lock().unwrap();
            match map.get_mut(id) {
                Some(s) if s.name_is_auto => {
                    s.name = title.to_string();
                    s.name_is_auto = false; // E12:命名后锁定,重启/resume 不再 re-title
                    true
                }
                _ => false,
            }
        };
        if wrote {
            let _ = self.store.update_name(id, title);
            let _ = self.store.update_name_is_auto(id, false);
            // 名字变化经现有 SessionInfo 下发机制自动广播给客户端
        }
        wrote
    }

    /// 给 auto-titler 解析它该用哪个后端 + CLI 路径(跟随会话 agent)。
    /// 返回 None 表示该会话类型不支持自动命名(如 tmux)。
    pub fn titler_cli_for(&self, agent_label: &str) -> Option<(TitlerBackend, String)> {
        match agent_label {
            "claude-code" => Some((TitlerBackend::Claude, self.claude_path.clone())),
            "kiro" => Some((TitlerBackend::Kiro, self.kiro_path.clone())),
            "codex" => Some((TitlerBackend::Codex, self.codex_path.clone())),
            _ => None,
        }
    }

    /// Set a session's resume token, persisting only if it actually changed.
    /// Used by fan-out tasks (Task 6/7) to record cross-process resume context.
    pub fn set_resume_token(&self, id: &str, token: ResumeToken) {
        let should_write = {
            let mut map = self.sessions.lock().unwrap();
            match map.get_mut(id) {
                Some(s) if s.resume_token.as_ref() != Some(&token) => {
                    s.resume_token = Some(token.clone());
                    true
                }
                _ => false,
            }
        };
        if should_write {
            let _ = self.store.update_resume_token(id, Some(&token));
        }
    }

    /// Load persisted session metadata from the store into memory on startup.
    /// Sessions are restored with `running: None` (no live process) — they can
    /// be respawned from their resume_token (Task 5+). Existing in-memory
    /// sessions are never clobbered.
    pub fn load_persisted(&self) {
        let rows = match self.store.load_all() {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!("load_all failed: {}", e);
                return;
            }
        };
        let mut map = self.sessions.lock().unwrap();
        for p in rows {
            if map.contains_key(&p.id) {
                continue;
            }
            let id = p.id.clone();
            map.insert(
                id,
                Session {
                    id: p.id,
                    name: p.name,
                    session_type: p.session_type,
                    cols: 80,
                    rows: 24,
                    work_dir: p.work_dir,
                    owner_id: p.owner_id,
                    description: p.description,
                    name_is_auto: p.name_is_auto,
                    status: SessionMeta::Idle,
                    resume_token: p.resume_token,
                    worktree_path: p.worktree_path.map(std::path::PathBuf::from),
                    created_ms: p.created_ms,
                    source_task_id: p.source_task_id.clone(),
                    spawning: false,
                    last_activity_ms: now_millis(),
                    turns_completed: 0,
                    run_metrics: VecDeque::new(),
                    lifetime_turns: 0,
                    lifetime_duration_ms: 0,
                    lifetime_cost_usd: 0.0,
                    running: None,
                    scrollback: VecDeque::new(),
                    scrollback_bytes: 0,
                },
            );
        }
    }

    /// Get session type for a given id
    pub fn session_type(&self, id: &str) -> Option<SessionType> {
        self.sessions.lock().unwrap().get(id).map(|s| s.session_type)
    }

    /// Push output data to the scrollback buffer (base64 for PTY, JSON for ACP/Kiro)
    pub fn push_scrollback(&self, id: &str, data: String) {
        if let Some(s) = self.sessions.lock().unwrap().get_mut(id) {
            let data_len = data.len();
            s.scrollback.push_back(data);
            s.scrollback_bytes += data_len;
            // See record_and_broadcast: never evict the just-appended tail, so a
            // single oversized frame can't wipe the whole buffer to empty.
            while s.scrollback_bytes > SCROLLBACK_MAX_BYTES && s.scrollback.len() > 1 {
                if let Some(removed) = s.scrollback.pop_front() {
                    s.scrollback_bytes -= removed.len();
                }
            }
        }
    }

    /// Get a clone of the scrollback buffer for replay
    pub fn get_scrollback(&self, id: &str) -> Vec<String> {
        self.sessions
            .lock()
            .unwrap()
            .get(id)
            .map(|s| s.scrollback.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// Get work_dir for a session
    pub fn work_dir(&self, id: &str) -> Option<String> {
        self.sessions.lock().unwrap().get(id).map(|s| s.work_dir.clone())
    }

    /// Get PTY child PID for a session
    pub fn pty_pid(&self, id: &str) -> Option<u32> {
        self.sessions
            .lock()
            .unwrap()
            .get(id)
            .and_then(|s| s.running.as_ref())
            .and_then(|rp| rp.pty_pid)
    }
}

// ── Fan-out tasks for ACP/Kiro processes ──

/// Auto-log a `task_done` agent event when a process reports a turn result.
///
/// Called from every agent fan-out task on each emitted `AcpEvent`. Only the
/// `Result` variant produces an event — all three agents (Claude/Kiro/Codex)
/// emit `AcpEvent::Result` at end-of-turn, so this is the single common hook
/// for the activity dashboard. PTY sessions never reach here.
fn log_result_event(
    events: &EventStore,
    agent_label: &'static str,
    session_id: &str,
    work_dir: &str,
    owner_id: &str,
    evt: &crate::acp::process::AcpEvent,
) {
    use crate::acp::process::AcpEvent;
    if let AcpEvent::Result { text, cost_usd, .. } = evt {
        let metadata = cost_usd.map(|c| serde_json::json!({ "cost_usd": c }));
        let req = CreateEventReq {
            agent: agent_label.to_string(),
            event: "task_done".to_string(),
            summary: Some(crate::events::summarize(text, 200)),
            session_id: Some(session_id.to_string()),
            work_dir: Some(work_dir.to_string()),
            metadata,
        };
        if let Err(e) = events.create(req, owner_id) {
            tracing::warn!("Failed to auto-log task_done for session {}: {}", session_id, e);
        }
    }
}

/// Finalize an in-flight scheduled run as failed, then clear its id — used when an
/// interactive prompt (Interrupt/Passthrough queue mode) supersedes a running
/// scheduled turn. The scheduled run is finalized in exactly one place normally:
/// the boundary block keyed on `active_run_id.take()`. Superseding the turn drops
/// that handle before its boundary arrives, so without this the run row stays
/// `"running"` forever and the task's overlap guard wedges every future fire.
/// Sets `*active_run_id` to `None` (same end state the callers previously had), so
/// the later stale boundary's `take()` correctly no-ops (no double finalize).
fn finalize_active_run_if_scheduled(
    mgr: &Weak<SessionManager>,
    active_run_id: &mut Option<String>,
    failure_kind: &str,
) {
    if let Some(rid) = active_run_id.take() {
        if let Some(m) = mgr.upgrade() {
            m.finalize_run(&rid, "failed", None, Some(failure_kind));
        }
    }
}

/// On fan-out exit, clear the session's running state (keep metadata) so it can
/// be respawned from its resume_token (Task 5+). No-op if the manager or session
/// is already gone (e.g. the session was removed, which is why the fan-out ended).
fn mark_fanout_ended(mgr: &Weak<SessionManager>, sid: &str) {
    if let Some(mgr) = mgr.upgrade() {
        if let Some(s) = mgr.sessions.lock().unwrap().get_mut(sid) {
            s.running = None;
            s.status = SessionMeta::Idle;
        }
    }
}

/// Extract Claude's backend session_id from an id-bearing event, for resume backfill.
fn claude_session_id(evt: &AcpEvent) -> Option<String> {
    match evt {
        AcpEvent::System { session_id: Some(s), .. } => Some(s.clone()),
        AcpEvent::Result { session_id, .. } if !session_id.is_empty() => Some(session_id.clone()),
        _ => None,
    }
}

/// Extract Kiro's sessionId from an id-bearing event, for resume backfill.
/// Kiro emits `System { subtype:"init", session_id: Some(sid) }` at spawn.
fn kiro_session_id(evt: &AcpEvent) -> Option<String> {
    match evt {
        AcpEvent::System { session_id: Some(s), .. } => Some(s.clone()),
        _ => None,
    }
}

/// Extract Codex's threadId from an id-bearing event, for resume backfill.
fn codex_thread_id(evt: &AcpEvent) -> Option<String> {
    match evt {
        AcpEvent::Result { session_id, .. } if !session_id.is_empty() => Some(session_id.clone()),
        _ => None,
    }
}

/// Build a `RunMetric` from per-turn fields. Pure helper (no I/O, no clock) so
/// it is unit-testable; the fan-out passes the boundary's resolved outcome and
/// token/cost figures. `duration_ms` is derived (clamps clock regressions).
#[allow(clippy::too_many_arguments)]
fn build_run_metric(
    run_id: &str, session_id: &str, work_dir: &str, agent_type: &str, turn_seq: u64,
    started_ms: i64, ended_ms: i64,
    outcome: crate::run_metrics::RunOutcome, failure_kind: Option<String>,
    cost_usd: Option<f64>, tokens_in: Option<u64>, tokens_out: Option<u64>,
) -> crate::run_metrics::RunMetric {
    crate::run_metrics::RunMetric {
        run_id: run_id.to_string(), session_id: session_id.to_string(),
        work_dir: work_dir.to_string(), agent_type: agent_type.to_string(), turn_seq,
        started_ms, ended_ms, duration_ms: crate::run_metrics::duration_ms(started_ms, ended_ms),
        outcome, failure_kind,
        verdict: None, verdict_source: crate::run_metrics::VerdictSource::None,
        cost_usd, tokens_in, tokens_out, input_snapshot_ref: None,
    }
}

fn spawn_acp_fanout(
    sid: String,
    mut process: AcpProcess,
    event_tx: broadcast::Sender<String>,
    mut input_rx: mpsc::Receiver<SessionInput>,
    events: Arc<EventStore>,
    agent_label: &'static str,
    is_resumed: bool,
    work_dir: String,
    owner_id: String,
    mgr: Weak<SessionManager>,
) {
    tokio::spawn(async move {
        let mut token_saved = false;
        let mut turn_seq: u64 = 0;
        let mut local_running = false;
        let mut boundary_count: u64 = 0;
        let mut active_run_id: Option<String> = None;
        // ── auto-titler 状态(仅 acp/claude fanout 触发;见 auto_titler.rs 后端覆盖说明) ──
        // 记录本会话首条"实质" prompt;首个 Result 到达且仍为 auto 名时,后台命名一次。
        let mut first_substantive_prompt: Option<String> = None;
        let mut titled = false;
        // ── collect 队列状态 ──
        // 不变量:两个 deadline 仅在 `!local_running && !pending.is_empty()` 时为 Some。
        // 入队只在 turn 进行中(Running)发生;flush 窗口只在 turn 结束(Idle)后 arm,
        // 因此合并 prompt 永不在一个进行中的 turn 里发出(否则会变成 mid-turn 强打断)。
        let mut queue = PromptQueue::new();
        // 队列模式(G2b):collect(默认)/interrupt。passthrough 经 effective()
        // 在所有后端降级为 collect(见 QueueMode::effective 注释,review 2026-06-11)。
        let mut queue_mode = QueueMode::Collect;
        // ── per-run metrics state ──
        // `turn_starts` is a FIFO of per-turn start stamps: a stamp is pushed
        // at every turn-start site and `settle()`d (pop_front) at the boundary,
        // pairing each FIFO-ordered boundary with its own turn (an interrupt-
        // resend starts turn N+1 before turn N's aborted boundary arrives, so a
        // single slot would mis-attribute both — see TurnStarts). `pending_outcome`
        // carries INTENT (Cancel/Interrupt→Cancelled, TimeoutKill→Timeout) set on
        // the input branch and overrides the terminal-event inference.
        let mut pending_outcome: Option<crate::run_metrics::RunOutcome> = None;
        let mut turn_starts = TurnStarts::default();
        // ── cost 差分状态(仅 claude-code;见 cost-calibration spec)──
        // 冷启动:prev=Some(0.0)→首轮增量=total 本身;resume:prev=None→首轮记 0。
        let mut prev_cost: Option<f64> = if is_resumed { None } else { Some(0.0) };
        let mut first_cost_seen = false;
        let is_claude = agent_label == "claude-code";
        loop {
            tokio::select! {
                event = process.event_rx.recv() => {
                    match event {
                        Some(evt) => {
                            log_result_event(&events, agent_label, &sid, &work_dir, &owner_id, &evt);
                            // Backfill Claude resume token on first id-bearing event.
                            if !token_saved {
                                if let Some(sid_val) = claude_session_id(&evt) {
                                    if let Some(m) = mgr.upgrade() {
                                        m.set_resume_token(&sid, ResumeToken::Claude(sid_val));
                                    }
                                    token_saved = true;
                                }
                            }
                            let is_boundary = matches!(
                                evt,
                                AcpEvent::Result { .. } | AcpEvent::Error { .. } | AcpEvent::Exit { .. }
                            );
                            emit(&mgr, &sid, &event_tx, turn_seq, &evt);
                            // Tee to events.ndjson for the active scheduled run's turn.
                            // Scoped to active_run_id window: fires for every event from
                            // prompt-injection until active_run_id.take() at the boundary.
                            if let Some(rid) = &active_run_id {
                                if let Ok(line) = serde_json::to_string(&evt) {
                                    append_run_event(rid, &line);
                                }
                            }
                            if is_boundary {
                                // Each started turn emits AT LEAST one boundary
                                // (Result/Error/Exit) in FIFO order, but NOT
                                // always exactly one: a single turn can emit two
                                // — Claude `is_error` Result then the always-on
                                // Exit at EOF (acp/process.rs), Codex an Error
                                // notification then the resolving tools/call
                                // Result, or a mid-turn Error before completion.
                                // `boundary_count` counts boundaries; `turn_seq`
                                // counts turns. Once caught up (>= turn_seq) this
                                // boundary settles the live turn: CLAMP the count
                                // back to turn_seq so a SECOND boundary of the
                                // same turn can't push it permanently past
                                // turn_seq — which would make every future turn's
                                // Idle carry a seq that never equals rp.turn_seq,
                                // wedging the session Running forever (→ the idle
                                // watchdog kills a healthy session). Mark Idle
                                // with turn_seq (== rp.turn_seq) so the guard
                                // fires; apply_turn's Idle branch is idempotent so
                                // the second boundary doesn't double-count. Stale
                                // boundaries of a superseded interrupt-resend turn
                                // (count < turn_seq) get no Idle mark at all.
                                boundary_count += 1;
                                if boundary_count >= turn_seq {
                                    boundary_count = turn_seq;
                                    local_running = false;
                                    if let Some(m) = mgr.upgrade() {
                                        m.mark_turn(&sid, TurnState::Idle, turn_seq);
                                    }
                                }
                                // turn_done push: settling boundary of a non-scheduled
                                // turn (active_run_id still None → human-interactive turn).
                                // Must read active_run_id.is_none() BEFORE the take() below.
                                // Fire-and-forget via tokio::spawn; never await in the fan-out.
                                if boundary_count >= turn_seq && active_run_id.is_none() {
                                    if let Some(m) = mgr.upgrade() {
                                        if let Some(p) = m.push_handle() {
                                            let now = now_millis();
                                            let dur = turn_starts.front().map(|s| now - s).unwrap_or(0);
                                            let name = m.session_name(&sid).unwrap_or_default();
                                            let uid = owner_id.clone();
                                            let sid2 = sid.clone();
                                            tokio::spawn(async move {
                                                if crate::push::should_push_turn_done(now, p.last_turn_push(&uid, &sid2), dur) {
                                                    p.mark_turn_pushed(&uid, &sid2, now);
                                                    p.send_to_user(&uid, &crate::push::payload_for("turn_done", &name, &sid2, None)).await;
                                                }
                                            });
                                        }
                                    }
                                }
                                // Finalize a scheduled run exactly once, keyed
                                // on active_run_id, mapped by terminal event type.
                                if let Some(rid) = active_run_id.take() {
                                    if let Some(m) = mgr.upgrade() {
                                        match &evt {
                                            AcpEvent::Result { text, .. } => {
                                                let verdict = crate::scheduled_tasks::extract_verdict(text);
                                                m.finalize_run(&rid, "succeeded", verdict.as_deref(),
                                                    if verdict.is_some() { None } else { Some("no_verdict") });
                                            }
                                            AcpEvent::Error { .. } => {
                                                m.finalize_run(&rid, "failed", None, Some("cli_error"));
                                                // run_failed push: scheduled run ended with error
                                                if let Some(p2) = m.push_handle() {
                                                    let name = m.session_name(&sid).unwrap_or_default();
                                                    let uid = owner_id.clone();
                                                    let sid2 = sid.clone();
                                                    tokio::spawn(async move {
                                                        p2.send_to_user(&uid, &crate::push::payload_for("run_failed", &name, &sid2, Some("cli_error"))).await;
                                                    });
                                                }
                                            }
                                            AcpEvent::Exit { .. } => {
                                                m.finalize_run(&rid, "failed", None, Some("cli_exited"));
                                                // run_failed push: scheduled run exited unexpectedly
                                                if let Some(p2) = m.push_handle() {
                                                    let name = m.session_name(&sid).unwrap_or_default();
                                                    let uid = owner_id.clone();
                                                    let sid2 = sid.clone();
                                                    tokio::spawn(async move {
                                                        p2.send_to_user(&uid, &crate::push::payload_for("run_failed", &name, &sid2, Some("cli_exited"))).await;
                                                    });
                                                }
                                            }
                                            _ => { active_run_id = Some(rid); } // not terminal, keep waiting
                                        }
                                    }
                                }
                                // per-run metrics: every boundary (completed/error/cancel/timeout)
                                // records exactly one metric from this single exit. Intent
                                // (pending_outcome) overrides the event-type inference; the
                                // late boundaries of an interrupt-resend still each record a run
                                // (they represent a real run that ended) — the turn_starts FIFO
                                // pairs each with its own turn's start. Skipped only if this
                                // boundary has no pending turn-start (turn_starts empty).
                                let term = match &evt {
                                    AcpEvent::Result { .. } => crate::run_metrics::TerminalEvt::Result,
                                    AcpEvent::Error { .. } => crate::run_metrics::TerminalEvt::Error,
                                    _ => crate::run_metrics::TerminalEvt::Exit,
                                };
                                let outcome = crate::run_metrics::classify_outcome(term, pending_outcome.take());
                                let (raw_cost, mt_in, mt_out) = match &evt {
                                    AcpEvent::Result { cost_usd, tokens_in, tokens_out, .. } => (*cost_usd, *tokens_in, *tokens_out),
                                    _ => (None, None, None),
                                };
                                // 本边界是否会落 metric:由 FIFO 队首(最早未结算的 turn-start)
                                // 决定。boundaries 严格 FIFO、每 turn 恰一个,故 front() 就是本
                                // 边界所属 turn 的 start;若队列已空(罕见的多余边界)则不落 metric,
                                // 且**不能**推进 prev_cost,否则该轮增量凭空消失、lifetime_cost_usd
                                // 偏低(见 diff_cost_at_boundary 文档)。settle() 在下方消费同一队首。
                                let will_record = turn_starts.front().is_some();
                                let mc = if is_claude {
                                    let (delta, new_prev, new_seen) = crate::run_metrics::diff_cost_at_boundary(
                                        prev_cost, raw_cost, first_cost_seen, is_resumed, will_record);
                                    prev_cost = new_prev;
                                    first_cost_seen = new_seen;
                                    delta
                                } else {
                                    raw_cost // Kiro/Codex 恒 None,不动
                                };
                                let fk = match outcome {
                                    crate::run_metrics::RunOutcome::Errored => Some(
                                        if matches!(evt, AcpEvent::Exit { .. }) { "cli_exited" } else { "cli_error" }.to_string()),
                                    _ => None,
                                };
                                if let Some(started) = turn_starts.settle() {
                                    if let Some(m) = mgr.upgrade() {
                                        let rid = crate::run_metrics::new_run_id();
                                        let metric = build_run_metric(&rid, &sid, &work_dir, agent_label, turn_seq,
                                            started, now_millis(), outcome, fk, mc, mt_in, mt_out);
                                        m.record_run_metric(&sid, metric);
                                    }
                                }
                                // collect:turn 真正结束(已翻 Idle)且有排队的追加 →
                                // arm 收集窗口。只在这里 arm,保证 flush 永不发生在进行中的 turn 里。
                                if !local_running {
                                    queue.arm();
                                }
                                // auto-titler:首条实质 prompt 的首个 Result 触发一次性命名。
                                // first_substantive_prompt 仅在普通(非 run_id)turn 记录,故调度
                                // 运行不会触发。命中即 titled=true,无论成功与否只尝试一次;
                                // set_auto_title 内部再查 name_is_auto 防与用户改名竞态(E12)。
                                if !titled {
                                    if let AcpEvent::Result { text, .. } = &evt {
                                        if let Some(fp) = first_substantive_prompt.clone() {
                                            titled = true;
                                            if let Some(m) = mgr.upgrade() {
                                                if m.session_name_is_auto(&sid) {
                                                    if let Some((backend, path)) = m.titler_cli_for(agent_label) {
                                                        crate::auto_titler::spawn_titler(
                                                            sid.clone(), backend, path,
                                                            fp, text.clone(), mgr.clone(),
                                                        );
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        None => break,
                    }
                }
                input = input_rx.recv() => {
                    match input {
                        Some(SessionInput::Prompt { text, run_id, client_id }) => {
                            // Echo each user prompt as its own UserPrompt event (P1):
                            // N collect-merged messages still surface as N bubbles.
                            // turn_id = the turn this prompt will belong to. In the
                            // idle/run_id branches turn_seq is incremented below to
                            // start the turn, so prompt_turn (turn_seq+1) matches. In
                            // the collect path queued prompts each use turn_seq+1; since
                            // turn_seq stays fixed while running/in-window until the
                            // merged flush does turn_seq+=1, all share the same next-turn
                            // id, matching the merged assistant turn (T1).
                            let prompt_turn = turn_seq + 1;
                            emit(&mgr, &sid, &event_tx, prompt_turn, &AcpEvent::UserPrompt {
                                text: truncate_prompt_for_scrollback(&text),
                                turn_id: prompt_turn,
                                client_id: client_id.clone(),
                            });
                            if run_id.is_some() {
                                // C3:调度运行 prompt 绕过 collect,自成干净 turn。先丢弃任何
                                // 待合并队列+窗口,保证调度 turn 不被用户闲聊追加污染,且收集
                                // 窗口不会在调度 turn 进行中 flush(verdict 不会 finalize 在混入
                                // 对话的合并 turn 上)。
                                queue.clear();
                                active_run_id = run_id.clone();
                                if local_running {
                                    if let Err(e) = process.interrupt().await {
                                        tracing::warn!("interrupt before resend failed for {}: {}", sid, e);
                                    }
                                }
                                turn_seq += 1;
                                local_running = true;
                                turn_starts.start(now_millis());
                                if let Some(m) = mgr.upgrade() {
                                    m.mark_turn(&sid, TurnState::Running, turn_seq);
                                }
                                if let Err(e) = process.send_prompt(&text).await {
                                    tracing::warn!("ACP send_prompt failed for {}: {}", sid, e);
                                }
                            } else {
                                // 非调度 prompt:按当前队列模式分流(G2b)。
                                match queue_mode {
                                    QueueMode::Interrupt if local_running => {
                                        // 打断当前 turn,丢弃任何待合并,立即发新 prompt。
                                        if let Err(e) = process.interrupt().await {
                                            tracing::warn!("interrupt (queue mode) failed for {}: {}", sid, e);
                                        }
                                        queue.clear();
                                        // 若被打断的是一个在跑的调度 turn,先落定它的 run,再丢 rid。
                                        // 否则 active_run_id 被清后,该 turn 的 boundary 到来时
                                        // finalize 块 `active_run_id.take()` 已是 None → 永不 finalize,
                                        // run 行永久 "running",任务的 overlap 守卫从此挡住每一次后续触发。
                                        // take() 后仍为 None,故后到的 stale boundary 正确 no-op(不双 finalize)。
                                        finalize_active_run_if_scheduled(&mgr, &mut active_run_id, "interrupted");
                                        turn_seq += 1;
                                        local_running = true;
                                        turn_starts.start(now_millis());
                                        if let Some(m) = mgr.upgrade() {
                                            m.mark_turn(&sid, TurnState::Running, turn_seq);
                                        }
                                        if let Err(e) = process.send_prompt(&text).await {
                                            tracing::warn!("ACP send_prompt failed for {}: {}", sid, e);
                                        }
                                    }
                                    QueueMode::Passthrough => {
                                        // 不打断,直接并发发出。
                                        // 同 Interrupt 分支:若有在跑的调度 run,先 finalize 再丢 rid,
                                        // 否则该 run 永久 "running"。此处 turn 不被打断仍会各自出
                                        // boundary,但 rid 已丢 → boundary 的 finalize 块拿不到 rid。
                                        finalize_active_run_if_scheduled(&mgr, &mut active_run_id, "interrupted");
                                        turn_seq += 1;
                                        local_running = true;
                                        turn_starts.start(now_millis());
                                        if let Some(m) = mgr.upgrade() {
                                            m.mark_turn(&sid, TurnState::Running, turn_seq);
                                        }
                                        if let Err(e) = process.send_prompt(&text).await {
                                            tracing::warn!("ACP send_prompt failed for {}: {}", sid, e);
                                        }
                                    }
                                    // QueueMode::Collect(默认),以及 Interrupt 在 !local_running 时:
                                    // 沿用原 collect 行为。
                                    _ => {
                                        if local_running {
                                            // turn 进行中:入队,不打断(collect 核心)。窗口在 turn 结束后才 arm。
                                            queue.enqueue(text);
                                            emit_queued(&event_tx, queue.pending.len());
                                        } else if queue.debounce.is_some() {
                                            // 收集窗口开着(已 Idle,等 flush):继续入队 + 重置防抖,硬上限保持。
                                            queue.enqueue(text);
                                            queue.bump_debounce();
                                            emit_queued(&event_tx, queue.pending.len());
                                        } else {
                                            // 真正空闲:立即发送(原行为)
                                            // auto-titler:记录首条实质 prompt(P1:跳过 hi/ls/继续 等开场)
                                            if first_substantive_prompt.is_none() && is_substantive_prompt(&text) {
                                                first_substantive_prompt = Some(text.clone());
                                            }
                                            active_run_id = None;
                                            turn_seq += 1;
                                            local_running = true;
                                            turn_starts.start(now_millis());
                                            if let Some(m) = mgr.upgrade() {
                                                m.mark_turn(&sid, TurnState::Running, turn_seq);
                                            }
                                            if let Err(e) = process.send_prompt(&text).await {
                                                tracing::warn!("ACP send_prompt failed for {}: {}", sid, e);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        Some(SessionInput::SetQueueMode(m)) => {
                            queue_mode = m.effective();
                        }
                        Some(SessionInput::Interrupt) => {
                            if local_running {
                                // Intent: the interrupted turn is not a completion.
                                pending_outcome = Some(crate::run_metrics::RunOutcome::Cancelled);
                                if let Err(e) = process.interrupt().await {
                                    tracing::warn!("interrupt failed for {}: {}", sid, e);
                                }
                                // 旧 turn 的 Result/Error 会照常到达并经 mark_turn(Idle,seq) 翻 Idle
                            }
                            // E5:无条件清队列 + 取消窗口。用户中断意图含"别发那批排队的了",
                            // 即使 turn 已结束、窗口正等 flush(local_running==false)也要清。
                            queue.clear();
                        }
                        Some(SessionInput::Cancel) => {
                            // Intent before kill: the ensuing Exit must classify as Cancelled.
                            pending_outcome = Some(crate::run_metrics::RunOutcome::Cancelled);
                            process.kill().await;
                        }
                        Some(SessionInput::TimeoutKill { .. }) => {
                            // Intent before kill: the ensuing Exit must classify as Timeout.
                            pending_outcome = Some(crate::run_metrics::RunOutcome::Timeout);
                            process.kill().await;
                        }
                        None => break, // all input senders dropped (session removed)
                        _ => {} // ignore PTY commands
                    }
                }
                // collect flush:收集窗口(防抖 OR 硬上限,取较早者)到期 → 合并发一条。
                // 两个 deadline 在 turn 结束时一并 arm,故同 Some 同 None;只在 Idle 时触发。
                _ = async {
                    match (queue.debounce.as_mut(), queue.hard_cap.as_mut()) {
                        (Some(d), Some(h)) => { tokio::select! { _ = d.as_mut() => {}, _ = h.as_mut() => {} } }
                        (Some(d), None) => d.as_mut().await,
                        (None, Some(h)) => h.as_mut().await,
                        (None, None) => std::future::pending::<()>().await,
                    }
                }, if queue.debounce.is_some() => {
                    queue.disarm();
                    if !queue.pending.is_empty() {
                        tracing::info!("collect[{}]: flushing {} queued prompt(s) as one merged turn", sid, queue.pending.len());
                        let merged = queue.drain_merged();
                        active_run_id = None; // 合并 turn 永不携带 run_id(C3)
                        turn_seq += 1;
                        local_running = true;
                        turn_starts.start(now_millis());
                        if let Some(m) = mgr.upgrade() {
                            m.mark_turn(&sid, TurnState::Running, turn_seq);
                        }
                        if let Err(e) = process.send_prompt(&merged).await {
                            tracing::warn!("collect flush send_prompt failed for {}: {}", sid, e);
                        }
                    }
                }
            }
        }
        mark_fanout_ended(&mgr, &sid);
        tracing::info!("ACP fan-out task ended for session {}", sid);
    });
}

/// Running 期间追加、等待合并的一条用户 prompt。
#[derive(Debug, Clone)]
struct PendingPrompt {
    text: String,
    ts_ms: i64,
}

/// FIFO of per-turn start timestamps for the run-metrics bookkeeping.
///
/// Replaces a single `Option<i64>` slot that conflated concurrently-live
/// turns. In an interrupt-resend, turn N+1 starts (and stamps its start) BEFORE
/// turn N's aborted terminal boundary arrives, so a single slot loses turn N's
/// stamp: the aborted boundary then wrongly consumes turn N+1's stamp
/// (duration≈0) and turn N+1's real boundary records nothing.
///
/// Boundaries arrive strictly FIFO — the same ordering `boundary_count`
/// (Idle-settling) already relies on. So the start-stamp is pushed at each
/// turn-start and `pop_front`'d at each boundary, pairing every boundary with
/// its own turn's start. If a turn emits >1 boundary (Codex panic Error+Exit,
/// or a mid-turn error followed by the call result), the extra boundary finds
/// an empty queue → `settle()` returns None → no metric and no baseline
/// advance, keeping the `will_record=false` guard load-bearing. The Idle-state
/// path tolerates the same >1-boundary case by clamping `boundary_count` to
/// `turn_seq` on the settling boundary (fan-out blocks) + an idempotent
/// `apply_turn` Idle branch, so a second boundary can neither push the count
/// past `turn_seq` (wedging Running forever) nor double-count a turn.
///
/// Load-bearing invariant: **every started turn eventually yields ≥1 boundary.**
/// A turn that pushed a stamp but never boundaries would strand it and drift
/// all later pairings. Holds because every start site is immediately followed
/// by `send_prompt`, whose failure implies process death → an `Exit` boundary
/// drains the stamp; and `Cancel`/`TimeoutKill` `kill()` the process (→ `Exit`).
/// (An outcome-intent FIFO to label the aborted turn of a coupled interrupt-
/// resend as Cancelled rather than Completed is a documented follow-up; the
/// single `pending_outcome` slot still covers the standalone Cancel/Interrupt
/// paths, and the aborted-turn label was already Completed before this fix.)
#[derive(Default)]
struct TurnStarts {
    inner: VecDeque<i64>,
}

impl TurnStarts {
    /// A turn started at `ms`; enqueue its start-stamp.
    fn start(&mut self, ms: i64) {
        self.inner.push_back(ms);
    }

    /// Peek the oldest pending start-stamp without consuming it (used for the
    /// turn_done push duration, read before the metric block settles it).
    fn front(&self) -> Option<i64> {
        self.inner.front().copied()
    }

    /// A boundary arrived; consume and return the oldest pending start-stamp,
    /// or None if this boundary has no matching turn-start (spurious extra).
    fn settle(&mut self) -> Option<i64> {
        self.inner.pop_front()
    }
}

/// Shared collect-queue state for all three fan-outs (was duplicated ~3×).
/// Holds the pending appended prompts and the two debounce/hard-cap timers.
/// Behavior is identical to the prior inline logic; this is an extraction only.
struct PromptQueue {
    pending: Vec<PendingPrompt>,
    debounce: Option<std::pin::Pin<Box<tokio::time::Sleep>>>,
    hard_cap: Option<std::pin::Pin<Box<tokio::time::Sleep>>>,
}

impl PromptQueue {
    const DEBOUNCE_MS: u64 = 500;
    const MAX_MS: u64 = 3000;

    fn new() -> Self {
        Self { pending: Vec::new(), debounce: None, hard_cap: None }
    }

    fn enqueue(&mut self, text: String) {
        self.pending.push(PendingPrompt { text, ts_ms: now_millis() });
    }

    /// Reset the debounce timer (called on each new enqueue inside the window).
    fn bump_debounce(&mut self) {
        self.debounce = Some(Box::pin(tokio::time::sleep(
            std::time::Duration::from_millis(Self::DEBOUNCE_MS))));
    }

    /// Arm both timers when a turn ends with items queued.
    fn arm(&mut self) {
        if !self.pending.is_empty() && self.debounce.is_none() {
            self.bump_debounce();
            self.hard_cap = Some(Box::pin(tokio::time::sleep(
                std::time::Duration::from_millis(Self::MAX_MS))));
        }
    }

    fn disarm(&mut self) {
        self.debounce = None;
        self.hard_cap = None;
    }

    fn clear(&mut self) {
        self.pending.clear();
        self.disarm();
    }

    fn drain_merged(&mut self) -> String {
        let merged = merge_pending(&self.pending);
        self.pending.clear();
        merged
    }
}

/// 向客户端广播一条 ephemeral `System{subtype:"queued"}` 事件,携带当前排队条数。
/// 该事件在 ws_handler 侧被跳过 scrollback(E7),故重连回放不残留。三个 fanout 共用。
fn emit_queued(event_tx: &broadcast::Sender<String>, count: usize) {
    tracing::info!("collect: enqueued appended prompt while turn running, {} queued", count);
    if let Ok(json) = serde_json::to_string(&AcpEvent::System {
        subtype: std::borrow::Cow::Borrowed("queued"),
        session_id: None,
        count: Some(count as u32),
    }) {
        let _ = event_tx.send(json);
    }
}

/// True for events that are forwarded live but NOT persisted to scrollback.
/// Currently only `System{subtype:"queued"}` (the collect enqueue hint): a
/// reconnect must not replay a phantom "已排队 N 条" for a batch already flushed.
fn is_ephemeral_event(evt: &AcpEvent) -> bool {
    matches!(
        evt,
        AcpEvent::System { subtype, .. } if subtype.as_ref() == "queued"
    )
}

/// Single emit/persist chokepoint for all fan-out events.
/// Invariant (T2): scrollback is written UNCONDITIONALLY, before and
/// independent of `event_tx.send`. `broadcast::send` returns Err when there
/// are zero subscribers (all clients disconnected) — gating persistence on
/// send success would drop output produced while the phone is backgrounded.
/// Invariant (D2): this is the ONLY scrollback write path for live events, so
/// multiple connected clients can never double-record (the per-connection
/// write in ws_handler is removed in Task G0.3).
fn emit(
    mgr: &Weak<SessionManager>,
    sid: &str,
    event_tx: &broadcast::Sender<String>,
    turn_id: u64,
    evt: &AcpEvent,
) {
    // ContentBlock/Result arrive from the process layer with turn_id:0 (it
    // doesn't track turn_seq). Stamp the live turn here before broadcast/persist
    // so the frontend can group by turn (T1). Other events are passed through.
    let stamped;
    let evt = match evt {
        AcpEvent::ContentBlock { .. } | AcpEvent::Result { .. } => {
            stamped = with_turn_id(evt.clone(), turn_id);
            &stamped
        }
        _ => evt,
    };
    let json = match serde_json::to_string(evt) {
        Ok(j) => j,
        Err(_) => return,
    };
    if is_ephemeral_event(evt) {
        // Ephemeral (queued hint): broadcast only, never persisted (E7).
        let _ = event_tx.send(json); // Err == zero subscribers; ignore (T2)
    } else if let Some(m) = mgr.upgrade() {
        // Persist + broadcast atomically under one lock so a reconnecting
        // client never sees this event in BOTH replay and live stream
        // (review 2026-06-11; pairs with subscribe_with_history).
        m.record_and_broadcast(sid, json);
    } else {
        // SessionManager gone (shutting down): best-effort live broadcast.
        let _ = event_tx.send(json);
    }
}

/// Append one serialized AcpEvent line to a run's events.ndjson. Best-effort:
/// a write failure is dropped (never blocks the run). Scoped by the caller to
/// the active_run_id window only.
fn append_run_event(run_id: &str, serialized: &str) {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/home/ubuntu".to_string());
    let dir = std::path::Path::new(&home).join(".zeromux").join("runs").join(run_id);
    if std::fs::create_dir_all(&dir).is_err() { return; }
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("events.ndjson")) {
        let _ = writeln!(f, "{}", serialized);
    }
}

/// Cap a user prompt before it enters scrollback (T3). A single huge paste
/// must not blow the 2MB scrollback ring. NOT redaction — see spec P3 TODO.
const USER_PROMPT_SCROLLBACK_CAP: usize = 64 * 1024;
fn truncate_prompt_for_scrollback(text: &str) -> String {
    if text.len() <= USER_PROMPT_SCROLLBACK_CAP {
        return text.to_string();
    }
    let cut = text
        .char_indices()
        .take_while(|(i, _)| *i < USER_PROMPT_SCROLLBACK_CAP)
        .last()
        .map(|(i, c)| i + c.len_utf8())
        .unwrap_or(0);
    let dropped = text.len() - cut;
    format!("{}\n[已截断 {} 字节]", &text[..cut], dropped)
}

fn with_turn_id(mut evt: AcpEvent, tid: u64) -> AcpEvent {
    match &mut evt {
        AcpEvent::ContentBlock { turn_id, .. } => *turn_id = tid,
        AcpEvent::Result { turn_id, .. } => *turn_id = tid,
        _ => {}
    }
    evt
}

/// 把 Running 期间排队的追加 prompt 合并成一条带语义头的文本。
/// 语义头让模型明确这是"上一条处理期间的追加",而非独立新请求。
fn merge_pending(items: &[PendingPrompt]) -> String {
    use chrono::TimeZone;
    let mut out = String::from("[以下是你处理上一条消息期间用户追加发送的内容,请一并处理]\n");
    for p in items {
        let hhmm = chrono_tz::Asia::Shanghai
            .timestamp_millis_opt(p.ts_ms)
            .single()
            .map(|dt| dt.format("%H:%M").to_string())
            .unwrap_or_else(|| "--:--".into());
        out.push_str(&format!("[{}] {}\n", hhmm, p.text));
    }
    out
}

/// 判定一条 prompt 是否"实质"——值得用它生成会话标题。
/// 规则:trim 后,含空白(多词/含说明)即实质;否则要求字符数 >= 6。
/// 挡掉 hi/ls/继续/y/q/ok 这类单 token 短命令开场(评审 P1)。
fn is_substantive_prompt(text: &str) -> bool {
    let t = text.trim();
    if t.is_empty() {
        return false;
    }
    if t.chars().any(|c| c.is_whitespace()) {
        return true;
    }
    t.chars().count() >= 6
}

/// 若 `s` 以一个"标签词 + 冒号"前缀开头(如 `标题:`、`中文标题：`、`Title:`、
/// `Session Title:`),返回冒号之后的内容;否则返回 None。
///
/// 通用化(评审 A,修 live bug `中文标题:Claude 模型默认`):不再硬编固定串。
/// 规则:取第一个中英文冒号(`:` / `：`)之前的片段,若它"短"(≤8 字符)且
/// 含标签关键词(标题/题/title/name/名称/会话/session),则判定为标签前缀并剥离。
/// "短 + 含关键词"双条件避免误伤正文(如 `给文章起标题` 无冒号、`实现:配置中心`
/// 冒号前是正文词而非标签词,均不剥)。
fn strip_label_prefix(s: &str) -> Option<&str> {
    let idx = s.find(|c| c == ':' || c == '：')?;
    let (label, rest) = s.split_at(idx);
    // 跳过冒号本身(可能是 1 或 3 字节)
    let rest = &rest[rest.chars().next().map(|c| c.len_utf8()).unwrap_or(0)..];
    let label_lower = label.trim().to_lowercase();
    // 关键词是主门槛;长度上限是次级防护(挡掉"某段正文:..."这类冒号在很靠后的句子)。
    if label.chars().count() > 24 {
        return None;
    }
    // 注意:不要用裸 "题"(会误伤 问题:/话题:);"标题" 已覆盖 标题/中文标题/会话标题。
    const KEYWORDS: &[&str] = &["标题", "title", "名称", "会话", "session"];
    if KEYWORDS.iter().any(|k| label_lower.contains(k)) {
        Some(rest.trim())
    } else {
        None
    }
}

/// 清洗 LLM 返回的标题:取第一行、剥标签前缀、去引号、按字符截断 16、空→None。
pub fn sanitize_title(raw: &str) -> Option<String> {
    let first_line = raw.lines().next().unwrap_or("").trim();
    // 标签前缀可能出现在引号外层,故先剥前缀;剥不到则保留原文。
    let stripped = strip_label_prefix(first_line).unwrap_or(first_line).trim();
    let quotes: &[char] = &['"', '\'', '\u{201c}', '\u{201d}', '\u{2018}', '\u{2019}', '\u{300c}', '\u{300d}', '\u{300e}', '\u{300f}', '`'];
    let unquoted = stripped.trim_matches(|c| quotes.contains(&c)).trim();
    if unquoted.is_empty() {
        return None;
    }
    let truncated: String = unquoted.chars().take(16).collect();
    if truncated.trim().is_empty() {
        None
    } else {
        Some(truncated)
    }
}

fn spawn_kiro_fanout(
    sid: String,
    mut process: KiroProcess,
    event_tx: broadcast::Sender<String>,
    mut input_rx: mpsc::Receiver<SessionInput>,
    events: Arc<EventStore>,
    agent_label: &'static str,
    work_dir: String,
    owner_id: String,
    mgr: Weak<SessionManager>,
) {
    tokio::spawn(async move {
        let mut token_saved = false;
        let mut turn_seq: u64 = 0;
        let mut local_running = false;
        let mut boundary_count: u64 = 0;
        // ── collect 队列状态(镜像 spawn_acp_fanout;见那里的不变量注释) ──
        let mut queue = PromptQueue::new();
        // 队列模式(G2b):passthrough 经 effective() 降级为 collect(见 QueueMode::effective)。
        let mut queue_mode = QueueMode::Collect;
        // ── per-run metrics state (mirrors spawn_acp_fanout) ──
        let mut pending_outcome: Option<crate::run_metrics::RunOutcome> = None;
        let mut turn_starts = TurnStarts::default();
        loop {
            tokio::select! {
                event = process.event_rx.recv() => {
                    match event {
                        Some(evt) => {
                            log_result_event(&events, agent_label, &sid, &work_dir, &owner_id, &evt);
                            // Backfill Kiro resume token (sessionId) on first id-bearing event.
                            if !token_saved {
                                if let Some(sid_val) = kiro_session_id(&evt) {
                                    if let Some(m) = mgr.upgrade() {
                                        m.set_resume_token(&sid, ResumeToken::Kiro(sid_val));
                                    }
                                    token_saved = true;
                                }
                            }
                            let is_boundary = matches!(
                                evt,
                                AcpEvent::Result { .. } | AcpEvent::Error { .. } | AcpEvent::Exit { .. }
                            );
                            emit(&mgr, &sid, &event_tx, turn_seq, &evt);
                            if is_boundary {
                                // A turn can emit >1 boundary (Error+Exit /
                                // Error+Result). Clamp boundary_count to turn_seq
                                // on the settling boundary and mark Idle with
                                // turn_seq (not boundary_count) so the count can't
                                // run past turn_seq and wedge the session Running
                                // forever. Stale interrupt-resend boundaries
                                // (count < turn_seq) get no Idle mark. See the
                                // detailed note in spawn_acp_fanout.
                                boundary_count += 1;
                                if boundary_count >= turn_seq {
                                    boundary_count = turn_seq;
                                    local_running = false;
                                    if let Some(m) = mgr.upgrade() {
                                        m.mark_turn(&sid, TurnState::Idle, turn_seq);
                                    }
                                }
                                // per-run metrics: one metric per boundary, intent overrides
                                // event type (mirrors spawn_acp_fanout). Skipped when this
                                // boundary has no matching turn-start stamp.
                                let term = match &evt {
                                    AcpEvent::Result { .. } => crate::run_metrics::TerminalEvt::Result,
                                    AcpEvent::Error { .. } => crate::run_metrics::TerminalEvt::Error,
                                    _ => crate::run_metrics::TerminalEvt::Exit,
                                };
                                let outcome = crate::run_metrics::classify_outcome(term, pending_outcome.take());
                                let (mc, mt_in, mt_out) = match &evt {
                                    AcpEvent::Result { cost_usd, tokens_in, tokens_out, .. } => (*cost_usd, *tokens_in, *tokens_out),
                                    _ => (None, None, None),
                                };
                                let fk = match outcome {
                                    crate::run_metrics::RunOutcome::Errored => Some(
                                        if matches!(evt, AcpEvent::Exit { .. }) { "cli_exited" } else { "cli_error" }.to_string()),
                                    _ => None,
                                };
                                if let Some(started) = turn_starts.settle() {
                                    if let Some(m) = mgr.upgrade() {
                                        let rid = crate::run_metrics::new_run_id();
                                        let metric = build_run_metric(&rid, &sid, &work_dir, agent_label, turn_seq,
                                            started, now_millis(), outcome, fk, mc, mt_in, mt_out);
                                        m.record_run_metric(&sid, metric);
                                    }
                                }
                                // collect:turn 结束(已 Idle)且有排队追加 → arm 收集窗口。
                                if !local_running {
                                    queue.arm();
                                }
                            }
                        }
                        None => break,
                    }
                }
                input = input_rx.recv() => {
                    match input {
                        Some(SessionInput::Prompt { text, run_id, client_id }) => {
                            // Echo each user prompt as its own UserPrompt event (P1):
                            // N collect-merged messages still surface as N bubbles.
                            // turn_id = the turn this prompt will belong to. In the
                            // idle/run_id branches turn_seq is incremented below to
                            // start the turn, so prompt_turn (turn_seq+1) matches. In
                            // the collect path queued prompts each use turn_seq+1; since
                            // turn_seq stays fixed while running/in-window until the
                            // merged flush does turn_seq+=1, all share the same next-turn
                            // id, matching the merged assistant turn (T1).
                            let prompt_turn = turn_seq + 1;
                            emit(&mgr, &sid, &event_tx, prompt_turn, &AcpEvent::UserPrompt {
                                text: truncate_prompt_for_scrollback(&text),
                                turn_id: prompt_turn,
                                client_id: client_id.clone(),
                            });
                            if run_id.is_some() {
                                // C3:调度 prompt 绕过 collect(kiro 当前不跑调度,留此分支保持三 fanout 对称)
                                queue.clear();
                                if local_running {
                                    if let Err(e) = process.interrupt().await {
                                        tracing::warn!("interrupt before resend failed for {}: {}", sid, e);
                                    }
                                }
                                turn_seq += 1;
                                local_running = true;
                                turn_starts.start(now_millis());
                                if let Some(m) = mgr.upgrade() {
                                    m.mark_turn(&sid, TurnState::Running, turn_seq);
                                }
                                if let Err(e) = process.send_prompt(&text).await {
                                    tracing::warn!("Kiro send_prompt failed for {}: {}", sid, e);
                                }
                            } else {
                                // 非调度 prompt:按队列模式分流(G2b)。Kiro 为 ACP,
                                // passthrough 已在 SetQueueMode 处降级为 collect。
                                match queue_mode {
                                    QueueMode::Interrupt if local_running => {
                                        if let Err(e) = process.interrupt().await {
                                            tracing::warn!("interrupt (queue mode) failed for {}: {}", sid, e);
                                        }
                                        queue.clear();
                                        turn_seq += 1;
                                        local_running = true;
                                        turn_starts.start(now_millis());
                                        if let Some(m) = mgr.upgrade() {
                                            m.mark_turn(&sid, TurnState::Running, turn_seq);
                                        }
                                        if let Err(e) = process.send_prompt(&text).await {
                                            tracing::warn!("Kiro send_prompt failed for {}: {}", sid, e);
                                        }
                                    }
                                    QueueMode::Passthrough => {
                                        turn_seq += 1;
                                        local_running = true;
                                        turn_starts.start(now_millis());
                                        if let Some(m) = mgr.upgrade() {
                                            m.mark_turn(&sid, TurnState::Running, turn_seq);
                                        }
                                        if let Err(e) = process.send_prompt(&text).await {
                                            tracing::warn!("Kiro send_prompt failed for {}: {}", sid, e);
                                        }
                                    }
                                    _ => {
                                        if local_running {
                                            queue.enqueue(text);
                                            emit_queued(&event_tx, queue.pending.len());
                                        } else if queue.debounce.is_some() {
                                            queue.enqueue(text);
                                            queue.bump_debounce();
                                            emit_queued(&event_tx, queue.pending.len());
                                        } else {
                                            turn_seq += 1;
                                            local_running = true;
                                            turn_starts.start(now_millis());
                                            if let Some(m) = mgr.upgrade() {
                                                m.mark_turn(&sid, TurnState::Running, turn_seq);
                                            }
                                            if let Err(e) = process.send_prompt(&text).await {
                                                tracing::warn!("Kiro send_prompt failed for {}: {}", sid, e);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        Some(SessionInput::SetQueueMode(m)) => {
                            queue_mode = m.effective();
                        }
                        Some(SessionInput::Interrupt) => {
                            if local_running {
                                // Intent: the interrupted turn is not a completion.
                                pending_outcome = Some(crate::run_metrics::RunOutcome::Cancelled);
                                if let Err(e) = process.interrupt().await {
                                    tracing::warn!("interrupt failed for {}: {}", sid, e);
                                }
                            }
                            // E5:无条件清队列 + 取消窗口
                            queue.clear();
                        }
                        Some(SessionInput::Cancel) => {
                            // Intent before kill: the ensuing Exit must classify as Cancelled.
                            pending_outcome = Some(crate::run_metrics::RunOutcome::Cancelled);
                            process.kill().await;
                        }
                        Some(SessionInput::TimeoutKill { .. }) => {
                            // Intent before kill: the ensuing Exit must classify as Timeout.
                            pending_outcome = Some(crate::run_metrics::RunOutcome::Timeout);
                            process.kill().await;
                        }
                        None => break,
                        // PtyData / PtyResize aren't meaningful for an MCP
                        // agent session — they only apply to PTY/tmux. Drop
                        // silently rather than mis-route into send_prompt.
                        _ => {}
                    }
                }
                _ = async {
                    match (queue.debounce.as_mut(), queue.hard_cap.as_mut()) {
                        (Some(d), Some(h)) => { tokio::select! { _ = d.as_mut() => {}, _ = h.as_mut() => {} } }
                        (Some(d), None) => d.as_mut().await,
                        (None, Some(h)) => h.as_mut().await,
                        (None, None) => std::future::pending::<()>().await,
                    }
                }, if queue.debounce.is_some() => {
                    queue.disarm();
                    if !queue.pending.is_empty() {
                        let merged = queue.drain_merged();
                        turn_seq += 1;
                        local_running = true;
                        turn_starts.start(now_millis());
                        if let Some(m) = mgr.upgrade() {
                            m.mark_turn(&sid, TurnState::Running, turn_seq);
                        }
                        if let Err(e) = process.send_prompt(&merged).await {
                            tracing::warn!("collect flush send_prompt failed for {}: {}", sid, e);
                        }
                    }
                }
            }
        }
        mark_fanout_ended(&mgr, &sid);
        tracing::info!("Kiro fan-out task ended for session {}", sid);
    });
}

fn spawn_codex_fanout(
    sid: String,
    mut process: crate::acp::codex_process::CodexProcess,
    event_tx: broadcast::Sender<String>,
    mut input_rx: mpsc::Receiver<SessionInput>,
    events: Arc<EventStore>,
    agent_label: &'static str,
    work_dir: String,
    owner_id: String,
    mgr: Weak<SessionManager>,
) {
    tokio::spawn(async move {
        let mut token_saved = false;
        let mut turn_seq: u64 = 0;
        let mut local_running = false;
        let mut boundary_count: u64 = 0;
        // ── collect 队列状态(镜像 spawn_acp_fanout;见那里的不变量注释) ──
        let mut queue = PromptQueue::new();
        // 队列模式(G2b):Codex 的 mcp-server 事件循环在 turn 进行中会丢弃新 prompt
        // (codex_process.rs),故无法真正并发;passthrough 经 effective() 降级为
        // collect(见 QueueMode::effective,review 2026-06-11)。
        let mut queue_mode = QueueMode::Collect;
        // ── per-run metrics state (mirrors spawn_acp_fanout) ──
        let mut pending_outcome: Option<crate::run_metrics::RunOutcome> = None;
        let mut turn_starts = TurnStarts::default();
        loop {
            tokio::select! {
                event = process.event_rx.recv() => {
                    match event {
                        Some(evt) => {
                            log_result_event(&events, agent_label, &sid, &work_dir, &owner_id, &evt);
                            // Backfill Codex resume token (threadId) on first id-bearing event.
                            if !token_saved {
                                if let Some(tid) = codex_thread_id(&evt) {
                                    if let Some(m) = mgr.upgrade() {
                                        m.set_resume_token(&sid, ResumeToken::Codex(tid));
                                    }
                                    token_saved = true;
                                }
                            }
                            let is_boundary = matches!(
                                evt,
                                AcpEvent::Result { .. } | AcpEvent::Error { .. } | AcpEvent::Exit { .. }
                            );
                            emit(&mgr, &sid, &event_tx, turn_seq, &evt);
                            if is_boundary {
                                // A turn can emit >1 boundary (Error+Exit /
                                // Error+Result). Clamp boundary_count to turn_seq
                                // on the settling boundary and mark Idle with
                                // turn_seq (not boundary_count) so the count can't
                                // run past turn_seq and wedge the session Running
                                // forever. Stale interrupt-resend boundaries
                                // (count < turn_seq) get no Idle mark. See the
                                // detailed note in spawn_acp_fanout.
                                boundary_count += 1;
                                if boundary_count >= turn_seq {
                                    boundary_count = turn_seq;
                                    local_running = false;
                                    if let Some(m) = mgr.upgrade() {
                                        m.mark_turn(&sid, TurnState::Idle, turn_seq);
                                    }
                                }
                                // per-run metrics: one metric per boundary, intent overrides
                                // event type (mirrors spawn_acp_fanout). Skipped when this
                                // boundary has no matching turn-start stamp.
                                let term = match &evt {
                                    AcpEvent::Result { .. } => crate::run_metrics::TerminalEvt::Result,
                                    AcpEvent::Error { .. } => crate::run_metrics::TerminalEvt::Error,
                                    _ => crate::run_metrics::TerminalEvt::Exit,
                                };
                                let outcome = crate::run_metrics::classify_outcome(term, pending_outcome.take());
                                let (mc, mt_in, mt_out) = match &evt {
                                    AcpEvent::Result { cost_usd, tokens_in, tokens_out, .. } => (*cost_usd, *tokens_in, *tokens_out),
                                    _ => (None, None, None),
                                };
                                let fk = match outcome {
                                    crate::run_metrics::RunOutcome::Errored => Some(
                                        if matches!(evt, AcpEvent::Exit { .. }) { "cli_exited" } else { "cli_error" }.to_string()),
                                    _ => None,
                                };
                                if let Some(started) = turn_starts.settle() {
                                    if let Some(m) = mgr.upgrade() {
                                        let rid = crate::run_metrics::new_run_id();
                                        let metric = build_run_metric(&rid, &sid, &work_dir, agent_label, turn_seq,
                                            started, now_millis(), outcome, fk, mc, mt_in, mt_out);
                                        m.record_run_metric(&sid, metric);
                                    }
                                }
                                // collect:turn 结束(已 Idle)且有排队追加 → arm 收集窗口。
                                if !local_running {
                                    queue.arm();
                                }
                            }
                        }
                        None => break,
                    }
                }
                input = input_rx.recv() => {
                    match input {
                        Some(SessionInput::Prompt { text, run_id, client_id }) => {
                            // Echo each user prompt as its own UserPrompt event (P1):
                            // N collect-merged messages still surface as N bubbles.
                            // turn_id = the turn this prompt will belong to. In the
                            // idle/run_id branches turn_seq is incremented below to
                            // start the turn, so prompt_turn (turn_seq+1) matches. In
                            // the collect path queued prompts each use turn_seq+1; since
                            // turn_seq stays fixed while running/in-window until the
                            // merged flush does turn_seq+=1, all share the same next-turn
                            // id, matching the merged assistant turn (T1).
                            let prompt_turn = turn_seq + 1;
                            emit(&mgr, &sid, &event_tx, prompt_turn, &AcpEvent::UserPrompt {
                                text: truncate_prompt_for_scrollback(&text),
                                turn_id: prompt_turn,
                                client_id: client_id.clone(),
                            });
                            if run_id.is_some() {
                                // C3:调度 prompt 绕过 collect(codex 当前不跑调度,留此分支保持三 fanout 对称)
                                queue.clear();
                                if local_running {
                                    if let Err(e) = process.interrupt().await {
                                        tracing::warn!("interrupt before resend failed for {}: {}", sid, e);
                                    }
                                }
                                turn_seq += 1;
                                local_running = true;
                                turn_starts.start(now_millis());
                                if let Some(m) = mgr.upgrade() {
                                    m.mark_turn(&sid, TurnState::Running, turn_seq);
                                }
                                if let Err(e) = process.send_prompt(&text).await {
                                    tracing::warn!("Codex send_prompt failed for {}: {}", sid, e);
                                }
                            } else {
                                // 非调度 prompt:按队列模式分流(G2b)。
                                match queue_mode {
                                    QueueMode::Interrupt if local_running => {
                                        if let Err(e) = process.interrupt().await {
                                            tracing::warn!("interrupt (queue mode) failed for {}: {}", sid, e);
                                        }
                                        queue.clear();
                                        turn_seq += 1;
                                        local_running = true;
                                        turn_starts.start(now_millis());
                                        if let Some(m) = mgr.upgrade() {
                                            m.mark_turn(&sid, TurnState::Running, turn_seq);
                                        }
                                        if let Err(e) = process.send_prompt(&text).await {
                                            tracing::warn!("Codex send_prompt failed for {}: {}", sid, e);
                                        }
                                    }
                                    QueueMode::Passthrough => {
                                        turn_seq += 1;
                                        local_running = true;
                                        turn_starts.start(now_millis());
                                        if let Some(m) = mgr.upgrade() {
                                            m.mark_turn(&sid, TurnState::Running, turn_seq);
                                        }
                                        if let Err(e) = process.send_prompt(&text).await {
                                            tracing::warn!("Codex send_prompt failed for {}: {}", sid, e);
                                        }
                                    }
                                    _ => {
                                        if local_running {
                                            queue.enqueue(text);
                                            emit_queued(&event_tx, queue.pending.len());
                                        } else if queue.debounce.is_some() {
                                            queue.enqueue(text);
                                            queue.bump_debounce();
                                            emit_queued(&event_tx, queue.pending.len());
                                        } else {
                                            turn_seq += 1;
                                            local_running = true;
                                            turn_starts.start(now_millis());
                                            if let Some(m) = mgr.upgrade() {
                                                m.mark_turn(&sid, TurnState::Running, turn_seq);
                                            }
                                            if let Err(e) = process.send_prompt(&text).await {
                                                tracing::warn!("Codex send_prompt failed for {}: {}", sid, e);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        Some(SessionInput::SetQueueMode(m)) => {
                            queue_mode = m.effective();
                        }
                        Some(SessionInput::Interrupt) => {
                            if local_running {
                                // Intent: the interrupted turn is not a completion.
                                pending_outcome = Some(crate::run_metrics::RunOutcome::Cancelled);
                                if let Err(e) = process.interrupt().await {
                                    tracing::warn!("interrupt failed for {}: {}", sid, e);
                                }
                            }
                            // E5:无条件清队列 + 取消窗口
                            queue.clear();
                        }
                        Some(SessionInput::Cancel) => {
                            // Intent before kill: the ensuing Exit must classify as Cancelled.
                            pending_outcome = Some(crate::run_metrics::RunOutcome::Cancelled);
                            process.kill().await;
                        }
                        Some(SessionInput::TimeoutKill { .. }) => {
                            // Intent before kill: the ensuing Exit must classify as Timeout.
                            pending_outcome = Some(crate::run_metrics::RunOutcome::Timeout);
                            process.kill().await;
                        }
                        None => break,
                        // See note in spawn_kiro_fanout: PTY-style inputs
                        // are silently dropped for MCP sessions.
                        _ => {}
                    }
                }
                _ = async {
                    match (queue.debounce.as_mut(), queue.hard_cap.as_mut()) {
                        (Some(d), Some(h)) => { tokio::select! { _ = d.as_mut() => {}, _ = h.as_mut() => {} } }
                        (Some(d), None) => d.as_mut().await,
                        (None, Some(h)) => h.as_mut().await,
                        (None, None) => std::future::pending::<()>().await,
                    }
                }, if queue.debounce.is_some() => {
                    queue.disarm();
                    if !queue.pending.is_empty() {
                        let merged = queue.drain_merged();
                        turn_seq += 1;
                        local_running = true;
                        turn_starts.start(now_millis());
                        if let Some(m) = mgr.upgrade() {
                            m.mark_turn(&sid, TurnState::Running, turn_seq);
                        }
                        if let Err(e) = process.send_prompt(&merged).await {
                            tracing::warn!("collect flush send_prompt failed for {}: {}", sid, e);
                        }
                    }
                }
            }
        }
        mark_fanout_ended(&mgr, &sid);
        tracing::info!("Codex fan-out task ended for session {}", sid);
    });
}

/// Serializes the few tests that read or mutate the process-global `HOME`
/// env var. `cargo test` runs tests as threads in one process, so without
/// this lock `append_run_event_writes_and_isolates` (which sets HOME to a
/// tempdir) can race the work_dir tests that canonicalize the real HOME.
#[cfg(test)]
pub(crate) static HOME_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
mod work_dir_confinement_tests {
    use super::{work_dir_under_home, HOME_ENV_LOCK};

    #[test]
    fn home_itself_and_subdir_pass() {
        let _guard = HOME_ENV_LOCK.lock().unwrap();
        let home = std::env::var("HOME").unwrap();
        assert!(work_dir_under_home(&home).is_ok());
        // A subdir guaranteed to exist and canonicalize under HOME.
        let sub = std::path::Path::new(&home);
        if sub.join(".").canonicalize().is_ok() {
            assert!(work_dir_under_home(&format!("{home}/.")).is_ok());
        }
    }

    #[test]
    fn outside_home_is_rejected() {
        // /etc exists and canonicalizes, but is not under HOME.
        assert!(work_dir_under_home("/etc").is_err());
        assert!(work_dir_under_home("/").is_err());
    }

    #[test]
    fn nonexistent_path_is_rejected() {
        // canonicalize() fails on a path that does not exist — must not pass.
        assert!(work_dir_under_home("/home/ubuntu/__zeromux_does_not_exist__/x").is_err());
    }

    #[test]
    fn returns_canonical_path_not_raw_input() {
        let _guard = HOME_ENV_LOCK.lock().unwrap();
        // The caller MUST spawn from the returned (canonical) path, not the raw
        // string — that is what closes the TOCTOU. So a path with a symlink or
        // a `.` component must come back fully resolved, with no `.`/symlink left.
        let home = std::env::var("HOME").unwrap();
        let canonical_home = std::path::Path::new(&home).canonicalize().unwrap();
        let resolved = work_dir_under_home(&format!("{home}/.")).unwrap();
        assert_eq!(resolved, canonical_home);
        // No trailing `.` component survives canonicalization.
        assert!(!resolved.to_string_lossy().ends_with("/."));
    }
}

#[cfg(test)]
mod resolve_work_dir_tests {
    use super::resolve_work_dir;

    fn git_init(path: &std::path::Path) {
        let ok = std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(path)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        assert!(ok, "git init failed — git must be on PATH for this test");
    }

    /// With isolation OFF (the default), a git repo must NOT get a worktree —
    /// `git worktree add` is the 24s-on-JuiceFS cost we are eliminating. The
    /// effective dir is the base dir itself and no worktree path is returned.
    #[test]
    fn isolation_off_skips_worktree_in_git_repo() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path();
        git_init(path);

        let (effective, worktree) = resolve_work_dir(&path.to_string_lossy(), "sid12345", false);
        assert_eq!(effective, path, "effective dir must be the base dir");
        assert!(worktree.is_none(), "no worktree must be created when isolation is off");
        assert!(
            !path.join(".zeromux-worktrees").exists(),
            "the .zeromux-worktrees dir must not be created when isolation is off"
        );
    }

    /// With isolation ON in a git repo, a dedicated worktree is created under
    /// `.zeromux-worktrees/` and returned as the effective dir.
    #[test]
    fn isolation_on_creates_worktree_in_git_repo() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path();
        git_init(path);
        // `git worktree add` needs at least one commit to anchor HEAD.
        for args in [
            vec!["config", "user.email", "t@t"],
            vec!["config", "user.name", "t"],
            vec!["commit", "--allow-empty", "-q", "-m", "init"],
        ] {
            let ok = std::process::Command::new("git")
                .args(&args)
                .current_dir(path)
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
            assert!(ok, "git {:?} failed", args);
        }

        let (effective, worktree) = resolve_work_dir(&path.to_string_lossy(), "sidABCDE", true);
        let wt = worktree.expect("a worktree must be created when isolation is on");
        assert_eq!(effective, wt, "effective dir must be the worktree path");
        assert!(
            wt.starts_with(path.join(".zeromux-worktrees")),
            "worktree must live under .zeromux-worktrees"
        );
    }
}

#[cfg(test)]
mod resume_token_tests {
    use super::ResumeToken;

    #[test]
    fn roundtrip_all_variants() {
        let cases = [
            (ResumeToken::Claude("sid-1".into()), ("claude", "sid-1")),
            (ResumeToken::Kiro("k-2".into()), ("kiro", "k-2")),
            (ResumeToken::Codex("t-3".into()), ("codex", "t-3")),
            (ResumeToken::Tmux("work".into()), ("tmux", "work")),
        ];
        for (token, (kind, val)) in cases {
            let (k, v) = token.to_kind_value();
            assert_eq!((k, v.as_str()), (kind, val));
            let back = ResumeToken::from_kind_value(kind, val).unwrap();
            assert_eq!(back, token);
        }
    }

    #[test]
    fn from_unknown_kind_is_none() {
        assert!(ResumeToken::from_kind_value("bogus", "x").is_none());
    }
}

#[cfg(test)]
mod append_run_event_tests {
    use super::*;

    #[test]
    fn append_run_event_writes_and_isolates() {
        // HOME is process-global; lock against the work_dir tests that read it.
        let _guard = HOME_ENV_LOCK.lock().unwrap();
        let prev_home = std::env::var("HOME").ok();
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("HOME", tmp.path());
        append_run_event("run_abc", "{\"a\":1}");
        append_run_event("run_abc", "{\"b\":2}");
        let p = tmp.path().join(".zeromux/runs/run_abc/events.ndjson");
        let content = std::fs::read_to_string(&p).unwrap();
        // Restore HOME before the guard drops so no later test sees the tempdir.
        match prev_home {
            Some(h) => std::env::set_var("HOME", h),
            None => std::env::remove_var("HOME"),
        }
        assert_eq!(content.lines().count(), 2);
        assert!(content.contains("\"a\":1") && content.contains("\"b\":2"));
    }
}

#[cfg(test)]
mod decide_spawn_tests {
    use super::*;

    /// Build a minimal not-running session for decision-logic tests. No process
    /// is spawned, so this is safe without any CLI binaries present.
    fn test_session() -> Session {
        Session {
            id: "sid".into(),
            name: "n".into(),
            session_type: SessionType::Tmux,
            cols: 80,
            rows: 24,
            work_dir: "/tmp".into(),
            owner_id: "o".into(),
            description: String::new(),
            name_is_auto: true,
            status: SessionMeta::Idle,
            resume_token: None,
            worktree_path: None,
            created_ms: 0,
            source_task_id: None,
            spawning: false,
            last_activity_ms: 0,
            turns_completed: 0,
            run_metrics: VecDeque::new(),
            lifetime_turns: 0,
            lifetime_duration_ms: 0,
            lifetime_cost_usd: 0.0,
            running: None,
            scrollback: VecDeque::new(),
            scrollback_bytes: 0,
        }
    }

    #[test]
    fn fresh_session_claims_spawning() {
        let mut s = test_session();
        match decide_spawn(&mut s) {
            SpawnDecision::Spawn(plan) => {
                assert_eq!(plan.stype, SessionType::Tmux);
                assert_eq!(plan.work_dir, "/tmp");
            }
            _ => panic!("expected Spawn"),
        }
        // The decision must have claimed the spawning flag so a concurrent
        // caller observes Wait rather than double-spawning.
        assert!(s.spawning, "spawning flag must be set after claiming");
    }

    #[test]
    fn concurrent_caller_waits() {
        let mut s = test_session();
        // First caller claims spawning.
        assert!(matches!(decide_spawn(&mut s), SpawnDecision::Spawn(_)));
        // Second caller, seeing spawning=true and still not running, must Wait.
        assert!(matches!(decide_spawn(&mut s), SpawnDecision::Wait));
        // Flag stays set (only phase 3 clears it).
        assert!(s.spawning);
    }

    #[test]
    fn already_running_is_noop() {
        let mut s = test_session();
        let (event_tx, _) = broadcast::channel(BROADCAST_CAPACITY);
        let (input_tx, _input_rx) = mpsc::channel::<SessionInput>(64);
        s.running = Some(RunningProcess {
            event_tx,
            input_tx,
            pty_pid: None,
            turn_state: TurnState::Idle,
            turn_started_ms: None,
            turn_seq: 0,
        });
        assert!(matches!(decide_spawn(&mut s), SpawnDecision::AlreadyRunning));
        // Must not flip spawning when nothing needs spawning.
        assert!(!s.spawning);
    }

    /// Build a real SessionManager backed by tempdir stores (no CLI processes).
    fn test_manager() -> (Arc<SessionManager>, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let events = Arc::new(crate::events::EventStore::open(dir.path()).unwrap());
        let store = Arc::new(crate::session_store::SessionStore::open(dir.path()).unwrap());
        let mgr = SessionManager::new(
            events,
            store,
            "claude".into(),
            "kiro".into(),
            "codex".into(),
            "off".into(),
            "bash".into(),
            false,
        );
        (mgr, dir)
    }

    #[test]
    fn armed_guard_resets_spawning_on_drop() {
        let (mgr, _dir) = test_manager();
        // Insert a session already mid-spawn (spawning=true), as phase 1 leaves it.
        let mut s = test_session();
        s.spawning = true;
        mgr.sessions.lock().unwrap().insert(s.id.clone(), s);

        // Simulate the ensure_running future being cancelled mid-spawn: the guard
        // is created armed and then dropped without phase 3 disarming it.
        {
            let _guard = SpawningGuard {
                mgr: mgr.weak(),
                id: "sid".into(),
                armed: true,
            };
        } // _guard drops here → resets spawning

        let map = mgr.sessions.lock().unwrap();
        assert!(!map.get("sid").unwrap().spawning, "armed guard must reset spawning on drop");
    }

    #[test]
    fn set_auto_title_writes_once_then_locks() {
        let (mgr, _dir) = test_manager();
        // One session, name "claude-1", name_is_auto = true (test_session default).
        let mut s = test_session();
        s.name = "claude-1".into();
        let id = s.id.clone();
        mgr.sessions.lock().unwrap().insert(id.clone(), s);

        assert!(mgr.session_name_is_auto(&id));
        // First call: writes and locks.
        assert!(mgr.set_auto_title(&id, "修复登录"));
        assert!(!mgr.session_name_is_auto(&id)); // E12: locked after naming
        // Second call: already locked, refuses.
        assert!(!mgr.set_auto_title(&id, "另一个名字"));
        // Name is the first title, not the second.
        let map = mgr.sessions.lock().unwrap();
        assert_eq!(map.get(&id).unwrap().name, "修复登录");
    }

    #[test]
    fn user_rename_locks_name_is_auto() {
        let (mgr, _dir) = test_manager();
        let s = test_session(); // name_is_auto = true
        let id = s.id.clone();
        mgr.sessions.lock().unwrap().insert(id.clone(), s);

        assert!(mgr.session_name_is_auto(&id));
        // Rename with a name → locks
        mgr.update_session_meta_named(&id, Some("我的名字".into()), None, None);
        assert!(!mgr.session_name_is_auto(&id));
    }

    #[test]
    fn description_only_update_does_not_lock_name_is_auto() {
        let (mgr, _dir) = test_manager();
        let s = test_session(); // name_is_auto = true
        let id = s.id.clone();
        mgr.sessions.lock().unwrap().insert(id.clone(), s);

        assert!(mgr.session_name_is_auto(&id));
        // Description-only update (name = None) → must NOT lock
        mgr.update_session_meta_named(&id, None, Some("仅描述".into()), None);
        assert!(
            mgr.session_name_is_auto(&id),
            "description-only update must not lock name_is_auto"
        );
    }

    #[test]
    fn disarmed_guard_leaves_spawning_untouched() {
        let (mgr, _dir) = test_manager();
        let mut s = test_session();
        s.spawning = true;
        mgr.sessions.lock().unwrap().insert(s.id.clone(), s);

        // Normal success path: phase 3 already cleared spawning + disarmed guard.
        {
            let mut guard = SpawningGuard {
                mgr: mgr.weak(),
                id: "sid".into(),
                armed: true,
            };
            guard.armed = false; // disarm as phase 3 does
        }

        // Guard drop was a no-op; spawning stays whatever phase 3 set it to (here
        // we left it true to prove the guard didn't touch it).
        let map = mgr.sessions.lock().unwrap();
        assert!(map.get("sid").unwrap().spawning, "disarmed guard must not touch spawning");
    }
}

#[cfg(test)]
mod turn_state_tests {
    use super::*;

    fn running_session(id: &str) -> Session {
        let (event_tx, _) = broadcast::channel(BROADCAST_CAPACITY);
        let (input_tx, _rx) = mpsc::channel(8);
        Session {
            id: id.into(), name: "t".into(),
            session_type: SessionType::Claude,
            cols: 80, rows: 24, work_dir: "/tmp".into(),
            owner_id: "u".into(), description: String::new(),
            name_is_auto: true,
            status: SessionMeta::Running,
            resume_token: None, worktree_path: None, created_ms: 0,
            source_task_id: None,
            spawning: false,
            last_activity_ms: 0,
            turns_completed: 0,
            run_metrics: VecDeque::new(),
            lifetime_turns: 0,
            lifetime_duration_ms: 0,
            lifetime_cost_usd: 0.0,
            running: Some(RunningProcess {
                event_tx, input_tx, pty_pid: None,
                turn_state: TurnState::Idle,
                turn_started_ms: None,
                turn_seq: 0,
            }),
            scrollback: VecDeque::new(), scrollback_bytes: 0,
        }
    }

    #[test]
    fn apply_running_sets_started_and_seq() {
        let mut s = running_session("s");
        apply_turn(&mut s, TurnState::Running, 1);
        let rp = s.running.as_ref().unwrap();
        assert_eq!(rp.turn_state, TurnState::Running);
        assert!(rp.turn_started_ms.is_some());
        assert_eq!(rp.turn_seq, 1);
    }

    #[test]
    fn runs_for_session_enforces_owner_and_limit() {
        let (mgr, _dir) = {
            let dir = tempfile::tempdir().unwrap();
            let events = Arc::new(crate::events::EventStore::open(dir.path()).unwrap());
            let store = Arc::new(crate::session_store::SessionStore::open(dir.path()).unwrap());
            let mgr = SessionManager::new(
                events, store,
                "claude".into(), "kiro".into(), "codex".into(), "off".into(), "bash".into(), false,
            );
            (mgr, dir)
        };

        // Session owned by "u1" with 3 run metrics.
        let mut s = running_session("sid");
        s.owner_id = "u1".into();
        let mk = |id: &str| crate::run_metrics::RunMetric {
            run_id: id.into(), session_id: "sid".into(), work_dir: "/w".into(),
            agent_type: "claude".into(), turn_seq: 1, started_ms: 0, ended_ms: 100,
            duration_ms: 100, outcome: crate::run_metrics::RunOutcome::Completed,
            failure_kind: None, verdict: None,
            verdict_source: crate::run_metrics::VerdictSource::None,
            cost_usd: None, tokens_in: None, tokens_out: None, input_snapshot_ref: None,
        };
        s.run_metrics.push_back(mk("r1"));
        s.run_metrics.push_back(mk("r2"));
        s.run_metrics.push_back(mk("r3"));
        mgr.sessions.lock().unwrap().insert("sid".into(), s);

        // Cross-owner → None (don't leak existence).
        assert!(mgr.runs_for_session("sid", "u2", None, None).is_none());

        // Owner match, limit=2 → 2 runs in the page, but stats over full history (count==3).
        let (runs, stats) = mgr.runs_for_session("sid", "u1", Some(2), None).unwrap();
        assert_eq!(runs.len(), 2);
        assert_eq!(stats.count, 3);
        // Newest-first ordering.
        assert_eq!(runs[0].run_id, "r3");
        assert_eq!(runs[1].run_id, "r2");
    }

    #[test]
    fn apply_idle_matching_seq_clears_and_counts() {
        let mut s = running_session("s");
        apply_turn(&mut s, TurnState::Running, 1);
        apply_turn(&mut s, TurnState::Idle, 1);
        assert_eq!(s.turns_completed, 1);
        assert_eq!(s.running.as_ref().unwrap().turn_state, TurnState::Idle);
        assert!(s.running.as_ref().unwrap().turn_started_ms.is_none());
    }

    #[test]
    fn apply_idle_stale_seq_ignored() {
        let mut s = running_session("s");
        apply_turn(&mut s, TurnState::Running, 2);
        apply_turn(&mut s, TurnState::Idle, 1);
        assert_eq!(s.turns_completed, 0);
        assert_eq!(s.running.as_ref().unwrap().turn_state, TurnState::Running);
    }

    #[test]
    fn apply_on_hibernated_is_noop() {
        let mut s = running_session("s");
        s.running = None;
        s.last_activity_ms = -1; // sentinel
        apply_turn(&mut s, TurnState::Running, 1);
        assert!(s.running.is_none());
        assert!(s.last_activity_ms > 0, "last_activity_ms must update even when hibernated");
    }

    #[test]
    fn session_info_reports_turn_fields() {
        let mut s = running_session("s");
        apply_turn(&mut s, TurnState::Running, 1);
        let info = session_info_of(&s);
        assert_eq!(info.running, true);
        assert_eq!(info.turn_state, Some("running"));
        assert!(info.turn_started_ms.is_some());
    }

    #[test]
    fn hibernated_session_turn_state_none() {
        let mut s = running_session("h");
        s.running = None;
        let info = session_info_of(&s);
        assert_eq!(info.running, false);
        assert_eq!(info.turn_state, None);
    }

    #[test]
    fn interrupt_resend_stale_boundary_does_not_idle_new_turn() {
        // Reproduces the interrupt-and-resend interleaving the fan-out drives:
        // turn 1 running, a mid-turn Prompt interrupts+bumps to turn 2, then
        // turn 1's stale boundary arrives. The fan-out reports boundaries by
        // their FIFO ordinal (boundary_count), so the stale boundary carries
        // seq=1 while the live turn is seq=2 — apply_turn's guard must drop it,
        // leaving the new turn Running and NOT counting the aborted turn.
        let mut s = running_session("s");
        apply_turn(&mut s, TurnState::Running, 1); // turn 1 starts
        apply_turn(&mut s, TurnState::Running, 2); // resend → turn 2
        apply_turn(&mut s, TurnState::Idle, 1); // stale boundary #1 (turn 1)
        assert_eq!(s.running.as_ref().unwrap().turn_state, TurnState::Running);
        assert_eq!(s.turns_completed, 0);
        apply_turn(&mut s, TurnState::Idle, 2); // real boundary #2 (turn 2)
        assert_eq!(s.running.as_ref().unwrap().turn_state, TurnState::Idle);
        assert_eq!(s.turns_completed, 1);
    }

    #[test]
    fn idle_is_idempotent_at_same_seq() {
        // A single turn can emit two boundaries (Claude Error+Exit, Codex
        // Error+Result). Both now settle with the same live turn_seq, so Idle
        // must be idempotent: the second boundary must NOT count a second turn.
        let mut s = running_session("s");
        apply_turn(&mut s, TurnState::Running, 1);
        apply_turn(&mut s, TurnState::Idle, 1); // boundary #1 (Error)
        apply_turn(&mut s, TurnState::Idle, 1); // boundary #2 (Exit) — same turn
        assert_eq!(s.turns_completed, 1, "two boundaries of one turn count once");
        assert_eq!(s.running.as_ref().unwrap().turn_state, TurnState::Idle);
    }

    // Mirrors the fan-out boundary block's clamp: boundary_count counts
    // boundaries, turn_seq counts turns; the settling boundary clamps the count
    // to turn_seq and marks Idle with turn_seq. This drives apply_turn exactly
    // as the three fan-outs do, so the test reproduces the real wedge.
    fn settle_boundary(s: &mut Session, boundary_count: &mut u64, turn_seq: u64) {
        *boundary_count += 1;
        if *boundary_count >= turn_seq {
            *boundary_count = turn_seq;
            apply_turn(s, TurnState::Idle, turn_seq);
        }
    }

    #[test]
    fn two_boundary_turn_does_not_wedge_running_forever() {
        // THE BUG: before the clamp, a turn that emitted TWO boundaries pushed
        // boundary_count past turn_seq (Idle marked with boundary_count=2 while
        // rp.turn_seq=1 → dropped), then EVERY future turn's Idle carried a seq
        // that never equaled rp.turn_seq → session stuck Running forever → the
        // idle-watchdog killed a healthy session. The clamp fixes it.
        let mut s = running_session("s");
        let mut bc: u64 = 0;
        let mut turn_seq: u64 = 0;

        // Turn 1: two boundaries (e.g. Error then Exit).
        turn_seq += 1;
        apply_turn(&mut s, TurnState::Running, turn_seq);
        settle_boundary(&mut s, &mut bc, turn_seq); // boundary #1 settles turn 1
        settle_boundary(&mut s, &mut bc, turn_seq); // boundary #2 (same turn), clamped
        assert_eq!(s.running.as_ref().unwrap().turn_state, TurnState::Idle);
        assert_eq!(s.turns_completed, 1);

        // Turn 2: single normal boundary — MUST settle to Idle (the regression
        // was that this Idle was silently dropped forever).
        turn_seq += 1;
        apply_turn(&mut s, TurnState::Running, turn_seq);
        assert_eq!(s.running.as_ref().unwrap().turn_state, TurnState::Running);
        settle_boundary(&mut s, &mut bc, turn_seq);
        assert_eq!(s.running.as_ref().unwrap().turn_state, TurnState::Idle,
            "turn 2 must idle even after turn 1 emitted two boundaries");
        assert_eq!(s.turns_completed, 2);
    }

    #[test]
    fn turn_starts_fifo_pairs_each_boundary_with_its_own_turn() {
        // Metric-side counterpart of interrupt_resend_stale_boundary_*: the
        // per-run start-stamp must be FIFO, not a single slot. In an
        // interrupt-resend, turn 2 starts (stamps T2) BEFORE turn 1's aborted
        // boundary arrives. A single Option<i64> would hold only T2 →
        //   - boundary #1 (aborted turn 1) consumes T2 → started=T2, duration≈0
        //   - boundary #2 (real turn 2) finds None → records NO metric
        // The FIFO settles the OLDEST pending start at each boundary, so each
        // boundary is paired with its own turn's start.
        let mut ts = TurnStarts::default();
        ts.start(1_000); // turn 1 start (T1)
        ts.start(2_000); // turn 2 resend start (T2) — single slot would drop T1

        // boundary #1 (aborted turn 1) → T1, not T2
        assert_eq!(ts.front(), Some(1_000));
        assert_eq!(ts.settle(), Some(1_000));
        // boundary #2 (real answering turn) → T2, still recorded
        assert_eq!(ts.front(), Some(2_000));
        assert_eq!(ts.settle(), Some(2_000));
        // a spurious extra boundary with no pending start → no metric,
        // no baseline corruption (will_record=false path stays load-bearing)
        assert_eq!(ts.front(), None);
        assert_eq!(ts.settle(), None);
    }

    #[test]
    fn apply_meta_changes_name_and_reports_persist() {
        let mut s = running_session("s");
        let (pn, pd) = apply_meta(&mut s, Some("renamed".into()), None, None);
        assert_eq!(s.name, "renamed");
        assert_eq!(pn.as_deref(), Some("renamed"));
        assert_eq!(pd, None);
    }

    #[test]
    fn merge_pending_formats_with_header_and_timestamps() {
        let items = vec![
            PendingPrompt { text: "先看安全".into(), ts_ms: 1_700_000_000_000 },
            PendingPrompt { text: "重点 SQL 注入".into(), ts_ms: 1_700_000_060_000 },
        ];
        let out = merge_pending(&items);
        assert!(out.starts_with("[以下是你处理上一条消息期间用户追加发送的内容"));
        assert!(out.contains("先看安全"));
        assert!(out.contains("重点 SQL 注入"));
        assert!(out.find("先看安全").unwrap() < out.find("重点 SQL 注入").unwrap());
        assert!(out.matches('[').count() >= 3); // header + 2 timestamps
    }

    #[test]
    fn queue_mode_parses_and_defaults_collect() {
        assert_eq!(QueueMode::from_str("collect"), QueueMode::Collect);
        assert_eq!(QueueMode::from_str("interrupt"), QueueMode::Interrupt);
        assert_eq!(QueueMode::from_str("passthrough"), QueueMode::Passthrough);
        assert_eq!(QueueMode::from_str("garbage"), QueueMode::Collect);
    }

    #[test]
    fn passthrough_degrades_to_collect_on_every_backend() {
        // Passthrough is unsound under the single-turn_seq machinery (Codex
        // drops the mid-turn prompt → wedge; Claude/Kiro mis-stamp). effective()
        // degrades it to Collect everywhere. Collect/Interrupt pass through.
        assert_eq!(QueueMode::Passthrough.effective(), QueueMode::Collect);
        assert_eq!(QueueMode::Collect.effective(), QueueMode::Collect);
        assert_eq!(QueueMode::Interrupt.effective(), QueueMode::Interrupt);
    }

    #[test]
    fn prompt_queue_enqueue_and_drain() {
        let mut q = PromptQueue::new();
        assert!(q.pending.is_empty());
        q.enqueue("a".into());
        q.enqueue("b".into());
        assert_eq!(q.pending.len(), 2);
        let merged = q.drain_merged();
        assert!(q.pending.is_empty());
        assert!(merged.contains("a") && merged.contains("b"));
    }

    #[test]
    fn is_substantive_prompt_filters_trivial_openers() {
        for t in ["hi", "ls", "继续", "y", "q", "  ", "ok"] {
            assert!(!is_substantive_prompt(t), "expected non-substantive: {:?}", t);
        }
        for t in ["帮我 review 这段代码", "fix the auth bug", "解释一下这个函数的作用"] {
            assert!(is_substantive_prompt(t), "expected substantive: {:?}", t);
        }
    }

    #[test]
    fn sanitize_title_cleans_and_truncates() {
        assert_eq!(sanitize_title("  修复登录 bug  "), Some("修复登录 bug".to_string()));
        assert_eq!(sanitize_title("\"带引号标题\""), Some("带引号标题".to_string()));
        assert_eq!(sanitize_title("标题：配置中心重构"), Some("配置中心重构".to_string()));
        assert_eq!(sanitize_title("第一行\n第二行"), Some("第一行".to_string()));
        let long = "一二三四五六七八九十一二三四五六七八";
        assert_eq!(sanitize_title(long).unwrap().chars().count(), 16);
        assert_eq!(sanitize_title("   "), None);
        assert_eq!(sanitize_title(""), None);
    }

    #[test]
    fn sanitize_title_strips_label_prefixes() {
        // 真实 live bad sample:模型受 prompt "Language: Chinese" 影响,把
        // "中文标题:" 当成内容输出 → 名字坏成 "中文标题:Claude 模型默认"。
        // sanitize 必须剥掉任意 <标签词><冒号> 前缀,而非硬编几个固定串。
        assert_eq!(sanitize_title("中文标题:Claude 模型默认"), Some("Claude 模型默认".to_string()));
        assert_eq!(sanitize_title("中文标题：配置中心"), Some("配置中心".to_string()));
        assert_eq!(sanitize_title("会话标题: 项目架构"), Some("项目架构".to_string()));
        assert_eq!(sanitize_title("Session Title: Deploy LiteLLM"), Some("Deploy LiteLLM".to_string()));
        // 前缀剥离后再去引号:剥 + 去引号叠加。
        assert_eq!(sanitize_title("标题：\"重构\""), Some("重构".to_string()));
        // 不该误伤:正文里含"标题"二字但不是前缀冒号形态 → 整体保留。
        assert_eq!(sanitize_title("给文章起标题"), Some("给文章起标题".to_string()));
    }

    #[test]
    fn queued_event_serializes_to_ephemeral_contract() {
        // Locks the cross-layer contract: ws_handler (E7 ephemeral skip) matches on
        // type=="system" && subtype=="queued", and the frontend reads `count`.
        // If serde tags drift, the scrollback skip silently breaks → phantom hints
        // on reconnect. This test fails loudly if the wire shape changes.
        let json = serde_json::to_string(&AcpEvent::System {
            subtype: std::borrow::Cow::Borrowed("queued"),
            session_id: None,
            count: Some(3),
        })
        .unwrap();
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v.get("type").and_then(|t| t.as_str()), Some("system"));
        assert_eq!(v.get("subtype").and_then(|s| s.as_str()), Some("queued"));
        assert_eq!(v.get("count").and_then(|c| c.as_u64()), Some(3));
        // session_id is None → skipped, so reconnect/init parsing stays clean.
        assert!(v.get("session_id").is_none());
    }
}

#[cfg(test)]
mod running_summary_tests {
    use super::*;

    // 构造一个带 running 进程的会话,可指定类型/是否 source_task/turn_state。
    fn running_session(
        id: &str,
        stype: SessionType,
        source_task_id: Option<String>,
        turn: TurnState,
    ) -> Session {
        let (event_tx, _) = broadcast::channel(BROADCAST_CAPACITY);
        let (input_tx, _rx) = mpsc::channel::<SessionInput>(64);
        Session {
            id: id.into(),
            name: "n".into(),
            session_type: stype,
            cols: 80,
            rows: 24,
            work_dir: "/tmp".into(),
            owner_id: "o".into(),
            description: String::new(),
            name_is_auto: true,
            status: SessionMeta::Idle,
            resume_token: None,
            worktree_path: None,
            created_ms: 0,
            source_task_id,
            spawning: false,
            last_activity_ms: 0,
            turns_completed: 0,
            run_metrics: VecDeque::new(),
            lifetime_turns: 0,
            lifetime_duration_ms: 0,
            lifetime_cost_usd: 0.0,
            running: Some(RunningProcess {
                event_tx,
                input_tx,
                pty_pid: None,
                turn_state: turn,
                turn_started_ms: None,
                turn_seq: 0,
            }),
            scrollback: VecDeque::new(),
            scrollback_bytes: 0,
        }
    }

    fn mgr_with(sessions: Vec<Session>) -> (Arc<SessionManager>, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let events = Arc::new(crate::events::EventStore::open(dir.path()).unwrap());
        let store = Arc::new(crate::session_store::SessionStore::open(dir.path()).unwrap());
        let m = SessionManager::new(
            events, store,
            "claude".into(), "kiro-cli".into(), "codex".into(), "off".into(), "bash".into(), false,
        );
        // Wire a scheduled store: `scheduled` in the summary is now sourced from
        // the DB in-flight run count, so tests that exercise the scheduled gate
        // seed runs into this store (see `seed_active_run`).
        let sched = Arc::new(crate::scheduled_tasks::ScheduledStore::open(dir.path()).unwrap());
        m.set_scheduled_store(sched);
        {
            let mut map = m.sessions.lock().unwrap();
            for s in sessions { map.insert(s.id.clone(), s); }
        }
        (m, dir)
    }

    // Seed one scheduled run in the given non-terminal or terminal state, so
    // `running_summary().scheduled` (a DB count of claimed/running) is exercised.
    fn seed_active_run(m: &SessionManager, run_id: &str, task_id: &str, state: &str) {
        seed_active_run_bound(m, run_id, task_id, state, None);
    }

    // Same, but binds the run to a session_id (for the remove-session finalize path).
    fn seed_active_run_bound(m: &SessionManager, run_id: &str, task_id: &str, state: &str, session_id: Option<&str>) {
        let store = m.scheduled.lock().unwrap().clone().unwrap();
        let run = crate::scheduled_tasks::TaskRun {
            id: run_id.into(), task_id: task_id.into(), scheduled_for_ms: 1, state: "claimed".into(),
            session_id: None, verdict: None, failure_kind: None, started_ms: Some(1), ended_ms: None,
            input_snapshot: None, confirm_status: None, replay_of: None,
        };
        store.claim_run(&run).unwrap(); // inserts as 'claimed'
        // Bind session_id (backfilled via COALESCE) and move to the requested
        // state. For 'claimed' we still call set_run_state so the session binding
        // takes effect; claimed→claimed keeps the state, only backfilling the id.
        store.set_run_state(run_id, state, session_id, None, None, Some(2)).unwrap();
    }

    #[test]
    fn counts_interactive_running_turns_skipping_tmux_and_scheduled() {
        // interactive counts only non-source Running turns; the scheduled session
        // is counted via the DB run below, not its in-memory turn_state.
        let (m, _tmp) = mgr_with(vec![
            running_session("a", SessionType::Claude, Some("task1".into()), TurnState::Running),
            running_session("b", SessionType::Codex, None, TurnState::Running),
            running_session("c", SessionType::Claude, None, TurnState::Idle),
            running_session("d", SessionType::Tmux, None, TurnState::Running),
        ]);
        seed_active_run(&m, "r1", "task1", "running");
        let s = m.running_summary();
        assert_eq!(s.scheduled, 1, "in-flight scheduled run blocks (DB count)");
        assert_eq!(s.interactive, 1, "only non-source running-turn agent counts as interactive");
    }

    #[test]
    fn idle_scheduled_session_does_not_block_after_run_finalized() {
        // A completed scheduled Claude run lingers Idle with running=Some (the
        // persistent `claude -p` process isn't reaped). Once its DB run reaches a
        // terminal state, it must NOT keep `scheduled` pinned at ≥1 — that
        // permanently blocked background auto-update (gate E1: scheduled>0 never
        // force-punches through). This is the 8a5dc74 fix, now DB-sourced.
        let (m, _tmp) = mgr_with(vec![
            running_session("a", SessionType::Claude, Some("task1".into()), TurnState::Idle),
        ]);
        seed_active_run(&m, "r1", "task1", "succeeded"); // finalized
        let s = m.running_summary();
        assert_eq!(s.scheduled, 0, "finalized scheduled run must not block auto-update");
        assert_eq!(s.interactive, 0);
    }

    #[test]
    fn scheduled_startup_window_blocks_before_turn_marks_running() {
        // Regression (8a5dc74 opened this): a scheduled run's `claude -p` child is
        // spawned and the session inserted with turn_state=Idle, and the DB row
        // set to `claimed`/`running`, BEFORE the fan-out marks the turn Running.
        // Gating on in-memory turn_state saw scheduled==0 in that window → auto-
        // update could `systemctl stop` and cgroup-kill the live child. The DB
        // count is set at claim time (pre-spawn), so it blocks across the window.
        let (m, _tmp) = mgr_with(vec![
            // process alive, session in map, but turn not yet Running:
            running_session("a", SessionType::Claude, Some("task1".into()), TurnState::Idle),
        ]);
        seed_active_run(&m, "r1", "task1", "claimed"); // claimed, turn not started
        let s = m.running_summary();
        assert_eq!(s.scheduled, 1, "claimed run blocks even before the turn marks Running");
    }

    #[test]
    fn removing_scheduled_session_midturn_finalizes_its_run() {
        // Regression the DB-count fix would otherwise introduce: deleting a
        // scheduled session mid-turn (HTTP DELETE → remove_session) closes the
        // fan-out via channel-close WITHOUT hitting its boundary block, so the
        // normal finalize_run never fires. With scheduled now counted from the DB,
        // a lingering `running` row would block auto-update until the next restart.
        // remove_session must finalize the in-flight run bound to the session.
        let (m, _tmp) = mgr_with(vec![
            running_session("sess1", SessionType::Claude, Some("task1".into()), TurnState::Running),
        ]);
        seed_active_run_bound(&m, "r1", "task1", "running", Some("sess1"));
        assert_eq!(m.running_summary().scheduled, 1, "in-flight run blocks before removal");
        assert!(m.remove_session("sess1"));
        assert_eq!(m.running_summary().scheduled, 0,
            "removing the scheduled session must finalize its run so auto-update isn't wedged");
    }

    #[test]
    fn all_idle_when_no_running_agents_and_no_active_runs() {
        let (m, _tmp) = mgr_with(vec![
            running_session("c", SessionType::Claude, None, TurnState::Idle),
            running_session("d", SessionType::Tmux, None, TurnState::Running),
        ]);
        let s = m.running_summary();
        assert_eq!(s.scheduled, 0);
        assert_eq!(s.interactive, 0);
    }

    // Scrollback eviction must never drop the just-appended frame, even when
    // that single frame exceeds the byte cap. Otherwise a reconnecting client
    // replays an EMPTY buffer for a turn that produced a large tool_result
    // (agent content blocks are not pre-capped like user prompts are).
    #[test]
    fn oversized_single_frame_survives_eviction_for_replay() {
        let (m, _tmp) = mgr_with(vec![running_session(
            "s", SessionType::Codex, None, TurnState::Running,
        )]);
        // One frame strictly larger than the whole cap.
        let big = "x".repeat(SCROLLBACK_MAX_BYTES + 1024);
        m.push_scrollback("s", big.clone());
        let history = m.get_scrollback("s");
        // The oversized frame is retained (not self-evicted to empty).
        assert_eq!(history, vec![big.clone()], "oversized tail must survive");

        // A subsequent frame pushes the now-over-cap ring down: the OLD oversized
        // frame is evicted, the NEW tail is kept — buffer is never wiped to empty.
        m.push_scrollback("s", "next".to_string());
        let history2 = m.get_scrollback("s");
        assert_eq!(history2, vec!["next".to_string()], "new tail retained, old oversized evicted");
    }

    /// 像 running_session，但返回接收端供断言"发了什么"。
    /// 复用 running_session 的字段构造，避免 Session 字段增改时两处漂移。
    fn running_session_observable(
        id: &str,
        stype: SessionType,
    ) -> (Session, mpsc::Receiver<SessionInput>) {
        let (input_tx, rx) = mpsc::channel::<SessionInput>(64);
        let mut s = running_session(id, stype, None, TurnState::Idle);
        s.running.as_mut().unwrap().input_tx = input_tx;
        (s, rx)
    }

    // Build a running_session with an explicit last_activity_ms so the idle
    // filter can be exercised deterministically (running_session sets it to 0).
    fn aged_session(
        id: &str,
        source_task_id: Option<String>,
        turn: TurnState,
        last_activity_ms: i64,
    ) -> Session {
        let mut s = running_session(id, SessionType::Claude, source_task_id, turn);
        s.last_activity_ms = last_activity_ms;
        s
    }

    #[test]
    fn running_idle_too_long_targets_only_interactive_running_stale() {
        let now = 1_000_000i64;
        let idle = 30 * 60_000i64; // 30 min
        let stale_ts = now - idle - 1; // older than threshold
        let fresh_ts = now - 1; // within threshold
        let (m, _tmp) = mgr_with(vec![
            // interactive + Running + stale  → SHOULD be killed
            aged_session("kill_me", None, TurnState::Running, stale_ts),
            // interactive + Running + fresh  → too recent, skip
            aged_session("fresh", None, TurnState::Running, fresh_ts),
            // interactive + Idle + stale     → not in a turn, skip
            aged_session("idle_interactive", None, TurnState::Idle, stale_ts),
            // scheduled + Running + stale     → has its own reconcile path, skip
            aged_session("scheduled", Some("task1".into()), TurnState::Running, stale_ts),
            // exactly at threshold (>=)        → SHOULD be killed (boundary)
            aged_session("boundary", None, TurnState::Running, now - idle),
        ]);

        let mut got = m.running_idle_too_long(now, idle);
        got.sort();
        assert_eq!(got, vec!["boundary".to_string(), "kill_me".to_string()],
            "only interactive + Running + silent>=idle sessions; scheduled/idle/fresh excluded");
    }

    #[test]
    fn stuck_push_candidates_returns_id_owner_name() {
        let now = 10_000_000i64;
        let idle = 600_000i64; // 10 min
        let stale_ts = now - idle - 1; // older than threshold
        let fresh_ts = now - 1; // within threshold
        let (m, _tmp) = mgr_with(vec![
            // interactive + Running + stale  → SHOULD be a candidate
            aged_session("stuck_me", None, TurnState::Running, stale_ts),
            // interactive + Running + fresh  → too recent, skip
            aged_session("fresh", None, TurnState::Running, fresh_ts),
            // interactive + Idle + stale     → not in a turn, skip
            aged_session("idle_interactive", None, TurnState::Idle, stale_ts),
            // scheduled + Running + stale     → has its own reconcile path, skip
            aged_session("scheduled", Some("task1".into()), TurnState::Running, stale_ts),
        ]);

        let out = m.stuck_push_candidates(now, idle);
        assert_eq!(out.len(), 1, "only the interactive + Running + silent>=idle session is a candidate");
        let (id, owner, name) = &out[0];
        assert_eq!(id, "stuck_me");
        assert_eq!(owner, "o", "owner_id carried out for push (running_session seeds \"o\")");
        assert_eq!(name, "n", "name carried out for push (running_session seeds \"n\")");
        assert!(out.iter().any(|(id, owner, _name)| !id.is_empty() && !owner.is_empty()));
    }

    #[test]
    fn record_and_broadcast_bumps_last_activity_so_streaming_turn_is_not_killed() {
        // A turn that started long ago but is actively streaming must survive:
        // record_and_broadcast bumps last_activity_ms, so the watchdog sees recent
        // activity and does NOT kill it. A second, silent session IS killed.
        let now = now_millis();
        let idle = 30 * 60_000i64; // 30 min
        let long_ago = now - idle - 60_000; // turn started well past the threshold
        let (m, _tmp) = mgr_with(vec![
            aged_session("streaming", None, TurnState::Running, long_ago),
            aged_session("silent", None, TurnState::Running, long_ago),
        ]);

        // "streaming" receives a fresh event; "silent" does not.
        m.record_and_broadcast("streaming", "some output".to_string());

        let killed = m.running_idle_too_long(now_millis(), idle);
        assert_eq!(killed, vec!["silent".to_string()],
            "streaming session bumped last_activity_ms and must be spared; only the silent one is killed");
    }

    #[tokio::test]
    async fn send_timeout_kill_emits_timeout_kill_run_id_none() {
        let (s, mut rx) = running_session_observable("sid", SessionType::Claude);
        let (m, _tmp) = mgr_with(vec![s]);

        m.send_timeout_kill("sid", None).await;

        let got = rx.recv().await.expect("a TimeoutKill should have been sent");
        match got {
            SessionInput::TimeoutKill { run_id } => {
                assert!(run_id.is_none(), "watchdog kills interactive sessions with run_id=None");
            }
            _other => panic!("expected SessionInput::TimeoutKill variant"),
        }
    }

    #[tokio::test]
    async fn send_initial_prompt_passthrough_run_id_none() {
        let (s, mut rx) = running_session_observable("sid", SessionType::Claude);
        let (m, _tmp) = mgr_with(vec![s]);

        m.send_initial_prompt("sid", "查一下登录 bug").await;

        let got = rx.recv().await.expect("a prompt should have been sent");
        match got {
            SessionInput::Prompt { text, run_id, client_id } => {
                assert_eq!(text, "查一下登录 bug", "文本必须原样透传，无 verdict 追加");
                assert!(run_id.is_none(), "F1: 交互式启动 prompt 的 run_id 必须为 None");
                assert!(client_id.is_none());
            }
            _other => panic!("expected SessionInput::Prompt variant"),
        }
    }
}

#[cfg(test)]
mod emit_tests {
    use super::*;

    #[test]
    fn is_ephemeral_event_only_matches_queued() {
        let queued = AcpEvent::System {
            subtype: std::borrow::Cow::Borrowed("queued"),
            session_id: None,
            count: Some(3),
        };
        assert!(is_ephemeral_event(&queued));
        let init = AcpEvent::System {
            subtype: std::borrow::Cow::Borrowed("init"),
            session_id: None,
            count: None,
        };
        assert!(!is_ephemeral_event(&init));
    }

    #[test]
    fn truncate_prompt_for_scrollback_caps_and_marks() {
        let short = "hello";
        assert_eq!(truncate_prompt_for_scrollback(short), "hello");
        let big = "x".repeat(70_000);
        let out = truncate_prompt_for_scrollback(&big);
        assert!(out.len() < 70_000);
        assert!(out.contains("已截断"));
    }

    // Regression for the reconnect double-delivery race (review 2026-06-11).
    // The fix makes "snapshot scrollback + subscribe" atomic against "push
    // scrollback + broadcast". This test pins the boundary semantics directly
    // on the broadcast/VecDeque primitives the two SessionManager methods use:
    // an event recorded BEFORE the snapshot is in `history` and NOT in the
    // receiver; an event recorded AFTER is in the receiver and NOT in `history`.
    // No event is ever in both — which is exactly what prevents the duplicated
    // streaming chunk a reconnecting client used to see.
    #[test]
    fn snapshot_and_subscribe_partition_events_no_overlap() {
        use std::collections::VecDeque;
        let (event_tx, _keep) = broadcast::channel::<String>(BROADCAST_CAPACITY);
        let mut scrollback: VecDeque<String> = VecDeque::new();

        // Event emitted BEFORE the client connects: persisted, broadcast to
        // nobody (zero subscribers).
        scrollback.push_back("before".to_string());
        let _ = event_tx.send("before".to_string());

        // Atomic (single conceptual lock) snapshot + subscribe, exactly as
        // subscribe_with_history does: take history, THEN subscribe.
        let history: Vec<String> = scrollback.iter().cloned().collect();
        let mut rx = event_tx.subscribe();

        // Event emitted AFTER: persisted AND delivered to the live receiver.
        scrollback.push_back("after".to_string());
        let _ = event_tx.send("after".to_string());

        // Replay contains only the pre-connect event.
        assert_eq!(history, vec!["before".to_string()]);
        // Live receiver gets only the post-subscribe event — "before" is NOT
        // redelivered (the bug was that it would be, via a non-atomic gap).
        assert_eq!(rx.try_recv().unwrap(), "after");
        assert!(rx.try_recv().is_err()); // nothing else queued
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_run_metric_maps_fields() {
        let m = build_run_metric(
            "rid", "sess", "/w", "claude", 3,
            1000, 1700, // started, ended → duration 700
            crate::run_metrics::RunOutcome::Completed, None,
            Some(0.05), Some(10), Some(20),
        );
        assert_eq!(m.duration_ms, 700);
        assert_eq!(m.outcome, crate::run_metrics::RunOutcome::Completed);
        assert_eq!(m.cost_usd, Some(0.05));
        assert_eq!(m.turn_seq, 3);
    }
}

#[cfg(test)]
mod lifetime_tests {
    use super::*;

    fn make_manager() -> (Arc<SessionManager>, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let events = Arc::new(crate::events::EventStore::open(dir.path()).unwrap());
        let store = Arc::new(crate::session_store::SessionStore::open(dir.path()).unwrap());
        let mgr = SessionManager::new(
            events, store,
            "claude".into(), "kiro".into(), "codex".into(), "off".into(), "bash".into(), false,
        );
        (mgr, dir)
    }

    fn make_session(id: &str, owner: &str) -> Session {
        Session {
            id: id.into(),
            name: "n".into(),
            session_type: SessionType::Claude,
            cols: 80,
            rows: 24,
            work_dir: "/tmp".into(),
            owner_id: owner.into(),
            description: String::new(),
            name_is_auto: true,
            status: SessionMeta::Idle,
            resume_token: None,
            worktree_path: None,
            created_ms: 0,
            source_task_id: None,
            spawning: false,
            last_activity_ms: 0,
            turns_completed: 0,
            run_metrics: VecDeque::new(),
            lifetime_turns: 0,
            lifetime_duration_ms: 0,
            lifetime_cost_usd: 0.0,
            running: None,
            scrollback: VecDeque::new(),
            scrollback_bytes: 0,
        }
    }

    #[test]
    fn lifetime_accumulates_beyond_cap50() {
        let (mgr, _dir) = make_manager();
        let sid = "s-life";
        let s = make_session(sid, "owner1");
        mgr.sessions.lock().unwrap().insert(sid.into(), s);

        for i in 0..80u64 {
            let m = crate::run_metrics::RunMetric {
                run_id: format!("r{i}"),
                session_id: sid.into(),
                work_dir: "/w".into(),
                agent_type: "claude-code".into(),
                turn_seq: i,
                started_ms: 0,
                ended_ms: 100,
                duration_ms: 100,
                outcome: crate::run_metrics::RunOutcome::Completed,
                failure_kind: None,
                verdict: None,
                verdict_source: crate::run_metrics::VerdictSource::None,
                cost_usd: Some(0.01),
                tokens_in: None,
                tokens_out: None,
                input_snapshot_ref: None,
            };
            mgr.record_run_metric(sid, m);
        }

        let (lt, ld, lc) = mgr.session_lifetime(sid).unwrap();
        assert_eq!(lt, 80);               // not truncated by cap-50
        assert_eq!(ld, 8000);             // 80 × 100ms
        assert!((lc - 0.80).abs() < 1e-9); // 80 × 0.01
    }

    #[test]
    fn lifetime_cost_skips_none_but_counts_turn() {
        let (mgr, _dir) = make_manager();
        let sid = "s-none";
        let s = make_session(sid, "owner1");
        mgr.sessions.lock().unwrap().insert(sid.into(), s);

        for c in [Some(0.05), None, Some(0.03)] {
            let m = crate::run_metrics::RunMetric {
                run_id: "r".into(),
                session_id: sid.into(),
                work_dir: "/w".into(),
                agent_type: "claude-code".into(),
                turn_seq: 0,
                started_ms: 0,
                ended_ms: 50,
                duration_ms: 50,
                outcome: crate::run_metrics::RunOutcome::Completed,
                failure_kind: None,
                verdict: None,
                verdict_source: crate::run_metrics::VerdictSource::None,
                cost_usd: c,
                tokens_in: None,
                tokens_out: None,
                input_snapshot_ref: None,
            };
            mgr.record_run_metric(sid, m);
        }

        let (lt, ld, lc) = mgr.session_lifetime(sid).unwrap();
        assert_eq!(lt, 3);                 // includes None turn
        assert_eq!(ld, 150);               // 3 × 50
        assert!((lc - 0.08).abs() < 1e-9); // 0.05 + 0.03, skip None
    }
}

#[cfg(test)]
mod cost_diff_integration_guard_tests {
    #[test]
    fn diff_cost_only_applies_to_claude_label() {
        // 文档化不变量:非 claude-code label 不调用 diff_cost(Kiro/Codex cost 恒 None)。
        // 这里断言纯函数对 None 输入的恒等行为,作为接入处的回归锚点。
        let (d, p) = crate::run_metrics::diff_cost(Some(0.0), None, true, false);
        assert_eq!(d, None);
        assert_eq!(p, Some(0.0));
    }
}
