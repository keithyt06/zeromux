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
    /// ACP/Kiro: prompt text
    Prompt(String),
    /// ACP/Kiro: cancel/kill
    Cancel,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum TurnState { Idle, Running }

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
    pub status: SessionMeta,
    resume_token: Option<ResumeToken>,
    /// Git worktree path for ACP sessions (cleaned up on delete)
    worktree_path: Option<PathBuf>,
    created_ms: i64,
    /// 并发重生互斥（仅锁内访问）。
    spawning: bool,
    last_activity_ms: i64,
    turns_completed: u32,
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
fn resolve_work_dir(work_dir: &str, session_id: &str) -> (PathBuf, Option<PathBuf>) {
    let base = if work_dir == "." {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
    } else {
        PathBuf::from(work_dir)
    };

    if is_git_repo(&base) {
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
                if rp.turn_seq == seq {
                    rp.turn_state = TurnState::Idle;
                    rp.turn_started_ms = None;
                    session.turns_completed = session.turns_completed.wrapping_add(1);
                }
            }
        }
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
        });
        *mgr.self_weak.lock().unwrap() = Arc::downgrade(&mgr);
        mgr
    }

    fn weak(&self) -> Weak<SessionManager> {
        self.self_weak.lock().unwrap().clone()
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
                                let _ = event_tx_clone.send(b64);
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
            status: SessionMeta::Running,
            resume_token: tmux_target.map(|t| ResumeToken::Tmux(t.to_string())),
            worktree_path: None,
            created_ms: now_millis(),
            spawning: false,
            last_activity_ms: now_millis(),
            turns_completed: 0,
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
            work_dir.to_string(),
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
        let id = uuid::Uuid::new_v4().to_string();
        let (effective_dir, worktree_path) = resolve_work_dir(work_dir, &id);

        let running = self
            .spawn_claude(&id, &effective_dir.to_string_lossy(), None)
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
            status: SessionMeta::Running,
            resume_token: None,
            worktree_path,
            created_ms: now_millis(),
            spawning: false,
            last_activity_ms: now_millis(),
            turns_completed: 0,
            running: Some(running),
            scrollback: VecDeque::new(),
            scrollback_bytes: 0,
        };

        self.persist_meta(&session);
        self.sessions.lock().unwrap().insert(id.clone(), session);
        Ok(id)
    }

    /// Spawn a Kiro process for `id` at `work_dir`, start its fan-out, return the
    /// live handle. `resume: Some(sid)` issues `session/load` to restore context.
    async fn spawn_kiro(
        &self,
        id: &str,
        work_dir: &str,
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
        let (effective_dir, worktree_path) = resolve_work_dir(work_dir, &id);

        let running = self
            .spawn_kiro(&id, &effective_dir.to_string_lossy(), None)
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
            status: SessionMeta::Running,
            resume_token: None,
            worktree_path,
            created_ms: now_millis(),
            spawning: false,
            last_activity_ms: now_millis(),
            turns_completed: 0,
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
        let (effective_dir, worktree_path) = resolve_work_dir(work_dir, &id);

        let running = self
            .spawn_codex(&id, &effective_dir.to_string_lossy(), None)
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
            status: SessionMeta::Running,
            resume_token: None,
            worktree_path,
            created_ms: now_millis(),
            spawning: false,
            last_activity_ms: now_millis(),
            turns_completed: 0,
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
        let Some(SpawnPlan { stype, resume_token: token, work_dir, cols, rows }) = plan else {
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
                self.spawn_claude(id, &work_dir, r).await
            }
            SessionType::Kiro => {
                let r = match &token {
                    Some(ResumeToken::Kiro(s)) => Some(s.as_str()),
                    _ => None,
                };
                self.spawn_kiro(id, &work_dir, r).await
            }
            SessionType::Codex => {
                let r = match &token {
                    Some(ResumeToken::Codex(t)) => Some(t.clone()),
                    _ => None,
                };
                self.spawn_codex(id, &work_dir, r).await
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
                    SessionType::Claude => self.spawn_claude(id, &work_dir, None).await,
                    SessionType::Kiro => self.spawn_kiro(id, &work_dir, None).await,
                    SessionType::Codex => self.spawn_codex(id, &work_dir, None).await,
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
        // Apply in-memory under the lock, capturing the new description (if any)
        // so we can persist it AFTER releasing the sessions lock.
        let persist_desc = {
            let mut map = self.sessions.lock().unwrap();
            match map.get_mut(id) {
                Some(session) => {
                    let mut persist = None;
                    if let Some(d) = description {
                        session.description = d.clone();
                        persist = Some(d);
                    }
                    if let Some(s) = status {
                        session.status = s;
                    }
                    Some(persist)
                }
                None => None,
            }
        };
        match persist_desc {
            Some(persist) => {
                if let Some(d) = persist {
                    let _ = self.store.update_description(id, &d);
                }
                true
            }
            None => false,
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
                    status: SessionMeta::Idle,
                    resume_token: p.resume_token,
                    worktree_path: p.worktree_path.map(std::path::PathBuf::from),
                    created_ms: p.created_ms,
                    spawning: false,
                    last_activity_ms: now_millis(),
                    turns_completed: 0,
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
            while s.scrollback_bytes > SCROLLBACK_MAX_BYTES && !s.scrollback.is_empty() {
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
        if let Err(e) = events.create(req) {
            tracing::warn!("Failed to auto-log task_done for session {}: {}", session_id, e);
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

fn spawn_acp_fanout(
    sid: String,
    mut process: AcpProcess,
    event_tx: broadcast::Sender<String>,
    mut input_rx: mpsc::Receiver<SessionInput>,
    events: Arc<EventStore>,
    agent_label: &'static str,
    work_dir: String,
    mgr: Weak<SessionManager>,
) {
    tokio::spawn(async move {
        let mut token_saved = false;
        loop {
            tokio::select! {
                event = process.event_rx.recv() => {
                    match event {
                        Some(evt) => {
                            log_result_event(&events, agent_label, &sid, &work_dir, &evt);
                            // Backfill Claude resume token on first id-bearing event.
                            if !token_saved {
                                if let Some(sid_val) = claude_session_id(&evt) {
                                    if let Some(m) = mgr.upgrade() {
                                        m.set_resume_token(&sid, ResumeToken::Claude(sid_val));
                                    }
                                    token_saved = true;
                                }
                            }
                            let json = match serde_json::to_string(&evt) {
                                Ok(j) => j,
                                Err(_) => continue,
                            };
                            let _ = event_tx.send(json);
                        }
                        None => break,
                    }
                }
                input = input_rx.recv() => {
                    match input {
                        Some(SessionInput::Prompt(text)) => {
                            if let Err(e) = process.send_prompt(&text).await {
                                tracing::warn!("ACP send_prompt failed for {}: {}", sid, e);
                            }
                        }
                        Some(SessionInput::Cancel) => {
                            process.kill().await;
                        }
                        None => break, // all input senders dropped (session removed)
                        _ => {} // ignore PTY commands
                    }
                }
            }
        }
        mark_fanout_ended(&mgr, &sid);
        tracing::info!("ACP fan-out task ended for session {}", sid);
    });
}

fn spawn_kiro_fanout(
    sid: String,
    mut process: KiroProcess,
    event_tx: broadcast::Sender<String>,
    mut input_rx: mpsc::Receiver<SessionInput>,
    events: Arc<EventStore>,
    agent_label: &'static str,
    work_dir: String,
    mgr: Weak<SessionManager>,
) {
    tokio::spawn(async move {
        let mut token_saved = false;
        loop {
            tokio::select! {
                event = process.event_rx.recv() => {
                    match event {
                        Some(evt) => {
                            log_result_event(&events, agent_label, &sid, &work_dir, &evt);
                            // Backfill Kiro resume token (sessionId) on first id-bearing event.
                            if !token_saved {
                                if let Some(sid_val) = kiro_session_id(&evt) {
                                    if let Some(m) = mgr.upgrade() {
                                        m.set_resume_token(&sid, ResumeToken::Kiro(sid_val));
                                    }
                                    token_saved = true;
                                }
                            }
                            let json = match serde_json::to_string(&evt) {
                                Ok(j) => j,
                                Err(_) => continue,
                            };
                            let _ = event_tx.send(json);
                        }
                        None => break,
                    }
                }
                input = input_rx.recv() => {
                    match input {
                        Some(SessionInput::Prompt(text)) => {
                            if let Err(e) = process.send_prompt(&text).await {
                                tracing::warn!("Kiro send_prompt failed for {}: {}", sid, e);
                            }
                        }
                        Some(SessionInput::Cancel) => {
                            process.kill().await;
                        }
                        None => break,
                        // PtyData / PtyResize aren't meaningful for an MCP
                        // agent session — they only apply to PTY/tmux. Drop
                        // silently rather than mis-route into send_prompt.
                        _ => {}
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
    mgr: Weak<SessionManager>,
) {
    tokio::spawn(async move {
        let mut token_saved = false;
        loop {
            tokio::select! {
                event = process.event_rx.recv() => {
                    match event {
                        Some(evt) => {
                            log_result_event(&events, agent_label, &sid, &work_dir, &evt);
                            // Backfill Codex resume token (threadId) on first id-bearing event.
                            if !token_saved {
                                if let Some(tid) = codex_thread_id(&evt) {
                                    if let Some(m) = mgr.upgrade() {
                                        m.set_resume_token(&sid, ResumeToken::Codex(tid));
                                    }
                                    token_saved = true;
                                }
                            }
                            let json = match serde_json::to_string(&evt) {
                                Ok(j) => j,
                                Err(_) => continue,
                            };
                            let _ = event_tx.send(json);
                        }
                        None => break,
                    }
                }
                input = input_rx.recv() => {
                    match input {
                        Some(SessionInput::Prompt(text)) => {
                            if let Err(e) = process.send_prompt(&text).await {
                                tracing::warn!("Codex send_prompt failed for {}: {}", sid, e);
                            }
                        }
                        Some(SessionInput::Cancel) => {
                            process.kill().await;
                        }
                        None => break,
                        // See note in spawn_kiro_fanout: PTY-style inputs
                        // are silently dropped for MCP sessions.
                        _ => {}
                    }
                }
            }
        }
        mark_fanout_ended(&mgr, &sid);
        tracing::info!("Codex fan-out task ended for session {}", sid);
    });
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
            status: SessionMeta::Idle,
            resume_token: None,
            worktree_path: None,
            created_ms: 0,
            spawning: false,
            last_activity_ms: 0,
            turns_completed: 0,
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
            status: SessionMeta::Running,
            resume_token: None, worktree_path: None, created_ms: 0,
            spawning: false,
            last_activity_ms: 0,
            turns_completed: 0,
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
}
