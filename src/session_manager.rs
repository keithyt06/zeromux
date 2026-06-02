use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tokio::sync::{broadcast, mpsc};

/// Max scrollback buffer size in bytes (2MB of encoded data)
const SCROLLBACK_MAX_BYTES: usize = 2 * 1024 * 1024;

/// Broadcast channel capacity — slow clients that fall behind will get Lagged error
const BROADCAST_CAPACITY: usize = 512;

use crate::acp::kiro_process::KiroProcess;
use crate::acp::process::AcpProcess;
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

#[derive(Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
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
    /// Broadcast channel: fan-out task writes, all WS clients subscribe
    event_tx: broadcast::Sender<String>,
    /// Input channel: any WS client writes, fan-out task forwards to process
    input_tx: mpsc::Sender<SessionInput>,
    /// Git worktree path for ACP sessions (cleaned up on delete)
    worktree_path: Option<PathBuf>,
    /// PTY child PID kept for /proc lookup (PTY sessions only)
    pty_pid: Option<u32>,
    /// Output history for replay on reconnect (base64 for PTY, JSON for ACP/Kiro)
    scrollback: VecDeque<String>,
    scrollback_bytes: usize,
}

pub struct SessionManager {
    sessions: Mutex<HashMap<String, Session>>,
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

impl SessionManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    pub fn create_pty_session(
        &self,
        name: String,
        shell: &str,
        work_dir: &str,
        cols: u16,
        rows: u16,
        owner_id: &str,
        tmux_target: Option<&str>,
    ) -> Result<String, String> {
        let cwd = if work_dir.is_empty() || work_dir == "." {
            None
        } else {
            Some(work_dir)
        };
        let (cmd, args): (&str, Vec<&str>) = if let Some(target) = tmux_target {
            ("tmux", vec!["attach", "-t", target])
        } else {
            (shell, vec![])
        };
        let (pty, mut output_rx) = PtyHandle::spawn(cmd, &args, &[], cols, rows, cwd)
            .map_err(|e| format!("Failed to spawn PTY: {}", e))?;

        let effective_dir = if work_dir.is_empty() || work_dir == "." {
            std::env::current_dir().unwrap_or_default().to_string_lossy().to_string()
        } else {
            work_dir.to_string()
        };

        let id = uuid::Uuid::new_v4().to_string();
        let (event_tx, _) = broadcast::channel(BROADCAST_CAPACITY);
        let (input_tx, mut input_rx) = mpsc::channel::<SessionInput>(64);

        let pid = pty.pid();
        let event_tx_clone = event_tx.clone();
        let sid = id.clone();

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
        });

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
            event_tx,
            input_tx,
            worktree_path: None,
            pty_pid: pid,
            scrollback: VecDeque::new(),
            scrollback_bytes: 0,
        };

        self.sessions.lock().unwrap().insert(id.clone(), session);
        Ok(id)
    }

    pub async fn create_acp_session(
        &self,
        name: String,
        claude_path: &str,
        work_dir: &str,
        cols: u16,
        rows: u16,
        owner_id: &str,
    ) -> Result<String, String> {
        let id = uuid::Uuid::new_v4().to_string();
        let (effective_dir, worktree_path) = resolve_work_dir(work_dir, &id);

        let process = AcpProcess::spawn(claude_path, effective_dir.to_str().unwrap_or("."))
            .await
            .map_err(|e| {
                if let Some(wt) = &worktree_path {
                    let base = PathBuf::from(work_dir);
                    remove_worktree(&base, wt);
                }
                format!("Failed to spawn Claude: {}", e)
            })?;

        let (event_tx, _) = broadcast::channel(BROADCAST_CAPACITY);
        let (input_tx, input_rx) = mpsc::channel::<SessionInput>(64);

        let event_tx_clone = event_tx.clone();
        let sid = id.clone();

        // Spawn fan-out task for ACP process
        spawn_acp_fanout(sid, process, event_tx_clone, input_rx);

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
            event_tx,
            input_tx,
            worktree_path,
            pty_pid: None,
            scrollback: VecDeque::new(),
            scrollback_bytes: 0,
        };

        self.sessions.lock().unwrap().insert(id.clone(), session);
        Ok(id)
    }

    pub async fn create_kiro_session(
        &self,
        name: String,
        kiro_path: &str,
        work_dir: &str,
        cols: u16,
        rows: u16,
        owner_id: &str,
    ) -> Result<String, String> {
        let id = uuid::Uuid::new_v4().to_string();
        let (effective_dir, worktree_path) = resolve_work_dir(work_dir, &id);

        let process = KiroProcess::spawn(kiro_path, effective_dir.to_str().unwrap_or("."))
            .await
            .map_err(|e| {
                if let Some(wt) = &worktree_path {
                    let base = PathBuf::from(work_dir);
                    remove_worktree(&base, wt);
                }
                format!("Failed to spawn Kiro: {}", e)
            })?;

        let (event_tx, _) = broadcast::channel(BROADCAST_CAPACITY);
        let (input_tx, input_rx) = mpsc::channel::<SessionInput>(64);

        let event_tx_clone = event_tx.clone();
        let sid = id.clone();

        // Spawn fan-out task for Kiro process
        spawn_kiro_fanout(sid, process, event_tx_clone, input_rx);

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
            event_tx,
            input_tx,
            worktree_path,
            pty_pid: None,
            scrollback: VecDeque::new(),
            scrollback_bytes: 0,
        };

        self.sessions.lock().unwrap().insert(id.clone(), session);
        Ok(id)
    }

    pub async fn create_codex_session(
        &self,
        name: String,
        codex_path: &str,
        codex_reasoning: &str,
        work_dir: &str,
        cols: u16,
        rows: u16,
        owner_id: &str,
    ) -> Result<String, String> {
        let id = uuid::Uuid::new_v4().to_string();
        let (effective_dir, worktree_path) = resolve_work_dir(work_dir, &id);

        let reasoning = if codex_reasoning.is_empty() || codex_reasoning == "off" {
            None
        } else {
            Some(codex_reasoning.to_string())
        };

        let process = crate::acp::codex_process::CodexProcess::spawn(
            codex_path,
            effective_dir.to_str().unwrap_or("."),
            reasoning,
        )
        .await
        .map_err(|e| {
            if let Some(wt) = &worktree_path {
                let base = PathBuf::from(work_dir);
                remove_worktree(&base, wt);
            }
            format!("Failed to spawn Codex: {}", e)
        })?;

        let (event_tx, _) = broadcast::channel(BROADCAST_CAPACITY);
        let (input_tx, input_rx) = mpsc::channel::<SessionInput>(64);

        let event_tx_clone = event_tx.clone();
        let sid = id.clone();

        // Spawn fan-out task for Codex process
        spawn_codex_fanout(sid, process, event_tx_clone, input_rx);

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
            event_tx,
            input_tx,
            worktree_path,
            pty_pid: None,
            scrollback: VecDeque::new(),
            scrollback_bytes: 0,
        };

        self.sessions.lock().unwrap().insert(id.clone(), session);
        Ok(id)
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
            .map(|s| SessionInfo {
                id: s.id.clone(),
                name: s.name.clone(),
                session_type: s.session_type,
                cols: s.cols,
                rows: s.rows,
                work_dir: s.work_dir.clone(),
                description: s.description.clone(),
                status: s.status,
            })
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
            .map(|s| s.event_tx.subscribe())
    }

    /// Get the input sender for a session. Returns None if session not found.
    pub fn input_tx(&self, id: &str) -> Option<mpsc::Sender<SessionInput>> {
        self.sessions
            .lock()
            .unwrap()
            .get(id)
            .map(|s| s.input_tx.clone())
    }

    // (PTY write/resize now handled via input_tx → fan-out task)

    /// Update session metadata (description, status)
    pub fn update_session_meta(
        &self,
        id: &str,
        description: Option<String>,
        status: Option<SessionMeta>,
    ) -> bool {
        if let Some(session) = self.sessions.lock().unwrap().get_mut(id) {
            if let Some(d) = description {
                session.description = d;
            }
            if let Some(s) = status {
                session.status = s;
            }
            true
        } else {
            false
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
        self.sessions.lock().unwrap().get(id).and_then(|s| s.pty_pid)
    }
}

