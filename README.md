# ZeroMux

A single-binary, web-based terminal multiplexer and AI agent orchestration platform built with Rust.

ZeroMux lets you manage multiple terminal sessions and **three AI coding agents — Claude Code, Kiro CLI, and OpenAI Codex** — from a browser, with built-in file browsing, git visualization, session notes, an activity dashboard, and multi-client support. Sessions survive server restarts and reconnect automatically.

> 中文文档见 [README_ZH.md](README_ZH.md)。

## Features

- **Web Terminal** — Full xterm.js terminal with PTY backend, WebGL rendering, 2MB scrollback persistence across reconnects
- **Three AI Agent Backends** — Run **Claude Code** (stream-json ACP), **Kiro CLI** (JSON-RPC 2.0), and **OpenAI Codex** (`codex mcp-server` via the MCP/rmcp client) side by side, each normalized to a common event stream
- **Agent Tool Visibility** — Streaming text, reasoning/thinking blocks, and tool calls (shell commands, file edits) render inline in the chat — you see what the agent actually did, not just its prose
- **Session Persistence & Recovery** — Session metadata is persisted to SQLite; after a server restart (or an idle hibernation) sessions are lazily respawned on reconnect, resuming agent context where the backend supports it (Claude `--resume`, Kiro `session/load`, Codex `codex-reply`, tmux re-attach)
- **Active Session Management** — Per-session turn state (Idle/Running) with live status dots, a completion red-dot for finished turns in background sessions, an **Interrupt** button to cancel an in-flight turn, send-while-busy (auto-interrupt + resend), a stuck-turn timer, and inline session rename
- **Activity Dashboard** — A cross-session feed of agent `task_done` events (per-user scoped) with summaries, working directory, and cost
- **Resilient WebSockets** — Server-side keepalive ping + frontend auto-reconnect with backoff, so idle-timeout proxies (nginx, Cloudflare) can't silently freeze a session
- **Multi-Client WebSocket** — Broadcast architecture allows multiple browser tabs/devices to view and drive the same session simultaneously
- **Session Notes** — Per-working-directory note timeline with markdown files as source of truth and SQLite index, stored centrally in `~/.zeromux/notes/`
- **Git Viewer** — Branch/merge graph visualization with commit diffs, file stats, and ref badges (HEAD, branches, tags)
- **Working-Tree Diff Review** — Inspect an agent's uncommitted changes (`git status` + `git diff HEAD`) in a "worktree changes" tab, then forward a commit/discard instruction back to the agent. Read-only on git; never writes directly. Sensitive dirs are refused and filtered out of the diff
- **Stuck-Turn Surfacing** — A running turn silent past a threshold shows an amber dot in the session list (180s) and, when you're away (10min), a push notification
- **Obsidian Vault Reader** — Admin-only, read-only browser for an Obsidian vault (`--vault-dir`): directory tree, filename search, wikilink (`[[...]]`) navigation, image rendering, two-pane mobile reading layout. Never writes.
- **File Browser** — Browse, edit, create, rename, upload, and delete files in session working directories
- **Markdown Rendering** — KaTeX math, mermaid diagrams, syntax highlighting, and pipe tables in agent output, with content-hash caching to avoid re-render churn
- **Git Worktrees** — Auto-creates isolated git worktrees for each AI agent session
- **Mobile Responsive** — Collapsible overlay sidebar, auto-close on selection, hamburger menu for small screens
- **Authentication** — GitHub OAuth with admin approval flow, or simple password mode
- **Per-User Authorization** — Sessions and agent events are owner-scoped; only the owner (or an admin) can attach to, drive, or read a session and its events
- **Single Binary** — Frontend embedded via `rust-embed`, no external file dependencies
- **Docker Ready** — Multi-stage Dockerfile included

## Quick Start

### Prerequisites

- Rust 1.70+
- Node.js 20+
- git, tmux (for terminal sessions)
- Optional, per agent you want to use: `claude`, `kiro-cli`, `codex` on PATH (or pass explicit paths)

### Build & Run

The frontend **must** be built before the Rust binary — `rust-embed` reads `frontend/dist/` at compile time.

```bash
# Build frontend
cd frontend && npm ci && npm run build && cd ..

# Build binary
cargo build --release

# Run (auto-generates password, printed to console)
./target/release/zeromux --port 8080

# Or with a specific password
./target/release/zeromux --port 8080 --password "my-secret"
```

Or use the helper script (rebuilds if the binary is missing, manages a PID file + `zeromux.log`):

