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

/// Smallest terminal size a client may impose. A hidden (display:none) xterm's
/// FitAddon falls back to ~10x5; with tmux `window-size latest` that tiny size
/// would become the shared window size and truncate every TUI in it.
pub const MIN_COLS: u16 = 20;
pub const MIN_ROWS: u16 = 5;
/// Size used when a persisted row carries a corrupted (below-minimum) size.
const DEFAULT_COLS: u16 = 80;
const DEFAULT_ROWS: u16 = 24;

pub fn resize_is_sane(cols: u16, rows: u16) -> bool {
    cols >= MIN_COLS && rows >= MIN_ROWS
}

use crate::acp::process::{AcpEvent, AcpProcess};
use crate::pty_bridge::PtyHandle;

#[derive(Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionMeta {
    Running,
    Done,
    Blocked,
    Idle,
    Ended,
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
            SessionMeta::Ended => write!(f, "ended"),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionType {
    Tmux,
    Claude,
    Codex,
    Crew,
}

/// 自动命名器后端：决定 auto-titler 调用哪个 CLI。
#[derive(Debug, Clone, Copy)]
pub enum TitlerBackend { Claude, Codex, Crew }

impl std::fmt::Display for SessionType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SessionType::Tmux => write!(f, "tmux"),
            SessionType::Claude => write!(f, "claude"),
            SessionType::Codex => write!(f, "codex"),
            SessionType::Crew => write!(f, "crew"),
        }
    }
}

impl SessionType {
    /// 从持久化字符串还原；未知值回落 Tmux（最保守，PTY 无 resume 副作用）。
    pub fn from_str_lenient(s: &str) -> Self {
        match s {
            "claude" => SessionType::Claude,
            "codex" => SessionType::Codex,
            "crew" => SessionType::Crew,
            _ => SessionType::Tmux,
        }
    }
}

/// 跨进程恢复会话上下文的令牌，按后端区分。持久化为 (kind, value) 两列。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResumeToken {
    Claude(String), // --resume <session_id>
    Codex(String),  // codex-reply threadId
    Tmux(String),   // tmux attach -t <target>
    /// Crew: the Gateway slot key (`zmx-xxxxxxxx`). Not a session id — reconnect
    /// confirms it with `GET /api/chat/slots/{key}` and re-attaches; the
    /// conversation state lives on the Gateway, so this is a MORE reliable resume
    /// than the other three backends'.
    Crew(String),
}

#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TmuxOrigin { Own, External }

impl TmuxOrigin {
    pub fn as_str(self) -> &'static str { match self { Self::Own => "own", Self::External => "external" } }
    pub fn from_str_lenient(s: &str) -> Self { if s == "external" { Self::External } else { Self::Own } }
}

impl ResumeToken {
    /// 拆成持久化用的 (kind, value)。
    pub fn to_kind_value(&self) -> (&'static str, String) {
        match self {
            ResumeToken::Claude(v) => ("claude", v.clone()),
            ResumeToken::Codex(v) => ("codex", v.clone()),
            ResumeToken::Tmux(v) => ("tmux", v.clone()),
            ResumeToken::Crew(v) => ("crew", v.clone()),
        }
    }

    /// 从持久化的 (kind, value) 还原。未知 kind 返回 None。
    pub fn from_kind_value(kind: &str, value: &str) -> Option<Self> {
        match kind {
            "claude" => Some(ResumeToken::Claude(value.to_string())),
            "codex" => Some(ResumeToken::Codex(value.to_string())),
            "tmux" => Some(ResumeToken::Tmux(value.to_string())),
            "crew" => Some(ResumeToken::Crew(value.to_string())),
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
    /// ACP: prompt text + optional scheduled-run id for exactly-once
    /// finalization (None for manual user prompts). `client_id` is the optional
    /// browser-generated id used to dedupe the optimistic user bubble against the
    /// server echo (G3, T1); None for scheduled runs.
    Prompt { text: String, run_id: Option<String>, client_id: Option<String> },
    /// ACP: cancel/kill
    Cancel,
    /// ACP: turn-level interrupt (abort current turn, keep process alive)
    Interrupt,
    /// ACP/Codex: switch the per-session queue handling mode for
    /// multiple in-flight prompts (collect / interrupt / passthrough).
    SetQueueMode(QueueMode),
    /// Watchdog→fan-out: 超时终结当前 run。让超时和完成/错/取消一样从 fan-out
    /// 单一出口走,run_metrics 与 finalize_run 天然一致(评审 P0)。
    TimeoutKill { run_id: Option<String> },
    /// Crew: 审批回执（approve / reject）。仅 Crew fan-out 消费；其余 fan-out
    /// 静默丢弃（与 PtyData 对 agent fan-out 的处理同构）。
    Approval { approval_id: String, action: String },
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

    /// Stable wire string, sent in `replay_done` so a reconnecting client adopts the
    /// authoritative mode. Passthrough is already `effective()`-degraded to Collect
    /// before it is ever stored, so it never reaches the wire, but map it to
    /// "collect" for completeness (the client only branches on == "collect").
    pub fn to_str(self) -> &'static str {
        match self {
            QueueMode::Interrupt => "interrupt",
            QueueMode::Passthrough => "collect",
            QueueMode::Collect => "collect",
        }
    }

    /// Passthrough cannot work under the current single-`turn_seq` /
    /// `boundary_count` fan-out machinery on ANY backend:
    /// - Codex (codex_process.rs): drops a prompt that arrives mid-turn, so the
    ///   2nd prompt is lost AND `turn_seq` was already bumped → `boundary_count`
    ///   can never catch up → the session wedges in Running ("thinking…") forever.
    /// - Claude/Crew: the single `turn_seq` stamps the still-streaming prior
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
    /// True iff `scheduled` was forced to 1 by a DB READ ERROR (not a real in-flight
    /// run). The gate still fails CLOSED either way, but the caller uses this to log
    /// the TRUE cause: a persistent scheduled.db fault (disk full / SQLITE_CORRUPT)
    /// blocks auto-update forever, and "blocked by scheduled run(s)" would misdirect
    /// an operator away from the real IO fault. Diagnosability only. (review 2026-07-26,
    /// F-SCHED-LOG)
    pub scheduled_read_failed: bool,
}

/// Fail-CLOSED reduction of the scheduled in-flight run count for the E1 gate.
/// `None` = no scheduler store wired → genuinely 0. `Some(Ok(n))` = the DB truth.
/// `Some(Err(_))` = a store IS wired but its read failed (transient JuiceFS/SQLite
/// error): we must NOT report 0, or the gate would treat "DB unreadable" as "no
/// scheduled run" and cgroup-kill a scheduled agent in its startup window (before
/// turn_state marks Running, when this count is the sole backstop). Report 1 to
/// block the upgrade until the next tick can read the DB. (F-SCHED-FAILOPEN-1)
fn scheduled_count_fail_closed(count: Option<Result<i64, String>>) -> usize {
    match count {
        None => 0,
        Some(Ok(n)) => n.max(0) as usize,
        Some(Err(_)) => 1,
    }
}

/// Whether a session's current turn is owned by a live scheduled run and thus must
/// be excluded from the interactive watchdogs (kill / stuck-push).
/// `scheduled` is `inflight_scheduled_sessions()`'s output: `Some(set)` = authoritative
/// DB truth (exclude iff in the set); `None` = the DB read FAILED, so we fail CLOSED
/// and exclude EVERY scheduled session (`source_task_id.is_some()`) rather than reap
/// one whose liveness we can't currently confirm. (F-SCHED-FAILOPEN-1)
fn scheduled_owned(
    scheduled: &Option<std::collections::HashSet<String>>,
    s: &Session,
) -> bool {
    match scheduled {
        Some(set) => set.contains(&s.id),
        None => s.source_task_id.is_some(),
    }
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
    /// The fan-out task's current queue mode, mirrored here on every delivered
    /// `SetQueueMode` so a (re)connecting client can learn the AUTHORITATIVE mode
    /// from `replay_done` instead of guessing. The fan-out is spawned once per
    /// session and its local `queue_mode` persists across WS reconnects (a
    /// transient reconnect returns `AlreadyRunning`, no respawn), so the client's
    /// own memory of the mode is wrong after a reconnect; only the backend knows.
    /// Defaults to Collect at construction, matching the fan-out's own default —
    /// so a genuine process respawn correctly reports Collect. (review 2026-07-26)
    queue_mode: QueueMode,
}

pub fn now_millis() -> i64 {
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
    /// Some for tmux-backed terminals (resume_token is Tmux(name)); None for
    /// legacy bare-shell PTYs and agent sessions.
    tmux_origin: Option<TmuxOrigin>,
    /// Set by DELETE on tmux sessions: hidden from lists, killed when due (T5).
    pending_kill_until: Option<i64>,
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
    /// Triage "at a glance" fields (spec v3 M2). In-memory, lock-only.
    posture: Posture,
    /// 运行态；None = 未运行（可按 resume_token 重生）。
    running: Option<RunningProcess>,
    /// Output history for replay on reconnect (base64 for PTY, JSON for ACP agents)
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
    codex_path: String,
    codex_reasoning: String,
    /// Kiro Crew Gateway 的端口与数据目录。与 `codex_reasoning` 同理在构造时捕获：
    /// `ensure_running` 重生一个会话时只有 session id + 存储的元数据，没有调用者
    /// 能供给这些值。**secret 不在此处** —— 它由 `crew_process.rs` 在 fan-out 栈上
    /// 从 `crew_home` 现读，绝不进这个结构体（它会被共享）。
    crew_port: u16,
    crew_home: String,
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
    /// Fuzzy-search indexes, wired at startup. The turn-end hook asks it to rescan
    /// the session's work_dir when that lies inside the vault. None in tests.
    search: Mutex<Option<Arc<crate::fuzzy_index::SearchIndexes>>>,
    /// OAuth (multi-user) mode, wired at startup. Claude sessions refuse
    /// cross-session messages in this mode (spec 2026-09-26 v2).
    oauth_mode: std::sync::atomic::AtomicBool,
    /// Per-run metrics writer channel. `record_run_metric` pushes into the
    /// session's in-memory VecDeque (under lock) and then `try_send`s here
    /// (outside the lock) so the async writer fsyncs off the conversation path.
    run_metrics_tx: tokio::sync::mpsc::Sender<crate::run_metrics::RunMetric>,
    /// tmux control (socket + `-N`); every terminal is a tmux session on it.
    tmux: crate::tmux::TmuxCtl,
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
    pub tmux_name: Option<String>,
    pub tmux_origin: Option<TmuxOrigin>,
    pub other_clients: u32,
    pub peer_name: Option<String>,
    pub last_outcome: Option<&'static str>,
    pub last_outcome_ms: Option<i64>,
    pub last_snippet: Option<String>,
    pub current_step: Option<String>,
    pub pending_approvals: u32,
    pub lifetime_cost_usd: f64,
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
    source_task_id: Option<String>,
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
            source_task_id: s.source_task_id.clone(),
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
                // A superseded turn (interrupt-resend) never settles, and an approval
                // answered elsewhere sends no receipt: a new turn starts with none (A9).
                session.posture.approval_ids.clear();
                session.posture.turn_snippet = None;
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

/// Claude Code cross-session address for a ZeroMux Claude session. Derived from
/// the session id (stable across resume/respawn); ASCII-only so peers can type
/// it without quoting. `zmx-ai-` (not `zmx-`) so it can't be mistaken for a tmux
/// terminal name `zmx-<id8>` (spec 2026-09-26 v3 §1a).
fn peer_name_for(id: &str) -> String {
    let n = id.char_indices().nth(6).map(|(i, _)| i).unwrap_or(id.len());
    format!("zmx-ai-{}", &id[..n])
}

/// Accept peer messages only for interactive sessions in legacy (single-user)
/// mode. OAuth tenants share one OS user, so the CLI's socket isolation does not
/// separate them; scheduled runs are unattended.
fn claude_inbound(oauth_mode: bool, source_task_id: Option<&str>) -> crate::acp::process::Inbound {
    if oauth_mode || source_task_id.is_some() {
        crate::acp::process::Inbound::Refuse
    } else {
        crate::acp::process::Inbound::Accept
    }
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
        tmux_name: match (&s.resume_token, s.tmux_origin) {
            (Some(ResumeToken::Tmux(n)), Some(_)) => Some(n.clone()),
            _ => None,
        },
        tmux_origin: s.tmux_origin,
        other_clients: 0,
        peer_name: (s.session_type == SessionType::Claude).then(|| peer_name_for(&s.id)),
        last_outcome: s.posture.last_outcome.map(crate::run_metrics::RunOutcome::as_str),
        last_outcome_ms: s.posture.last_outcome_ms,
        last_snippet: s.posture.last_snippet.clone(),
        current_step: s.posture.current_step.clone(),
        pending_approvals: s.posture.approval_ids.len() as u32,
        lifetime_cost_usd: s.lifetime_cost_usd,
    }
}

impl SessionManager {
    pub fn new(
        events: Arc<EventStore>,
        store: Arc<SessionStore>,
        claude_path: String,
        codex_path: String,
        codex_reasoning: String,
        crew_port: u16,
        crew_home: String,
        shell: String,
        worktree_isolation: bool,
        tmux: crate::tmux::TmuxCtl,
    ) -> Arc<Self> {
        let mgr = Arc::new(Self {
            sessions: Mutex::new(HashMap::new()),
            events,
            store,
            self_weak: Mutex::new(Weak::new()),
            claude_path,
            codex_path,
            codex_reasoning,
            crew_port,
            crew_home,
            shell,
            worktree_isolation,
            scheduled: Mutex::new(None),
            push: Mutex::new(None),
            search: Mutex::new(None),
            oauth_mode: std::sync::atomic::AtomicBool::new(false),
            run_metrics_tx: crate::run_metrics::spawn_writer(),
            tmux,
        });
        *mgr.self_weak.lock().unwrap() = Arc::downgrade(&mgr);
        mgr
    }

    pub fn tmux(&self) -> &crate::tmux::TmuxCtl {
        &self.tmux
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

    /// Wire the search indexes (called once at startup).
    pub fn set_search(&self, s: Arc<crate::fuzzy_index::SearchIndexes>) {
        *self.search.lock().unwrap() = Some(s);
    }

    /// Wire the auth mode (called once at startup).
    pub fn set_oauth_mode(&self, on: bool) {
        self.oauth_mode.store(on, std::sync::atomic::Ordering::Relaxed);
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

    /// Authoritative queue mode of a session's live fan-out, as a wire string.
    /// Sent in `replay_done` so a (re)connecting client adopts the true mode instead
    /// of guessing: the fan-out is spawned once per session and keeps its mode across
    /// transient WS reconnects (which return `AlreadyRunning`, no respawn), so the
    /// client's own memory is wrong after a reconnect and a second observer tab never
    /// learned it at all. `None` if the session has no live process (client then keeps
    /// its default). Mirrored from the fan-out via `mark_queue_mode`. (review 2026-07-26)
    pub fn queue_mode(&self, id: &str) -> Option<&'static str> {
        self.sessions
            .lock()
            .unwrap()
            .get(id)
            .and_then(|s| s.running.as_ref())
            .map(|rp| rp.queue_mode.to_str())
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

    /// Session IDs currently backed by an in-flight (`claimed`/`running`) scheduled
    /// run — the DB truth for "a scheduled run owns this session's current turn".
    /// The interactive watchdogs subtract this set so they reap an interactive
    /// follow-up on a *finished* scheduled session (which has no such row) without
    /// double-handling a session whose scheduled run is still live (owned by
    /// `reconcile_timeouts_per_task`). Same DB source as `running_summary().scheduled`,
    /// keeping the gate and the watchdogs consistent (d7cb58d parity).
    ///
    /// Returns `None` when a store is wired but its read FAILED (transient
    /// JuiceFS/SQLite error): the caller must then fail CLOSED and exclude every
    /// scheduled session (`source_task_id.is_some()`) rather than reap one whose DB
    /// truth is momentarily unavailable — a premature interactive TimeoutKill of a
    /// genuinely-live scheduled turn would be an E1-adjacent kill. `Some(set)` is the
    /// authoritative in-flight set (empty set = no scheduler wired OR none in flight).
    /// (review 2026-07-25, F-SCHED-FAILOPEN-1)
    fn inflight_scheduled_sessions(&self) -> Option<std::collections::HashSet<String>> {
        let store = { self.scheduled.lock().unwrap().clone() };
        match store {
            None => Some(std::collections::HashSet::new()), // no scheduler wired
            Some(s) => s
                .inflight_bound_sessions()
                .ok()
                .map(|v| v.into_iter().collect()),
        }
    }

    /// Watchdog: find sessions whose current turn is Running and silent for at least
    /// `idle_ms` (true wedge detection) AND is NOT backed by an in-flight scheduled
    /// run. `last_activity_ms` is bumped on every persisted event in
    /// `record_and_broadcast`, so an actively-streaming long turn is NOT killed.
    /// Keying on the DB in-flight set (not `source_task_id`) is deliberate: a
    /// lingering finished-scheduled session accepts interactive follow-ups
    /// (run_id:None, no DB row), and those must be reaped when they wedge — the gap
    /// d7cb58d closed in the gate but left open here. A session with a LIVE scheduled
    /// run is excluded — `reconcile_timeouts_per_task` owns it (no double-kill).
    /// Pure filter over the in-memory map; the caller sends TimeoutKill.
    pub fn running_idle_too_long(&self, now_ms: i64, idle_ms: i64) -> Vec<String> {
        let scheduled = self.inflight_scheduled_sessions();
        let map = self.sessions.lock().unwrap();
        map.values()
            .filter(|s| !scheduled_owned(&scheduled, s))
            .filter(|s| s.running.as_ref().map(|rp| rp.turn_state == TurnState::Running).unwrap_or(false))
            .filter(|s| now_ms - s.last_activity_ms >= idle_ms)
            .map(|s| s.id.clone())
            .collect()
    }

    /// Candidates for a stuck-push: sessions whose current turn is Running but silent
    /// for >= idle_ms and not backed by an in-flight scheduled run. Returns
    /// (session_id, owner_id, name) so the caller can push without re-locking.
    /// Mirrors running_idle_too_long's filter; that one kills, this one notifies.
    pub fn stuck_push_candidates(&self, now_ms: i64, idle_ms: i64) -> Vec<(String, String, String)> {
        let scheduled = self.inflight_scheduled_sessions();
        let map = self.sessions.lock().unwrap();
        map.values()
            .filter(|s| !scheduled_owned(&scheduled, s))
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
        if let Err(e) = self.store.upsert(&persisted_of(s)) {
            tracing::warn!("persist session {} failed: {}", s.id, e);
        }
    }

    /// Spawn a tmux/PTY process for `id` rooted at `work_dir`, start its fan-out
    /// task, and return the live handle. `tmux_name` Some → `tmux new-session -A -s <name>`
    /// (attach-or-create, via TmuxCtl); None → legacy bare shell.
    /// Shared by `create_pty_session` and `ensure_running`.
    fn spawn_tmux(
        &self,
        id: &str,
        work_dir: &str,
        cols: u16,
        rows: u16,
        tmux_name: Option<&str>,
    ) -> Result<RunningProcess, String> {
        let cwd = if work_dir.is_empty() || work_dir == "." {
            None
        } else {
            Some(work_dir)
        };
        let argv: Vec<String>;
        let (cmd, args): (&str, Vec<&str>) = if let Some(name) = tmux_name {
            argv = self.tmux.attach_argv(name, cwd);
            ("tmux", argv.iter().map(String::as_str).collect())
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
        let is_tmux = tmux_name.is_some();

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
                                // tmux terminals keep NO byte scrollback: the tmux server holds
                                // the real history and repaints via refresh-client on connect.
                                if let Some(m) = mgr_weak.upgrade() {
                                    if is_tmux { m.broadcast_pty(&sid, b64); }
                                    else { m.record_and_broadcast(&sid, b64, true, None); }
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
            // The tmux client exited. If the tmux SESSION is gone too (killed from
            // VSCode, or its last shell exited), this terminal is over — mark Ended
            // so the next connect shows the overlay instead of recreating.
            if let Some(m) = mgr_weak.upgrade() {
                if let Some((name, _)) = m.tmux_binding(&sid_for_exit) {
                    if let Ok(false) = m.tmux.has(&name).await {
                        if m.mark_ended(&sid_for_exit) {
                            // Not a deliberate close (that path removes the session
                            // before killing, so tmux_binding above would be None) —
                            // the terminal ended on its own. Push in the background
                            // so the fan-out isn't blocked on network.
                            if let (Some(p), Some(owner)) = (m.push_handle(), m.owner_of(&sid_for_exit)) {
                                let title = m.session_name(&sid_for_exit).unwrap_or_default();
                                let sid3 = sid_for_exit.clone();
                                tokio::spawn(async move {
                                    p.send_to_user(&owner, &crate::push::payload_for("term_ended", &title, &sid3, None, None)).await;
                                });
                            }
                        }
                    }
                }
            }
        });

        Ok(RunningProcess {
            event_tx,
            input_tx,
            pty_pid: pid,
            turn_state: TurnState::Idle,
            turn_started_ms: None,
            turn_seq: 0,
            queue_mode: QueueMode::Collect,
        })
    }

    pub async fn create_pty_session(
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

        let (tmux_name, origin) = match tmux_target {
            // Adopting a zeromux leftover: it's ours, recreate-on-loss semantics apply.
            Some(t) if t.starts_with("zmx-") => (t.to_string(), TmuxOrigin::Own),
            Some(t) => (t.to_string(), TmuxOrigin::External),
            None => (crate::tmux::tmux_name_for(&id), TmuxOrigin::Own),
        };
        // Refuse rather than fall back to a bare shell: a bare shell silently
        // loses the "survives deploy / attach from VSCode" promise.
        match tmux_target {
            // Attach target must already exist: never let `new-session -A` create
            // a stray session under a user-chosen name.
            // Already bound to a zeromux session: a second binding would let closing
            // either one kill-session the other's live shell.
            Some(t) if self.tracked_tmux_names().contains(t) => return Err("该 tmux 会话已被接入".into()),
            Some(t) => match self.tmux.has(t).await {
                Ok(true) => {}
                Ok(false) => return Err(crate::tmux::TmuxError::NotFound.to_string()),
                Err(e) => return Err(e.to_string()),
            },
            None => {
                self.tmux.run(&["list-sessions"]).await.or_else(|e| match e {
                    crate::tmux::TmuxError::NotFound => Ok(String::new()), // server up, 0 sessions
                    e => Err(e.to_string()),
                })?;
            }
        }
        let running = self.spawn_tmux(&id, work_dir, cols, rows, Some(&tmux_name))?;

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
            resume_token: Some(ResumeToken::Tmux(tmux_name.clone())),
            tmux_origin: Some(origin),
            pending_kill_until: None,
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
            posture: Posture::default(),
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
        source_task_id: Option<&str>,
    ) -> Result<RunningProcess, String> {
        let peer_name = peer_name_for(id);
        let inbound = claude_inbound(
            self.oauth_mode.load(std::sync::atomic::Ordering::Relaxed), source_task_id);
        let process = AcpProcess::spawn(&self.claude_path, work_dir, resume, &peer_name, inbound)
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
            queue_mode: QueueMode::Collect,
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
            .spawn_claude(&id, &effective_dir.to_string_lossy(), owner_id, None, source_task_id.as_deref())
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
            tmux_origin: None,
            pending_kill_until: None,
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
            posture: Posture::default(),
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
        let count = {
            let store = self.scheduled.lock().unwrap().clone();
            store.map(|s| s.active_run_count())
        };
        // Fail CLOSED on a DB read error: a store is wired but its count is
        // unreadable (transient JuiceFS/SQLite IO error), so we must assume an
        // in-flight scheduled run MAY exist and block the upgrade — never treat
        // "DB unreadable" as "0 scheduled" (that would let the E1 gate cgroup-kill
        // a scheduled agent in its startup window, when turn_state isn't Running
        // yet and this DB count is the sole backstop). No store = no scheduler
        // wired = genuinely 0. (review 2026-07-25, F-SCHED-FAILOPEN-1)
        let scheduled_read_failed = matches!(count, Some(Err(_)));
        let scheduled = scheduled_count_fail_closed(count);
        let map = self.sessions.lock().unwrap();
        let mut interactive = 0;
        for s in map.values() {
            if !matches!(s.session_type,
                SessionType::Claude | SessionType::Codex | SessionType::Crew) {
                continue; // tmux 无 turn 概念,不阻塞升级
            }
            // 任何内存 turn_state==Running 的 agent 会话都算 interactive —— 包括对
            // 已结束调度会话发起的交互式追问。此前这里 `source_task_id.is_some()` 直接
            // continue,假设调度会话的活跃全由上面 DB 计数覆盖;但该假设只在调度 run
            // *进行中* 成立:run 结束 finalize 后 `claude -p` 子进程 Idle 常驻不回收
            // (从不 remove_session),用户可对这个残留会话发交互式追问(run_id:None →
            // turn_state=Running 但**无** DB run 行)。那样 scheduled==0 且 interactive
            // 也漏计 → gate 判全 idle → systemctl stop 连 cgroup 杀掉正在飞行的交互
            // turn(E1,且比普通交互 turn 更糟:零 WaitInteractive 宽限)。改数 turn_state
            // 不会重演 8a5dc74 死锁:那修的是"只要会话存活就算"(进程永不回收 → 永久
            // 阻塞);turn 边界(见下方 fanout)对 source_task 会话也无条件 mark(Idle),
            // 故残留 Idle 会话贡献 0;调度 run 进行中则 active_run_count≥1,gate 用
            // scheduled>0 短路,双计无害。
            let Some(rp) = s.running.as_ref() else { continue };
            if rp.turn_state == TurnState::Running {
                interactive += 1;
            }
        }
        RunningSummary { interactive, scheduled, scheduled_read_failed }
    }

    /// Create the agent session for a scheduled run, mark the run running, and
    /// inject the goal prompt carrying the run_id (so the fan-out finalizes it).
    ///
    /// `agent_type` is the task's stored backend label. Before this it was a DEAD
    /// field: `trigger_run` hardcoded `create_acp_session_tagged` (Claude) and never
    /// read it. It is now read through `scheduled_session_type` — the single place
    /// where a new scheduled backend gets wired in.
    pub async fn trigger_run(
        &self,
        run_id: &str,
        name: String,
        work_dir: &str,
        owner_id: &str,
        task_id: &str,
        prompt: String,
        agent_type: &str,
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
        // default terminal size for unattended sessions.
        // 分派按 `scheduled_session_type(agent_type)` —— 在本任务之前这里硬编码
        // Claude，`agent_type` 根本没被读。目前所有值都映射 Claude（见该函数的
        // 文档注释：Crew/Codex 的 fan-out 缺 run 终结机制，放行会卡死 E1 门），
        // 所以这是**行为等价**的重构 + 日后放行的接入点。
        // 穷尽 match(不写 `_`)是刻意的:日后 scheduled_session_type 放行一个新
        // SessionType 时,这里会**编译失败**而不是静默落进兜底臂开一个 Claude 会话。
        let sid = match scheduled_session_type(agent_type) {
            SessionType::Claude
            // 这三个分支当前**不可达**(scheduled_session_type 只产出 Claude);
            // 列出来是为了让穷尽性检查在放行时报错。放行某个后端时把它从这里
            // 挪出去,配一个 create_<backend>_session_tagged。
            | SessionType::Crew
            | SessionType::Codex
            | SessionType::Tmux => self
                .create_acp_session_tagged(
                    name,
                    &canonical_str,
                    80,
                    24,
                    owner_id,
                    Some(task_id.to_string()),
                )
                .await?,
        };
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
                // 记真实分派的类型（而不是 task 上存的字符串）—— replay 才不会
                // 因为 config 被改成一个尚未放行的后端而换掉行为。
                "agent_type": scheduled_session_type(agent_type).to_string(),
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
        // 快照里的 agent_type 是 trigger 时**真实分派**的类型（见 trigger_run 的
        // set_input_snapshot），所以 replay 重放的是原 run 的后端，而不是 config
        // 现在的值。缺字段的老快照回落 "claude"（当时唯一可能的分派）。
        let agent_type = v["agent_type"].as_str().unwrap_or("claude").to_string();
        self.trigger_run(new_run_id, name, &work_dir, owner_id, task_id, prompt, &agent_type).await
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
            queue_mode: QueueMode::Collect,
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
            tmux_origin: None,
            pending_kill_until: None,
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
            posture: Posture::default(),
            running: Some(running),
            scrollback: VecDeque::new(),
            scrollback_bytes: 0,
        };

        self.persist_meta(&session);
        self.sessions.lock().unwrap().insert(id.clone(), session);
        Ok(id)
    }

    /// Spawn a Crew session for `id` at `work_dir`, start its fan-out, return the
    /// live handle. `resume` carries a slot key from a previous run.
    async fn spawn_crew(
        &self,
        id: &str,
        work_dir: &str,
        owner_id: &str,
        resume: Option<String>,
    ) -> Result<RunningProcess, String> {
        let cfg = crate::acp::crew_process::CrewConfig::new(
            std::path::PathBuf::from(&self.crew_home),
            self.crew_port,
        );
        let process = crate::acp::crew_process::CrewProcess::spawn(
            cfg, work_dir, resume.as_deref(),
        )
        .await
        .map_err(|e| format!("Failed to start Crew session: {}", e))?;

        let (event_tx, _) = broadcast::channel(BROADCAST_CAPACITY);
        let (input_tx, input_rx) = mpsc::channel::<SessionInput>(64);

        spawn_crew_fanout(
            id.to_string(),
            process,
            event_tx.clone(),
            input_rx,
            self.events.clone(),
            "crew",
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
            queue_mode: QueueMode::Collect,
        })
    }

