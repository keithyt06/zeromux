# Codex CLI (MCP) Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `codex mcp-server` as a third AI agent session type in zeromux, peer to Claude Code and Kiro, using the official `rmcp` Rust SDK to drive the MCP protocol over stdio. Multi-turn conversations are preserved via Codex's `threadId`; cancellation uses MCP `notifications/cancelled` to abort the in-flight turn without losing the thread.

**Architecture:** New file `src/acp/codex_process.rs` wraps `rmcp::serve_client` over a `TokioChildProcess` running `codex mcp-server`. The `CodexProcess` struct exposes the same outer API as `KiroProcess` (`spawn` / `send_prompt` / `kill` / `pub event_rx: mpsc::Receiver<AcpEvent>`), so `session_manager.rs` integrates by adding a `Codex` variant + `create_codex_session` + `spawn_codex_fanout` that mirrors the existing Kiro plumbing. Internally an event loop holds a `RunningService` (rmcp client) and an `Option<String> thread_id`; first prompt routes to `tools/call("codex")`, subsequent prompts route to `tools/call("codex-reply")`. A custom `ClientHandler` impl translates `notifications/progress` into `AcpEvent::ContentBlock { streaming: true }` and auto-accepts any `elicitation/create` reverse requests as a defensive fallback (with `approval-policy: "never"` they should not fire).

**Tech Stack:** Rust (axum 0.8, tokio, **rmcp 1.7** with `client` + `transport-child-process` features, futures 0.3), TypeScript (React 19).

**Spec reference:** `docs/specs/2026-05-19-codex-mcp-integration-design.md`

**Working directory:** Project root is `/home/ubuntu/s3-workspace/keith-space/github-search/ai/zeromux/`. All paths are relative to it unless prefixed with `frontend/`. Frontend commands run inside `frontend/`; backend commands run at the root.

---

## File Map

**New backend files:**
- `src/acp/codex_process.rs` — `CodexProcess` struct + `ClientHandler` impl + event loop + thread_id state machine. ~180 lines.

**Modified backend files:**
- `Cargo.toml` — add `rmcp = { version = "1.7", features = ["client", "transport-child-process"] }`
- `src/acp/mod.rs` — `pub mod codex_process;`
- `src/main.rs` — `--codex-path` CLI flag + `AppState.codex_path` field
- `src/session_manager.rs` — `SessionType::Codex` enum variant + Display + `create_codex_session` + `spawn_codex_fanout`
- `src/web.rs` — `Codex` arm in `create_session` match

**Modified frontend files:**
- `frontend/src/lib/api.ts` — extend `SessionType` union with `'codex'`
- `frontend/src/components/Sidebar.tsx` — Codex button in new-session panel + icon mapping in session list rows
- `frontend/src/components/AcpChatView.tsx` — extend `agentType` union with `'codex'` + label

---

## Task 1: Add `rmcp` dependency

**Files:**
- Modify: `Cargo.toml`

- [ ] **Step 1: Add the dependency**

In `Cargo.toml` `[dependencies]` (alphabetical position; just after `reqwest` and before `rusqlite`):

```toml
rmcp = { version = "1.7", features = ["client", "transport-child-process"] }
```

- [ ] **Step 2: Build to fetch and resolve**

Run: `cargo build`
Expected: clean build, new deps downloaded, no warnings about feature conflicts.

- [ ] **Step 3: Verify only one tokio version is in tree**

Run: `cargo tree -i tokio | head -20`
Expected: a single `tokio v1.x` entry; `rmcp` shows up as one of its rev-deps along with `axum`, `reqwest`, etc.

If multiple `tokio` versions appear, **stop**: pin a compatible `rmcp` minor version that aligns with the existing `tokio` 1.x major.

- [ ] **Step 4: Commit**

```bash
git add Cargo.toml Cargo.lock
git commit -m "chore: add rmcp 1.7 for Codex MCP client integration"
```

---

## Task 2: Skeleton `codex_process.rs` (compiles, doesn't spawn yet)

**Files:**
- Create: `src/acp/codex_process.rs`
- Modify: `src/acp/mod.rs`

- [ ] **Step 1: Create the skeleton file**

Create `src/acp/codex_process.rs` with the bare struct + non-functional spawn that returns an error:

```rust
use crate::acp::process::AcpEvent;
use tokio::sync::mpsc;

#[allow(dead_code)]
enum Cmd {
    Prompt(String),
    Cancel,
    Stop,
}

pub struct CodexProcess {
    #[allow(dead_code)]
    cmd_tx: mpsc::Sender<Cmd>,
    pub event_rx: mpsc::Receiver<AcpEvent>,
}

impl CodexProcess {
    pub async fn spawn(
        _codex_path: &str,
        _work_dir: &str,
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        Err("CodexProcess::spawn not yet implemented".into())
    }

    #[allow(dead_code)]
    pub async fn send_prompt(&mut self, _text: &str) -> Result<(), std::io::Error> {
        Err(std::io::Error::new(std::io::ErrorKind::Other, "not yet implemented"))
    }

    #[allow(dead_code)]
    pub async fn kill(&mut self) {}
}

impl Drop for CodexProcess {
    fn drop(&mut self) {}
}
```

- [ ] **Step 2: Register module in `src/acp/mod.rs`**

After the existing `pub mod kiro_process;` line, add:

```rust
pub mod codex_process;
```