```bash
./start.sh --port 8080 --password "my-secret"
```

### Docker

```bash
docker build -t zeromux .
docker run -p 8080:8080 zeromux --password "my-secret"
```

Mount a volume for persistent notes / session / events storage:

```bash
docker run -p 8080:8080 -v zeromux-data:/root/.zeromux zeromux --password "my-secret"
```

## Configuration

All options can be set via CLI flags or environment variables.

| Flag | Env Var | Default | Description |
|------|---------|---------|-------------|
| `--port` | — | `8080` | Listen port |
| `--host` | — | `0.0.0.0` | Listen address |
| `--password` | `ZEROMUX_PASSWORD` | Auto-generated | Legacy auth password |
| `--shell` | — | `bash` | Shell for terminal sessions |
| `--claude-path` | — | `claude` | Path to Claude CLI binary |
| `--kiro-path` | — | `kiro-cli` | Path to Kiro CLI binary |
| `--codex-path` | — | `codex` | Path to Codex CLI binary (run as `codex mcp-server`) |
| `--codex-reasoning` | — | `off` | Codex reasoning effort: `off` \| `low` \| `medium` \| `high` (see note below) |
| `--work-dir` | — | `.` | Default working directory (sessions are restricted to paths under `$HOME`) |
| `--cols` | — | `120` | Default terminal columns |
| `--rows` | — | `36` | Default terminal rows |
| `--log-dir` | — | — | Enable session I/O logging |
| `--data-dir` | — | `~/.zeromux` | Database and notes directory |

> **`--codex-reasoning`** injects `model_reasoning_effort` into each Codex `tools/call`. It only has an effect if the underlying model/provider (e.g. LiteLLM → Bedrock Claude) supports and propagates the `thinking` parameter; otherwise it is a no-op.

### GitHub OAuth

For multi-user setups with GitHub authentication:

| Flag | Env Var | Description |
|------|---------|-------------|
| `--github-client-id` | `GITHUB_CLIENT_ID` | GitHub OAuth App client ID |
| `--github-client-secret` | `GITHUB_CLIENT_SECRET` | GitHub OAuth App client secret |
| `--jwt-secret` | `ZEROMUX_JWT_SECRET` | JWT signing key (auto-generated if omitted) |
| `--allowed-users` | `ZEROMUX_ALLOWED_USERS` | Comma-separated GitHub usernames to auto-approve |
| `--external-url` | `ZEROMUX_EXTERNAL_URL` | Public URL for OAuth callback |

```bash
./target/release/zeromux \
  --github-client-id "your-id" \
  --github-client-secret "your-secret" \
  --external-url "https://zeromux.example.com" \
  --allowed-users "alice,bob"
```

The first user to log in is automatically promoted to admin. In OAuth mode, sessions and events are scoped per user; admins can see all.

## Architecture

```
┌──────────────────────────────────────────────────┐
│                    Browser                        │
│  ┌──────────┐ ┌──────────┐ ┌───────────────────┐ │
│  │ Terminal │ │  Agent   │ │ Git / Files /     │ │
│  │ (xterm)  │ │  Chat    │ │ Notes / Dashboard │ │
│  └────┬─────┘ └────┬─────┘ └──────┬────────────┘ │
│       │WS          │WS            │HTTP           │
└───────┼────────────┼──────────────┼───────────────┘
        │            │              │
┌───────┴────────────┴──────────────┴───────────────┐
│              ZeroMux (single binary)               │
│                                                    │
│  ┌──────────┐  ┌────────────────┐  ┌───────────┐  │
│  │  Axum    │  │  Session       │  │   Auth    │  │
│  │  Router  │  │  Manager       │  │ (JWT/     │  │
│  │          │  │  + Store       │  │  OAuth)   │  │
│  └────┬─────┘  └───────┬────────┘  └───────────┘  │
│       │                │                           │
│  ┌────┴─────┐  ┌───────┴────────┐  ┌───────────┐  │
│  │ Fan-out  │  │  broadcast::   │  │  SQLite   │  │
│  │ Tasks    │  │  Sender<T>     │  │ Sessions/ │  │
│  │ (PTY /   │  │  (per session) │  │ Events /  │  │
│  │  ACP ×3) │  │                │  │ Notes     │  │
│  └──────────┘  └────────────────┘  └───────────┘  │
└────────────────────────────────────────────────────┘
```

**Key design decisions:**