    pub async fn create_crew_session(
        &self,
        name: String,
        work_dir: &str,
        cols: u16,
        rows: u16,
        owner_id: &str,
    ) -> Result<String, String> {
        let id = uuid::Uuid::new_v4().to_string();
        // worktree 隔离对 Crew **不适用**：cwd 由 Gateway 管（我们 POST project），
        // 所以传 false 而不是 self.worktree_isolation（spec §7）。
        let (effective_dir, worktree_path) = resolve_work_dir(work_dir, &id, false);

        let running = self
            .spawn_crew(&id, &effective_dir.to_string_lossy(), owner_id, None)
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
            session_type: SessionType::Crew,
            cols,
            rows,
            work_dir: effective_dir.to_string_lossy().to_string(),
            owner_id: owner_id.to_string(),
            description: String::new(),
            name_is_auto: true,
            status: SessionMeta::Running,
            resume_token: None,
            tmux_origin: None,
            pending_kill_until: None,
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
            posture: Posture::default(),
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
        let Some(SpawnPlan { stype, resume_token: token, work_dir, owner_id, cols, rows, source_task_id }) = plan else {
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
                | (SessionType::Codex, Some(ResumeToken::Codex(_)))
                | (SessionType::Tmux, Some(ResumeToken::Tmux(_)))
                | (SessionType::Crew, Some(ResumeToken::Crew(_)))
        );
        let result = match stype {
            SessionType::Claude => {
                let r = match &token {
                    Some(ResumeToken::Claude(s)) => Some(s.as_str()),
                    _ => None,
                };
                self.spawn_claude(id, &work_dir, &owner_id, r, source_task_id.as_deref()).await
            }
            SessionType::Codex => {
                let r = match &token {
                    Some(ResumeToken::Codex(t)) => Some(t.clone()),
                    _ => None,
                };
                self.spawn_codex(id, &work_dir, &owner_id, r).await
            }
            SessionType::Crew => {
                let r = match &token {
                    Some(ResumeToken::Crew(s)) => Some(s.clone()),
                    _ => None,
                };
                self.spawn_crew(id, &work_dir, &owner_id, r).await
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
                    SessionType::Claude => self.spawn_claude(id, &work_dir, &owner_id, None, source_task_id.as_deref()).await,
                    SessionType::Codex => self.spawn_codex(id, &work_dir, &owner_id, None).await,
                    SessionType::Crew => self.spawn_crew(id, &work_dir, &owner_id, None).await,
                    // tmux: no bare-shell fallback — a bare shell silently loses
                    // persistence. Preflight already decided Lost/Ended/ServerDown.
                    SessionType::Tmux => Err(e.clone()),
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
                s.pending_kill_until.is_none() && owner_filter
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
            // Drop this session's push-debounce state (both maps are insert-only,
            // keyed by (user_id, session_id)) so they don't accumulate dead keys for
            // the lifetime of the process.
            if let Some(push) = self.push_handle() {
                push.forget_session(id);
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

    /// tmux terminals: live broadcast only. The tmux server holds the real
    /// history; on (re)connect we `refresh-client` instead of replaying bytes.
    /// Still bumps `last_activity_ms` so the sidebar's "recent activity" stays live.
    fn broadcast_pty(&self, id: &str, data: String) {
        let mut map = self.sessions.lock().unwrap();
        if let Some(s) = map.get_mut(id) {
            s.last_activity_ms = now_millis();
            if let Some(rp) = &s.running { let _ = rp.event_tx.send(data); }
        }
    }

    /// Atomically push an event to scrollback AND broadcast it under a SINGLE
    /// lock (review 2026-06-11). Pairs with `subscribe_with_history`: because
    /// both the persist+broadcast here and the snapshot+subscribe there happen
    /// under the same `sessions` mutex, a reconnecting client can never observe
    /// an event in both its replay and its live stream. `broadcast::send` is
    /// synchronous, so holding the std mutex across it does not block on I/O.
    /// Returns the broadcast result (Err == zero live subscribers; persistence
    /// still happened — that is the whole point, see T2).
    fn record_and_broadcast(&self, id: &str, data: String, bump_activity: bool, delta: Option<PostureDelta>) {
        let mut map = self.sessions.lock().unwrap();
        if let Some(s) = map.get_mut(id) {
            // Most persisted events (ContentBlock/Result/…) are real forward
            // progress, so bump last_activity_ms here. This makes it a true silence
            // timestamp (updated within a turn, not just at turn boundaries), which
            // the interactive watchdog (running_idle_too_long) relies on to avoid
            // killing healthy long-running turns. Lock already held; no await/I/O.
            //
            // `bump_activity=false` is passed ONLY for a mid-turn error-styled
            // ContentBlock (see emit): a repeated Codex `codex/event` error storm on
            // a tools/call that never resolves is NOT agent progress — counting it as
            // activity would keep resetting the 30-min silence clock so the watchdog
            // never fires and the turn wedges Running forever (F-CODEX-1-CLOCK, review
            // 2026-07-29). Still persisted + broadcast so the user sees the error; it
            // just doesn't pretend the agent is making progress.
            if bump_activity {
                s.last_activity_ms = now_millis();
            }
            if let Some(d) = delta {
                apply_posture_delta(&mut s.posture, d);
            }
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

    /// A turn truly settled (not a Claude SkipBoundary): record its outcome and
    /// clear per-turn posture. Called beside `record_run_metric` in each fan-out.
    fn settle_posture(&self, sid: &str, outcome: crate::run_metrics::RunOutcome) {
        {
            let mut map = self.sessions.lock().unwrap();
            let Some(s) = map.get_mut(sid) else { return };
            s.posture.last_outcome = Some(outcome);
            s.posture.last_outcome_ms = Some(now_millis());
            s.posture.current_step = None;
            s.posture.approval_ids.clear();
            // A failed turn has no summary of its own; don't show the previous turn's (A10).
            if matches!(outcome, crate::run_metrics::RunOutcome::Errored | crate::run_metrics::RunOutcome::Timeout) {
                s.posture.last_snippet = None;
            }
        }
        // U3: lock released above — never hold `sessions` across SQLite I/O.
        self.persist_posture(sid);
    }

    /// Push body source: this turn's own Result snippet, if any.
    fn push_snippet(&self, sid: &str) -> Option<String> {
        self.sessions.lock().unwrap().get(sid).and_then(|s| s.posture.turn_snippet.clone())
    }

    /// U3: snapshot the persisted posture subset under the sessions lock, then write
    /// it OUTSIDE the lock (SQLite on JuiceFS can be slow). Best-effort: a failed
    /// write only warns — the fan-out must never stall on persistence.
    fn persist_posture(&self, sid: &str) {
        let snap = {
            let map = self.sessions.lock().unwrap();
            let Some(s) = map.get(sid) else { return };
            persisted_posture_of(&s.posture)
        };
        if let Err(e) = self.store.update_posture(sid, &snap) {
            tracing::warn!("persist posture {} failed: {}", sid, e);
        }
    }

    /// The browser answered one Crew approval (the Gateway sends no receipt).
    fn approval_resolved(&self, sid: &str, approval_id: &str) {
        let mut map = self.sessions.lock().unwrap();
        if let Some(s) = map.get_mut(sid) {
            s.posture.approval_ids.retain(|x| x != approval_id);
            // The human's answer is forward progress (else triage shows 可能卡住 right after approving an old request).
            s.last_activity_ms = now_millis();
        }
    }

    /// Mirror the fan-out's current queue mode into the Session so `queue_mode()`
    /// (→ `replay_done`) can report the authoritative value to reconnecting/observer
    /// clients. Called by each fan-out on every delivered `SetQueueMode`. Brief lock,
    /// no await held — see `mark_turn`. No-op if the session's process is gone.
    fn mark_queue_mode(&self, sid: &str, mode: QueueMode) {
        let mut map = self.sessions.lock().unwrap();
        if let Some(rp) = map.get_mut(sid).and_then(|s| s.running.as_mut()) {
            rp.queue_mode = mode;
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

    /// 返回当前 owner 的任一活 Crew 会话的 Gateway slot key。
    /// 记忆写入需要 `X-Session-Key: <已存在的 slot>`（实测：缺头 →
    /// `missing_session_key`，给不存在的 slot → `unknown session`），而 slot key
    /// 只存在于 `ResumeToken::Crew` 里 —— `SessionInfo` 不带它，也不该带
    /// （那会把它暴露给前端，而前端无需知道 slot 命名）。
    pub fn any_crew_slot_key(&self, owner_id: &str) -> Option<String> {
        let map = self.sessions.lock().unwrap();
        map.values()
            .filter(|s| s.session_type == SessionType::Crew && s.owner_id == owner_id)
            .find_map(|s| match &s.resume_token {
                Some(ResumeToken::Crew(k)) if !k.is_empty() => Some(k.clone()),
                _ => None,
            })
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
            // Self-heal rows corrupted by hidden-view resizes (e.g. 10x5) so a
            // respawn doesn't create a tiny PTY.
            let (cols, rows) = if resize_is_sane(p.cols, p.rows) {
                (p.cols, p.rows)
            } else {
                (DEFAULT_COLS, DEFAULT_ROWS)
            };
            map.insert(
                id,
                Session {
                    id: p.id,
                    name: p.name,
                    session_type: p.session_type,
                    cols,
                    rows,
                    work_dir: p.work_dir,
                    owner_id: p.owner_id,
                    description: p.description,
                    name_is_auto: p.name_is_auto,
                    status: SessionMeta::Idle,
                    tmux_origin: match (&p.resume_token, p.tmux_origin.as_deref()) {
                        (Some(ResumeToken::Tmux(_)), Some(o)) => Some(TmuxOrigin::from_str_lenient(o)),
                        // Pre-migration rows: zeromux-made names are ours, anything else was attached.
                        (Some(ResumeToken::Tmux(n)), None) => Some(if n.starts_with("zmx-") { TmuxOrigin::Own } else { TmuxOrigin::External }),
                        _ => None,
                    },
                    pending_kill_until: p.pending_kill_until,
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
                    posture: Posture {
                        last_outcome: p.posture.last_outcome.as_deref()
                            .and_then(crate::run_metrics::RunOutcome::parse_lenient),
                        last_outcome_ms: p.posture.last_outcome_ms,
                        last_snippet: p.posture.last_snippet,
                        awaiting_input: p.posture.awaiting_input,
                        ..Posture::default()
                    },
                    running: None,
                    scrollback: VecDeque::new(),
                    scrollback_bytes: 0,
                },
            );
        }
    }

    pub fn set_size(&self, id: &str, cols: u16, rows: u16) {
        let changed = match self.sessions.lock().unwrap().get_mut(id) {
            Some(s) if (s.cols, s.rows) != (cols, rows) => { s.cols = cols; s.rows = rows; true }
            _ => false,
        };
        if changed { let _ = self.store.update_size(id, cols, rows); }
    }

    /// Decide how a connecting terminal client should proceed BEFORE ensure_running
    /// spawns anything. Own+missing → Lost (ensure_running's `new-session -A`
    /// recreates it under the same name); External+missing → Ended (never spawn:
    /// someone else closed it).
    pub async fn tmux_preflight(&self, id: &str) -> Preflight {
        let (name, origin) = {
            let map = self.sessions.lock().unwrap();
            let Some(s) = map.get(id) else { return Preflight::Ready };
            if matches!(s.status, SessionMeta::Ended) { return Preflight::Ended; }
            if s.running.is_some() { return Preflight::Ready; }
            match (&s.resume_token, s.tmux_origin) {
                (Some(ResumeToken::Tmux(n)), Some(o)) => (n.clone(), o),
                _ => return Preflight::Ready,
            }
        };
        let decision = match self.tmux.has(&name).await {
            Ok(exists) => decide_tmux_resume(origin, exists),
            Err(_) => return Preflight::ServerDown,
        };
        if matches!(decision, Preflight::Ended) { self.mark_ended(id); }
        decision
    }

    /// Never clears `running` and never touches a running/spawning session: a
    /// concurrent respawn that won the race must not be dropped.
    /// Returns true iff this call actually transitioned the session to Ended
    /// (false if the session was missing, already Ended, or a respawn won the
    /// race) — the fan-out exit path uses this to push `term_ended` exactly
    /// once, only on a real transition.
    fn mark_ended(&self, id: &str) -> bool {
        if let Some(s) = self.sessions.lock().unwrap().get_mut(id) {
            if s.running.is_none() && !s.spawning && s.status != SessionMeta::Ended {
                s.status = SessionMeta::Ended;
                return true;
            }
        }
        false
    }

    /// Look up a session's owner_id. Returns None if the session doesn't exist.
    pub fn owner_of(&self, id: &str) -> Option<String> {
        self.sessions.lock().unwrap().get(id).map(|s| s.owner_id.clone())
    }

    /// "新建同名会话": the tmux session is now zeromux's own.
    pub fn revive(&self, id: &str) -> bool {
        let snapshot = {
            let mut map = self.sessions.lock().unwrap();
            let Some(s) = map.get_mut(id) else { return false };
            if !matches!(s.status, SessionMeta::Ended) { return false; }
            s.status = SessionMeta::Idle;
            s.tmux_origin = Some(TmuxOrigin::Own);
            persisted_of(s)
        };
        if let Err(e) = self.store.upsert(&snapshot) { tracing::warn!("persist revive {} failed: {}", id, e); }
        true
    }

    pub fn mark_pending_kill(&self, id: &str, now: i64) -> bool {
        let until = now + PENDING_KILL_MS;
        {
            let mut map = self.sessions.lock().unwrap();
            let Some(s) = map.get_mut(id) else { return false };
            if s.tmux_origin.is_none() { return false; }
            s.pending_kill_until = Some(until);
        }
        let _ = self.store.set_pending_kill(id, Some(until));
        true
    }

    pub fn restore(&self, id: &str) -> bool {
        {
            let mut map = self.sessions.lock().unwrap();
            let Some(s) = map.get_mut(id) else { return false };
            if s.pending_kill_until.take().is_none() { return false; }
        }
        let _ = self.store.set_pending_kill(id, None);
        true
    }

    /// Explicit close path — the ONE place (with reconcile) that runs
    /// `tmux kill-session`. Deliberately not in Drop: detach / fan-out exit must
    /// never kill the user's tmux session.
    pub async fn finalize_pending_kill(&self, id: &str, now: i64) -> bool {
        let (name, ended) = {
            let map = self.sessions.lock().unwrap();
            match map.get(id) {
                Some(s) if s.pending_kill_until.is_some_and(|t| t <= now) => match &s.resume_token {
                    Some(ResumeToken::Tmux(n)) => (n.clone(), matches!(s.status, SessionMeta::Ended)),
                    _ => return false,
                },
                _ => return false,
            }
        };
        // Remove FIRST so the fan-out's exit check finds no binding and doesn't
        // report this deliberate close as "ended elsewhere" / push it.
        let removed = self.remove_session(id);
        // Ended = our binding is already gone; a session now holding that name is
        // someone else's (e.g. re-created in VSCode) and must not be killed.
        if !ended {
            if let Err(e) = self.tmux.kill(&name).await {
                tracing::warn!("kill tmux {} for {} failed: {}", name, id, e);
            }
        }
        removed
    }

    /// Startup: every close still inside its undo window when the previous
    /// process died is executed now (the undo UI died with it).
    pub async fn reconcile_pending_kills(&self) {
        let ids: Vec<String> = self.sessions.lock().unwrap().values()
            .filter(|s| s.pending_kill_until.is_some()).map(|s| s.id.clone()).collect();
        for id in ids {
            if let Some(s) = self.sessions.lock().unwrap().get_mut(&id) { s.pending_kill_until = Some(0); }
            self.finalize_pending_kill(&id, now_millis()).await;
        }
    }

    pub async fn close_check(&self, id: &str) -> Option<CloseCheck> {
        let (name, origin, running) = {
            let map = self.sessions.lock().unwrap();
            let s = map.get(id)?;
            // Dead binding: nothing to warn about (and the name may belong to someone else now).
            if matches!(s.status, SessionMeta::Ended) { return None; }
            match (&s.resume_token, s.tmux_origin) {
                (Some(ResumeToken::Tmux(n)), Some(o)) => (n.clone(), o, s.running.is_some()),
                _ => return None,
            }
        };
        let info = self.tmux.info(&name).await.ok();
        Some(CloseCheck {
            external: origin == TmuxOrigin::External,
            other_clients: info.as_ref().map(|i| i.attached.saturating_sub(running as u32)).unwrap_or(0),
            busy_command: info.map(|i| i.current_command).filter(|c| !SHELLS.contains(&c.as_str())),
        })
    }

    /// Names of every tmux session bound to a zeromux session — including ones
    /// pending kill, so a just-closed window doesn't reappear as "host tmux".
    pub fn tracked_tmux_names(&self) -> std::collections::HashSet<String> {
        self.sessions.lock().unwrap().values().filter_map(|s| match (&s.resume_token, s.tmux_origin) {
            (Some(ResumeToken::Tmux(n)), Some(_)) => Some(n.clone()),
            _ => None,
        }).collect()
    }

    pub fn tmux_binding(&self, id: &str) -> Option<(String, TmuxOrigin)> {
        let map = self.sessions.lock().unwrap();
        let s = map.get(id)?;
        match (&s.resume_token, s.tmux_origin) {
            (Some(ResumeToken::Tmux(n)), Some(o)) => Some((n.clone(), o)),
            _ => None,
        }
    }

    /// Get session type for a given id
    pub fn session_type(&self, id: &str) -> Option<SessionType> {
        self.sessions.lock().unwrap().get(id).map(|s| s.session_type)
    }

    /// Push output data to the scrollback buffer (base64 for PTY, JSON for ACP agents)
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

// ── Fan-out tasks for ACP agent processes ──

/// Auto-log a `task_done` agent event when a process reports a turn result.
///
/// Called from every agent fan-out task on each emitted `AcpEvent`. Only the
/// `Result` variant produces an event — all agents (Claude/Crew/Codex)
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

/// 定时任务的 `agent_type` → `SessionType`。
///
/// `agent_type` 是 DB 里的自由字符串（`scheduled_tasks.rs:357`），所以映射必须显式
/// 且有回落。**回落 Claude 是保持现状**：`trigger_run` 在本任务之前一直硬编码
/// Claude，生产库里唯一一行也是 `'claude'`。
///
/// 未知值不 fail 而是回落，理由：定时任务是无人值守的，一个 fail 会让 run 静默
/// 失败并进 failed 终态；回落到一个能跑的后端至少留下可读的输出。
///
/// **为什么 `"crew"` / `"codex"` 目前也回落 Claude（而不是各自的 SessionType）**：
/// 只有 `spawn_acp_fanout`（Claude）实现了 scheduled-run 的终结机制 ——
/// `active_run_id` 窗口 + 边界上按终态事件 `finalize_run(succeeded/failed)` +
/// 被抢占时的 `finalize_active_run_if_scheduled`。`spawn_crew_fanout` 与
/// `spawn_codex_fanout` **各自 `finalize_run` 出现 0 次**（它们的 `run_id.is_some()`
/// 臂会正常发 prompt，但把 run_id 丢掉）。
///
/// 若在补齐 fan-out 之前放行，后果是确定性的、且无人值守时看不见：
/// 1. `agent_task_runs` 那行永远停在 `state='running'`；
/// 2. `active_run_count()`（数 `state IN ('claimed','running')`）永久 ≥1；
/// 3. `auto_update.rs` 的门见 `summary.scheduled > 0` → **永久阻塞自动升级**
///    （该分支注释原文「永不强制穿透」）；
/// 4. 该任务的 overlap guard wedge → 后续每次触发都被记 `skipped`；
/// 5. 直到看门狗按 `idle_timeout_min`（默认 60 分钟）把它标成
///    `aborted` + `watchdog_timeout` —— 即每个这样的 run 都必然记为超时失败。
///
/// **放行的前置条件**：给对应 fan-out 补上 `active_run_id` + `finalize_run`
/// （照 `spawn_acp_fanout` 的形状，含 `maybe_push_turn_done` 的
/// `active_run_id.is_none()` 门，否则调度 run 会误发交互式 turn_done push），
/// 然后把这里的臂改成对应 `SessionType`，并写 `create_<backend>_session_tagged`
/// （目前只有 `create_acp_session_tagged` 存在）。
fn scheduled_session_type(agent_type: &str) -> SessionType {
    match agent_type {
        // 放行时在此加臂 —— 见上面的前置条件。当前刻意没有 "crew" / "codex" 臂。
        _ => SessionType::Claude,
    }
}

/// Build the persisted row for a session (pure; callable under the sessions lock).
fn persisted_of(s: &Session) -> PersistedSession {
    PersistedSession {
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
        tmux_origin: s.tmux_origin.map(|o| o.as_str().to_string()),
        cols: s.cols,
        rows: s.rows,
        pending_kill_until: s.pending_kill_until,
        posture: persisted_posture_of(&s.posture),
        crew_mode: String::new(),
        crew_agent: String::new(),
        crew_origin: "zeromux".into(),
    }
}

pub const PENDING_KILL_MS: i64 = 5_000;

#[derive(Debug, serde::Serialize)]
pub struct CloseCheck { pub external: bool, pub other_clients: u32, pub busy_command: Option<String> }

const SHELLS: &[&str] = &["bash", "zsh", "sh", "fish", "dash"];

pub enum Preflight { Ready, Lost, Ended, ServerDown }

/// Pure resume decision for a non-running tmux-backed terminal.
pub fn decide_tmux_resume(origin: TmuxOrigin, exists: bool) -> Preflight {
    match (exists, origin) {
        (true, _) => Preflight::Ready,
        (false, TmuxOrigin::Own) => Preflight::Lost,
        (false, TmuxOrigin::External) => Preflight::Ended,
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
            s.posture.current_step = None;
            s.posture.approval_ids.clear();
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

/// Crew 的 slot_key 来源有两个：spawn 开局那条 `System{init}`，与每轮的 `Result`。
/// 双臂是必需的 —— 单看 Result 会让一个从未完成过一轮的会话拿不到 resume token。
fn crew_slot_key(evt: &AcpEvent) -> Option<String> {
    match evt {
        AcpEvent::System { session_id: Some(s), .. } if !s.is_empty() => Some(s.clone()),
        AcpEvent::Result { session_id, .. } if !session_id.is_empty() => Some(session_id.clone()),
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

/// A turn whose FIFO intent is `Cancelled` (user Cancel/Interrupt) or `Timeout`
/// (watchdog kill) was DELIBERATELY aborted — it did not genuinely complete or fail.
/// Both the `turn_done` push ("✅ 完成") and the scheduled `run_failed` push
/// ("⚠️ 失败 · 进程退出") must suppress on this: the abort's real outcome is surfaced
/// elsewhere (the metric's intent-override classification, and — for a side-effecting
/// scheduled task — the watchdog's `confirm` push). Sending either here would lie about
/// the cause and, for run_failed, double-notify. Single source of truth for both call
/// sites so they can't drift. (review 2026-08-12, F-RUNFAILED-INTENT.)
fn intent_suppresses_push(intent: Option<crate::run_metrics::RunOutcome>) -> bool {
    matches!(
        intent,
        Some(crate::run_metrics::RunOutcome::Cancelled)
            | Some(crate::run_metrics::RunOutcome::Timeout)
    )
}

/// Turn-end hook: if this session works inside the Obsidian vault, rescan its
/// work_dir so notes the agent just wrote become searchable now (1a has no
/// watcher). Deliberately NOT gated on active_run_id — scheduled runs write
/// notes too. Reads only `work_dir`; never touches the process (fan-out
/// invariant). Lock-in/lock-out: clone the Arc, release, then call.
fn maybe_mark_vault_dirty(mgr: &Weak<SessionManager>, work_dir: &str) {
    let Some(m) = mgr.upgrade() else { return };
    let si = m.search.lock().unwrap().clone();
    if let Some(si) = si {
        si.reconcile_vault_dir(std::path::Path::new(work_dir));
    }
}

/// Fire the "turn finished while you were away" Web Push for a settling
/// interactive turn. Shared by all three agent fan-outs so the notification
/// reaches Claude, Crew AND Codex sessions identically — the block used to live
/// only in `spawn_acp_fanout`, so Crew/Codex turns silently never pushed
/// (review 2026-08-06, F4). Callers gate on the settling boundary and pass the
/// turn duration (read from the FIFO front BEFORE `settle()` consumes it). The
/// debounce/away-gate (`should_push_turn_done`) and the actual send run inside a
/// spawned task — never await in the fan-out select loop.
///
/// `outcome` is the settling turn's INTENT — the caller passes
/// `turn_starts.front_intent()`, i.e. the intent stamped on THIS turn's own FIFO
/// entry (`Some` for a turn the user explicitly Cancelled/Interrupted or the
/// watchdog Timeout-killed). The turn_done payload is worded "✅ 完成 / 本轮已结束"
/// (success), so firing it for a cancelled or timed-out turn tells the user their
/// aborted turn *completed successfully* — a lie. Suppress the push for those
/// outcomes; a Completed turn or a plain agent-side Error (which still "finished")
/// is a legitimate turn_done. (review 2026-08-07 F3; per-turn FIFO intent so a
/// coupled interrupt-resend can't cross-contaminate — 2026-08-08 F2.) Same
/// suppression across all three fan-outs.
fn maybe_push_turn_done(
    mgr: &Weak<SessionManager>,
    sid: &str,
    owner_id: &str,
    dur_ms: i64,
    outcome: Option<crate::run_metrics::RunOutcome>,
) {
    // A turn the user aborted (Cancel/Interrupt → Cancelled) or the watchdog
    // killed (Timeout) did NOT complete — never tell the user "✅ 完成".
    if intent_suppresses_push(outcome) {
        return;
    }
    if let Some(m) = mgr.upgrade() {
        if let Some(p) = m.push_handle() {
            let now = now_millis();
            let name = m.session_name(sid).unwrap_or_default();
            let body = m.push_snippet(sid).and_then(|s| crate::push::push_body_of(&s));
            let uid = owner_id.to_string();
            let sid2 = sid.to_string();
            tokio::spawn(async move {
                if crate::push::should_push_turn_done(now, p.last_turn_push(&uid, &sid2), dur_ms) {
                    p.mark_turn_pushed(&uid, &sid2, now);
                    p.send_to_user(&uid, &crate::push::payload_for("turn_done", &name, &sid2, None, body.as_deref())).await;
                }
            });
        }
    }
}

/// Gate for the run_done push at the scheduled `Result` arm: that arm is entered by
/// EVENT TYPE, so a Cancelled/Timeout-killed run whose CLI still emits a Result
/// would otherwise push "⏰ 完成" (spec §2.3). Same intent source as turn_done.
fn run_done_push_allowed(intent: Option<crate::run_metrics::RunOutcome>) -> bool {
    !intent_suppresses_push(intent)
}

/// F2: a scheduled run finished successfully. Routine band (D8); called only from the
/// `finalize_run(…, "succeeded", …)` arm, and the caller gates it on
/// `run_done_push_allowed(intent)` because a Cancelled/Timeout run can still reach
/// that arm via a Result. Body: verdict > this turn's snippet > default.
/// Dedupes against turn_done's (uid,sid) debounce map (spec §2.2): suppressed if
/// that session pushed within the last 30s, then marks the map. A scheduled turn
/// never also fires turn_done (gated on `active_run_id.is_none()`), so in practice
/// this throttles back-to-back runs / a just-preceding interactive turn_done.
fn maybe_push_run_done(mgr: &Weak<SessionManager>, sid: &str, owner_id: &str, verdict: Option<&str>) {
    let Some(m) = mgr.upgrade() else { return };
    let Some(p) = m.push_handle() else { return };
    let name = m.session_name(sid).unwrap_or_default();
    let body = verdict.and_then(crate::push::push_body_of)
        .or_else(|| m.push_snippet(sid).and_then(|s| crate::push::push_body_of(&s)));
    let (uid, sid2, now) = (owner_id.to_string(), sid.to_string(), now_millis());
    tokio::spawn(async move {
        if !crate::push::should_push_run_done(now, p.last_turn_push(&uid, &sid2)) {
            return;
        }
        p.mark_turn_pushed(&uid, &sid2, now);
        p.send_to_user(&uid, &crate::push::payload_for("run_done", &name, &sid2, None, body.as_deref())).await;
    });
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
        // single slot would mis-attribute both — see TurnStarts). Each entry also
        // carries INTENT (Cancel/Interrupt→Cancelled, TimeoutKill→Timeout), stamped
        // on the LIVE turn's entry via `set_live_intent` from the input branch, so
        // it overrides the terminal-event inference for exactly that turn.
        let mut turn_starts = TurnStarts::default();
        // Spec 2026-09-26 §2d: set by a TurnOrigin marker, consumed by the very
        // next boundary: that boundary ends a CLI-started turn.
        let mut pending_origin = false;
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
                            // TurnOrigin / StdinEcho are fan-out-internal markers:
                            // update attribution state and drop them (never emitted,
                            // persisted or logged — spec 2026-09-26 v2 §2d).
                            if let AcpEvent::TurnOrigin { kind } = &evt {
                                tracing::debug!("claude[{}]: next boundary ends a CLI-started turn ({})", sid, kind);
                                pending_origin = true;
                                continue;
                            }
                            if matches!(evt, AcpEvent::StdinEcho) {
                                turn_starts.mark_echoed();
                                continue;
                            }
                            let evt = cap_peer_message(evt);
                            let step = classify_claude_event(
                                local_running, &evt, pending_origin,
                                turn_starts.front_is_external() || turn_starts.front_is_echoed());
                            if step == ClaudeStep::StartExternal {
                                // The CLI started a turn on its own (peer message or
                                // background-task notification). Same four steps as a
                                // stdin prompt so busy/metrics/push/queue all see a
                                // real turn.
                                tracing::info!("claude[{}]: CLI-started turn (external)", sid);
                                turn_seq += 1;
                                local_running = true;
                                turn_starts.start_external(now_millis());
                                if let Some(m) = mgr.upgrade() {
                                    m.mark_turn(&sid, TurnState::Running, turn_seq);
                                }
                                // Flush-only-while-Idle invariant: a collect window armed
                                // after the previous turn must not fire mid external turn.
                                // Pending prompts are kept; this turn's boundary re-arms.
                                queue.disarm();
                            }
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
                            // The origin marker belongs to exactly this boundary.
                            if is_boundary {
                                pending_origin = false;
                            }
                            let skip_boundary = step == ClaudeStep::SkipBoundary;
                            if skip_boundary {
                                tracing::info!(
                                    "claude[{}]: origin-tagged boundary before our prompt was echoed; not settling",
                                    sid);
                            }
                            emit(&mgr, &sid, &event_tx, turn_seq, &evt);
                            // Tee to events.ndjson for the active scheduled run's turn.
                            // Scoped to active_run_id window: fires for every event from
                            // prompt-injection until active_run_id.take() at the boundary.
                            if let Some(rid) = &active_run_id {
                                if let Ok(line) = serde_json::to_string(&evt) {
                                    append_run_event(rid, &line);
                                }
                            }
                            if is_boundary && !skip_boundary {
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
                                // dur AND intent read from the FIFO front (the settling
                                // turn's own entry) BEFORE settle() consumes it — so a
                                // Cancelled/Timeout turn is suppressed and coupled
                                // interrupt-resend turns don't cross-contaminate
                                // (review 2026-08-07 F3; 2026-08-08 F2).
                                if boundary_count >= turn_seq && active_run_id.is_none() {
                                    let dur = turn_starts.front().map(|s| now_millis() - s).unwrap_or(0);
                                    maybe_push_turn_done(&mgr, &sid, &owner_id, dur, turn_starts.front_intent());
                                }
                                // Vault reconcile runs for EVERY settling turn (scheduled
                                // runs write notes too), unlike the turn_done push above
                                // which is gated on active_run_id.is_none().
                                if boundary_count >= turn_seq {
                                    maybe_mark_vault_dirty(&mgr, &work_dir);
                                }
                                // Whether the settling turn was DELIBERATELY aborted
                                // (user Cancel / watchdog Timeout stamped its FIFO
                                // intent). Read from the front BEFORE settle() consumes
                                // it — same source `maybe_push_turn_done` and the metric
                                // classifier use. The `run_failed` push below must honor
                                // it too: a Timeout kill is already surfaced via the
                                // scheduler's `confirm` push (side-effecting) or is a
                                // deliberate abort, and a Cancel is user-initiated — so a
                                // "⚠️ 失败 · 进程退出" push there both lies about the cause
                                // (real cause is idle/watchdog-timeout or cancel) and, for
                                // a side-effecting task, DOUBLE-notifies alongside the
                                // confirm push. The `turn_done` path was hardened for this
                                // exact intent-vs-event-type gap (2026-08-07 F3 / 08-08 F2);
                                // this closes the sibling on the scheduled run_failed path.
                                // (review 2026-08-12, F-RUNFAILED-INTENT.)
                                let run_intent = turn_starts.front_intent();
                                let intent_aborted = intent_suppresses_push(run_intent);
                                // Finalize a scheduled run exactly once, keyed
                                // on active_run_id, mapped by terminal event type.
                                if let Some(rid) = active_run_id.take() {
                                    if let Some(m) = mgr.upgrade() {
                                        match &evt {
                                            AcpEvent::Result { text, .. } => {
                                                let verdict = crate::scheduled_tasks::extract_verdict(text);
                                                m.finalize_run(&rid, "succeeded", verdict.as_deref(),
                                                    if verdict.is_some() { None } else { Some("no_verdict") });
                                                if run_done_push_allowed(run_intent) {
                                                    maybe_push_run_done(&mgr, &sid, &owner_id, verdict.as_deref());
                                                }
                                            }
                                            AcpEvent::Error { .. } => {
                                                m.finalize_run(&rid, "failed", None, Some("cli_error"));
                                                // run_failed push: scheduled run ended with error —
                                                // suppressed when the turn was deliberately aborted
                                                // (Cancel/Timeout), whose real outcome is surfaced
                                                // elsewhere (confirm push / metric).
                                                if !intent_aborted {
                                                    if let Some(p2) = m.push_handle() {
                                                        let name = m.session_name(&sid).unwrap_or_default();
                                                        let uid = owner_id.clone();
                                                        let sid2 = sid.clone();
                                                        tokio::spawn(async move {
                                                            p2.send_to_user(&uid, &crate::push::payload_for("run_failed", &name, &sid2, Some("cli_error"), None)).await;
                                                        });
                                                    }
                                                }
                                            }
                                            AcpEvent::Exit { .. } => {
                                                m.finalize_run(&rid, "failed", None, Some("cli_exited"));
                                                // run_failed push: scheduled run exited unexpectedly —
                                                // suppressed on a deliberate abort (see above): a
                                                // Timeout-killed run's stdout-EOF→Exit is not a genuine
                                                // failure to notify about.
                                                if !intent_aborted {
                                                    if let Some(p2) = m.push_handle() {
                                                        let name = m.session_name(&sid).unwrap_or_default();
                                                        let uid = owner_id.clone();
                                                        let sid2 = sid.clone();
                                                        tokio::spawn(async move {
                                                            p2.send_to_user(&uid, &crate::push::payload_for("run_failed", &name, &sid2, Some("cli_exited"), None)).await;
                                                        });
                                                    }
                                                }
                                            }
                                            _ => { active_run_id = Some(rid); } // not terminal, keep waiting
                                        }
                                    }
                                }
                                // per-run metrics: every boundary (completed/error/cancel/timeout)
                                // records exactly one metric from this single exit. The turn's
                                // own intent (from its FIFO entry) overrides the event-type
                                // inference; the late boundaries of an interrupt-resend still
                                // each record a run (they represent a real run that ended) — the
                                // turn_starts FIFO pairs each with its own turn's start+intent.
                                // Skipped only if this boundary has no pending turn-start.
                                let term = match &evt {
                                    AcpEvent::Result { .. } => crate::run_metrics::TerminalEvt::Result,
                                    AcpEvent::Error { .. } => crate::run_metrics::TerminalEvt::Error,
                                    _ => crate::run_metrics::TerminalEvt::Exit,
                                };
                                // Consume THIS boundary's own (start, intent) from the
                                // FIFO front — boundaries drain in order, so the front
                                // is the turn this boundary belongs to. The intent
                                // (Cancel/Timeout, set on that turn's entry) overrides
                                // the event-type inference and can't be stolen by a
                                // coupled interrupt-resend turn (review 2026-08-08, F2).
                                // 队首(最早未结算的 turn-start)决定本边界是否落 metric;
                                // 若队列已空(罕见的多余边界)则不落 metric,且**不能**推进
                                // prev_cost,否则该轮增量凭空消失(见 diff_cost_at_boundary)。
                                let settled = turn_starts.settle();
                                let will_record = settled.is_some();
                                let outcome = crate::run_metrics::classify_outcome(
                                    term, settled.and_then(|(_, o)| o));
                                let (raw_cost, mt_in, mt_out) = match &evt {
                                    AcpEvent::Result { cost_usd, tokens_in, tokens_out, .. } => (*cost_usd, *tokens_in, *tokens_out),
                                    _ => (None, None, None),
                                };
                                let mc = if is_claude {
                                    let (delta, new_prev, new_seen) = crate::run_metrics::diff_cost_at_boundary(
                                        prev_cost, raw_cost, first_cost_seen, is_resumed, will_record);
                                    prev_cost = new_prev;
                                    first_cost_seen = new_seen;
                                    delta
                                } else {
                                    raw_cost // Crew/Codex 恒 None,不动
                                };
                                let fk = match outcome {
                                    crate::run_metrics::RunOutcome::Errored => Some(
                                        if matches!(evt, AcpEvent::Exit { .. }) { "cli_exited" } else { "cli_error" }.to_string()),
                                    _ => None,
                                };
                                // Only the boundary that settles the LIVE turn updates posture
                                // (see posture_settles).
                                if posture_settles(boundary_count, turn_seq, settled.is_some()) {
                                    if let Some(m) = mgr.upgrade() {
                                        m.settle_posture(&sid, outcome);
                                    }
                                }
                                if let Some((started, _)) = settled {
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
                                    // Parity with the QueueMode::Interrupt arm (review 2026-08-10):
                                    // stamp Cancelled on the live turn (FIFO back, turn_seq not yet
                                    // bumped) BEFORE interrupting, else its boundary settles with no
                                    // intent and classify_outcome mislabels it Completed/Errored +
                                    // fires a false "✅ 完成" push. LATENT today — `run_id:Some`
                                    // prompts come only from `trigger_run`, which always spawns a
                                    // FRESH session (local_running == false here), so this branch is
                                    // currently dead; kept as defensive symmetry so routing a
                                    // scheduled prompt into a busy session can't reopen the 08-10
                                    // mislabel. (review 2026-08-14, F2 — latent parity hardening.)
                                    turn_starts.set_live_intent(crate::run_metrics::RunOutcome::Cancelled);
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
                                        // Stamp Cancelled intent on the live turn (FIFO back) BEFORE
                                        // starting turn N+1 — same as the explicit Interrupt handler.
                                        // Without it, the interrupted turn's boundary settles with no
                                        // intent and classify_outcome records it Completed/Errored
                                        // instead of Cancelled, diverging from the Interrupt button.
                                        // The back is still the live turn here (turn_seq not yet
                                        // bumped), so it targets the correct entry. (review 2026-08-10)
                                        turn_starts.set_live_intent(crate::run_metrics::RunOutcome::Cancelled);
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
                            // Mirror the authoritative mode into the Session so a
                            // reconnecting/observer client can read it from replay_done
                            // instead of guessing (review 2026-07-26).
                            if let Some(mgr) = mgr.upgrade() {
                                mgr.mark_queue_mode(&sid, queue_mode);
                            }
                            // Also broadcast it LIVE so an already-connected tab adopts
                            // the new mode without a reconnect (review 2026-07-27,
                            // F-OBS-LIVE). replay_done only delivers it at connect time.
                            emit_queue_mode(&event_tx, queue_mode);
                        }
                        Some(SessionInput::Interrupt) => {
                            if local_running {
                                // Intent: the LIVE turn (FIFO back) is not a completion.
                                // Stamping the specific entry (not a shared slot) means a
                                // coupled interrupt-resend can't misattribute it (F2).
                                turn_starts.set_live_intent(crate::run_metrics::RunOutcome::Cancelled);
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
                            // Intent before kill: the ensuing Exit must classify the
                            // LIVE turn as Cancelled (FIFO back entry).
                            turn_starts.set_live_intent(crate::run_metrics::RunOutcome::Cancelled);
                            process.kill().await;
                        }
                        Some(SessionInput::TimeoutKill { .. }) => {
                            // Intent before kill: the ensuing Exit must classify the
                            // LIVE turn as Timeout (FIFO back entry).
                            turn_starts.set_live_intent(crate::run_metrics::RunOutcome::Timeout);
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
///
/// Each entry ALSO carries the turn's outcome INTENT (`Option<RunOutcome>`),
/// paired 1:1 with its start-stamp. This replaces the earlier single
/// `pending_outcome` slot, which conflated coupled interrupt-resend turns the
/// same way a single start-slot conflated their durations: a Cancel/Timeout
/// intent belongs to *the turn that was live when the user pressed the button*
/// (the FIFO back at that instant), but the single slot was consumed by whichever
/// boundary arrived first. So `resend-then-cancel` let the aborted turn's stale
/// boundary steal the live turn's Cancelled intent (→ false "✅ 完成" push), and
/// the mirror `cancel-then-resend` would have leaked the intent forward onto the
/// next clean turn. Storing intent on the specific entry settles both orderings:
/// `set_live_intent` stamps the back (the live turn) and each boundary reads only
/// its own entry's intent. (review 2026-08-08, F2 — the documented follow-up to
/// 2026-08-07 F3.)
#[derive(Default)]
struct TurnStarts {
    inner: VecDeque<TurnEntry>,
}

/// One pending turn: start stamp, outcome intent, whether the CLI started it on
/// its own (cross-session peer message / task notification), and whether the
/// CLI has echoed the stdin prompt that started it (spec 2026-09-26 v2).
struct TurnEntry {
    ms: i64,
    intent: Option<crate::run_metrics::RunOutcome>,
    external: bool,
    echoed: bool,
}

impl TurnStarts {
    /// A turn started at `ms`; enqueue its start-stamp with no intent yet.
    fn start(&mut self, ms: i64) {
        self.inner.push_back(TurnEntry { ms, intent: None, external: false, echoed: false });
    }

    /// A turn the CLI started by itself (no ZeroMux stdin write) began at `ms`.
    /// There is no stdin prompt to wait for, so it counts as already echoed.
    fn start_external(&mut self, ms: i64) {
        self.inner.push_back(TurnEntry { ms, intent: None, external: true, echoed: true });
    }

    /// Whether the oldest pending turn (the one the next boundary settles) was
    /// CLI-started. False on an empty FIFO.
    fn front_is_external(&self) -> bool {
        self.inner.front().is_some_and(|e| e.external)
    }

    /// The CLI echoed one of our stdin prompts. Every internal `start()` is
    /// paired with exactly one `send_prompt`, echoed in write order, so the echo
    /// belongs to the oldest entry still waiting for one. No-op if none.
    fn mark_echoed(&mut self) {
        if let Some(e) = self.inner.iter_mut().find(|e| !e.echoed) {
            e.echoed = true;
        }
    }

    /// Whether the oldest pending turn's prompt has been taken in by the CLI.
    /// False on an empty FIFO.
    fn front_is_echoed(&self) -> bool {
        self.inner.front().is_some_and(|e| e.echoed)
    }

    /// Record the outcome INTENT for the currently-live turn (the FIFO back),
    /// set when the user Cancels/Interrupts or the watchdog Timeout-kills it.
    /// No-op when no turn is live (empty FIFO) — a cancel with nothing running
    /// must NOT persist an intent that a future unrelated turn would consume.
    fn set_live_intent(&mut self, outcome: crate::run_metrics::RunOutcome) {
        if let Some(back) = self.inner.back_mut() {
            back.intent = Some(outcome);
        }
    }

    /// Peek the oldest pending start-stamp without consuming it (used for the
    /// turn_done push duration, read before the metric block settles it).
    fn front(&self) -> Option<i64> {
        self.inner.front().map(|e| e.ms)
    }

    /// Peek the oldest pending turn's outcome intent without consuming it (used
    /// for the turn_done push suppression on the settling boundary — the front
    /// IS the settling turn's entry, since boundaries drain the FIFO in order).
    fn front_intent(&self) -> Option<crate::run_metrics::RunOutcome> {
        self.inner.front().and_then(|e| e.intent)
    }

    /// A boundary arrived; consume and return the oldest pending (start, intent),
    /// or None if this boundary has no matching turn-start (spurious extra).
    fn settle(&mut self) -> Option<(i64, Option<crate::run_metrics::RunOutcome>)> {
        self.inner.pop_front().map(|e| (e.ms, e.intent))
    }
}

/// Per-event decision for the Claude fan-out's handling of CLI-started turns
/// (spec 2026-09-26 §2b/§2d). Pure so it is unit-testable without a process.
#[derive(Debug, PartialEq, Eq)]
enum ClaudeStep {
    /// Idle and the agent produced a peer message / output: the CLI started a
    /// turn on its own. Run the same four turn-start steps as a stdin prompt.
    StartExternal,
    /// A boundary whose `result.origin` says it ends a CLI-started turn, but the
    /// FIFO front is a ZeroMux turn whose prompt the CLI has not echoed yet (or
    /// nothing): the CLI ran a peer turn ahead of our prompt. Emit it but do not
    /// settle anything.
    SkipBoundary,
    /// Everything else: existing handling.
    Normal,
}

fn classify_claude_event(
    local_running: bool,
    evt: &AcpEvent,
    has_pending_origin: bool,
    front_settles_on_origin: bool,
) -> ClaudeStep {
    // ZeroMux sets local_running BEFORE writing stdin, so output arriving while
    // idle can only come from a turn the CLI started itself. System / Notice /
    // Exit are lifecycle noise and never open a turn.
    if !local_running
        && matches!(evt, AcpEvent::PeerMessage { .. } | AcpEvent::ContentBlock { .. })
    {
        return ClaudeStep::StartExternal;
    }
    let is_boundary = matches!(
        evt,
        AcpEvent::Result { .. } | AcpEvent::Error { .. } | AcpEvent::Exit { .. }
    );
    // An origin-tagged boundary ends a CLI-started turn. It settles the FIFO
    // front only if that front IS the CLI-started turn, or is our prompt that the
    // CLI already took in (echoed) — i.e. merged into that turn. Otherwise the
    // CLI ran the peer turn ahead of our not-yet-echoed prompt: skip it.
    if is_boundary && has_pending_origin && !front_settles_on_origin {
        return ClaudeStep::SkipBoundary;
    }
    ClaudeStep::Normal
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

/// Broadcast a live `queue_mode` change to all connected clients so an
/// already-connected tab adopts the authoritative mode WITHOUT waiting for a
/// reconnect. `replay_done` only carries `queue_mode` at (re)connect (ws_handler),
/// so a second/observer tab that stays connected across another tab's mode flip
/// would otherwise keep a stale `queueModeRef` — and a busy send in the wrong mode
/// mis-seeds the turn clock (inflated 已运行 + false 可能卡住, the F-FE-1 symptom).
/// Broadcast-only like `emit_queued` (never persisted): reconnect replay carries the
/// mode authoritatively via `replay_done`, so scrollback needn't retain it.
/// (review 2026-07-27, F-OBS-LIVE)
fn emit_queue_mode(event_tx: &broadcast::Sender<String>, mode: QueueMode) {
    let json = serde_json::json!({
        "type": "queue_mode",
        "queue_mode": mode.to_str(),
    });
    let _ = event_tx.send(json.to_string()); // Err == zero subscribers; ignore (T2)
}

/// Precomputed "at a glance" state for the triage list (spec v3 §0.5.1 M2/M3/M5).
/// Maintained only under the sessions lock from `record_and_broadcast` /
/// `settle_posture` / `approval_resolved`; `session_info_of` just copies it.
/// `last_outcome*` / `last_snippet` / `awaiting_input` are persisted once per settled
/// turn by `persist_posture` (S5 U3); `current_step` / `approval_ids` stay in memory.
#[derive(Default, Clone, Debug, PartialEq)]
struct Posture {
    last_outcome: Option<crate::run_metrics::RunOutcome>,
    last_outcome_ms: Option<i64>,
    last_snippet: Option<String>,
    current_step: Option<String>,
    /// Unresolved Crew approval ids, deduped (M9b). Exported as `len()`.
    approval_ids: Vec<String>,
    /// 「待回答」 (S6 G3 writes it; S5 only persists and restores it).
    awaiting_input: bool,
    /// THIS turn's Result snippet, for the push body only (Review Focus 1): cleared
    /// when a turn starts, so an errored turn never pushes the previous summary.
    /// Never persisted.
    turn_snippet: Option<String>,
}

fn persisted_posture_of(p: &Posture) -> crate::session_store::PersistedPosture {
    crate::session_store::PersistedPosture {
        last_outcome: p.last_outcome.map(|o| o.as_str().to_string()),
        last_outcome_ms: p.last_outcome_ms,
        last_snippet: p.last_snippet.clone(),
        awaiting_input: p.awaiting_input,
    }
}

/// What one event changes in `Posture`. Computed in `emit` from the typed event,
/// BEFORE serialization, so `record_and_broadcast` never re-parses JSON.
enum PostureDelta {
    Step(String),
    Snippet(String),
    ApprovalAdded(String),
}

fn cap_chars(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// Last non-empty line of an agent's final text, with light markdown stripped.
/// Only `Result.text` feeds this: streamed text blocks are deltas (M3).
fn snippet_of(text: &str) -> Option<String> {
    let line = text.lines().rev().map(str::trim).find(|l| !l.is_empty())?;
    let line = line.trim_start_matches(|c| c == '#' || c == '-' || c == '*' || c == '>' || c == ' ');
    // `_` only as whole-line emphasis: inside words it is part of identifiers (`session_manager.rs`).
    let cleaned: String = line.chars().filter(|c| *c != '*' && *c != '`').collect();
    let cleaned = cleaned.trim().trim_matches('_').trim();
    if cleaned.is_empty() { return None; }
    Some(cap_chars(cleaned, 120))
}

fn posture_delta_of(evt: &AcpEvent) -> Option<PostureDelta> {
    match evt {
        AcpEvent::ContentBlock { block_type, name, summary, .. } if block_type.as_ref() == "tool_use" => {
            let name = name.as_deref().unwrap_or("tool");
            let step = match summary.as_deref() {
                Some(s) if !s.is_empty() => format!("{} · {}", name, s),
                _ => name.to_string(),
            };
            Some(PostureDelta::Step(cap_chars(&step, 80)))
        }
        AcpEvent::Result { text, .. } => snippet_of(text).map(PostureDelta::Snippet),
        AcpEvent::Approval { id, .. } => Some(PostureDelta::ApprovalAdded(id.clone())),
        _ => None,
    }
}

/// Whether a turn boundary settles the LIVE turn and so may update posture.
/// Requires BOTH: caught up with the live turn (`boundary_count` is clamped to
/// `turn_seq`, so a stale boundary of a superseded interrupt-resend turn has
/// count < seq), AND it consumed a turn-start from the FIFO — an idle spurious
/// boundary (e.g. Crew Gateway reconnect `Error`) or the second boundary of an
/// already-settled turn has count == seq but nothing to settle, and would
/// otherwise stamp a false `Errored`.
fn posture_settles(boundary_count: u64, turn_seq: u64, settled: bool) -> bool {
    boundary_count >= turn_seq && settled
}

fn apply_posture_delta(p: &mut Posture, d: PostureDelta) {
    match d {
        PostureDelta::Step(s) => p.current_step = Some(s),
        PostureDelta::Snippet(s) => { p.turn_snippet = Some(s.clone()); p.last_snippet = Some(s) }
        PostureDelta::ApprovalAdded(id) => { if !p.approval_ids.contains(&id) { p.approval_ids.push(id) } }
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
        AcpEvent::ContentBlock { .. } | AcpEvent::Result { .. } | AcpEvent::PeerMessage { .. } => {
            stamped = with_turn_id(evt.clone(), turn_id);
            &stamped
        }
        _ => evt,
    };
    // A mid-turn error-styled ContentBlock is persisted + broadcast like any other
    // block, but it is NOT agent forward-progress: it must not bump the silence
    // clock, or a Codex error storm on a never-resolving tools/call would defeat the
    // 30-min watchdog and wedge the turn Running forever (F-CODEX-1-CLOCK, review
    // 2026-07-29). Every other event (text/thinking/tool_* blocks, Result, …) is
    // real activity. Terminal AcpEvent::Error settles the turn via is_boundary, so it
    // never reaches the wedge case regardless.
    //
    // A `UserPrompt` echo is ALSO not agent progress and must not bump the clock. In
    // collect mode (the default) a prompt sent while a turn is already Running is only
    // ENQUEUED — never delivered to the agent — yet it flows through here first. Pre-fix
    // its bump refreshed `last_activity_ms`, so a user poking a genuinely-wedged turn
    // faster than every 30 min kept `running_idle_too_long`/`stuck_push_candidates`
    // from ever firing: the wedge was never TimeoutKill'd, never pushed, and the queue
    // grew unbounded. The same F-CODEX-1-CLOCK class: a signal that is not forward
    // progress must not reset the watchdog it is supposed to be bounded by. The bump on
    // the paths where a prompt actually STARTS or INTERRUPTS a turn is not lost — every
    // such path calls `mark_turn(Running)` → `apply_turn`, which stamps
    // `last_activity_ms` fresh (so an idle-then-prompted turn is still spared for the
    // full idle window before the agent's first token). (review 2026-08-05)
    //
    // Third exclusion, same class: Crew's `System{subtype:"status"}` is the Gateway's
    // "Thinking…" heartbeat, emitted on a timer regardless of whether the agent is
    // producing anything. Letting it bump the clock would keep a turn wedged on a
    // never-returning tool call looking alive forever, defeating the idle watchdog.
    // Placed here rather than in the crew fan-out because `emit` is the sole
    // emit/persist chokepoint (T2/D2, :2932-2939), and the predicate is vacuously
    // true for the other three backends — their `System` only ever carries
    // "init" / "queued", never "status".
    let bump_activity = !matches!(
        evt,
        AcpEvent::ContentBlock { block_type, .. } if block_type == "error"
    ) && !matches!(evt, AcpEvent::UserPrompt { .. })
      && crate::acp::crew_process::crew_event_is_forward_progress(evt);
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
        m.record_and_broadcast(sid, json, bump_activity, posture_delta_of(evt));
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

/// Cap a peer message body before it enters scrollback — same budget as a
/// UserPrompt (a peer can send ~1M chars; spec 2026-09-26 review focus 5).
fn cap_peer_message(evt: AcpEvent) -> AcpEvent {
    match evt {
        AcpEvent::PeerMessage { from_name, text, turn_id } => AcpEvent::PeerMessage {
            from_name,
            text: truncate_prompt_for_scrollback(&text),
            turn_id,
        },
        other => other,
    }
}

fn with_turn_id(mut evt: AcpEvent, tid: u64) -> AcpEvent {
    match &mut evt {
        AcpEvent::ContentBlock { turn_id, .. } => *turn_id = tid,
        AcpEvent::Result { turn_id, .. } => *turn_id = tid,
        AcpEvent::PeerMessage { turn_id, .. } => *turn_id = tid,
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

/// Crew fan-out. Mirrors `spawn_acp_fanout` byte-for-byte in structure — the
/// only differences are the resume-token source (`crew_slot_key` → `ResumeToken::Crew`)
/// and the backend name in log lines. The fan-out no longer owns a child process but
/// **one Gateway WS connection + one slot_key**; `CrewProcess`'s `Drop` deletes the
/// remote slot, so CLAUDE.md's "the fan-out task is the sole owner of the session's
/// process" invariant holds in that form (same as Codex owning an rmcp client).
fn spawn_crew_fanout(
    sid: String,
    mut process: crate::acp::crew_process::CrewProcess,
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
        // Per-turn (start, intent) FIFO; intent stamped on the live turn via
        // set_live_intent from the input branch (Cancel/Timeout). See TurnStarts.
        let mut turn_starts = TurnStarts::default();
        loop {
            tokio::select! {
                event = process.event_rx.recv() => {
                    match event {
                        Some(evt) => {
                            log_result_event(&events, agent_label, &sid, &work_dir, &owner_id, &evt);
                            // Backfill the Crew resume token (the Gateway slot_key) on the
                            // first id-bearing event. Two sources — `System{init}` at spawn
                            // and every `Result` — see crew_slot_key: a session that never
                            // completed a turn would otherwise never get a resume token.
                            if !token_saved {
                                if let Some(slot) = crew_slot_key(&evt) {
                                    if let Some(m) = mgr.upgrade() {
                                        m.set_resume_token(&sid, ResumeToken::Crew(slot));
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
                                    // turn_done push (parity with spawn_acp_fanout — F4).
                                    // Crew runs no scheduled tasks yet (trigger_run still
                                    // hardcodes Claude), so every settling turn here is
                                    // interactive (no active_run_id gate needed).
                                    // dur AND intent read from the FIFO front (the settling
                                    // turn's own entry) BEFORE settle() consumes it — so a
                                    // Cancelled/Timeout turn is suppressed and coupled
                                    // interrupt-resend turns don't cross-contaminate
                                    // (review 2026-08-07 F3; 2026-08-08 F2).
                                    let dur = turn_starts.front().map(|s| now_millis() - s).unwrap_or(0);
                                    maybe_push_turn_done(&mgr, &sid, &owner_id, dur, turn_starts.front_intent());
                                    maybe_mark_vault_dirty(&mgr, &work_dir);
                                }
                                // per-run metrics: one metric per boundary, intent overrides
                                // event type (mirrors spawn_acp_fanout). Skipped when this
                                // boundary has no matching turn-start stamp.
                                let term = match &evt {
                                    AcpEvent::Result { .. } => crate::run_metrics::TerminalEvt::Result,
                                    AcpEvent::Error { .. } => crate::run_metrics::TerminalEvt::Error,
                                    _ => crate::run_metrics::TerminalEvt::Exit,
                                };
                                // Consume THIS boundary's own (start, intent) from the FIFO
                                // front; the per-turn intent can't be stolen by a coupled
                                // interrupt-resend turn (review 2026-08-08, F2).
                                let settled = turn_starts.settle();
                                let outcome = crate::run_metrics::classify_outcome(
                                    term, settled.and_then(|(_, o)| o));
                                let (mc, mt_in, mt_out) = match &evt {
                                    AcpEvent::Result { cost_usd, tokens_in, tokens_out, .. } => (*cost_usd, *tokens_in, *tokens_out),
                                    _ => (None, None, None),
                                };
                                let fk = match outcome {
                                    crate::run_metrics::RunOutcome::Errored => Some(
                                        if matches!(evt, AcpEvent::Exit { .. }) { "cli_exited" } else { "cli_error" }.to_string()),
                                    _ => None,
                                };
                                // Only the boundary that settles the LIVE turn updates posture
                                // (see posture_settles).
                                if posture_settles(boundary_count, turn_seq, settled.is_some()) {
                                    if let Some(m) = mgr.upgrade() {
                                        m.settle_posture(&sid, outcome);
                                    }
                                }
                                if let Some((started, _)) = settled {
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
                                // C3:调度 prompt 绕过 collect(crew 当前不跑调度,留此分支保持四 fanout 对称)
                                queue.clear();
                                if local_running {
                                    // Latent parity hardening — see the Claude fan-out's run_id arm
                                    // (review 2026-08-14, F2). Crew runs no scheduled tasks so this is
                                    // doubly dead, but the fanouts are kept byte-symmetric.
                                    turn_starts.set_live_intent(crate::run_metrics::RunOutcome::Cancelled);
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
                                    tracing::warn!("Crew send_prompt failed for {}: {}", sid, e);
                                }
                            } else {
                                // 非调度 prompt:按队列模式分流(G2b)。Crew 为 ACP,
                                // passthrough 已在 SetQueueMode 处降级为 collect。
                                match queue_mode {
                                    QueueMode::Interrupt if local_running => {
                                        // Stamp Cancelled intent on the live turn before starting
                                        // the next — see the Claude fan-out. (review 2026-08-10)
                                        turn_starts.set_live_intent(crate::run_metrics::RunOutcome::Cancelled);
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
                                            tracing::warn!("Crew send_prompt failed for {}: {}", sid, e);
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
                                            tracing::warn!("Crew send_prompt failed for {}: {}", sid, e);
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
                                                tracing::warn!("Crew send_prompt failed for {}: {}", sid, e);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        Some(SessionInput::SetQueueMode(m)) => {
                            queue_mode = m.effective();
                            // Mirror the authoritative mode into the Session so a
                            // reconnecting/observer client can read it from replay_done
                            // instead of guessing (review 2026-07-26).
                            if let Some(mgr) = mgr.upgrade() {
                                mgr.mark_queue_mode(&sid, queue_mode);
                            }
                            // Also broadcast it LIVE so an already-connected tab adopts
                            // the new mode without a reconnect (review 2026-07-27,
                            // F-OBS-LIVE). replay_done only delivers it at connect time.
                            emit_queue_mode(&event_tx, queue_mode);
                        }
                        Some(SessionInput::Interrupt) => {
                            if local_running {
                                // Intent: the LIVE turn (FIFO back) is not a completion
                                // (per-entry so a coupled resend can't misattribute — F2).
                                turn_starts.set_live_intent(crate::run_metrics::RunOutcome::Cancelled);
                                if let Err(e) = process.interrupt().await {
                                    tracing::warn!("interrupt failed for {}: {}", sid, e);
                                }
                            }
                            // E5:无条件清队列 + 取消窗口
                            queue.clear();
                        }
                        Some(SessionInput::Cancel) => {
                            // Intent before kill: classify the LIVE turn as Cancelled
                            // (FIFO back entry — see spawn_acp_fanout, F2).
                            turn_starts.set_live_intent(crate::run_metrics::RunOutcome::Cancelled);
                            process.kill().await;
                        }
                        Some(SessionInput::TimeoutKill { .. }) => {
                            // Intent before kill: classify the LIVE turn as Timeout
                            // (FIFO back entry — see spawn_acp_fanout, F2).
                            turn_starts.set_live_intent(crate::run_metrics::RunOutcome::Timeout);
                            process.kill().await;
                        }
                        Some(SessionInput::Approval { approval_id, action }) => {
                            // Crew-only: proxy the browser's decision to
                            // `POST /api/approvals/{id}/{action}`. The process layer
                            // spawns it detached (it must not queue behind a Prompt
                            // POST that blocks for the whole turn), so this await
                            // only hands it to the event loop. Deliberately NOT
                            // gated on `local_running` and deliberately no
                            // set_live_intent: answering an approval CONTINUES the
                            // turn — it is neither a cancel nor a completion, so it
                            // must not touch the turn_starts FIFO intent.
                            if let Some(m) = mgr.upgrade() {
                                m.approval_resolved(&sid, &approval_id);
                            }
                            if let Err(e) = process.resolve_approval(&approval_id, &action).await {
                                tracing::warn!("crew approval failed for {}: {}", sid, e);
                            }
                        }
                        None => break,
                        // PtyData / PtyResize aren't meaningful for a Gateway-backed
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
        tracing::info!("Crew fan-out task ended for session {}", sid);
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
        // Per-turn (start, intent) FIFO; intent stamped on the live turn via
        // set_live_intent from the input branch (Cancel/Timeout). See TurnStarts.
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
                                    // turn_done push (parity with spawn_acp_fanout — F4).
                                    // Codex runs no scheduled tasks, so every settling
                                    // turn here is interactive (no active_run_id gate needed).
                                    // dur AND intent read from the FIFO front (the settling
                                    // turn's own entry) BEFORE settle() consumes it — so a
                                    // Cancelled/Timeout turn is suppressed and coupled
                                    // interrupt-resend turns don't cross-contaminate
                                    // (review 2026-08-07 F3; 2026-08-08 F2).
                                    let dur = turn_starts.front().map(|s| now_millis() - s).unwrap_or(0);
                                    maybe_push_turn_done(&mgr, &sid, &owner_id, dur, turn_starts.front_intent());
                                    maybe_mark_vault_dirty(&mgr, &work_dir);
                                }
                                // per-run metrics: one metric per boundary, intent overrides
                                // event type (mirrors spawn_acp_fanout). Skipped when this
                                // boundary has no matching turn-start stamp.
                                let term = match &evt {
                                    AcpEvent::Result { .. } => crate::run_metrics::TerminalEvt::Result,
                                    AcpEvent::Error { .. } => crate::run_metrics::TerminalEvt::Error,
                                    _ => crate::run_metrics::TerminalEvt::Exit,
                                };
                                // Consume THIS boundary's own (start, intent) from the FIFO
                                // front; the per-turn intent can't be stolen by a coupled
                                // interrupt-resend turn (review 2026-08-08, F2).
                                let settled = turn_starts.settle();
                                let outcome = crate::run_metrics::classify_outcome(
                                    term, settled.and_then(|(_, o)| o));
                                let (mc, mt_in, mt_out) = match &evt {
                                    AcpEvent::Result { cost_usd, tokens_in, tokens_out, .. } => (*cost_usd, *tokens_in, *tokens_out),
                                    _ => (None, None, None),
                                };
                                let fk = match outcome {
                                    crate::run_metrics::RunOutcome::Errored => Some(
                                        if matches!(evt, AcpEvent::Exit { .. }) { "cli_exited" } else { "cli_error" }.to_string()),
                                    _ => None,
                                };
                                // Only the boundary that settles the LIVE turn updates posture
                                // (see posture_settles).
                                if posture_settles(boundary_count, turn_seq, settled.is_some()) {
                                    if let Some(m) = mgr.upgrade() {
                                        m.settle_posture(&sid, outcome);
                                    }
                                }
                                if let Some((started, _)) = settled {
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
                                    // Latent parity hardening — see the Claude fan-out's run_id arm
                                    // (review 2026-08-14, F2). Codex runs no scheduled tasks so this is
                                    // doubly dead, but the three fanouts are kept byte-symmetric.
                                    turn_starts.set_live_intent(crate::run_metrics::RunOutcome::Cancelled);
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
                                        // Stamp Cancelled intent on the live turn before starting
                                        // the next — see the Claude fan-out. Codex interrupt emits
                                        // AcpEvent::Error, which would otherwise classify Errored.
                                        // (review 2026-08-10)
                                        turn_starts.set_live_intent(crate::run_metrics::RunOutcome::Cancelled);
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
                            // Mirror the authoritative mode into the Session so a
                            // reconnecting/observer client can read it from replay_done
                            // instead of guessing (review 2026-07-26).
                            if let Some(mgr) = mgr.upgrade() {
                                mgr.mark_queue_mode(&sid, queue_mode);
                            }
                            // Also broadcast it LIVE so an already-connected tab adopts
                            // the new mode without a reconnect (review 2026-07-27,
                            // F-OBS-LIVE). replay_done only delivers it at connect time.
                            emit_queue_mode(&event_tx, queue_mode);
                        }
                        Some(SessionInput::Interrupt) => {
                            if local_running {
                                // Intent: the LIVE turn (FIFO back) is not a completion
                                // (per-entry so a coupled resend can't misattribute — F2).
                                turn_starts.set_live_intent(crate::run_metrics::RunOutcome::Cancelled);
                                if let Err(e) = process.interrupt().await {
                                    tracing::warn!("interrupt failed for {}: {}", sid, e);
                                }
                            }
                            // E5:无条件清队列 + 取消窗口
                            queue.clear();
                        }
                        Some(SessionInput::Cancel) => {
                            // Intent before kill: classify the LIVE turn as Cancelled
                            // (FIFO back entry — see spawn_acp_fanout, F2).
                            turn_starts.set_live_intent(crate::run_metrics::RunOutcome::Cancelled);
                            process.kill().await;
                        }
                        Some(SessionInput::TimeoutKill { .. }) => {
                            // Intent before kill: classify the LIVE turn as Timeout
                            // (FIFO back entry — see spawn_acp_fanout, F2).
                            turn_starts.set_live_intent(crate::run_metrics::RunOutcome::Timeout);
                            process.kill().await;
                        }
                        None => break,
                        // See note in spawn_acp_fanout: PTY-style inputs
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
            tmux_origin: None,
            pending_kill_until: None,
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
            posture: Posture::default(),
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
            queue_mode: QueueMode::Collect,
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
            "codex".into(),
            "off".into(),
            5476,
            "/tmp/crew".into(),
            "bash".into(),
            false,
            crate::tmux::TmuxCtl::new(Some("zmx-test-unused".into())),
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
            resume_token: None, tmux_origin: None, pending_kill_until: None, worktree_path: None, created_ms: 0,
            source_task_id: None,
            spawning: false,
            last_activity_ms: 0,
            turns_completed: 0,
            run_metrics: VecDeque::new(),
            lifetime_turns: 0,
            lifetime_duration_ms: 0,
            lifetime_cost_usd: 0.0,
            posture: Posture::default(),
            running: Some(RunningProcess {
                event_tx, input_tx, pty_pid: None,
                turn_state: TurnState::Idle,
                turn_started_ms: None,
                turn_seq: 0,
                queue_mode: QueueMode::Collect,
            }),
            scrollback: VecDeque::new(), scrollback_bytes: 0,
        }
    }

    #[test]
    fn peer_name_is_stable_prefix_of_session_id() {
        assert_eq!(peer_name_for("3186986d-b29f-40d5-9cd3-20d8b9124d98"), "zmx-ai-318698");
        assert_eq!(peer_name_for("abc"), "zmx-ai-abc");
        // must not look like a tmux terminal name `zmx-<id8>` (tmux Own check uses starts_with("zmx-"))
        assert!(peer_name_for("3186986d").starts_with("zmx-ai-"));
    }

    #[test]
    fn inbound_refuses_oauth_and_scheduled_runs() {
        use crate::acp::process::Inbound;
        assert_eq!(claude_inbound(false, None), Inbound::Accept);
        assert_eq!(claude_inbound(true, None), Inbound::Refuse, "OAuth: tenants share one OS user");
        assert_eq!(claude_inbound(false, Some("task-1")), Inbound::Refuse, "unattended scheduled run");
    }

    #[test]
    fn session_info_exposes_peer_name_for_claude_only() {
        let s = running_session("3186986d-b29f");
        assert_eq!(session_info_of(&s).peer_name.as_deref(), Some("zmx-ai-318698"));
    }

    #[test]
    fn session_info_peer_name_none_for_non_claude() {
        let mut s = running_session("t1");
        s.session_type = SessionType::Tmux;
        assert_eq!(session_info_of(&s).peer_name, None);
    }

    #[test]
    fn apply_running_sets_started_and_seq() {
        let mut s = running_session("s");
        s.last_activity_ms = 0;
        apply_turn(&mut s, TurnState::Running, 1);
        let rp = s.running.as_ref().unwrap();
        assert_eq!(rp.turn_state, TurnState::Running);
        assert!(rp.turn_started_ms.is_some());
        assert_eq!(rp.turn_seq, 1);
        // A real turn start stamps last_activity_ms fresh. This is the path the
        // silence-clock fix (review 2026-08-05) relies on: since a queued-but-undelivered
        // UserPrompt no longer bumps the clock in `emit`, the idle→Running transition
        // here is what spares a freshly-prompted turn for the full idle window.
        assert!(s.last_activity_ms > 0,
            "apply_turn(Running) must stamp last_activity_ms so a real turn start freshens the silence clock");
    }

    #[test]
    fn runs_for_session_enforces_owner_and_limit() {
        let (mgr, _dir) = {
            let dir = tempfile::tempdir().unwrap();
            let events = Arc::new(crate::events::EventStore::open(dir.path()).unwrap());
            let store = Arc::new(crate::session_store::SessionStore::open(dir.path()).unwrap());
            let mgr = SessionManager::new(
                events, store,
                "claude".into(), "codex".into(), "off".into(),
                5476, "/tmp/crew".into(), "bash".into(), false,
            crate::tmux::TmuxCtl::new(Some("zmx-test-unused".into())),
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
        assert_eq!(ts.settle(), Some((1_000, None)));
        // boundary #2 (real answering turn) → T2, still recorded
        assert_eq!(ts.front(), Some(2_000));
        assert_eq!(ts.settle(), Some((2_000, None)));
        // a spurious extra boundary with no pending start → no metric,
        // no baseline corruption (will_record=false path stays load-bearing)
        assert_eq!(ts.front(), None);
        assert_eq!(ts.settle(), None);
    }

    #[test]
    fn turn_starts_tracks_external_source_per_entry() {
        // Spec 2026-09-26 §2a: each FIFO entry records whether the turn was
        // started by the CLI itself (peer message / task notification) so the
        // boundary-attribution rule can tell an external turn's result from a
        // user turn's.
        let mut ts = TurnStarts::default();
        assert!(!ts.front_is_external(), "empty FIFO is not external");
        ts.start_external(1_000);
        ts.start(2_000);
        assert!(ts.front_is_external());
        assert_eq!(ts.settle(), Some((1_000, None)));
        assert!(!ts.front_is_external(), "user turn is internal");
        assert_eq!(ts.settle(), Some((2_000, None)));
        assert!(!ts.front_is_external());
    }

    #[test]
    fn set_live_intent_on_external_entry_keeps_source() {
        use crate::run_metrics::RunOutcome;
        // Review focus 3: Interrupt during an external turn stamps Cancelled on
        // the external entry without losing its source flag.
        let mut ts = TurnStarts::default();
        ts.start_external(1_000);
        ts.set_live_intent(RunOutcome::Cancelled);
        assert!(ts.front_is_external());
        assert_eq!(ts.front_intent(), Some(RunOutcome::Cancelled));
        assert_eq!(ts.settle(), Some((1_000, Some(RunOutcome::Cancelled))));
    }

    #[test]
    fn mark_echoed_marks_oldest_unechoed_internal_entry() {
        // Spec v2 §2a: each stdin write is echoed once, in order. The echo tells
        // us that prompt has been taken into a CLI turn (possibly merged into a
        // running CLI-started turn — CTO merged-race finding).
        let mut ts = TurnStarts::default();
        assert!(!ts.front_is_echoed(), "empty FIFO is not echoed");
        ts.start(1_000);
        ts.start(2_000);
        assert!(!ts.front_is_echoed());
        ts.mark_echoed();
        assert!(ts.front_is_echoed(), "first echo marks the oldest entry");
        ts.settle();
        assert!(!ts.front_is_echoed(), "second entry not echoed yet");
        ts.mark_echoed();
        assert!(ts.front_is_echoed());
        ts.settle();
        ts.mark_echoed(); // nothing pending: no-op, no panic
        assert!(!ts.front_is_echoed());
    }

    #[test]
    fn external_entries_count_as_echoed_and_are_skipped_by_mark_echoed() {
        // An external turn has no stdin write, so it never waits for an echo;
        // mark_echoed must pass over it to the next internal entry.
        let mut ts = TurnStarts::default();
        ts.start_external(1_000);
        ts.start(2_000);
        assert!(ts.front_is_echoed());
        ts.mark_echoed();
        ts.settle();
        assert!(ts.front_is_echoed(), "the echo went to the internal entry");
    }

    // ── spec 2026-09-26 §2b/§2d: Claude external-turn classification ──
    fn cb() -> AcpEvent {
        AcpEvent::ContentBlock { block_type: "text".into(), turn_id: 0, text: Some("x".into()),
            name: None, input: None, streaming: None, summary: None }
    }
    fn res() -> AcpEvent {
        AcpEvent::Result { text: "r".into(), turn_id: 0, session_id: "s".into(),
            cost_usd: None, tokens_in: None, tokens_out: None }
    }
    fn peer() -> AcpEvent {
        AcpEvent::PeerMessage { from_name: "a".into(), text: "b".into(), turn_id: 0 }
    }

    #[test]
    fn idle_peer_message_starts_external_turn() {
        assert_eq!(classify_claude_event(false, &peer(), false, false), ClaudeStep::StartExternal);
    }

    #[test]
    fn idle_content_block_starts_external_turn() {
        // task-notification turns have no `user` event: first sign is output.
        assert_eq!(classify_claude_event(false, &cb(), false, false), ClaudeStep::StartExternal);
    }

    #[test]
    fn busy_peer_and_output_are_normal() {
        assert_eq!(classify_claude_event(true, &peer(), false, false), ClaudeStep::Normal);
        assert_eq!(classify_claude_event(true, &cb(), false, true), ClaudeStep::Normal);
    }

    #[test]
    fn idle_system_and_notice_do_not_start_turn() {
        // Review focus 1: lifecycle events arrive while idle (task_updated,
        // background_tasks_changed, hold receipts) and must not open a turn.
        let sys = AcpEvent::System { subtype: "task_updated".into(), session_id: None, count: None };
        let notice = AcpEvent::Notice { text: "held".into(), level: "warning".into() };
        let exit = AcpEvent::Exit { code: 0 };
        assert_eq!(classify_claude_event(false, &sys, false, false), ClaudeStep::Normal);
        assert_eq!(classify_claude_event(false, &notice, false, false), ClaudeStep::Normal);
        assert_eq!(classify_claude_event(false, &exit, false, false), ClaudeStep::Normal);
    }

    #[test]
    fn origin_boundary_settles_when_front_is_external() {
        assert_eq!(classify_claude_event(true, &res(), true, true), ClaudeStep::Normal);
        let err = AcpEvent::Error { message: "e".into() };
        assert_eq!(classify_claude_event(true, &err, true, true), ClaudeStep::Normal);
    }

    #[test]
    fn origin_boundary_skipped_when_front_is_unechoed_user_turn() {
        // Serial race (spec v2 walkthrough A): the user's prompt counted turn N but
        // the CLI hasn't echoed it yet — it ran the peer turn first; that result
        // must not settle N.
        assert_eq!(classify_claude_event(true, &res(), true, false), ClaudeStep::SkipBoundary);
    }

    #[test]
    fn origin_boundary_with_empty_fifo_is_skipped() {
        // Review focus 2: nothing pending (front_is_external=false on empty FIFO).
        assert_eq!(classify_claude_event(false, &res(), true, false), ClaudeStep::SkipBoundary);
    }

    #[test]
    fn plain_boundary_is_normal() {
        assert_eq!(classify_claude_event(true, &res(), false, false), ClaudeStep::Normal);
        assert_eq!(classify_claude_event(true, &AcpEvent::Exit { code: 1 }, false, true), ClaudeStep::Normal);
    }

    fn settles(ts: &TurnStarts) -> bool {
        ts.front_is_external() || ts.front_is_echoed()
    }

    #[test]
    fn serial_race_skips_peer_result_then_settles_user_turn() {
        // Walkthrough A (CTO b.log): peer turn has no tool use, so the CLI runs it
        // to completion, THEN takes our stdin prompt.
        let mut ts = TurnStarts::default();
        ts.start(1_000); // user prompt written to stdin (local_running = true)
        assert_eq!(classify_claude_event(true, &peer(), false, settles(&ts)), ClaudeStep::Normal);
        // peer turn's result (origin) arrives before our prompt's echo → skip
        assert_eq!(classify_claude_event(true, &res(), true, settles(&ts)), ClaudeStep::SkipBoundary);
        assert_eq!(ts.front(), Some(1_000), "FIFO untouched by the skipped boundary");
        ts.mark_echoed(); // StdinEcho for our prompt
        // our own result (no origin) → settles turn N
        assert_eq!(classify_claude_event(true, &res(), false, settles(&ts)), ClaudeStep::Normal);
        assert_eq!(ts.settle(), Some((1_000, None)));
    }

    #[test]
    fn merged_race_settles_on_origin_result() {
        // Walkthrough B (CTO a.log / c.log) — the v1 BLOCKER: peer turn uses a
        // tool, the CLI injects our stdin prompt after the tool_result, and emits
        // ONE result carrying origin:peer that answers our prompt. It must settle
        // turn N, or the session stays Running until the 30-min watchdog.
        let mut ts = TurnStarts::default();
        ts.start(1_000);
        assert_eq!(classify_claude_event(true, &peer(), false, settles(&ts)), ClaudeStep::Normal);
        ts.mark_echoed(); // StdinEcho arrives BEFORE the only result
        assert_eq!(classify_claude_event(true, &res(), true, settles(&ts)), ClaudeStep::Normal);
        assert_eq!(ts.settle(), Some((1_000, None)));
    }

    #[test]
    fn task_notification_merged_into_user_turn_settles() {
        // Walkthrough C (CTO hypothesis): a background-task notification merged
        // into a user turn yields a result with origin:task-notification. The user
        // prompt that opened the turn was echoed first, so it settles.
        let mut ts = TurnStarts::default();
        ts.start(1_000);
        ts.mark_echoed();
        assert_eq!(classify_claude_event(true, &res(), true, settles(&ts)), ClaudeStep::Normal);
    }

    #[test]
    fn intent_fifo_resend_then_cancel_attributes_cancel_to_the_live_turn() {
        use crate::run_metrics::RunOutcome;
        // F2 scenario A (review 2026-08-08): interrupt-RESEND, THEN cancel.
        // turn 1 running; user resends (turn 2 starts) before turn 1's aborted
        // boundary arrives — TWO entries in flight. The user then cancels the LIVE
        // turn (turn 2). The old single `pending_outcome` slot let turn 1's aborted
        // boundary (arriving first) STEAL the Cancelled intent, so turn 2's settling
        // boundary read None → false "✅ 完成" push + mis-classified metric.
        let mut ts = TurnStarts::default();
        ts.start(1_000); // turn 1
        ts.start(2_000); // turn 2 (resend) — now the live turn (FIFO back)
        ts.set_live_intent(RunOutcome::Cancelled); // cancel targets turn 2

        // Boundary #1 = aborted turn 1: its OWN entry carries no intent → event-based.
        assert_eq!(ts.front_intent(), None, "turn 1 has no intent; the push isn't suppressed by turn 2's cancel");
        let (start1, intent1) = ts.settle().unwrap();
        assert_eq!(start1, 1_000);
        assert_eq!(crate::run_metrics::classify_outcome(crate::run_metrics::TerminalEvt::Exit, intent1),
            RunOutcome::Errored, "aborted turn 1 is event-based, NOT the live turn's cancel");

        // Boundary #2 = live turn 2: carries the Cancelled intent → suppressed + Cancelled.
        assert_eq!(ts.front_intent(), Some(RunOutcome::Cancelled), "turn 2's own boundary sees its cancel → push suppressed");
        let (start2, intent2) = ts.settle().unwrap();
        assert_eq!(start2, 2_000);
        assert_eq!(crate::run_metrics::classify_outcome(crate::run_metrics::TerminalEvt::Exit, intent2),
            RunOutcome::Cancelled);
    }

    #[test]
    fn intent_fifo_cancel_then_resend_does_not_leak_intent_onto_the_fresh_turn() {
        use crate::run_metrics::RunOutcome;
        // F2 scenario B (the MIRROR — a naive settling-only gate would REGRESS this):
        // cancel FIRST, THEN resend. The cancel targets turn 1 (live at that instant);
        // the resend then starts a fresh turn 2. Turn 1's cancel must stay with turn 1
        // and must NOT bleed onto the clean turn 2 (which would mislabel a completed
        // turn as Cancelled and suppress its legitimate push).
        let mut ts = TurnStarts::default();
        ts.start(1_000); // turn 1 — live
        ts.set_live_intent(RunOutcome::Cancelled); // cancel targets turn 1
        ts.start(2_000); // turn 2 (resend) — fresh, no intent

        // Boundary #1 = turn 1: carries the cancel.
        assert_eq!(ts.front_intent(), Some(RunOutcome::Cancelled));
        let (_, intent1) = ts.settle().unwrap();
        assert_eq!(crate::run_metrics::classify_outcome(crate::run_metrics::TerminalEvt::Exit, intent1),
            RunOutcome::Cancelled);

        // Boundary #2 = turn 2: NO intent → a Result completes normally (push fires).
        assert_eq!(ts.front_intent(), None, "fresh turn keeps no stale cancel");
        let (_, intent2) = ts.settle().unwrap();
        assert_eq!(crate::run_metrics::classify_outcome(crate::run_metrics::TerminalEvt::Result, intent2),
            RunOutcome::Completed, "the fresh turn completes; its success push is NOT suppressed");
    }

    #[test]
    fn queue_mode_interrupt_resend_records_the_interrupted_turn_as_cancelled() {
        use crate::run_metrics::RunOutcome;
        // review 2026-08-10 (F3): the QueueMode::Interrupt resend arm interrupts the
        // running turn and starts the next. Before the fix it did NOT stamp Cancelled
        // intent on the interrupted turn (only the explicit Interrupt button did), so
        // the aborted turn's boundary settled with no intent and classify_outcome
        // recorded it Completed (Claude's cancel→Result) or Errored (Codex's
        // cancel→Error) — the SAME user action ("interrupt the running turn") yielding
        // a different metric depending on which route triggered it.
        //
        // This models the FIXED fan-out ordering: set_live_intent(Cancelled) on the
        // live turn (FIFO back = turn 1, before turn_seq is bumped), THEN start turn 2.
        let mut ts = TurnStarts::default();
        ts.start(1_000); // turn 1 — running
        // — user sends a new prompt in Interrupt mode → the arm now stamps first:
        ts.set_live_intent(RunOutcome::Cancelled); // targets the still-live turn 1
        ts.start(2_000); // turn 2 (the resend) — fresh, no intent

        // Boundary #1 = the interrupted turn 1. Even though the backend delivers it as
        // a Result (Claude cancel) or Error (Codex), the stamped intent wins → Cancelled.
        assert_eq!(ts.front_intent(), Some(RunOutcome::Cancelled));
        let (start1, intent1) = ts.settle().unwrap();
        assert_eq!(start1, 1_000);
        assert_eq!(crate::run_metrics::classify_outcome(crate::run_metrics::TerminalEvt::Result, intent1),
            RunOutcome::Cancelled, "the interrupted turn must be Cancelled, not Completed");
        assert_eq!(crate::run_metrics::classify_outcome(crate::run_metrics::TerminalEvt::Error, intent1),
            RunOutcome::Cancelled, "…and not Errored (Codex's interrupt Error path)");

        // Boundary #2 = the resend turn 2: clean, completes normally, push not suppressed.
        assert_eq!(ts.front_intent(), None, "the resend turn carries no stale cancel");
        let (start2, intent2) = ts.settle().unwrap();
        assert_eq!(start2, 2_000);
        assert_eq!(crate::run_metrics::classify_outcome(crate::run_metrics::TerminalEvt::Result, intent2),
            RunOutcome::Completed);
    }

    #[test]
    fn set_live_intent_is_noop_when_no_turn_is_live() {
        use crate::run_metrics::RunOutcome;
        // A Cancel/Interrupt with nothing running must NOT persist an intent that a
        // future unrelated turn would then consume (the fan-out only calls
        // set_live_intent under `if local_running`, but the FIFO itself is defensive).
        let mut ts = TurnStarts::default();
        ts.set_live_intent(RunOutcome::Cancelled); // empty FIFO → dropped
        ts.start(1_000);
        assert_eq!(ts.front_intent(), None, "a later turn must not inherit a stale cancel");
        assert_eq!(ts.settle(), Some((1_000, None)));
    }

    #[test]
    fn double_boundary_turn_does_not_double_consume_or_double_suppress() {
        use crate::run_metrics::RunOutcome;
        // A single turn can emit TWO boundaries (Claude is_error Result then the
        // always-on Exit; Codex Error then the resolving Result). Boundary 1 pops
        // this turn's (start, intent); boundary 2 finds the FIFO EMPTY. Verify the
        // second boundary neither records a stray metric (settle→None) nor mislabels
        // via a foreign intent, and that front_intent→None so no wrong suppression.
        // The push's own second-fire is separately prevented by dur=0 when front()
        // is None (see the fan-out: `front().map(..).unwrap_or(0)`), which
        // should_push_turn_done rejects (<60s) — the reason the empty-FIFO read is safe.
        let mut ts = TurnStarts::default();
        ts.start(1_000);
        ts.set_live_intent(RunOutcome::Cancelled);
        // boundary 1: the real turn — intent present, metric recorded.
        assert_eq!(ts.front_intent(), Some(RunOutcome::Cancelled));
        assert_eq!(ts.settle(), Some((1_000, Some(RunOutcome::Cancelled))));
        // boundary 2 (same turn, extra Exit): FIFO empty → no intent, no metric,
        // and front() is None so the fan-out's `dur` collapses to 0 (push rejected).
        assert_eq!(ts.front(), None, "empty front → dur=0 → push not double-fired");
        assert_eq!(ts.front_intent(), None, "no foreign intent read on the extra boundary");
        assert_eq!(ts.settle(), None, "extra boundary records no stray metric / no desync");
    }

    #[test]
    fn standalone_cancel_intent_is_consumed_on_the_single_turn() {
        use crate::run_metrics::RunOutcome;
        // The common standalone Cancel (no resend): one live turn, one boundary.
        let mut ts = TurnStarts::default();
        ts.start(1_000);
        ts.set_live_intent(RunOutcome::Cancelled);
        assert_eq!(ts.front_intent(), Some(RunOutcome::Cancelled), "push suppressed");
        let (_, intent) = ts.settle().unwrap();
        assert_eq!(crate::run_metrics::classify_outcome(crate::run_metrics::TerminalEvt::Exit, intent),
            RunOutcome::Cancelled);
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
        // drops the mid-turn prompt → wedge; Claude/Crew mis-stamp). effective()
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
            tmux_origin: None,
            pending_kill_until: None,
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
            posture: Posture::default(),
            running: Some(RunningProcess {
                event_tx,
                input_tx,
                pty_pid: None,
                turn_state: turn,
                turn_started_ms: None,
                turn_seq: 0,
                queue_mode: QueueMode::Collect,
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
            "claude".into(), "codex".into(), "off".into(),
            5476, "/tmp/crew".into(), "bash".into(), false,
            crate::tmux::TmuxCtl::new(Some("zmx-test-unused".into())),
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
    fn counts_interactive_running_turns_skipping_tmux() {
        // interactive counts every Running agent turn (tmux excluded). During a
        // live scheduled run the source_task session is BOTH Running in memory and
        // counted via the DB run (scheduled=1); the gate short-circuits on
        // scheduled>0 so the double count is harmless. Session "a" (Running,
        // source_task, DB run in flight) therefore adds to interactive too.
        let (m, _tmp) = mgr_with(vec![
            running_session("a", SessionType::Claude, Some("task1".into()), TurnState::Running),
            running_session("b", SessionType::Codex, None, TurnState::Running),
            running_session("c", SessionType::Claude, None, TurnState::Idle),
            running_session("d", SessionType::Tmux, None, TurnState::Running),
        ]);
        seed_active_run(&m, "r1", "task1", "running");
        let s = m.running_summary();
        assert_eq!(s.scheduled, 1, "in-flight scheduled run blocks (DB count)");
        assert_eq!(s.interactive, 2, "both Running agent turns count (a is scheduled AND running)");
    }

    #[test]
    fn queue_mode_roundtrips_through_the_session_for_replay_done() {
        // F-FE-RECONNECT (2026-07-26): the fan-out is spawned once per session and
        // keeps its queue mode across a transient WS reconnect (no respawn), so the
        // client can't guess it — the backend must report the AUTHORITATIVE mode in
        // replay_done. mark_queue_mode mirrors the fan-out's mode into the Session;
        // queue_mode() reads it as the wire string replay_done sends.
        let (m, _tmp) = mgr_with(vec![
            running_session("a", SessionType::Claude, None, TurnState::Running),
            running_session("gone", SessionType::Claude, None, TurnState::Idle),
        ]);
        // Default at construction is Collect (matches the fan-out's own default, so a
        // genuine process respawn correctly reports Collect).
        assert_eq!(m.queue_mode("a"), Some("collect"), "default is collect");

        // A delivered SetQueueMode(Interrupt) mirrors through; queue_mode() reflects it
        // so a reconnecting client adopts Interrupt instead of resetting to collect.
        m.mark_queue_mode("a", QueueMode::Interrupt);
        assert_eq!(m.queue_mode("a"), Some("interrupt"), "interrupt is reported after mark");

        // Passthrough is effective()-degraded to Collect before storage everywhere, but
        // if one ever reached the mirror it maps to the wire "collect" (client only
        // branches on == 'collect').
        m.mark_queue_mode("a", QueueMode::Passthrough);
        assert_eq!(m.queue_mode("a"), Some("collect"), "passthrough → collect on the wire");

        // Unknown session → None (client keeps its provisional default).
        assert_eq!(m.queue_mode("nope"), None, "unknown session → None");

        // A session with no live process → None (nothing to adopt).
        {
            let mut map = m.sessions.lock().unwrap();
            map.get_mut("gone").unwrap().running = None;
        }
        m.mark_queue_mode("gone", QueueMode::Interrupt); // no-op, no running process
        assert_eq!(m.queue_mode("gone"), None, "no live process → None");
    }

    #[test]
    fn interactive_followup_on_finished_scheduled_session_counts_as_interactive() {
        // Regression (F-SCHED, 2026-07-22): after a scheduled run finalizes, its
        // `claude -p` child lingers Idle and is never reaped. A user can reuse that
        // session with an interactive follow-up (run_id:None → turn_state=Running,
        // NO new DB run row). Previously running_summary skipped source_task sessions
        // unconditionally → this live turn counted as neither scheduled (DB run
        // finalized → 0) nor interactive → gate saw all-idle → systemctl stop
        // cgroup-killed the live turn with ZERO grace (E1). Now it must count as
        // interactive so the gate waits (WaitInteractive) instead of killing it.
        let (m, _tmp) = mgr_with(vec![
            running_session("sess1", SessionType::Claude, Some("task1".into()), TurnState::Running),
        ]);
        seed_active_run(&m, "r1", "task1", "succeeded"); // scheduled run already done
        let s = m.running_summary();
        assert_eq!(s.scheduled, 0, "the scheduled run is finalized");
        assert_eq!(s.interactive, 1,
            "an interactive follow-up on a finished scheduled session must block auto-update");
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
            // scheduled + Running + stale WITH a live in-flight run → owned by
            // reconcile_timeouts_per_task, must be skipped here (no double-kill)
            aged_session("scheduled", Some("task1".into()), TurnState::Running, stale_ts),
            // exactly at threshold (>=)        → SHOULD be killed (boundary)
            aged_session("boundary", None, TurnState::Running, now - idle),
        ]);
        // Bind a live in-flight run to "scheduled" so it's excluded by DB truth.
        seed_active_run_bound(&m, "run_sched", "task1", "running", Some("scheduled"));

        let mut got = m.running_idle_too_long(now, idle);
        got.sort();
        assert_eq!(got, vec!["boundary".to_string(), "kill_me".to_string()],
            "Running + silent>=idle sessions not backed by a live scheduled run; \
             live-scheduled/idle/fresh excluded");
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
            // scheduled + Running + stale WITH a live in-flight run → reconcile owns it
            aged_session("scheduled", Some("task1".into()), TurnState::Running, stale_ts),
        ]);
        seed_active_run_bound(&m, "run_sched2", "task1", "running", Some("scheduled"));

        let out = m.stuck_push_candidates(now, idle);
        assert_eq!(out.len(), 1, "only the interactive + Running + silent>=idle session is a candidate");
        let (id, owner, name) = &out[0];
        assert_eq!(id, "stuck_me");
        assert_eq!(owner, "o", "owner_id carried out for push (running_session seeds \"o\")");
        assert_eq!(name, "n", "name carried out for push (running_session seeds \"n\")");
        assert!(out.iter().any(|(id, owner, _name)| !id.is_empty() && !owner.is_empty()));
    }

    #[test]
    fn watchdogs_reap_interactive_followup_on_finished_scheduled_session() {
        // d7cb58d taught running_summary to COUNT an interactive follow-up on a
        // lingering finished-scheduled session (source_task_id=Some, run_id:None →
        // turn_state=Running, NO in-flight DB run) so the auto-update gate won't
        // cgroup-kill it. But the interactive watchdogs still keyed on
        // source_task_id.is_none(), so if that same follow-up WEDGES, nothing reaps
        // it: reconcile_timeouts_per_task only handles rows in ('claimed','running'),
        // and this turn has no such row. It hangs forever, no TimeoutKill, no
        // stuck-push. Fix: watch any Running+stale session NOT backed by an in-flight
        // scheduled run — DB truth, same source as running_summary().scheduled.
        let now = 1_000_000i64;
        let idle = 30 * 60_000i64;
        let stale_ts = now - idle - 1;
        let (m, _tmp) = mgr_with(vec![
            // finished-scheduled session, interactive follow-up wedged → MUST reap
            aged_session("followup", Some("task1".into()), TurnState::Running, stale_ts),
            // scheduled session WITH a live in-flight run → scheduled reconcile owns
            // it; the interactive watchdog must NOT double-handle it
            aged_session("live_sched", Some("task2".into()), TurnState::Running, stale_ts),
            // plain interactive wedged → MUST reap (unchanged behavior)
            aged_session("plain", None, TurnState::Running, stale_ts),
        ]);
        // Only live_sched has an in-flight DB run bound to it.
        seed_active_run_bound(&m, "run_live", "task2", "running", Some("live_sched"));

        let mut killed = m.running_idle_too_long(now, idle);
        killed.sort();
        assert_eq!(killed, vec!["followup".to_string(), "plain".to_string()],
            "interactive follow-up on a finished scheduled session + plain interactive are reaped; \
             a session with a live in-flight scheduled run is left to reconcile_timeouts");

        let mut pushed: Vec<String> = m.stuck_push_candidates(now, idle).into_iter().map(|(id, _, _)| id).collect();
        pushed.sort();
        assert_eq!(pushed, vec!["followup".to_string(), "plain".to_string()],
            "stuck-push mirrors the kill filter");
    }

    #[test]
    fn scheduled_count_fails_closed_on_db_error() {
        // F-SCHED-FAILOPEN-1: the E1 gate reads scheduled in-flight count from the DB.
        // No store wired → 0. A good read passes through (clamped >=0). A FAILED read
        // must NOT collapse to 0 (that would let the gate cgroup-kill a scheduled
        // agent in its startup window, before turn_state marks Running); report >=1
        // to block the upgrade until the DB is readable again.
        assert_eq!(scheduled_count_fail_closed(None), 0, "no scheduler wired → 0");
        assert_eq!(scheduled_count_fail_closed(Some(Ok(0))), 0, "good read of 0");
        assert_eq!(scheduled_count_fail_closed(Some(Ok(3))), 3, "good read passes through");
        assert_eq!(scheduled_count_fail_closed(Some(Ok(-1))), 0, "negative clamped to 0");
        assert_eq!(
            scheduled_count_fail_closed(Some(Err("io error".into()))),
            1,
            "DB read error must block the upgrade (fail closed), not report 0"
        );
    }

    #[test]
    fn scheduled_read_failed_flag_tracks_only_the_error_case() {
        // F-SCHED-LOG (2026-07-26): running_summary must set scheduled_read_failed iff
        // the DB read actually errored, so the auto-update gate logs the TRUE cause
        // (disk/FS fault) instead of the misleading "blocked by scheduled run(s)".
        // The flag derives from the same read result that feeds the count; assert they
        // stay coupled (Err → count 1 AND flag true; every non-error → flag false).
        let read_failed = |c: &Option<Result<i64, String>>| matches!(c, Some(Err(_)));
        for c in [None, Some(Ok(0)), Some(Ok(5))] {
            assert!(!read_failed(&c), "a successful/absent read is not a failure: {c:?}");
        }
        let err: Option<Result<i64, String>> = Some(Err("io".into()));
        assert!(read_failed(&err), "an errored read sets the flag");
        assert_eq!(scheduled_count_fail_closed(err), 1, "and still fails closed to 1");
    }

    #[test]
    fn scheduled_owned_fails_closed_on_unknown_db_set() {
        // F-SCHED-FAILOPEN-1: the interactive watchdogs subtract the live-scheduled
        // set. Some(set) is DB truth (exclude iff in the set). None means the DB read
        // failed — fail CLOSED: exclude EVERY scheduled session (source_task_id.is_some())
        // so a genuinely-live scheduled turn isn't reaped by a premature TimeoutKill.
        let interactive = running_session("plain", SessionType::Claude, None, TurnState::Running);
        let scheduled =
            running_session("sched", SessionType::Claude, Some("t1".into()), TurnState::Running);

        // Authoritative DB truth: only ids in the set are owned.
        let set: std::collections::HashSet<String> = ["sched".to_string()].into_iter().collect();
        assert!(scheduled_owned(&Some(set.clone()), &scheduled), "in-set scheduled owned");
        assert!(!scheduled_owned(&Some(set), &interactive), "interactive not in set → reapable");

        // DB read failed (None): all scheduled excluded, interactive still reapable.
        assert!(scheduled_owned(&None, &scheduled), "DB unknown → any scheduled session excluded");
        assert!(!scheduled_owned(&None, &interactive), "interactive follow-up still reapable when DB unknown");
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
        m.record_and_broadcast("streaming", "some output".to_string(), true, None);

        let killed = m.running_idle_too_long(now_millis(), idle);
        assert_eq!(killed, vec!["silent".to_string()],
            "streaming session bumped last_activity_ms and must be spared; only the silent one is killed");
    }

    #[test]
    fn record_and_broadcast_without_activity_bump_leaves_turn_reapable() {
        // F-CODEX-1-CLOCK (review 2026-07-29): a mid-turn error-styled ContentBlock
        // is persisted+broadcast (bump_activity=false) but must NOT reset the silence
        // clock. Otherwise a repeated Codex `codex/event` error storm on a stuck
        // tools/call would keep the turn "fresh" forever and the 30-min watchdog would
        // never reap it. With bump_activity=false the aged, silent-of-real-progress
        // turn stays reapable even though an error frame was just persisted.
        let now = now_millis();
        let idle = 30 * 60_000i64;
        let long_ago = now - idle - 60_000;
        let (m, _tmp) = mgr_with(vec![
            aged_session("erroring", None, TurnState::Running, long_ago),
        ]);

        // An error frame arrives (persisted for the user to see) but is not progress.
        m.record_and_broadcast("erroring", "Codex: transient".to_string(), false, None);

        let killed = m.running_idle_too_long(now_millis(), idle);
        assert_eq!(killed, vec!["erroring".to_string()],
            "an error frame must not reset the silence clock; the wedged turn stays reapable");
    }

    #[test]
    fn subscribe_with_history_no_double_delivery_for_pty_frames() {
        // F-SM (2026-07-21): the PTY WS handler now reconnects via
        // subscribe_with_history (atomic snapshot+subscribe), mirroring the ACP
        // handler, because 19ab52b made the PTY fan-out persist-before-broadcast
        // via record_and_broadcast. A frame emitted AFTER the atomic subscribe
        // must appear in the live receiver and NOT also in the history snapshot —
        // exactly one side of the boundary. (The old two-step subscribe() then
        // get_scrollback() put a between-locks frame on BOTH sides → duplicate
        // xterm bytes on reconnect-mid-stream.)
        let (m, _tmp) = mgr_with(vec![running_session(
            "p", SessionType::Tmux, None, TurnState::Idle,
        )]);
        // A pre-existing scrollback frame (already persisted before reconnect).
        m.record_and_broadcast("p", "old".to_string(), true, None);

        // Reconnect: snapshot history AND subscribe under one lock.
        let (history, mut rx) = m.subscribe_with_history("p").expect("session exists");
        assert_eq!(history, vec!["old".to_string()], "history has only the pre-subscribe frame");

        // A frame emitted AFTER the atomic subscribe: goes to the live receiver,
        // and (being appended after the snapshot) is NOT in `history`.
        m.record_and_broadcast("p", "live".to_string(), true, None);
        assert_eq!(rx.try_recv().unwrap(), "live", "post-subscribe frame delivered live");
        assert!(rx.try_recv().is_err(), "no second copy of any frame on the live channel");
        assert!(!history.contains(&"live".to_string()), "live frame is not also in the replay snapshot");
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
    fn with_turn_id_stamps_peer_message() {
        let e = with_turn_id(AcpEvent::PeerMessage { from_name: "a".into(), text: "b".into(), turn_id: 0 }, 7);
        match e {
            AcpEvent::PeerMessage { turn_id, .. } => assert_eq!(turn_id, 7),
            other => panic!("expected PeerMessage, got {other:?}"),
        }
    }

    #[test]
    fn peer_message_text_is_truncated_for_scrollback() {
        // Review focus 5: a huge peer body must be capped like a UserPrompt.
        let big = "y".repeat(USER_PROMPT_SCROLLBACK_CAP + 10);
        let e = cap_peer_message(AcpEvent::PeerMessage { from_name: "a".into(), text: big, turn_id: 0 });
        match e {
            AcpEvent::PeerMessage { text, .. } => {
                assert!(text.len() < USER_PROMPT_SCROLLBACK_CAP + 64);
                assert!(text.contains("[已截断"));
            }
            other => panic!("expected PeerMessage, got {other:?}"),
        }
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

    #[test]
    fn emit_queue_mode_broadcasts_authoritative_wire_string() {
        // F-OBS-LIVE (review 2026-07-27): a live SetQueueMode must broadcast the new
        // mode to already-connected tabs (not only deliver it via replay_done at
        // reconnect). Assert the wire shape + that Interrupt/Collect map to the same
        // strings the client branches on, and Passthrough degrades to "collect".
        let (tx, mut rx) = broadcast::channel::<String>(BROADCAST_CAPACITY);
        emit_queue_mode(&tx, QueueMode::Interrupt);
        let got = rx.try_recv().unwrap();
        let v: serde_json::Value = serde_json::from_str(&got).unwrap();
        assert_eq!(v["type"], "queue_mode");
        assert_eq!(v["queue_mode"], "interrupt");

        emit_queue_mode(&tx, QueueMode::Collect);
        let v: serde_json::Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        assert_eq!(v["queue_mode"], "collect");

        emit_queue_mode(&tx, QueueMode::Passthrough);
        let v: serde_json::Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        assert_eq!(v["queue_mode"], "collect", "passthrough degrades to collect on the wire");
    }

    #[test]
    fn mid_turn_error_content_block_is_not_a_turn_boundary() {
        // F-CODEX-1 (review 2026-07-27): a transient mid-turn Codex error is now
        // emitted as ContentBlock{block_type:"error"} instead of AcpEvent::Error, so
        // the fan-out's `is_boundary` predicate (Result|Error|Exit) must NOT settle
        // the still-running turn on it. Pin the exact predicate the three fan-outs use.
        let is_boundary = |evt: &AcpEvent| {
            matches!(
                evt,
                AcpEvent::Result { .. } | AcpEvent::Error { .. } | AcpEvent::Exit { .. }
            )
        };
        let mid_turn_err = AcpEvent::ContentBlock {
            block_type: std::borrow::Cow::Borrowed("error"),
            turn_id: 0,
            text: Some("Codex: stream retry".into()),
            name: None,
            input: None,
            streaming: Some(false),
            summary: None,
        };
        assert!(!is_boundary(&mid_turn_err), "mid-turn error block must NOT settle the turn");
        // A genuine terminal error still settles it.
        let terminal_err = AcpEvent::Error { message: "Codex error: fatal".into() };
        assert!(is_boundary(&terminal_err), "a terminal Error still settles the turn");
    }

    #[test]
    fn mid_turn_error_block_does_not_bump_the_silence_clock() {
        // F-CODEX-1-CLOCK (review 2026-07-29): since a mid-turn error block no longer
        // settles the turn (test above), it must ALSO not be counted as agent activity
        // — else a Codex error storm keeps resetting last_activity_ms and the 30-min
        // watchdog never reaps a wedged turn. Pin the exact `bump_activity` predicate
        // `emit` uses: false ONLY for a ContentBlock whose block_type is "error";
        // true for every other event (text/thinking/tool blocks, Result, …).
        let bump = |evt: &AcpEvent| {
            !matches!(evt, AcpEvent::ContentBlock { block_type, .. } if block_type == "error")
        };
        let err_block = AcpEvent::ContentBlock {
            block_type: std::borrow::Cow::Borrowed("error"),
            turn_id: 0, text: Some("Codex: transient".into()),
            name: None, input: None, streaming: Some(false), summary: None,
        };
        let text_block = AcpEvent::ContentBlock {
            block_type: std::borrow::Cow::Borrowed("text"),
            turn_id: 0, text: Some("real output".into()),
            name: None, input: None, streaming: Some(true), summary: None,
        };
        assert!(!bump(&err_block), "an error block is not agent progress → must NOT bump the clock");
        assert!(bump(&text_block), "a text block is real progress → must bump the clock");
        assert!(bump(&AcpEvent::Result { text: "done".into(), turn_id: 0, session_id: String::new(),
            cost_usd: None, tokens_in: None, tokens_out: None }),
            "a Result is real progress → must bump the clock");
    }

    #[test]
    fn user_prompt_echo_does_not_bump_the_silence_clock() {
        // review 2026-08-05: a UserPrompt echo is not agent forward-progress. In the
        // default collect mode a prompt sent while a turn is Running is only ENQUEUED,
        // never delivered — yet it flows through `emit` first. If it bumped
        // last_activity_ms, a user poking a genuinely-wedged turn faster than the
        // 30-min idle window kept running_idle_too_long/stuck_push_candidates from ever
        // firing (never killed, never pushed, queue grew unbounded). Same F-CODEX-1-CLOCK
        // class as the error-block exemption above. Pin the exact `emit` predicate:
        // bump is false for BOTH a mid-turn error ContentBlock AND a UserPrompt.
        let bump = |evt: &AcpEvent| {
            !matches!(evt, AcpEvent::ContentBlock { block_type, .. } if block_type == "error")
                && !matches!(evt, AcpEvent::UserPrompt { .. })
        };
        let user_prompt = AcpEvent::UserPrompt {
            text: "are you stuck?".into(),
            turn_id: 5,
            client_id: Some("c1".into()),
        };
        assert!(!bump(&user_prompt),
            "a UserPrompt echo (queued, not delivered to the agent) must NOT bump the clock");
        // The bump lost on the enqueue path is NOT lost on the paths where a prompt
        // actually starts/interrupts a turn: those call mark_turn(Running) → apply_turn,
        // which stamps last_activity_ms fresh (asserted in
        // turn_state_tests::apply_running_sets_started_and_seq). So an idle-then-prompted
        // turn is still spared for the full idle window.
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

    #[test]
    fn crew_session_type_roundtrips() {
        // 持久化往返：DB 里存 "crew"，读回必须还是 Crew（而不是回落 Tmux —— 那会让
        // 一个 Crew 会话在服务重启后变成终端，且 resume_token 被当成垃圾丢掉）。
        assert_eq!(SessionType::Crew.to_string(), "crew");
        assert!(matches!(SessionType::from_str_lenient("crew"), SessionType::Crew));
        // 未知值回落 Tmux（既有约定，最保守：PTY 无 resume 副作用）。
        assert!(matches!(SessionType::from_str_lenient("nonsense"), SessionType::Tmux));
        // Task 11 起 `"kiro"` 不再是已知类型 → 走未知值回落 Tmux（最保守，
        // PTY 无 resume 副作用）。这条在 Task 5 时不成立，故当时未写。
        assert!(matches!(SessionType::from_str_lenient("kiro"), SessionType::Tmux));
    }

    #[test]
    fn scheduled_agent_type_maps_to_session_type() {
        // agent_type 是自由字符串（DB 里存什么都行），所以必须有一个显式映射函数，
        // 且未知值要有明确回落 —— 否则一个手改过 DB 的 agent_type 会静默变成
        // 别的后端，而定时任务是无人值守的（错了没人当场看见）。
        assert!(matches!(scheduled_session_type("claude"), SessionType::Claude));
        // 未知/空 → 回落 Claude（既有行为:生产库里 1 行 agent_type='claude'，
        // 且 trigger_run 在本任务之前一直硬编码 Claude，所以这个回落等于保持现状）。
        assert!(matches!(scheduled_session_type("kiro"), SessionType::Claude));
        assert!(matches!(scheduled_session_type(""), SessionType::Claude));
        assert!(matches!(scheduled_session_type("nonsense"), SessionType::Claude));
        // **下面两条断言 Claude 是刻意的，不是笔误。** `"crew"` / `"codex"` 目前
        // 同样回落 Claude —— 见 `scheduled_session_type` 的文档注释：它们的 fan-out
        // 还没有 `active_run_id` + `finalize_run` 机制，放行会让 run 永停 running。
        // 放行时把这两条改成各自的 SessionType，并同时补 fan-out。
        assert!(matches!(scheduled_session_type("crew"), SessionType::Claude));
        assert!(matches!(scheduled_session_type("codex"), SessionType::Claude));
    }

    #[test]
    fn crew_resume_token_roundtrips() {
        // Crew 的 resume 载荷是 slot_key（不是 session id）—— 重生时用它
        // `GET /api/chat/slots/{key}` 确认存活即接回。
        let t = ResumeToken::Crew("zmx-abc12345".to_string());
        let (kind, value) = t.to_kind_value();
        assert_eq!(kind, "crew");
        assert_eq!(value, "zmx-abc12345");
        assert!(matches!(
            ResumeToken::from_kind_value("crew", "zmx-abc12345"),
            Some(ResumeToken::Crew(v)) if v == "zmx-abc12345"
        ));
    }

    #[test]
    fn crew_slot_key_reads_both_sources() {
        // 两个源都填 slot_key：spawn 开局那条 System{init}，与每轮的 Result。
        // 照 claude_session_id（:2174-2180）的双臂形状 —— 单臂会让一个从未完成
        // 过一轮的会话（只有 init）拿不到 resume token。
        let init = AcpEvent::System {
            subtype: std::borrow::Cow::Borrowed("init"),
            session_id: Some("zmx-abc12345".into()),
            count: None,
        };
        assert_eq!(crew_slot_key(&init).as_deref(), Some("zmx-abc12345"));
        let result = AcpEvent::Result {
            text: "done".into(), turn_id: 1, session_id: "zmx-abc12345".into(),
            cost_usd: None, tokens_in: None, tokens_out: None,
        };
        assert_eq!(crew_slot_key(&result).as_deref(), Some("zmx-abc12345"));
        // 空 session_id 不算（否则会存一个空 token，重生时 GET /slots/ 变成列表请求）。
        let empty = AcpEvent::Result {
            text: String::new(), turn_id: 1, session_id: String::new(),
            cost_usd: None, tokens_in: None, tokens_out: None,
        };
        assert!(crew_slot_key(&empty).is_none());
        // 其它 System subtype 不带 slot_key。
        let queued = AcpEvent::System {
            subtype: std::borrow::Cow::Borrowed("queued"), session_id: None, count: Some(2),
        };
        assert!(crew_slot_key(&queued).is_none());
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
            "claude".into(), "codex".into(), "off".into(),
            5476, "/tmp/crew".into(), "bash".into(), false,
            crate::tmux::TmuxCtl::new(Some("zmx-test-unused".into())),
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
            tmux_origin: None,
            pending_kill_until: None,
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
            posture: Posture::default(),
            running: None,
            scrollback: VecDeque::new(),
            scrollback_bytes: 0,
        }
    }

    fn running_session_lt(id: &str, owner: &str) -> Session {
        let (event_tx, _keep) = broadcast::channel(BROADCAST_CAPACITY);
        let (input_tx, _rx) = mpsc::channel(8);
        let mut s = make_session(id, owner);
        s.status = SessionMeta::Running;
        s.running = Some(RunningProcess {
            event_tx, input_tx, pty_pid: None,
            turn_state: TurnState::Running,
            turn_started_ms: Some(0),
            turn_seq: 1,
            queue_mode: QueueMode::Collect,
        });
        s
    }

    #[test]
    fn emit_userprompt_does_not_bump_clock_but_contentblock_does() {
        // End-to-end guard (Codex-review 2026-08-05): drive the REAL `emit` chokepoint,
        // not a reconstructed predicate. A UserPrompt echo (queued, not delivered in
        // collect mode) must leave last_activity_ms untouched so the 30-min wedge
        // watchdog can still fire; a text ContentBlock (real agent progress) must bump it.
        let (mgr, _dir) = make_manager();
        let sid = "s-clock";
        let s = running_session_lt(sid, "owner1");
        let tx = s.running.as_ref().unwrap().event_tx.clone();
        mgr.sessions.lock().unwrap().insert(sid.into(), s);
        // Force a stale clock so any bump is observable.
        mgr.sessions.lock().unwrap().get_mut(sid).unwrap().last_activity_ms = 0;
        let weak = Arc::downgrade(&mgr);

        // UserPrompt echo → must NOT bump.
        emit(&weak, sid, &tx, 2, &AcpEvent::UserPrompt {
            text: "are you stuck?".into(), turn_id: 2, client_id: Some("c1".into()),
        });
        assert_eq!(mgr.last_activity_ms(sid), Some(0),
            "UserPrompt echo must not bump last_activity_ms (wedge watchdog stays armed)");

        // Text ContentBlock → real progress → must bump.
        emit(&weak, sid, &tx, 2, &AcpEvent::ContentBlock {
            block_type: std::borrow::Cow::Borrowed("text"),
            turn_id: 2, text: Some("working on it".into()),
            name: None, input: None, streaming: Some(true), summary: None,
        });
        assert!(mgr.last_activity_ms(sid).unwrap() > 0,
            "a text ContentBlock is agent progress → must bump last_activity_ms");
    }

    #[tokio::test]
    async fn maybe_push_turn_done_is_safe_noop_without_push_service() {
        // F4 (review 2026-08-06): the turn_done push was extracted into the shared
        // `maybe_push_turn_done` so all fan-outs (Claude/Crew/Codex) notify
        // identically — Crew/Codex previously never pushed. This guards the common
        // path: with no PushService wired (push_handle() == None, the default) the
        // helper must be a clean no-op and never panic, for any backend's session.
        let (mgr, _dir) = make_manager();
        let sid = "s-push";
        let s = running_session_lt(sid, "owner1");
        mgr.sessions.lock().unwrap().insert(sid.into(), s);
        let weak = Arc::downgrade(&mgr);
        // Call it exactly as the fan-outs do; must not panic with push disabled.
        maybe_push_turn_done(&weak, sid, "owner1", 120_000, None);
        // A dropped manager (Weak::upgrade → None) is also a safe no-op.
        maybe_push_turn_done(&Weak::new(), sid, "owner1", 120_000, None);
        // Cancelled/Timeout outcomes are suppressed BEFORE the upgrade — also no-op.
        maybe_push_turn_done(&weak, sid, "owner1", 120_000, Some(crate::run_metrics::RunOutcome::Cancelled));
        maybe_push_turn_done(&weak, sid, "owner1", 120_000, Some(crate::run_metrics::RunOutcome::Timeout));
        tokio::task::yield_now().await; // let any (here: none) spawned task run
        assert!(mgr.session_name(sid).is_some(), "session state untouched by the no-op push");
    }

    #[tokio::test]
    async fn maybe_mark_vault_dirty_reconciles_vault_work_dir_only() {
        let (mgr, _dir) = make_manager();
        let weak = Arc::downgrade(&mgr);
        // No search wired → clean no-op.
        maybe_mark_vault_dirty(&weak, "/tmp/anything");
        maybe_mark_vault_dirty(&Weak::new(), "/tmp/anything");

        let home = tempfile::tempdir().unwrap();
        let vault = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(vault.path().join("单词")).unwrap();
        let si = crate::fuzzy_index::SearchIndexes::start(home.path().into(), Some(vault.path().into()));
        mgr.set_search(si.clone());
        let slot = si.vault.clone().unwrap();
        for _ in 0..200 {
            if slot.current().is_some() && !slot.is_rebuilding() { break; }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        std::fs::write(vault.path().join("单词/2026-09-25-下午.md"), "x").unwrap();
        maybe_mark_vault_dirty(&weak, &vault.path().join("单词").to_string_lossy());
        let mut found = false;
        for _ in 0..200 {
            if slot.current().unwrap().index.entries.iter().any(|e| e.path == "单词/2026-09-25-下午.md") { found = true; break; }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(found, "a note written by the agent must be searchable after its turn ends");
    }

    #[test]
    fn every_fanout_marks_vault_dirty_next_to_turn_done_push() {
        // Parity guard (fan-out invariant): all three agent fan-outs must call the
        // hook, exactly where they settle a turn. Missing one = that backend's
        // notes silently stay unsearchable until the next warm-up.
        let src = include_str!("session_manager.rs");
        // concat! so this test's own literal doesn't count itself.
        let calls = src.matches(concat!("maybe_mark_vault_dirty(&mgr, ", "&work_dir);")).count();
        assert_eq!(calls, 3, "acp + crew + codex fan-outs");
    }

    #[test]
    fn turn_done_push_suppressed_for_cancelled_and_timeout_only() {
        // F3 (review 2026-08-07): the turn_done push payload says "✅ 完成 / 本轮已结束"
        // (success). A turn the user Cancelled/Interrupted (→ RunOutcome::Cancelled)
        // or the watchdog Timeout-killed did NOT complete, so firing it lies to the
        // user. `maybe_push_turn_done` now suppresses those two outcomes and fires for
        // Completed / plain agent-side Error / no-intent turns. This asserts the exact
        // suppression predicate the helper's guard uses, so the classification can't
        // silently drift (the helper's send path needs a live PushService + async
        // runtime; the guard itself is a pure match tested directly here).
        // Assert the EXACT shared predicate both push sites now consult (the
        // `intent_suppresses_push` helper), so turn_done and run_failed can't drift.
        use crate::run_metrics::RunOutcome;
        assert!(intent_suppresses_push(Some(RunOutcome::Cancelled)), "cancelled turn must not push ✅完成");
        assert!(intent_suppresses_push(Some(RunOutcome::Timeout)), "timeout-killed turn must not push ✅完成");
        assert!(!intent_suppresses_push(Some(RunOutcome::Completed)), "a completed turn is a real turn_done");
        assert!(!intent_suppresses_push(Some(RunOutcome::Errored)), "an agent-side error still finished the turn");
        assert!(!intent_suppresses_push(None), "no recorded intent (normal Result boundary) pushes");
    }

    #[test]
    fn run_failed_push_suppressed_on_deliberate_abort_intent() {
        // review 2026-08-12 (F-RUNFAILED-INTENT): the scheduled `run_failed` push at the
        // Error/Exit boundary fired purely on terminal EVENT TYPE, ignoring the settling
        // turn's FIFO intent. A watchdog Timeout-kill (idle_timeout/watchdog_timeout) or a
        // user Cancel drives the child to death → stdout-EOF → AcpEvent::Exit, so the push
        // fired "⚠️ 失败 · 进程退出" — a lie about the cause, and for a side-effecting task a
        // SECOND notification alongside the scheduler's `confirm` push. The metric for the
        // same boundary is (correctly) classified Timeout/Cancelled via intent-override, so
        // run_failed was the sole liar. The push is now gated on `!intent_suppresses_push`,
        // the SAME predicate turn_done uses. This asserts that predicate governs the abort
        // case (Timeout/Cancelled suppress) while genuine errors/exits (no abort intent)
        // still notify.
        use crate::run_metrics::RunOutcome;
        // Deliberately-aborted turns: run_failed must be suppressed.
        assert!(intent_suppresses_push(Some(RunOutcome::Timeout)),
            "a watchdog Timeout-killed scheduled run must NOT push run_failed 'cli_exited'");
        assert!(intent_suppresses_push(Some(RunOutcome::Cancelled)),
            "a user-Cancelled scheduled run must NOT push run_failed");
        // Genuine failures with no abort intent: run_failed still fires.
        assert!(!intent_suppresses_push(None),
            "a genuine CLI crash/exit (no abort intent) is a real run_failed → still push");
        assert!(!intent_suppresses_push(Some(RunOutcome::Errored)),
            "an agent-side error that isn't an abort is a real run_failed → still push");
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
        // 文档化不变量:非 claude-code label 不调用 diff_cost(Crew/Codex cost 恒 None)。
        // 这里断言纯函数对 None 输入的恒等行为,作为接入处的回归锚点。
        let (d, p) = crate::run_metrics::diff_cost(Some(0.0), None, true, false);
        assert_eq!(d, None);
        assert_eq!(p, Some(0.0));
    }
}

#[cfg(test)]
mod tmux_session_tests {
    use super::*;
    use crate::tmux::tests::TestServer;

    fn mgr_with(ctl: crate::tmux::TmuxCtl) -> (Arc<SessionManager>, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let events = Arc::new(crate::events::EventStore::open(dir.path()).unwrap());
        let store = Arc::new(crate::session_store::SessionStore::open(dir.path()).unwrap());
        let m = SessionManager::new(events, store, "claude".into(), "codex".into(), "off".into(),
            5476, "/tmp/crew".into(), "bash".into(), false, ctl);
        (m, dir)
    }

    #[tokio::test]
    async fn new_terminal_is_own_tmux_session() {
        let Some(srv) = TestServer::start() else { return };
        let (m, _d) = mgr_with(srv.ctl.clone());
        let id = m.create_pty_session("t".into(), "bash", "/tmp", 80, 24, "u", None).await.unwrap();
        let (name, origin) = m.tmux_binding(&id).unwrap();
        assert_eq!(name, crate::tmux::tmux_name_for(&id));
        assert_eq!(origin, TmuxOrigin::Own);
        // PTY client attaches asynchronously; poll briefly.
        for _ in 0..30 {
            if srv.ctl.has(&name).await.unwrap() { break; }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        assert!(srv.ctl.has(&name).await.unwrap());
        let info = m.list_sessions(None).into_iter().find(|s| s.id == id).unwrap();
        assert_eq!(info.tmux_name.as_deref(), Some(name.as_str()));
    }

    #[tokio::test]
    async fn tmux_output_is_not_kept_in_scrollback() {
        let Some(srv) = TestServer::start() else { return };
        let (m, _d) = mgr_with(srv.ctl.clone());
        let id = m.create_pty_session("t".into(), "bash", "/tmp", 80, 24, "u", None).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(800)).await; // tmux paints the screen
        let (hist, _rx) = m.subscribe_with_history(&id).unwrap();
        assert!(hist.is_empty(), "tmux redraws on refresh-client; replaying 2MB of redraw bytes is noise");
        assert!(m.pty_pid(&id).is_some());
    }

    #[tokio::test]
    async fn attach_target_is_external() {
        let Some(srv) = TestServer::start() else { return };
        srv.ctl.run(&["new-session", "-d", "-s", "vscode-dev"]).await.unwrap();
        let (m, _d) = mgr_with(srv.ctl.clone());
        let id = m.create_pty_session("x".into(), "bash", "/tmp", 80, 24, "u", Some("vscode-dev")).await.unwrap();
        assert_eq!(m.tmux_binding(&id), Some(("vscode-dev".into(), TmuxOrigin::External)));
    }

    #[tokio::test]
    async fn adopting_zmx_orphan_is_own_and_tracked() {
        let Some(srv) = TestServer::start() else { return };
        srv.ctl.run(&["new-session", "-d", "-s", "zmx-deadbeef"]).await.unwrap();
        let (m, _d) = mgr_with(srv.ctl.clone());
        let id = m.create_pty_session("o".into(), "bash", "/tmp", 80, 24, "u", Some("zmx-deadbeef")).await.unwrap();
        assert_eq!(m.tmux_binding(&id).unwrap().1, TmuxOrigin::Own);
        assert!(m.tracked_tmux_names().contains("zmx-deadbeef"));
    }

    #[tokio::test]
    async fn attaching_an_already_tracked_tmux_session_errors() {
        let Some(srv) = TestServer::start() else { return };
        srv.ctl.run(&["new-session", "-d", "-s", "zmx-deadbeef"]).await.unwrap();
        srv.ctl.run(&["new-session", "-d", "-s", "vscode-dev"]).await.unwrap();
        let (m, _d) = mgr_with(srv.ctl.clone());
        m.create_pty_session("o".into(), "bash", "/tmp", 80, 24, "u", Some("zmx-deadbeef")).await.unwrap();
        let err = m.create_pty_session("o2".into(), "bash", "/tmp", 80, 24, "u", Some("zmx-deadbeef")).await.unwrap_err();
        assert!(err.contains("已被接入"), "{err}");
        m.create_pty_session("x".into(), "bash", "/tmp", 80, 24, "u", Some("vscode-dev")).await.unwrap();
        let err = m.create_pty_session("x2".into(), "bash", "/tmp", 80, 24, "u", Some("vscode-dev")).await.unwrap_err();
        assert!(err.contains("已被接入"), "{err}");
        assert_eq!(m.list_sessions(None).len(), 2);
    }

    #[tokio::test]
    async fn server_down_errors_instead_of_bare_shell() {
        let ctl = crate::tmux::TmuxCtl::new(Some(format!("zmx-test-down-{}", std::process::id())));
        let (m, _d) = mgr_with(ctl);
        let err = m.create_pty_session("t".into(), "bash", "/tmp", 80, 24, "u", None).await.unwrap_err();
        assert!(err.contains("tmux 服务未运行"), "{err}");
        assert!(m.list_sessions(None).is_empty());
    }

    #[test]
    fn decide_resume_matrix() {
        assert!(matches!(decide_tmux_resume(TmuxOrigin::Own, true), Preflight::Ready));
        assert!(matches!(decide_tmux_resume(TmuxOrigin::External, true), Preflight::Ready));
        assert!(matches!(decide_tmux_resume(TmuxOrigin::Own, false), Preflight::Lost));
        assert!(matches!(decide_tmux_resume(TmuxOrigin::External, false), Preflight::Ended));
    }

    fn idle_tmux(m: &SessionManager, id: &str, name: &str, origin: TmuxOrigin) {
        let mut s = test_session_for_size();
        s.id = id.into();
        s.resume_token = Some(ResumeToken::Tmux(name.into()));
        s.tmux_origin = Some(origin);
        m.sessions.lock().unwrap().insert(id.into(), s);
    }

    #[tokio::test]
    async fn external_missing_marks_ended() {
        let Some(srv) = TestServer::start() else { return };
        let (m, _d) = mgr_with(srv.ctl.clone());
        idle_tmux(&m, "e1", "gone-ext", TmuxOrigin::External);
        assert!(matches!(m.tmux_preflight("e1").await, Preflight::Ended));
        let st = m.list_sessions(None).into_iter().find(|s| s.id == "e1").unwrap().status;
        assert!(matches!(st, SessionMeta::Ended));
        // A second connect must not spawn anything either.
        assert!(matches!(m.tmux_preflight("e1").await, Preflight::Ended));
        assert!(m.revive("e1"));
        assert_eq!(m.tmux_binding("e1").unwrap().1, TmuxOrigin::Own);
        assert!(matches!(m.tmux_preflight("e1").await, Preflight::Lost), "revived → recreated as own");
    }

    #[tokio::test]
    async fn own_missing_is_lost_and_server_down_reported() {
        let Some(srv) = TestServer::start() else { return };
        let (m, _d) = mgr_with(srv.ctl.clone());
        idle_tmux(&m, "o1", "zmx-o1", TmuxOrigin::Own);
        assert!(matches!(m.tmux_preflight("o1").await, Preflight::Lost));
        let (m2, _d2) = mgr_with(crate::tmux::TmuxCtl::new(Some(format!("zmx-test-down2-{}", std::process::id()))));
        idle_tmux(&m2, "o2", "zmx-o2", TmuxOrigin::Own);
        assert!(matches!(m2.tmux_preflight("o2").await, Preflight::ServerDown));
    }

    #[tokio::test]
    async fn killing_tmux_ends_the_session() {
        let Some(srv) = TestServer::start() else { return };
        let (m, _d) = mgr_with(srv.ctl.clone());
        let id = m.create_pty_session("t".into(), "bash", "/tmp", 80, 24, "u", None).await.unwrap();
        let (name, _) = m.tmux_binding(&id).unwrap();
        for _ in 0..30 { if srv.ctl.has(&name).await.unwrap() { break; } tokio::time::sleep(std::time::Duration::from_millis(100)).await; }
        srv.ctl.kill(&name).await.unwrap();      // e.g. killed from VSCode
        let mut ended = false;
        for _ in 0..50 {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            if let Some(s) = m.list_sessions(None).into_iter().find(|s| s.id == id) {
                if matches!(s.status, SessionMeta::Ended) { ended = true; break; }
            }
        }
        assert!(ended, "fan-out exit + has=false must mark Ended");
    }

    #[tokio::test]
    async fn killing_the_only_session_on_server_ends_it() {
        let Some(srv) = TestServer::start() else { return };
        srv.kill_boot();
        let (m, _d) = mgr_with(srv.ctl.clone());
        let id = m.create_pty_session("t".into(), "bash", "/tmp", 80, 24, "u", None).await.unwrap();
        let (name, _) = m.tmux_binding(&id).unwrap();
        for _ in 0..30 { if srv.ctl.has(&name).await.unwrap() { break; } tokio::time::sleep(std::time::Duration::from_millis(100)).await; }
        assert_eq!(srv.ctl.list().await.unwrap().len(), 1, "ours is the only session");
        srv.ctl.kill(&name).await.unwrap();      // server now empty (exit-empty off)
        let mut ended = false;
        for _ in 0..50 {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            if let Some(s) = m.list_sessions(None).into_iter().find(|s| s.id == id) {
                if matches!(s.status, SessionMeta::Ended) { ended = true; break; }
            }
        }
        assert!(ended, "empty server answers 'no current target' — must still be has=false → Ended");
    }

    #[tokio::test]
    async fn own_missing_on_empty_server_is_lost_not_server_down() {
        let Some(srv) = TestServer::start() else { return };
        srv.kill_boot();
        let (m, _d) = mgr_with(srv.ctl.clone());
        idle_tmux(&m, "o1", "zmx-o1", TmuxOrigin::Own);
        assert!(matches!(m.tmux_preflight("o1").await, Preflight::Lost));
        idle_tmux(&m, "e1", "gone-ext", TmuxOrigin::External);
        assert!(matches!(m.tmux_preflight("e1").await, Preflight::Ended));
    }

    #[tokio::test]
    async fn attach_missing_target_errors_and_creates_nothing() {
        let Some(srv) = TestServer::start() else { return };
        let (m, _d) = mgr_with(srv.ctl.clone());
        let err = m.create_pty_session("x".into(), "bash", "/tmp", 80, 24, "u", Some("no-such-sess")).await.unwrap_err();
        assert!(err.contains("tmux 会话不存在"), "{err}");
        assert!(m.list_sessions(None).is_empty());
        assert!(!srv.ctl.has("no-such-sess").await.unwrap(), "must not create the target");
    }

    #[test]
    fn set_size_updates_memory_and_store() {
        let (m, _d) = mgr_with(crate::tmux::TmuxCtl::new(Some("zmx-test-unused".into())));
        let mut s = test_session_for_size();
        s.id = "sz".into();
        m.persist_meta(&s);
        m.sessions.lock().unwrap().insert("sz".into(), s);
        m.set_size("sz", 101, 33);
        let s = m.sessions.lock().unwrap().get("sz").map(|s| (s.cols, s.rows));
        assert_eq!(s, Some((101, 33)));
        let row = m.store.load_all().unwrap().into_iter().find(|p| p.id == "sz").unwrap();
        assert_eq!((row.cols, row.rows), (101, 33));
    }

    #[tokio::test]
    async fn delayed_kill_then_restore_and_finalize() {
        let Some(srv) = TestServer::start() else { return };
        let (m, _d) = mgr_with(srv.ctl.clone());
        let id = m.create_pty_session("t".into(), "bash", "/tmp", 80, 24, "u", None).await.unwrap();
        let (name, _) = m.tmux_binding(&id).unwrap();
        for _ in 0..30 { if srv.ctl.has(&name).await.unwrap() { break; } tokio::time::sleep(std::time::Duration::from_millis(100)).await; }

        assert!(m.mark_pending_kill(&id, 1_000));
        assert!(m.list_sessions(None).iter().all(|s| s.id != id), "hidden while pending");
        assert!(m.restore(&id));
        assert!(m.list_sessions(None).iter().any(|s| s.id == id), "restored");
        assert!(!m.finalize_pending_kill(&id, 1_000 + PENDING_KILL_MS).await, "restore cancels the kill");
        assert!(srv.ctl.has(&name).await.unwrap());

        assert!(m.mark_pending_kill(&id, 2_000));
        assert!(!m.finalize_pending_kill(&id, 2_000 + PENDING_KILL_MS - 1).await, "not due yet");
        assert!(m.finalize_pending_kill(&id, 2_000 + PENDING_KILL_MS).await);
        assert!(!srv.ctl.has(&name).await.unwrap(), "tmux session killed");
        assert!(m.tmux_binding(&id).is_none(), "zeromux session removed");
    }

    #[tokio::test]
    async fn external_sessions_are_killed_too() {
        let Some(srv) = TestServer::start() else { return };
        srv.ctl.run(&["new-session", "-d", "-s", "ext1"]).await.unwrap();
        let (m, _d) = mgr_with(srv.ctl.clone());
        let id = m.create_pty_session("x".into(), "bash", "/tmp", 80, 24, "u", Some("ext1")).await.unwrap();
        assert!(m.mark_pending_kill(&id, 0));
        assert!(m.finalize_pending_kill(&id, PENDING_KILL_MS).await);
        assert!(!srv.ctl.has("ext1").await.unwrap());
    }

    #[tokio::test]
    async fn startup_reconcile_kills_pending() {
        let Some(srv) = TestServer::start() else { return };
        let dir = tempfile::tempdir().unwrap();
        let id = {
            let events = Arc::new(crate::events::EventStore::open(dir.path()).unwrap());
            let store = Arc::new(crate::session_store::SessionStore::open(dir.path()).unwrap());
            let m = SessionManager::new(events, store, "claude".into(), "codex".into(), "off".into(),
                5476, "/tmp/crew".into(), "bash".into(), false, srv.ctl.clone());
            let id = m.create_pty_session("t".into(), "bash", "/tmp", 80, 24, "u", None).await.unwrap();
            assert!(m.mark_pending_kill(&id, now_millis()));   // not yet due
            id
        }; // "process exits" before the timer fires
        let name = crate::tmux::tmux_name_for(&id);
        srv.ctl.run(&["new-session", "-d", "-s", &name]).await.ok(); // ensure it exists even if PTY died
        let events = Arc::new(crate::events::EventStore::open(dir.path()).unwrap());
        let store = Arc::new(crate::session_store::SessionStore::open(dir.path()).unwrap());
        let m = SessionManager::new(events, store, "claude".into(), "codex".into(), "off".into(),
            5476, "/tmp/crew".into(), "bash".into(), false, srv.ctl.clone());
        m.load_persisted();
        m.reconcile_pending_kills().await;
        assert!(!srv.ctl.has(&name).await.unwrap());
        assert!(m.list_sessions(None).is_empty());
    }

    #[tokio::test]
    async fn close_check_reports_other_clients_and_origin() {
        let Some(srv) = TestServer::start() else { return };
        srv.ctl.run(&["new-session", "-d", "-s", "ext2"]).await.unwrap();
        let (m, _d) = mgr_with(srv.ctl.clone());
        let id = m.create_pty_session("x".into(), "bash", "/tmp", 80, 24, "u", Some("ext2")).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let c = m.close_check(&id).await.unwrap();
        assert!(c.external);
        assert_eq!(c.other_clients, 0, "zeromux's own client is not 'other'");
        assert!(c.busy_command.is_none(), "idle shell is not busy");
    }

    #[test]
    fn mark_ended_leaves_running_session_alone() {
        let (m, _d) = mgr_with(crate::tmux::TmuxCtl::new(Some("zmx-test-unused".into())));
        let mut s = test_session_for_size();
        s.id = "r1".into();
        let (event_tx, _) = broadcast::channel(BROADCAST_CAPACITY);
        let (input_tx, _rx) = mpsc::channel(8);
        s.running = Some(RunningProcess {
            event_tx, input_tx, pty_pid: None, turn_state: TurnState::Idle,
            turn_started_ms: None, turn_seq: 0, queue_mode: QueueMode::Collect,
        });
        s.status = SessionMeta::Running;
        m.sessions.lock().unwrap().insert("r1".into(), s);
        m.mark_ended("r1");
        let map = m.sessions.lock().unwrap();
        let s = map.get("r1").unwrap();
        assert!(s.running.is_some(), "a concurrent respawn must survive mark_ended");
        assert!(matches!(s.status, SessionMeta::Running), "status unchanged while running");
        drop(map);
        let mut sp = test_session_for_size();
        sp.id = "sp".into();
        sp.spawning = true;
        m.sessions.lock().unwrap().insert("sp".into(), sp);
        m.mark_ended("sp");
        assert!(matches!(m.sessions.lock().unwrap().get("sp").unwrap().status, SessionMeta::Idle),
            "a spawning session must not be marked Ended");
    }

    #[test]
    fn mark_ended_return_value_signals_real_transition_only() {
        // The fan-out exit path (spawn_tmux) fires the `term_ended` push only
        // when mark_ended returns true, so it must be true exactly once for a
        // genuine Idle/no-running → Ended transition, and false for every case
        // that must NOT push: no-op on a running/spawning session (asserted by
        // the sibling test above), and false on a second call once already Ended
        // (so a respawn-and-die-again cycle, or any duplicate fan-out exit check,
        // can't double-push "已结束" for the same tmux session).
        let (m, _d) = mgr_with(crate::tmux::TmuxCtl::new(Some("zmx-test-unused".into())));
        let mut s = test_session_for_size();
        s.id = "e1".into();
        s.status = SessionMeta::Idle;
        m.sessions.lock().unwrap().insert("e1".into(), s);
        assert!(m.mark_ended("e1"), "Idle → Ended is a real transition");
        assert!(!m.mark_ended("e1"), "already Ended: no second push");
        assert!(!m.mark_ended("missing"), "no such session: false, not a panic");
    }

    #[test]
    fn owner_of_looks_up_the_owning_user() {
        let (m, _d) = mgr_with(crate::tmux::TmuxCtl::new(Some("zmx-test-unused".into())));
        let mut s = test_session_for_size();
        s.id = "e2".into();
        s.owner_id = "alice".into();
        m.sessions.lock().unwrap().insert("e2".into(), s);
        assert_eq!(m.owner_of("e2"), Some("alice".into()));
        assert_eq!(m.owner_of("missing"), None);
    }

    #[tokio::test]
    async fn closing_ended_session_does_not_kill_recreated_name() {
        let Some(srv) = TestServer::start() else { return };
        let (m, _d) = mgr_with(srv.ctl.clone());
        idle_tmux(&m, "e", "x", TmuxOrigin::External);
        assert!(matches!(m.tmux_preflight("e").await, Preflight::Ended));
        srv.ctl.run(&["new-session", "-d", "-s", "x"]).await.unwrap(); // re-created elsewhere
        assert!(m.close_check("e").await.is_none(), "no confirm for a dead binding");
        assert!(m.mark_pending_kill("e", 0));
        assert!(m.finalize_pending_kill("e", PENDING_KILL_MS).await);
        assert!(srv.ctl.has("x").await.unwrap(), "unrelated session with the same name survives");
        assert!(m.tmux_binding("e").is_none(), "zeromux session removed");
    }

    fn test_session_for_size() -> Session {
        Session {
            id: "sid".into(), name: "n".into(), session_type: SessionType::Tmux,
            cols: 80, rows: 24, work_dir: "/tmp".into(), owner_id: "u".into(),
            description: String::new(), name_is_auto: true, status: SessionMeta::Idle,
            resume_token: Some(ResumeToken::Tmux("zmx-sid".into())), tmux_origin: Some(TmuxOrigin::Own),
            pending_kill_until: None,
            worktree_path: None, created_ms: 0, source_task_id: None, spawning: false,
            last_activity_ms: 0, turns_completed: 0, run_metrics: VecDeque::new(),
            lifetime_turns: 0, lifetime_duration_ms: 0, lifetime_cost_usd: 0.0,
            posture: Posture::default(),
            running: None, scrollback: VecDeque::new(), scrollback_bytes: 0,
        }
    }
}

#[cfg(test)]
mod terminal_size_tests {
    use super::*;

    #[test]
    fn resize_is_sane_rejects_hidden_view_fallback_dims() {
        assert!(!resize_is_sane(12, 5), "hidden xterm fallback");
        assert!(!resize_is_sane(10, 5));
        assert!(!resize_is_sane(80, 4));
        assert!(!resize_is_sane(0, 0));
        assert!(resize_is_sane(MIN_COLS, MIN_ROWS));
        assert!(resize_is_sane(53, 20));
        assert!(resize_is_sane(80, 24));
    }

    fn persisted(id: &str, cols: u16, rows: u16) -> PersistedSession {
        PersistedSession {
            id: id.into(), name: id.into(), session_type: SessionType::Tmux,
            work_dir: "/tmp".into(), owner_id: "u".into(), description: String::new(),
            resume_token: Some(ResumeToken::Tmux(format!("zmx-{id}"))), worktree_path: None,
            created_ms: 0, source_task_id: None, name_is_auto: true,
            tmux_origin: Some("own".into()), cols, rows, pending_kill_until: None,
            posture: Default::default(),
            crew_mode: String::new(), crew_agent: String::new(), crew_origin: "zeromux".into(),
        }
    }

    #[test]
    fn load_persisted_clamps_corrupted_tiny_size_to_default() {
        let dir = tempfile::tempdir().unwrap();
        let events = Arc::new(crate::events::EventStore::open(dir.path()).unwrap());
        let store = Arc::new(crate::session_store::SessionStore::open(dir.path()).unwrap());
        store.upsert(&persisted("tiny", 10, 5)).unwrap();
        store.upsert(&persisted("short", 120, 3)).unwrap();
        store.upsert(&persisted("ok", 53, 20)).unwrap();
        let m = SessionManager::new(events, store, "claude".into(), "codex".into(), "off".into(),
            5476, "/tmp/crew".into(), "bash".into(), false,
            crate::tmux::TmuxCtl::new(Some("zmx-test-unused".into())));
        m.load_persisted();
        let map = m.sessions.lock().unwrap();
        let size = |id: &str| { let s = map.get(id).unwrap(); (s.cols, s.rows) };
        assert_eq!(size("tiny"), (DEFAULT_COLS, DEFAULT_ROWS));
        assert_eq!(size("short"), (DEFAULT_COLS, DEFAULT_ROWS));
        assert_eq!(size("ok"), (53, 20), "sane sizes are kept");
    }
}

#[cfg(test)]
mod posture_tests {
    use super::*;
    use std::borrow::Cow;

    fn block(bt: &'static str, text: Option<&str>, name: Option<&str>, summary: Option<&str>) -> AcpEvent {
        AcpEvent::ContentBlock {
            block_type: Cow::Borrowed(bt), turn_id: 0,
            text: text.map(String::from), name: name.map(String::from),
            input: None, streaming: None, summary: summary.map(String::from),
        }
    }

    #[test]
    fn snippet_takes_last_nonempty_line_strips_markdown_and_caps_chars() {
        assert_eq!(snippet_of("first\n\n**Done**: fixed `x`\n\n").as_deref(), Some("Done: fixed x"));
        assert_eq!(snippet_of("   \n  ").as_deref(), None);
        let long: String = "中".repeat(300);
        let s = snippet_of(&long).unwrap();
        assert_eq!(s.chars().count(), 120, "cap by chars, never bytes (multi-byte safe)");
        assert_eq!(snippet_of("# Title\n- item one").as_deref(), Some("item one"));
        // `_` inside identifiers survives; only whole-line `_emphasis_` is stripped.
        assert_eq!(snippet_of("fixed `session_manager.rs`").as_deref(), Some("fixed session_manager.rs"));
        assert_eq!(snippet_of("_all green_").as_deref(), Some("all green"));
    }

    #[test]
    fn delta_tool_use_is_step_with_name_and_summary_capped_80() {
        let d = posture_delta_of(&block("tool_use", None, Some("Bash"), Some("npx vitest run")));
        assert!(matches!(d, Some(PostureDelta::Step(ref s)) if s == "Bash · npx vitest run"));
        let d = posture_delta_of(&block("tool_use", None, Some("Read"), None));
        assert!(matches!(d, Some(PostureDelta::Step(ref s)) if s == "Read"));
        let long = "x".repeat(200);
        match posture_delta_of(&block("tool_use", None, Some("Bash"), Some(&long))) {
            Some(PostureDelta::Step(s)) => assert_eq!(s.chars().count(), 80),
            _ => panic!("expected Step"),
        }
    }

    #[test]
    fn delta_ignores_streaming_text_and_thinking_takes_result_text() {
        // Codex/Crew stream deltas: taking their "last line" would yield fragments (M3).
        assert!(posture_delta_of(&block("text", Some("partial wo"), None, None)).is_none());
        assert!(posture_delta_of(&block("thinking", Some("hmm"), None, None)).is_none());
        let r = AcpEvent::Result { text: "All green.\nShipped".into(), turn_id: 0, session_id: String::new(),
            cost_usd: None, tokens_in: None, tokens_out: None };
        assert!(matches!(posture_delta_of(&r), Some(PostureDelta::Snippet(ref s)) if s == "Shipped"));
        let empty = AcpEvent::Result { text: "  ".into(), turn_id: 0, session_id: String::new(),
            cost_usd: None, tokens_in: None, tokens_out: None };
        assert!(posture_delta_of(&empty).is_none());
    }

    #[test]
    fn delta_approval_increments() {
        let a = AcpEvent::Approval { id: "a1".into(), tool: "rm".into(), tool_input: None, tool_purpose: None, slot: "s".into() };
        assert!(matches!(posture_delta_of(&a), Some(PostureDelta::ApprovalAdded(ref id)) if id == "a1"));
        let mut p = Posture::default();
        apply_posture_delta(&mut p, PostureDelta::ApprovalAdded("a1".into()));
        apply_posture_delta(&mut p, PostureDelta::ApprovalAdded("a1".into()));   // replayed / duplicate frame
        apply_posture_delta(&mut p, PostureDelta::ApprovalAdded("a2".into()));
        assert_eq!(p.approval_ids, vec!["a1".to_string(), "a2".to_string()], "dedupe by id (M9b)");
    }

    #[test]
    fn posture_settles_only_on_live_turn_that_consumed_a_start() {
        assert!(posture_settles(3, 3, true), "live settle");
        assert!(!posture_settles(2, 3, true), "stale interrupt-resend boundary");
        assert!(!posture_settles(3, 3, false), "idle spurious boundary (e.g. Gateway reconnect Error)");
        assert!(!posture_settles(3, 3, false), "second boundary of an already-settled turn");
    }

    #[test]
    fn user_prompt_and_system_have_no_delta() {
        let u = AcpEvent::UserPrompt { text: "hi".into(), turn_id: 1, client_id: None };
        assert!(posture_delta_of(&u).is_none());
        let s = AcpEvent::System { subtype: Cow::Borrowed("status"), session_id: None, count: None };
        assert!(posture_delta_of(&s).is_none());
    }

    fn base_session(id: &str, stype: SessionType) -> Session {
        Session {
            id: id.into(), name: "n".into(), session_type: stype, cols: 80, rows: 24,
            work_dir: "/tmp".into(), owner_id: "o".into(), description: String::new(),
            name_is_auto: true, status: SessionMeta::Idle, resume_token: None, tmux_origin: None,
            pending_kill_until: None, worktree_path: None, created_ms: 0, source_task_id: None,
            spawning: false, last_activity_ms: 0, turns_completed: 0, run_metrics: VecDeque::new(),
            lifetime_turns: 0, lifetime_duration_ms: 0, lifetime_cost_usd: 0.0, posture: Posture::default(),
            running: None, scrollback: VecDeque::new(), scrollback_bytes: 0,
        }
    }

    fn mgr_one(stype: SessionType) -> (Arc<SessionManager>, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let events = Arc::new(crate::events::EventStore::open(dir.path()).unwrap());
        let store = Arc::new(crate::session_store::SessionStore::open(dir.path()).unwrap());
        let m = SessionManager::new(events, store, "claude".into(), "codex".into(), "off".into(),
            5476, "/tmp/crew".into(), "bash".into(), false,
            crate::tmux::TmuxCtl::new(Some("zmx-test-unused".into())));
        let (event_tx, _) = broadcast::channel(BROADCAST_CAPACITY);
        let (input_tx, _rx) = mpsc::channel::<SessionInput>(64);
        let mut s = base_session("p", stype);
        s.running = Some(RunningProcess { event_tx, input_tx, pty_pid: None, turn_state: TurnState::Running,
            turn_started_ms: None, turn_seq: 1, queue_mode: QueueMode::Collect });
        m.sessions.lock().unwrap().insert("p".into(), s);
        (m, dir)
    }

    fn info(m: &SessionManager) -> SessionInfo {
        session_info_of(m.sessions.lock().unwrap().get("p").unwrap())
    }

    #[test]
    fn record_applies_delta_under_lock_and_info_exports_it() {
        for stype in [SessionType::Claude, SessionType::Codex, SessionType::Crew] {
            let (m, _d) = mgr_one(stype);
            m.record_and_broadcast("p", "{}".into(), true,
                posture_delta_of(&block("tool_use", None, Some("Edit"), Some("src/a.rs"))));
            assert_eq!(info(&m).current_step.as_deref(), Some("Edit · src/a.rs"), "{:?}", stype);
            m.record_and_broadcast("p", "{}".into(), true, None);
            assert_eq!(info(&m).current_step.as_deref(), Some("Edit · src/a.rs"), "None delta leaves posture");
        }
    }

    #[test]
    fn settle_records_outcome_clears_step_and_approvals() {
        let (m, _d) = mgr_one(SessionType::Crew);
        let a = AcpEvent::Approval { id: "a".into(), tool: "t".into(), tool_input: None, tool_purpose: None, slot: "s".into() };
        m.record_and_broadcast("p", "{}".into(), true, posture_delta_of(&a));
        m.record_and_broadcast("p", "{}".into(), true, posture_delta_of(&block("tool_use", None, Some("Bash"), None)));
        assert_eq!(info(&m).pending_approvals, 1);
        let before = now_millis();
        m.settle_posture("p", crate::run_metrics::RunOutcome::Errored);
        let i = info(&m);
        assert_eq!(i.last_outcome, Some("errored"));
        assert!(i.last_outcome_ms.unwrap() >= before);
        assert_eq!(i.current_step, None, "settled boundary clears the running step");
        assert_eq!(i.pending_approvals, 0, "turn boundary zeroes approvals (Gateway has no receipt, M5)");
    }

    #[test]
    fn errored_or_timed_out_settle_drops_the_previous_snippet() {
        // A10: the triage second line must not show the last SUCCESSFUL turn's summary
        // under an 出错 badge.
        use crate::run_metrics::RunOutcome;
        for (outcome, cleared) in [(RunOutcome::Errored, true), (RunOutcome::Timeout, true),
                                   (RunOutcome::Completed, false), (RunOutcome::Cancelled, false)] {
            let (m, _d) = mgr_one(SessionType::Claude);
            let r = AcpEvent::Result { text: "All green".into(), turn_id: 0, session_id: String::new(),
                cost_usd: None, tokens_in: None, tokens_out: None };
            m.record_and_broadcast("p", "{}".into(), true, posture_delta_of(&r));
            m.settle_posture("p", outcome);
            assert_eq!(info(&m).last_snippet.is_none(), cleared, "{:?}", outcome);
        }
    }

    #[test]
    fn turn_start_clears_stale_approvals() {
        // A9: interrupt-resend, or an approval answered elsewhere (Gateway dashboard),
        // leaves no settle for the old turn; a new turn must not inherit 待审批.
        let (m, _d) = mgr_one(SessionType::Crew);
        let a = AcpEvent::Approval { id: "old".into(), tool: "t".into(), tool_input: None, tool_purpose: None, slot: "s".into() };
        m.record_and_broadcast("p", "{}".into(), true, posture_delta_of(&a));
        assert_eq!(info(&m).pending_approvals, 1);
        m.mark_turn("p", TurnState::Running, 2);
        assert_eq!(info(&m).pending_approvals, 0);
        // An approval raised during the new turn still counts.
        let b = AcpEvent::Approval { id: "new".into(), tool: "t".into(), tool_input: None, tool_purpose: None, slot: "s".into() };
        m.record_and_broadcast("p", "{}".into(), true, posture_delta_of(&b));
        assert_eq!(info(&m).pending_approvals, 1);
        m.mark_turn("p", TurnState::Idle, 2);
        assert_eq!(info(&m).pending_approvals, 1, "Idle leaves approvals to settle_posture");
    }

    #[test]
    fn approval_resolved_removes_by_id() {
        let (m, _d) = mgr_one(SessionType::Crew);
        for id in ["a", "b"] {
            let ev = AcpEvent::Approval { id: id.into(), tool: "t".into(), tool_input: None, tool_purpose: None, slot: "s".into() };
            m.record_and_broadcast("p", "{}".into(), true, posture_delta_of(&ev));
        }
        m.approval_resolved("p", "a");
        m.approval_resolved("p", "a");      // double click / unknown id is a no-op
        m.approval_resolved("p", "zzz");
        assert_eq!(info(&m).pending_approvals, 1);
    }

    #[test]
    fn approval_resolved_advances_last_activity() {
        // The human's answer is forward progress: an old request must not flip the
        // session to 可能卡住 the moment it is approved.
        let (m, _d) = mgr_one(SessionType::Crew);
        let ev = AcpEvent::Approval { id: "a".into(), tool: "t".into(), tool_input: None, tool_purpose: None, slot: "s".into() };
        m.record_and_broadcast("p", "{}".into(), true, posture_delta_of(&ev));
        m.sessions.lock().unwrap().get_mut("p").unwrap().last_activity_ms = 0;
        m.approval_resolved("p", "a");
        assert!(m.last_activity_ms("p").unwrap() > 0, "approval_resolved must bump last_activity_ms");
    }

    #[test]
    fn info_exports_lifetime_cost_and_defaults() {
        let (m, _d) = mgr_one(SessionType::Claude);
        m.sessions.lock().unwrap().get_mut("p").unwrap().lifetime_cost_usd = 0.42;
        let i = info(&m);
        assert_eq!(i.lifetime_cost_usd, 0.42);
        assert_eq!(i.last_outcome, None);
        assert_eq!(i.last_snippet, None);
        let json = serde_json::to_value(&i).unwrap();
        assert_eq!(json["pending_approvals"], 0);
        assert!(json["last_outcome"].is_null());
    }
}

#[cfg(test)]
mod posture_persist_tests {
    use super::*;
    use crate::run_metrics::RunOutcome;

    /// Shared fixture (also used by later S5 tasks): an idle, in-memory Claude session.
    pub(super) fn session(id: &str) -> Session {
        Session {
            id: id.into(), name: "n".into(), session_type: SessionType::Claude, cols: 80, rows: 24,
            work_dir: "/tmp".into(), owner_id: "o".into(), description: String::new(),
            name_is_auto: true, status: SessionMeta::Idle, resume_token: None, tmux_origin: None,
            pending_kill_until: None, worktree_path: None, created_ms: 0, source_task_id: None,
            spawning: false, last_activity_ms: 0, turns_completed: 0, run_metrics: VecDeque::new(),
            lifetime_turns: 0, lifetime_duration_ms: 0, lifetime_cost_usd: 0.0, posture: Posture::default(),
            running: None, scrollback: VecDeque::new(), scrollback_bytes: 0,
        }
    }

    /// Shared fixture: a manager whose event/session DBs live in `dir`, so a second
    /// `mgr_at(dir)` + `load_persisted()` simulates a restart.
    pub(super) fn mgr_at(dir: &std::path::Path) -> Arc<SessionManager> {
        let events = Arc::new(crate::events::EventStore::open(dir).unwrap());
        let store = Arc::new(crate::session_store::SessionStore::open(dir).unwrap());
        SessionManager::new(events, store, "claude".into(), "codex".into(), "off".into(),
            5476, "/tmp/crew".into(), "bash".into(), false,
            crate::tmux::TmuxCtl::new(Some("zmx-test-unused".into())))
    }

    /// Shared fixture: put `s` both in the store and in memory.
    pub(super) fn seed(m: &SessionManager, s: Session) {
        m.store.upsert(&persisted_of(&s)).unwrap();
        m.sessions.lock().unwrap().insert(s.id.clone(), s);
    }

    fn result(text: &str) -> AcpEvent {
        AcpEvent::Result { text: text.into(), turn_id: 0, session_id: String::new(),
            cost_usd: None, tokens_in: None, tokens_out: None }
    }

    pub(super) fn reloaded_info(dir: &std::path::Path, id: &str) -> SessionInfo {
        let m = mgr_at(dir);
        m.load_persisted();
        let map = m.sessions.lock().unwrap();
        session_info_of(map.get(id).unwrap())
    }

    #[test]
    fn completed_settle_survives_restart() {
        let d = tempfile::tempdir().unwrap();
        let m = mgr_at(d.path());
        seed(&m, session("p"));
        m.record_and_broadcast("p", "{}".into(), true, posture_delta_of(&result("All green\nShipped")));
        m.settle_posture("p", RunOutcome::Completed);
        let before = session_info_of(m.sessions.lock().unwrap().get("p").unwrap());
        drop(m);
        let after = reloaded_info(d.path(), "p");
        assert_eq!(after.last_outcome, Some("completed"));
        assert_eq!(after.last_outcome_ms, before.last_outcome_ms, "timestamp survives verbatim");
        assert_eq!(after.last_snippet.as_deref(), Some("Shipped"));
    }

    #[test]
    fn errored_settle_persists_a_null_snippet() {
        // D9 / A10: a failed turn must not resurrect the previous turn's summary after restart.
        let d = tempfile::tempdir().unwrap();
        let m = mgr_at(d.path());
        seed(&m, session("p"));
        m.record_and_broadcast("p", "{}".into(), true, posture_delta_of(&result("old summary")));
        m.settle_posture("p", RunOutcome::Completed);
        m.settle_posture("p", RunOutcome::Errored);
        drop(m);
        let after = reloaded_info(d.path(), "p");
        assert_eq!(after.last_outcome, Some("errored"));
        assert_eq!(after.last_snippet, None);
    }

    #[test]
    fn current_step_and_approvals_are_not_restored() {
        let d = tempfile::tempdir().unwrap();
        let m = mgr_at(d.path());
        seed(&m, session("p"));
        m.settle_posture("p", RunOutcome::Completed);
        // A new turn is mid-flight when the process dies.
        let tool = AcpEvent::ContentBlock { block_type: std::borrow::Cow::Borrowed("tool_use"), turn_id: 0,
            text: None, name: Some("Bash".into()), input: None, streaming: None, summary: None };
        m.record_and_broadcast("p", "{}".into(), true, posture_delta_of(&tool));
        let ap = AcpEvent::Approval { id: "a".into(), tool: "t".into(), tool_input: None, tool_purpose: None, slot: "s".into() };
        m.record_and_broadcast("p", "{}".into(), true, posture_delta_of(&ap));
        m.persist_posture("p");
        drop(m);
        let after = reloaded_info(d.path(), "p");
        assert_eq!(after.current_step, None);
        assert_eq!(after.pending_approvals, 0);
        assert_eq!(after.last_outcome, Some("completed"));
    }

    #[test]
    fn awaiting_input_round_trips() {
        let d = tempfile::tempdir().unwrap();
        let m = mgr_at(d.path());
        seed(&m, session("p"));
        m.sessions.lock().unwrap().get_mut("p").unwrap().posture.awaiting_input = true;
        m.persist_posture("p");
        drop(m);
        let m2 = mgr_at(d.path());
        m2.load_persisted();
        assert!(m2.sessions.lock().unwrap().get("p").unwrap().posture.awaiting_input);
    }

    #[test]
    fn unknown_outcome_string_loads_as_none_without_panic() {
        let d = tempfile::tempdir().unwrap();
        let m = mgr_at(d.path());
        seed(&m, session("p"));
        m.store.update_posture("p", &crate::session_store::PersistedPosture {
            last_outcome: Some("exploded".into()), last_outcome_ms: Some(7), ..Default::default()
        }).unwrap();
        drop(m);
        let after = reloaded_info(d.path(), "p");
        assert_eq!(after.last_outcome, None);
        assert_eq!(after.last_outcome_ms, Some(7));
    }

    #[test]
    fn persist_for_a_session_missing_from_the_store_is_a_silent_noop() {
        // In-memory-only sessions (every other test module) must not error or panic.
        let d = tempfile::tempdir().unwrap();
        let m = mgr_at(d.path());
        m.sessions.lock().unwrap().insert("ghost".into(), session("ghost"));
        m.settle_posture("ghost", RunOutcome::Completed);
        m.persist_posture("nope");
        // Nothing was written to the store (UPDATE on a missing row affects zero rows) …
        assert_eq!(m.store.load_all().unwrap().len(), 0);
        // … yet the in-memory posture still settled normally.
        let info = session_info_of(m.sessions.lock().unwrap().get("ghost").unwrap());
        assert_eq!(info.last_outcome, Some("completed"));
        assert!(info.last_outcome_ms.is_some());
    }

    fn running(mut s: Session) -> Session {
        let (event_tx, _) = broadcast::channel(BROADCAST_CAPACITY);
        let (input_tx, _rx) = mpsc::channel::<SessionInput>(8);
        s.running = Some(RunningProcess { event_tx, input_tx, pty_pid: None, turn_state: TurnState::Idle,
            turn_started_ms: None, turn_seq: 0, queue_mode: QueueMode::Collect });
        s
    }

    #[test]
    fn push_snippet_is_this_turns_result_only() {
        // Review Focus 1: Claude calls maybe_push_turn_done BEFORE settle_posture, so an
        // errored turn still holds the previous turn's last_snippet at push time.
        let d = tempfile::tempdir().unwrap();
        let m = mgr_at(d.path());
        seed(&m, running(session("p")));
        m.mark_turn("p", TurnState::Running, 1);
        m.record_and_broadcast("p", "{}".into(), true, posture_delta_of(&result("全部测试通过")));
        assert_eq!(m.push_snippet("p").as_deref(), Some("全部测试通过"));
        m.settle_posture("p", RunOutcome::Completed);
        // Turn 2 errors without a Result of its own.
        m.mark_turn("p", TurnState::Running, 2);
        assert_eq!(m.push_snippet("p"), None, "a new turn starts with no push snippet");
        assert_eq!(
            session_info_of(m.sessions.lock().unwrap().get("p").unwrap()).last_snippet.as_deref(),
            Some("全部测试通过"),
            "the triage second line is unchanged until settle"
        );
    }

    #[test]
    fn push_snippet_is_not_persisted() {
        let d = tempfile::tempdir().unwrap();
        let m = mgr_at(d.path());
        seed(&m, running(session("p")));
        m.record_and_broadcast("p", "{}".into(), true, posture_delta_of(&result("done")));
        m.settle_posture("p", RunOutcome::Completed);
        drop(m);
        let m2 = mgr_at(d.path());
        m2.load_persisted();
        assert_eq!(m2.push_snippet("p"), None);
    }

    #[tokio::test]
    async fn maybe_push_run_done_is_safe_noop_without_push_service() {
        let d = tempfile::tempdir().unwrap();
        let m = mgr_at(d.path());
        seed(&m, running(session("p")));
        assert!(m.push_handle().is_none(), "premise: no PushService wired");
        let weak = Arc::downgrade(&m);
        maybe_push_run_done(&weak, "p", "o", Some("无新告警"));
        maybe_push_run_done(&weak, "p", "o", None);
        maybe_push_run_done(&Weak::new(), "p", "o", None);
    }

    #[test]
    fn result_boundary_with_aborted_intent_does_not_push_run_done() {
        // Review fix: a Cancelled/Timeout scheduled run can still end on a Result
        // (partial text) → finalize_run("succeeded") arm; it must not push "⏰ 完成".
        assert!(!run_done_push_allowed(Some(RunOutcome::Cancelled)));
        assert!(!run_done_push_allowed(Some(RunOutcome::Timeout)));
        assert!(run_done_push_allowed(None), "a normal Result boundary pushes");
        assert!(run_done_push_allowed(Some(RunOutcome::Completed)));
    }
}