The full file should now read:
```rust
pub mod kiro_process;
pub mod codex_process;
pub mod process;
pub mod ws_handler;
```

- [ ] **Step 3: Build**

Run: `cargo build`
Expected: clean build, no warnings (the `#[allow(dead_code)]` keeps it quiet).

- [ ] **Step 4: Commit**

```bash
git add src/acp/codex_process.rs src/acp/mod.rs
git commit -m "feat: add CodexProcess skeleton (compiles, spawn returns error)"
```

---

## Task 3: Add `SessionType::Codex` + display + non-functional `create_codex_session`

**Files:**
- Modify: `src/session_manager.rs`

- [ ] **Step 1: Extend the `SessionType` enum**

In `src/session_manager.rs` around line 42-48, change:

```rust
#[derive(Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionType {
    Tmux,
    Claude,
    Kiro,
}
```

to:

```rust
#[derive(Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionType {
    Tmux,
    Claude,
    Kiro,
    Codex,
}
```

- [ ] **Step 2: Extend the `Display` impl**

Around line 50-58, change:

```rust
impl std::fmt::Display for SessionType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SessionType::Tmux => write!(f, "tmux"),
            SessionType::Claude => write!(f, "claude"),
            SessionType::Kiro => write!(f, "kiro"),
        }
    }
}
```

to:

```rust
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
```

- [ ] **Step 3: Add `create_codex_session` and `spawn_codex_fanout` (mirrors of Kiro)**

Find `create_kiro_session` (around line 350). Immediately after its closing `}`, paste:

```rust
    pub async fn create_codex_session(
        &self,
        name: String,
        codex_path: &str,
        work_dir: &str,
        cols: u16,
        rows: u16,
        owner_id: &str,
    ) -> Result<String, String> {
        let sid = uuid::Uuid::new_v4().to_string();
        let (effective_dir, worktree_path) = self.prepare_session_workdir(&sid, work_dir)?;

        let process = crate::acp::codex_process::CodexProcess::spawn(
            codex_path,
            effective_dir.to_str().unwrap_or("."),
        )
        .await
        .map_err(|e| {
            if let Some(path) = &worktree_path {
                let _ = std::fs::remove_dir_all(path);
            }
            format!("Failed to spawn Codex: {}", e)
        })?;

        let (event_tx, _event_rx) = broadcast::channel::<String>(256);
        let (input_tx, input_rx) = mpsc::channel::<SessionInput>(64);
        let event_tx_clone = event_tx.clone();
        let sid_clone = sid.clone();

        spawn_codex_fanout(sid_clone, process, event_tx_clone, input_rx);

        let session = Session {
            id: sid.clone(),
            name,
            session_type: SessionType::Codex,
            cols,
            rows,
            work_dir: effective_dir.to_string_lossy().to_string(),
            owner_id: owner_id.to_string(),
            description: String::new(),
            status: SessionMeta::default(),
            event_tx,
            input_tx,
            worktree_path,
            pty_pid: None,
            scrollback: VecDeque::new(),
            scrollback_bytes: 0,
        };

        self.sessions.lock().unwrap().insert(sid.clone(), session);
        Ok(sid)
    }
```

Then find `spawn_kiro_fanout` (around line 579). Immediately after its closing `}`, paste:

```rust
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
                        _ => {}
                    }
                }
            }
        }
        tracing::info!("Codex fan-out task ended for session {}", sid);
    });
}
```

- [ ] **Step 4: Build**

Run: `cargo build`
Expected: clean build. The Codex variant being added to the enum will produce non-exhaustive match errors in `web.rs`; that's expected and Task 4 fixes it.

If you see "non-exhaustive patterns" in `session_manager.rs` itself (any internal `match s.session_type`), add `SessionType::Codex => { /* same as Kiro */ }` arms. The codebase generally treats Codex like Kiro for housekeeping (worktree cleanup, scrollback, etc).

- [ ] **Step 5: Commit**

```bash
git add src/session_manager.rs
git commit -m "feat: add SessionType::Codex variant + create_codex_session"
```

---

## Task 4: Wire `--codex-path` CLI flag and `web.rs` route branch

**Files:**
- Modify: `src/main.rs`
- Modify: `src/web.rs`

- [ ] **Step 1: Add CLI argument and AppState field in `src/main.rs`**

Around line 42-44 (where `kiro_path` is defined), after `kiro_path: String,` add:

```rust
    /// Path to codex CLI binary
    #[arg(long, default_value = "codex")]
    codex_path: String,
```

Around line 91-92 (where `pub kiro_path: String,` lives in `AppState`), add:

```rust
    pub codex_path: String,
```

Around line 202-203 (where `claude_path` and `kiro_path` are threaded into the `AppState` literal), add:

```rust
        codex_path: args.codex_path,
```

- [ ] **Step 2: Add the Codex match arm in `src/web.rs`**

Around line 318-336, the `create_session` function has a `match req.session_type {}` block. Add a fourth arm:

```rust
        crate::session_manager::SessionType::Codex => {
            state.sessions
                .create_codex_session(name.clone(), &state.codex_path, &work_dir, state.default_cols, state.default_rows, &owner_id)
                .await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        }
```

- [ ] **Step 3: Build**

Run: `cargo build`
Expected: clean build.

- [ ] **Step 4: Sanity-run**

Run: `./target/debug/zeromux --help | grep -A1 codex`
Expected: shows `--codex-path <CODEX_PATH>` with default `codex`.