- **Broadcast fan-out** — Each session spawns a dedicated fan-out task that *exclusively owns* the PTY/agent process and broadcasts events via `tokio::sync::broadcast`. Multiple WebSocket clients subscribe independently — no exclusive ownership, no session hanging on disconnect. Cleanup is by `Drop`: removing a session ends its fan-out task, which drops the process.
- **Three agent wire protocols, one event model** — Claude (NDJSON stream-json), Kiro (JSON-RPC 2.0), and Codex (MCP notifications over rmcp) all normalize to a common `AcpEvent` enum the frontend renders.
- **Persistence & lazy respawn** — Session metadata lives in SQLite; on (re)connect a non-running session is respawned concurrency-safely and, where possible, resumed from a stored token.
- **Server-side scrollback** (2MB per session) replayed on reconnect — survives browser refresh and device switching.
- **WebSocket resilience** — periodic server ping + frontend auto-reconnect keep idle sessions alive behind timeout proxies.
- **Unified input channel** — All WebSocket clients send input through a shared `mpsc` channel (`SessionInput` enum: `PtyData`, `PtyResize`, `Prompt`, `Cancel`, `Interrupt`).
- **CSS visibility toggle** for view switching — terminal/chat state preserved when switching to file/git/dashboard views.
- **Git worktree isolation** — each AI agent session gets its own worktree, preventing conflicts.
- **Notes as files** — Notes stored as markdown files with YAML frontmatter in `~/.zeromux/notes/{dir_hash}/`, with SQLite as a query index.

## Session Types

| Type | Backend | Protocol | Use Case |
|------|---------|----------|----------|
| `tmux` | portable-pty | Raw PTY over WebSocket | Shell, tmux, vim, etc. |
| `claude` | Claude CLI | Stream-JSON ACP | Claude Code agent |
| `kiro` | Kiro CLI | JSON-RPC 2.0 | Kiro AI agent |
| `codex` | Codex CLI | MCP (`codex mcp-server` via rmcp) | OpenAI Codex agent |

## API

### Sessions

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/sessions` | List sessions (with turn state + activity) |
| POST | `/api/sessions` | Create session (`work_dir` restricted to `$HOME`) |
| PATCH | `/api/sessions/{id}` | Update name / description / status (owner only) |
| DELETE | `/api/sessions/{id}` | Delete session (owner only) |
| GET | `/api/sessions/{id}/status` | Git branch, dirty count |

### Agent Events (activity dashboard)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/events` | List agent events (own events; admins see all) |
| POST | `/api/events?token=...` | Ingest an event (token auth, for hooks; owner stamped server-side) |
| DELETE | `/api/events/{id}` | Delete an event (own events; admins any) |

### Notes

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/sessions/{id}/notes` | List notes for session's work_dir |
| POST | `/api/sessions/{id}/notes` | Create a note (body: `{"text": "..."}`) |
| DELETE | `/api/sessions/{id}/notes/{note_id}` | Delete a note |

Notes are scoped by working directory — sessions sharing the same work_dir share the same notes.

### Files

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/sessions/{id}/files?pattern=*.md` | List files |
| GET | `/api/sessions/{id}/file?path=...` | Read file (max 1MB) |
| POST | `/api/sessions/{id}/file` | Write file |
| DELETE | `/api/sessions/{id}/file?path=...` | Delete file |
| POST | `/api/sessions/{id}/upload` | Upload file (base64, max 10MB) |

### Git

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/sessions/{id}/git/log?limit=100` | Log with branch graph |
| GET | `/api/sessions/{id}/git/show?commit=...` | Commit diff + file stats |

### WebSocket

| Path | Protocol | Description |
|------|----------|-------------|
| `/ws/term/{id}` | Binary (base64) | Terminal I/O (multi-client) |
| `/ws/acp/{id}` | JSON | Agent stream — Claude/Kiro/Codex (multi-client) |

WebSocket auth is via a `?token=` query param. Only the session owner (or an admin) may attach. ACP client messages: `{"type":"prompt","text":...}`, `{"type":"interrupt"}`, `{"type":"cancel"}`. Multiple clients can connect to the same session simultaneously, each receiving the full broadcast stream.

## Tech Stack

**Backend:** Rust, Axum 0.8, Tokio, portable-pty, rmcp (MCP client), rusqlite, jsonwebtoken, rust-embed

**Frontend:** React 19, TypeScript, Tailwind CSS 4, xterm.js, react-markdown + KaTeX + mermaid, Vite, lucide-react

## License

MIT
