# ZeroMux

A single-binary, web-based terminal multiplexer and AI agent orchestration platform built with Rust.

ZeroMux lets you manage multiple terminal sessions, Claude Code agents, and Kiro CLI agents from a browser — with built-in file browsing, git visualization, session notes, and multi-client support.

## Features

- **Web Terminal** — Full xterm.js terminal with PTY backend, WebGL rendering, 2MB scrollback persistence across reconnects
- **AI Agent Sessions** — Run Claude Code (stream-json ACP) and Kiro CLI (JSON-RPC 2.0) side by side
- **Voice Input** — Push-to-talk microphone next to the chat input streams audio to AWS Transcribe Streaming for real-time Chinese transcription; results populate the textarea, never auto-send
- **Multi-Client WebSocket** — Broadcast architecture allows multiple browser tabs/devices to view the same session simultaneously
- **Session Notes** — Per-working-directory note timeline with markdown files as source of truth and SQLite index, stored centrally in `~/.zeromux/notes/`
- **Git Viewer** — Branch/merge graph visualization with commit diffs, file stats, and ref badges (HEAD, branches, tags)
- **File Browser** — Browse, edit, create, rename, upload, and delete files in session working directories
- **Session Metadata** — Description, status (Running/Done/Blocked/Idle) per session with color-coded indicators
- **Git Worktrees** — Auto-creates isolated git worktrees for each AI agent session
- **Mobile Responsive** — Collapsible overlay sidebar, auto-close on selection, hamburger menu for small screens
- **Authentication** — GitHub OAuth with admin approval flow, or simple password mode
- **Single Binary** — Frontend embedded via `rust-embed`, no external file dependencies
- **Docker Ready** — Multi-stage Dockerfile included

## Quick Start

### Prerequisites

- Rust 1.70+
- Node.js 20+
- git, tmux (for terminal sessions)

### Build & Run

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

Or use the helper script:

```bash
./start.sh --port 8080 --password "my-secret"
```

### Docker

```bash
docker build -t zeromux .
docker run -p 8080:8080 zeromux --password "my-secret"
```

Mount a volume for persistent notes storage:

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
| `--work-dir` | — | `.` | Default working directory |
| `--cols` | — | `120` | Default terminal columns |
| `--rows` | — | `36` | Default terminal rows |
| `--log-dir` | — | — | Enable session I/O logging |
| `--data-dir` | — | `~/.zeromux` | Database and notes directory |

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

The first user to log in is automatically promoted to admin.

### AWS Credentials (optional, required for voice input)

The voice input feature calls AWS Transcribe Streaming using the default AWS credential chain:

1. Env vars: `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` / `AWS_REGION`
2. Shared config: `~/.aws/credentials [default]` + `~/.aws/config [default]`
3. EC2 IAM instance role (recommended deployment)

Required IAM permission: `transcribe:StartStreamTranscription`.

Voice input is the only feature that uses AWS — without credentials, the rest of ZeroMux works normally; pressing the mic button surfaces an "AWS credentials not configured" error.

## Architecture

```
┌──────────────────────────────────────────────────┐
│                    Browser                        │
│  ┌──────────┐ ┌──────────┐ ┌───────────────────┐ │
│  │ Terminal  │ │  Claude   │ │ Git / Files /     │ │
│  │ (xterm)  │ │  Chat     │ │ Notes Viewer      │ │
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
│  │          │  │                │  │  OAuth)   │  │
│  └────┬─────┘  └───────┬────────┘  └───────────┘  │
│       │                │                           │
│  ┌────┴─────┐  ┌───────┴────────┐  ┌───────────┐  │
│  │ Fan-out  │  │  broadcast::   │  │  SQLite   │  │
│  │ Tasks    │  │  Sender<T>     │  │ + Notes   │  │
│  │ (PTY/    │  │  (per session) │  │  Store    │  │
│  │  ACP)    │  │                │  │           │  │
│  └──────────┘  └────────────────┘  └───────────┘  │
└────────────────────────────────────────────────────┘
```

**Key design decisions:**

- **Broadcast fan-out** — Each session spawns a dedicated fan-out task that owns the PTY/ACP process and broadcasts events via `tokio::sync::broadcast`. Multiple WebSocket clients subscribe independently — no exclusive ownership, no session hanging on disconnect.
- **Server-side scrollback** (2MB per session) replayed on reconnect — survives browser refresh and device switching
- **Unified input channel** — All WebSocket clients send input through a shared `mpsc` channel (`SessionInput` enum: `PtyData`, `PtyResize`, `Prompt`, `Cancel`)
- **CSS visibility toggle** for view switching — terminal state preserved when switching to file/git views
- **Git worktree isolation** — each AI agent session gets its own worktree, preventing conflicts
- **Notes as files** — Notes stored as markdown files with YAML frontmatter in `~/.zeromux/notes/{dir_hash}/`, with SQLite as a query index

## Session Types

| Type | Backend | Protocol | Use Case |
|------|---------|----------|----------|
| `tmux` | portable-pty | Raw PTY over WebSocket | Shell, tmux, vim, etc. |
| `claude` | Claude CLI | Stream-JSON ACP | Claude Code agent |
| `kiro` | Kiro CLI | JSON-RPC 2.0 | Kiro AI agent |

## API

### Sessions

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/sessions` | List sessions |
| POST | `/api/sessions` | Create session |
| PATCH | `/api/sessions/{id}` | Update description / status |
| DELETE | `/api/sessions/{id}` | Delete session |
| GET | `/api/sessions/{id}/status` | Git branch, dirty count |

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
| `/ws/acp/{id}` | JSON | ACP agent stream (multi-client) |

Multiple clients can connect to the same session WebSocket simultaneously. Each receives the full broadcast stream independently.

## Tech Stack

**Backend:** Rust, Axum 0.8, Tokio, portable-pty, rusqlite, jsonwebtoken, rust-embed

**Frontend:** React 19, TypeScript, Tailwind CSS 4, xterm.js 6, react-markdown, Vite 8, lucide-react

## License

MIT