- [ ] **Step 5: Commit**

```bash
git add src/main.rs src/web.rs
git commit -m "feat: --codex-path CLI flag and web route arm for Codex sessions"
```

---

## Task 5: Frontend wiring (button + label) so the UI can trigger Codex creation

**Files:**
- Modify: `frontend/src/lib/api.ts`
- Modify: `frontend/src/components/Sidebar.tsx`
- Modify: `frontend/src/components/AcpChatView.tsx`

- [ ] **Step 1: Extend the `SessionType` union in `api.ts`**

Find line 1:

```ts
export type SessionType = 'tmux' | 'claude' | 'kiro'
```

Change to:

```ts
export type SessionType = 'tmux' | 'claude' | 'kiro' | 'codex'
```

- [ ] **Step 2: Extend the `agentType` prop in `AcpChatView.tsx`**

Around line 54:

```ts
  agentType?: 'claude' | 'kiro'
```

Change to:

```ts
  agentType?: 'claude' | 'kiro' | 'codex'
```

Then around lines 242, 260, 288, change the agent-name expression to handle all three. For example line 242:

```tsx
<MessageBubble key={msg.id} msg={msg} agentName={agentType === 'kiro' ? 'Kiro' : agentType === 'codex' ? 'Codex' : 'Claude'} />
```

Apply the same triple-conditional to lines 260 (`Send a message to ...`) and 288 (default `agentName` parameter).

- [ ] **Step 3: Add Codex button to Sidebar new-session panel**

In `frontend/src/components/Sidebar.tsx`, find lines 281-300 (the Claude + Kiro buttons in `step === 'pick-type'`). Immediately after the Kiro button's closing `</button>`, add:

```tsx
                  <button
                    onClick={() => selectType('codex')}
                    className="flex items-center gap-2.5 w-full px-3 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                  >
                    <Cpu size={14} className="text-[var(--accent-blue)] shrink-0" />
                    <div className="text-left">
                      <div className="font-medium">Codex</div>
                      <div className="text-[10px] text-[var(--text-secondary)]">AI coding agent (MCP)</div>
                    </div>
                  </button>
```

At the top of the file's import block, ensure `Cpu` is added to the `lucide-react` imports. Find the existing `import { ..., Bot, ..., Sparkles, ..., Terminal } from 'lucide-react'` line and append `, Cpu`.

- [ ] **Step 4: Add Codex icon to session-list rows**

In the same file, line 136 reads (roughly):

```tsx
{s.type === 'claude' ? <Bot size={14} /> : s.type === 'kiro' ? <Sparkles size={14} /> : <Terminal size={14} />}
```

Change to:

```tsx
{s.type === 'claude' ? <Bot size={14} /> : s.type === 'kiro' ? <Sparkles size={14} /> : s.type === 'codex' ? <Cpu size={14} /> : <Terminal size={14} />}
```

Apply the same edit to line 236 (the second occurrence with `size={13}`).

- [ ] **Step 5: Pass `agentType="codex"` from App.tsx (or wherever AcpChatView is instantiated)**

Search `grep -n "AcpChatView" frontend/src/App.tsx` to find the call site. The existing pattern routes by session type: `agentType={s.type === 'kiro' ? 'kiro' : 'claude'}`. Update to:

```tsx
agentType={s.type === 'kiro' ? 'kiro' : s.type === 'codex' ? 'codex' : 'claude'}
```

- [ ] **Step 6: Build the frontend**

Run: `cd frontend && npm run build`
Expected: clean build, no TS errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/api.ts frontend/src/components/Sidebar.tsx frontend/src/components/AcpChatView.tsx frontend/src/App.tsx
git commit -m "feat(frontend): add Codex session type button + chat label"
```

---

## Task 6: Implement real `CodexProcess::spawn` (handshake only, no prompts yet)

**Files:**
- Modify: `src/acp/codex_process.rs`

- [ ] **Step 1: Replace the file with the handshake implementation**

Open `src/acp/codex_process.rs` and replace the entire content with:

```rust
use crate::acp::process::AcpEvent;
use rmcp::{ClientHandler, ServiceExt};
use rmcp::service::RunningService;
use rmcp::transport::child_process::TokioChildProcess;
use rmcp::model::{
    CreateElicitationRequestParams, CreateElicitationResult, ElicitationAction,
    ProgressNotificationParam,
};
use rmcp::handler::client::{NotificationContext, RequestContext};
use rmcp::RoleClient;
use rmcp::error::McpError;
use std::sync::Arc;
use tokio::process::Command;
use tokio::sync::mpsc;

/// Channel command from the outer fan-out loop into the rmcp event loop.
enum Cmd {
    Prompt(String),
    Cancel,
    Stop,
}

/// Internal notification carrier from `ClientHandler` callbacks
/// into the event loop.
#[derive(Debug)]
enum Notify {
    ProgressText(String),
}

#[derive(Clone)]
struct Handler {
    notify_tx: mpsc::Sender<Notify>,
}