// ── Fan-out tasks for ACP/Kiro processes ──

fn spawn_acp_fanout(
    sid: String,
    mut process: AcpProcess,
    event_tx: broadcast::Sender<String>,
    mut input_rx: mpsc::Receiver<SessionInput>,
) {
    tokio::spawn(async move {
        loop {
            tokio::select! {
                event = process.event_rx.recv() => {
                    match event {
                        Some(evt) => {
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
        tracing::info!("ACP fan-out task ended for session {}", sid);
    });
}

fn spawn_kiro_fanout(
    sid: String,
    mut process: KiroProcess,
    event_tx: broadcast::Sender<String>,
    mut input_rx: mpsc::Receiver<SessionInput>,
) {
    tokio::spawn(async move {
        loop {
            tokio::select! {
                event = process.event_rx.recv() => {
                    match event {
                        Some(evt) => {
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
        tracing::info!("Kiro fan-out task ended for session {}", sid);
    });
}

fn spawn_codex_fanout(
    sid: String,
    mut process: crate::acp::codex_process::CodexProcess,
    event_tx: broadcast::Sender<String>,
    mut input_rx: mpsc::Receiver<SessionInput>,
) {
    tokio::spawn(async move {
        loop {
            tokio::select! {
                event = process.event_rx.recv() => {
                    match event {
                        Some(evt) => {
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