impl ClientHandler for Handler {
    fn on_progress(
        &self,
        params: ProgressNotificationParam,
        _context: NotificationContext<RoleClient>,
    ) -> impl std::future::Future<Output = ()> + Send + '_ {
        let tx = self.notify_tx.clone();
        async move {
            // Codex emits progress payloads as a JSON object; we look for a `text`
            // field anywhere reasonable. If structure changes, fall through silently
            // — the final tool response still carries the full content.
            if let Some(text) = extract_progress_text(&params) {
                let _ = tx.send(Notify::ProgressText(text)).await;
            } else {
                tracing::debug!("codex: progress without text: {:?}", params);
            }
        }
    }

    fn create_elicitation(
        &self,
        request: CreateElicitationRequestParams,
        _context: RequestContext<RoleClient>,
    ) -> impl std::future::Future<Output = Result<CreateElicitationResult, McpError>> + Send + '_ {
        async move {
            // Defensive: with `approval-policy: "never"` set on tools/call,
            // elicitation should not fire. If it does, auto-accept once with
            // a warning trace so the agent doesn't deadlock.
            tracing::warn!(
                "codex: unexpected elicitation/create (auto-accepting): {:?}",
                request.message
            );
            Ok(CreateElicitationResult {
                action: ElicitationAction::Accept,
                content: None,
                meta: Default::default(),
            })
        }
    }
}

/// Extract a text chunk from a progress notification's `progress` object.
/// Codex's exact shape may vary across versions; try a couple known field names.
fn extract_progress_text(params: &ProgressNotificationParam) -> Option<String> {
    // Try the structured `message` field first (MCP-standard), then any nested
    // `progress.text` JSON value.
    if let Some(msg) = &params.message {
        if !msg.is_empty() {
            return Some(msg.clone());
        }
    }
    None
}

pub struct CodexProcess {
    cmd_tx: mpsc::Sender<Cmd>,
    pub event_rx: mpsc::Receiver<AcpEvent>,
    _service_drop_guard: Arc<()>,
}

impl CodexProcess {
    pub async fn spawn(
        codex_path: &str,
        work_dir: &str,
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        // Build the child process command. Env (CODEX_API_KEY) is passed
        // through automatically since we don't `.env_clear()` the Command.
        let mut cmd = Command::new(codex_path);
        cmd.arg("mcp-server");
        cmd.current_dir(work_dir);

        let transport = TokioChildProcess::new(cmd)
            .map_err(|e| format!("spawn codex: {e}"))?;

        let (notify_tx, notify_rx) = mpsc::channel::<Notify>(64);
        let handler = Handler { notify_tx };

        // serve() runs the MCP `initialize` handshake and returns a RunningService.
        let service: RunningService<RoleClient, Handler> = handler
            .serve(transport)
            .await
            .map_err(|e| format!("rmcp serve: {e}"))?;

        let (event_tx, event_rx) = mpsc::channel::<AcpEvent>(256);
        let (cmd_tx, cmd_rx) = mpsc::channel::<Cmd>(16);

        // Emit init event so the UI can show "session ready"
        let _ = event_tx
            .send(AcpEvent::System {
                subtype: "init".to_string(),
                session_id: None, // threadId not yet known
            })
            .await;

        let work_dir_owned = work_dir.to_string();
        let drop_guard = Arc::new(());
        tokio::spawn(run_event_loop(
            service,
            cmd_rx,
            notify_rx,
            event_tx,
            work_dir_owned,
            drop_guard.clone(),
        ));

        Ok(Self {
            cmd_tx,
            event_rx,
            _service_drop_guard: drop_guard,
        })
    }

    pub async fn send_prompt(&mut self, text: &str) -> Result<(), std::io::Error> {
        self.cmd_tx
            .send(Cmd::Prompt(text.to_string()))
            .await
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::BrokenPipe, "codex event loop exited"))
    }

    pub async fn kill(&mut self) {
        let _ = self.cmd_tx.send(Cmd::Cancel).await;
    }
}

impl Drop for CodexProcess {
    fn drop(&mut self) {
        // best-effort: tell event loop to stop
        let tx = self.cmd_tx.clone();
        tokio::spawn(async move {
            let _ = tx.send(Cmd::Stop).await;
        });
    }
}

/// The event loop drives the rmcp service: it serializes prompts into
/// `tools/call` invocations, ferries progress notifications back as
/// AcpEvent::ContentBlock, and emits AcpEvent::Result on tool completion.
///
/// This task is wrapped in catch_unwind by the caller-facing wrapper to
/// guarantee an Exit event reaches the broadcast even on panic.
async fn run_event_loop(
    service: RunningService<RoleClient, Handler>,
    mut _cmd_rx: mpsc::Receiver<Cmd>,
    mut _notify_rx: mpsc::Receiver<Notify>,
    event_tx: mpsc::Sender<AcpEvent>,
    _work_dir: String,
    _drop_guard: Arc<()>,
) {
    // PLACEHOLDER: handshake-only behaviour. Holding `service` keeps the child
    // process alive; when this task exits the service is dropped → child stdin
    // EOF → codex mcp-server self-exits.
    //
    // Task 7 replaces this with the real prompt/response loop.
    let _ = service.waiting().await;
    let _ = event_tx.send(AcpEvent::Exit { code: 0 }).await;
}
```

- [ ] **Step 2: Build**

Run: `cargo build`
Expected: clean build. If `rmcp` API names differ from those imported above (e.g. `ProgressNotificationParam` is named `ProgressNotification` in the version you got), fix the imports by checking `cargo doc --open -p rmcp` or grepping `~/.cargo/registry/src/.../rmcp-1.7*/src/`.

If the `extract_progress_text` field access doesn't compile, comment its body to `None` for now — Task 8 revisits it.

- [ ] **Step 3: Smoke A — verify a Codex session can be created end-to-end**

Run the binary: `cargo run --release -- --port 8080 --password test`

In a browser (or a second terminal with `curl`):

1. Authenticate (legacy login `test` password).
2. Click "New Session" → "Codex".
3. Verify the session appears in the sidebar with the Cpu icon.
4. Open the chat view. Verify a "connected" + replay events arrive (init event in scrollback).
5. `ps aux | grep "codex mcp-server"` should show one running child.
6. Delete the session. The child process should disappear.

If spawn fails with `codex: not found`, ensure `codex` is on PATH or pass `--codex-path /full/path/to/codex`.

If spawn fails with auth error: this is normal until prompts are sent. Init event should still appear.

- [ ] **Step 4: Commit**

```bash
git add src/acp/codex_process.rs
git commit -m "feat: CodexProcess spawn + rmcp handshake (no prompts yet)"
```

---

## Task 7: Implement `Cmd::Prompt` → `tools/call("codex")` (single-turn, no streaming)

**Files:**
- Modify: `src/acp/codex_process.rs`

- [ ] **Step 1: Replace `run_event_loop` with real prompt handling**

In `src/acp/codex_process.rs`, replace the body of `run_event_loop` with:

```rust
async fn run_event_loop(
    service: RunningService<RoleClient, Handler>,
    mut cmd_rx: mpsc::Receiver<Cmd>,
    mut notify_rx: mpsc::Receiver<Notify>,
    event_tx: mpsc::Sender<AcpEvent>,
    work_dir: String,
    _drop_guard: Arc<()>,
) {
    use rmcp::model::CallToolRequestParam;
    use serde_json::json;

    let mut thread_id: Option<String> = None;

    loop {
        tokio::select! {
            cmd = cmd_rx.recv() => {
                match cmd {
                    Some(Cmd::Prompt(text)) => {
                        // Drain any stale progress chunks left from a previous turn.
                        while notify_rx.try_recv().is_ok() {}

                        let (tool_name, args) = match &thread_id {
                            None => (
                                "codex",
                                json!({
                                    "prompt": text,
                                    "cwd": work_dir,
                                    "sandbox": "danger-full-access",
                                    "approval-policy": "never",
                                }),
                            ),
                            Some(tid) => (
                                "codex-reply",
                                json!({
                                    "prompt": text,
                                    "threadId": tid,
                                }),
                            ),
                        };

                        let arguments = args.as_object().cloned();

                        let result = service
                            .peer()
                            .call_tool(CallToolRequestParam {
                                name: tool_name.into(),
                                arguments,
                            })
                            .await;

                        match result {
                            Ok(resp) => {
                                // Codex returns { threadId, content } in the result.
                                // The exact shape lives under `resp.content[0].text` (CallToolResult)
                                // OR in `resp.structured_content` if rmcp surfaces it.
                                let (tid, content) = parse_codex_tool_result(&resp);
                                if let Some(t) = tid.clone() {
                                    thread_id = Some(t);
                                }
                                let _ = event_tx
                                    .send(AcpEvent::Result {
                                        text: content.unwrap_or_default(),
                                        session_id: tid.unwrap_or_default(),
                                        cost_usd: None,
                                    })
                                    .await;
                            }
                            Err(e) => {
                                // If thread_id was set and the error indicates the thread
                                // is gone, clear thread_id so the next prompt opens a new
                                // session.
                                let msg = format!("{e}");
                                if msg.contains("thread") && msg.contains("not found") {
                                    thread_id = None;
                                }
                                let _ = event_tx
                                    .send(AcpEvent::Error {
                                        message: format!("Codex error: {msg}"),
                                    })
                                    .await;
                            }
                        }
                    }
                    Some(Cmd::Cancel) | Some(Cmd::Stop) | None => {
                        break;
                    }
                }
            }

            // Drain progress notifications even when no Cmd is pending so the
            // channel doesn't fill up. Task 8 hooks them into AcpEvent.
            Some(_n) = notify_rx.recv() => {
                // intentionally dropped in Task 7; Task 8 wires this up
            }
        }
    }

    let _ = event_tx.send(AcpEvent::Exit { code: 0 }).await;
}

/// Parse a CallToolResult from `tools/call("codex" | "codex-reply")` into
/// `(threadId, content)`. Returns (None, None) on unexpected shape.
fn parse_codex_tool_result(result: &rmcp::model::CallToolResult) -> (Option<String>, Option<String>) {
    // Strategy 1: structured_content (preferred when present)
    if let Some(structured) = &result.structured_content {
        let tid = structured
            .get("threadId")
            .and_then(|v| v.as_str())
            .map(String::from);
        let content = structured
            .get("content")
            .and_then(|v| v.as_str())
            .map(String::from);
        if tid.is_some() || content.is_some() {
            return (tid, content);
        }
    }
    // Strategy 2: first text content block contains a JSON-encoded {threadId, content}
    for block in &result.content {
        if let Some(text) = block.as_text() {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text.text) {
                let tid = v.get("threadId").and_then(|x| x.as_str()).map(String::from);
                let content = v.get("content").and_then(|x| x.as_str()).map(String::from);
                if tid.is_some() || content.is_some() {
                    return (tid, content);
                }
            }
        }
    }
    (None, None)
}
```

Note: if `CallToolResult` field names in rmcp 1.7 differ (e.g. `structured_content` vs `structuredContent`), adjust to whatever rmcp exports. The struct name is stable but field naming can be camelCase via serde rename.

- [ ] **Step 2: Build**

Run: `cargo build`
Expected: clean build.

- [ ] **Step 3: Smoke B — single-turn prompt round-trip**

Run: `cargo run --release -- --port 8080 --password test` (ensure CODEX_API_KEY env or `~/.codex` auth is in place).

In the browser:
1. Create a Codex session in `/tmp/codex-smoke/` (any empty dir).
2. Send prompt: `list files in current directory`.
3. Verify a single non-streaming reply appears (full text in one chunk).
4. Confirm the message is rendered as a normal final message, not as streaming.

If you see an auth error in the chat bubble, check `echo $CODEX_API_KEY` or run `codex login` on the host.

- [ ] **Step 4: Commit**

```bash
git add src/acp/codex_process.rs
git commit -m "feat: send_prompt → tools/call('codex') single-turn round-trip"
```

---

## Task 8: Hook progress notifications into `AcpEvent::ContentBlock` streaming

**Files:**
- Modify: `src/acp/codex_process.rs`

- [ ] **Step 1: Wire `notify_rx` into AcpEvent emission**

In the `run_event_loop` function, replace the `Some(_n) = notify_rx.recv() => {}` arm with:

```rust
            Some(notify) = notify_rx.recv() => {
                match notify {
                    Notify::ProgressText(text) => {
                        let _ = event_tx
                            .send(AcpEvent::ContentBlock {
                                block_type: "text".to_string(),
                                text: Some(text),
                                name: None,
                                input: None,
                                streaming: Some(true),
                            })
                            .await;
                    }
                }
            }
```

- [ ] **Step 2: Verify the `extract_progress_text` field access**

Run: `cargo build`

If `extract_progress_text` (defined in Task 6) returns `None` for everything, dump the raw progress payload to debug-log first to discover the actual field name. Add temporarily inside `Handler::on_progress`:

```rust
tracing::info!("codex progress raw: {}", serde_json::to_string(&params).unwrap_or_default());
```

Run a smoke test, watch the log, then update `extract_progress_text` to read whichever JSON path Codex actually uses (likely `params.message`, `params.progress.text`, or a custom `_meta` field). Remove the temporary log line afterwards.

- [ ] **Step 3: Smoke C — verify streaming**

Run: `cargo run --release -- --port 8080 --password test`

In the browser:
1. Open a Codex session.
2. Send: `please write a 5-paragraph essay about Rust`.
3. Confirm chunks appear progressively in the chat bubble (streaming) rather than all at once at the end.
4. Confirm the final message is identical to the concatenated chunks (the tool result fires on completion).

If chunks are missing, the progress payload shape is different from what `extract_progress_text` expects — re-do Step 2 of this task with the live trace.

- [ ] **Step 4: Commit**

```bash
git add src/acp/codex_process.rs
git commit -m "feat: stream progress notifications as AcpEvent::ContentBlock"
```

---

## Task 9: Verify multi-turn (codex-reply) preserves context

**Files:**
- (No code changes; thread_id state machine was already implemented in Task 7.)

- [ ] **Step 1: Smoke D — multi-turn**

Run: `cargo run --release -- --port 8080 --password test`

In the browser:
1. Open a Codex session in `/tmp/codex-multi-turn/`.
2. Send: `My name is Keith. Remember that.`
3. Wait for completion. Note the thread setup is invisible (threadId stored in memory).
4. Send: `What is my name?`
5. Verify Codex replies with "Keith" or similar acknowledging memory of turn 1.

If turn 2 acts like a fresh conversation (no memory), the threadId state machine is broken — verify `parse_codex_tool_result` is actually returning a non-None threadId, by adding a `tracing::info!("codex threadId: {:?}", thread_id)` after the assignment and re-smoking.

- [ ] **Step 2: Commit (if any debug additions to clean up)**

```bash
# Remove any temporary trace lines added during debugging.
git diff
git add src/acp/codex_process.rs
git commit -m "test: verify multi-turn threadId routing"
```

(If no changes were made, skip this step.)

---

## Task 10: Implement Cancel via dropping the in-flight `call_tool` future

**Files:**
- Modify: `src/acp/codex_process.rs`

- [ ] **Step 1: Wrap `call_tool` in a `tokio::select!` that races against a cancel signal**

In `run_event_loop`, replace the body of the `Some(Cmd::Prompt(text)) => { ... }` arm with a structure that allows interleaved Cancel handling. Replace:

```rust
                let result = service
                    .peer()
                    .call_tool(CallToolRequestParam { ... })
                    .await;
```

With:

```rust
                // Race the call_tool future against an interleaved Cmd::Cancel.
                // Dropping the future causes rmcp to send notifications/cancelled.
                let call_fut = service.peer().call_tool(CallToolRequestParam {
                    name: tool_name.into(),
                    arguments,
                });
                tokio::pin!(call_fut);

                let result = loop {
                    tokio::select! {
                        biased;
                        cmd = cmd_rx.recv() => {
                            match cmd {
                                Some(Cmd::Cancel) => {
                                    tracing::info!("codex: cancelling in-flight call_tool");
                                    drop(call_fut);
                                    let _ = event_tx
                                        .send(AcpEvent::Error {
                                            message: "已取消".to_string(),
                                        })
                                        .await;
                                    break Err("cancelled by user".to_string().into());
                                }
                                Some(Cmd::Stop) | None => {
                                    drop(call_fut);
                                    return; // exit run_event_loop
                                }
                                Some(Cmd::Prompt(_)) => {
                                    // Ignore concurrent prompts; mpsc is FIFO so the
                                    // next iteration of the outer loop will pick this up.
                                    // For simplicity we just drop it here.
                                    tracing::warn!("codex: prompt received during in-flight turn; dropping");
                                }
                            }
                        }
                        Some(notify) = notify_rx.recv() => {
                            match notify {
                                Notify::ProgressText(text) => {
                                    let _ = event_tx
                                        .send(AcpEvent::ContentBlock {
                                            block_type: "text".to_string(),
                                            text: Some(text),
                                            name: None,
                                            input: None,
                                            streaming: Some(true),
                                        })
                                        .await;
                                }
                            }
                        }
                        r = &mut call_fut => break Ok::<_, Box<dyn std::error::Error + Send + Sync>>(r),
                    }
                };

                let result: Result<rmcp::model::CallToolResult, _> = match result {
                    Ok(Ok(resp)) => Ok(resp),
                    Ok(Err(e)) => Err(e.into()),
                    Err(e) => Err(e),
                };
```

Note: if `service.peer().call_tool()` returns a non-`Send` future on your rmcp version, the `tokio::pin!` may complain. In that case wrap as `Box::pin(...)`.

- [ ] **Step 2: Remove the now-redundant outer `notify_rx` arm**

The outer `Some(notify) = notify_rx.recv() => { ... }` arm in the top-level `tokio::select!` should still exist — keep it for the idle window between turns.

- [ ] **Step 3: Build**

Run: `cargo build`
Expected: clean build. If `tokio::pin!` errors with `not Send`, change to `let mut call_fut = Box::pin(service.peer().call_tool(...));` and use `&mut call_fut` in the select.

- [ ] **Step 4: Smoke E — cancel preserves thread**

Run: `cargo run --release -- --port 8080 --password test`

In the browser:
1. Open a Codex session.
2. Send: `Please write a 50-page novel about Rust borrow checker`.
3. While streaming, click the Cancel button in the chat view.
4. Verify the streaming stops and a "已取消" red error message appears.
5. Confirm the session is **not** marked Done.
6. Send a follow-up: `Just tell me one fun fact about Rust instead.`
7. Verify Codex replies coherently in the same thread (e.g. it does not start with "Hi! I'm a coding assistant...").

If after cancel the next prompt opens a fresh thread (loses context), the thread_id was incorrectly cleared on cancel — review the `Cmd::Cancel` arm logic.

- [ ] **Step 5: Commit**

```bash
git add src/acp/codex_process.rs
git commit -m "feat: cancel via drop in-flight tool call (preserves thread_id)"
```

---

## Task 11: Add panic guard around `run_event_loop`

**Files:**
- Modify: `src/acp/codex_process.rs`

- [ ] **Step 1: Wrap the spawn call**

In `CodexProcess::spawn`, change:

```rust
        tokio::spawn(run_event_loop(
            service,
            cmd_rx,
            notify_rx,
            event_tx,
            work_dir_owned,
            drop_guard.clone(),
        ));
```

to:

```rust
        let event_tx_for_panic = event_tx.clone();
        tokio::spawn(async move {
            let result = futures::FutureExt::catch_unwind(
                std::panic::AssertUnwindSafe(run_event_loop(
                    service,
                    cmd_rx,
                    notify_rx,
                    event_tx,
                    work_dir_owned,
                    drop_guard.clone(),
                )),
            )
            .await;
            if result.is_err() {
                let _ = event_tx_for_panic
                    .send(AcpEvent::Error {
                        message: "Codex event loop panicked".to_string(),
                    })
                    .await;
                let _ = event_tx_for_panic
                    .send(AcpEvent::Exit { code: -1 })
                    .await;
            }
        });
```

- [ ] **Step 2: Build**

Run: `cargo build`
Expected: clean build.

- [ ] **Step 3: Sanity smoke**

Re-run Smoke E (Task 10) to confirm cancel still works after the wrapper.

- [ ] **Step 4: Commit**

```bash
git add src/acp/codex_process.rs
git commit -m "fix: catch_unwind around Codex event loop to surface panics"
```

---

## Task 12: Inline unit tests for pure helpers

**Files:**
- Modify: `src/acp/codex_process.rs`

- [ ] **Step 1: Add `#[cfg(test)]` block at end of file**

Append to `src/acp/codex_process.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use rmcp::model::{CallToolResult, RawContent, RawTextContent, Annotated};

    fn text_content(s: &str) -> Annotated<RawContent> {
        Annotated::new(
            RawContent::Text(RawTextContent { text: s.to_string(), meta: Default::default() }),
            Default::default(),
        )
    }

    #[test]
    fn parses_structured_content() {
        let mut result = CallToolResult::default();
        result.structured_content = Some(serde_json::json!({
            "threadId": "t-abc",
            "content": "Hello world"
        }));
        let (tid, content) = parse_codex_tool_result(&result);
        assert_eq!(tid.as_deref(), Some("t-abc"));
        assert_eq!(content.as_deref(), Some("Hello world"));
    }

    #[test]
    fn parses_text_block_json_fallback() {
        let mut result = CallToolResult::default();
        result.content = vec![text_content(r#"{"threadId":"t-xyz","content":"reply text"}"#)];
        let (tid, content) = parse_codex_tool_result(&result);
        assert_eq!(tid.as_deref(), Some("t-xyz"));
        assert_eq!(content.as_deref(), Some("reply text"));
    }

    #[test]
    fn returns_none_for_unparseable_text() {
        let mut result = CallToolResult::default();
        result.content = vec![text_content("plain text not json")];
        let (tid, content) = parse_codex_tool_result(&result);
        assert!(tid.is_none());
        assert!(content.is_none());
    }

    #[test]
    fn returns_none_for_empty_result() {
        let result = CallToolResult::default();
        let (tid, content) = parse_codex_tool_result(&result);
        assert!(tid.is_none());
        assert!(content.is_none());
    }
}
```

If rmcp's actual struct names differ (e.g. `RawTextContent` may be `TextContent` in your version), adjust to whatever rustc reports as missing. The test intent is structural: feed structured + text-block + empty cases through `parse_codex_tool_result` and assert the right (Option, Option) tuple comes out.

- [ ] **Step 2: Run the tests**

Run: `cargo test --lib codex_process`
Expected: 4 passing tests.

- [ ] **Step 3: Commit**

```bash
git add src/acp/codex_process.rs
git commit -m "test: inline unit tests for parse_codex_tool_result"
```

---

## Task 13: Final smoke checklist (end-to-end manual verification)

**Files:** none

This task runs the full smoke checklist from `docs/specs/2026-05-19-codex-mcp-integration-design.md` §7.2 to confirm nothing regressed.

- [ ] **Step 1: Build everything fresh**

Run:

```bash
cd frontend && npm run build && cd ..
cargo build --release
```

Both must complete clean.

- [ ] **Step 2: Run with Codex auth available**

```bash
CODEX_API_KEY="<valid-key>" ./target/release/zeromux --port 8080 --password test
```

(or omit env if `codex login` was already run on the host)

- [ ] **Step 3: Walk the checklist**

Open the browser and verify each item:

- [ ] Sidebar new-session shows four buttons: Terminal / Claude / Kiro / **Codex**
- [ ] Click Codex; session is created; Sidebar row shows the Cpu icon
- [ ] Open chat; init event renders; "Send a message to Codex..." placeholder appears
- [ ] Send `ls`; streaming chunks appear; final response renders
- [ ] Send a follow-up that depends on turn 1; verify thread context preserved
- [ ] Send a long prompt; click Cancel; verify "已取消" appears; session not marked Done
- [ ] After cancel, send a short prompt; verify it goes to the SAME thread (no fresh context)
- [ ] Close the browser tab; reopen the same session; full scrollback replays
- [ ] Open the same session in a second browser tab; both update in sync as new prompts go through
- [ ] Delete the Codex session; `ps aux | grep "codex mcp-server"` shows no leftover child
- [ ] Restart zeromux with `--codex-path /no/such/bin`; new Codex session creation should fail with toast `Failed to spawn Codex: ...`
- [ ] Restart zeromux with empty `CODEX_API_KEY` and no `~/.codex` token; create Codex session; first prompt should produce a red auth-error bubble; session remains in list, can be deleted

- [ ] **Step 4: Run claude/kiro regression check**

To confirm we didn't break the other agent paths:

- [ ] Create a Claude session; send any prompt; verify it streams and completes
- [ ] Create a Kiro session; send any prompt; verify it streams and completes
- [ ] Create a Tmux session; type a shell command; verify echo

- [ ] **Step 5: Commit any final cleanup (if needed)**

If during the checklist you found issues that needed fixes, commit them as separate atomic commits with descriptive messages. The final state of the branch should be all-green smoke + clean `cargo build --release` + clean `npm run build`.

```bash
git log --oneline | head -15
```

Confirm the commit log reads as a coherent feature delivery (one commit per task ideally).

---

## Final Verification

After Task 13, the deliverables are:

- ✅ Codex sessions creatable from the UI alongside Claude / Kiro / Tmux
- ✅ Multi-turn conversations preserve threadId
- ✅ Streaming progress visible in real time
- ✅ Cancel preserves thread for follow-up
- ✅ Auto-elicitation guard against unexpected reverse requests
- ✅ Panic guard prevents silent event-loop death
- ✅ Smoke checklist passes end to end
- ✅ Existing Claude/Kiro/Tmux paths regressed-tested

Spec coverage cross-check:

| Spec section | Implemented in |
|---|---|
| §1 目标 1 (third agent type) | Tasks 3, 5 |
| §1 目标 2 (mcp-server, no exec/app-server) | Tasks 6, 7 |
| §1 目标 3 (rmcp official SDK) | Task 1, 6 |
| §1 目标 4 (reuse AcpEvent / WS / Sidebar) | Tasks 3, 5 |
| §1 目标 5 (multi-turn via threadId) | Task 7, 9 |
| §1 目标 6 (cancel preserves thread) | Task 10 |
| §1 目标 7 (default sandbox/approval) | Task 7 |
| §4.4 thread_id state machine | Task 7 |
| §4.5 thread recovery on `not found` | Task 7 (within prompt error path) |
| §6.1 startup errors | Tasks 6 (spawn error path), 13 (smoke E1/E2) |
| §6.2 runtime errors | Tasks 7 (R1, R2), 8 (R3) |
| §6.3 cancel errors | Task 10 |
| §6.4 panic guard | Task 11 |
| §7.1 inline tests | Task 12 |
| §7.2 manual checklist | Task 13 |
