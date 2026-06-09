# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

ZeroMux — a single-binary, web-based terminal multiplexer and AI-agent orchestration platform. A Rust/Axum backend serves a React/Vite frontend (embedded into the binary via `rust-embed`) and brokers WebSocket connections to PTY shells and three AI agent CLIs (Claude Code, Kiro, Codex). READMEs exist in both English (`README.md`) and Chinese (`README_ZH.md`); design docs under `docs/` are largely in Chinese.

## Build & run

The frontend **must** be built before the Rust binary — `rust-embed` reads `frontend/dist/` at compile time, so `cargo build` fails if it is missing.

```bash
# Frontend (run from frontend/)
cd frontend && npm ci && npm run build    # tsc -b && vite build → frontend/dist/
npm run dev                                # Vite dev server (frontend only)
npm run lint                               # eslint
npm test                                   # vitest run (single run)
npm run test:watch                         # vitest watch
npx vitest run src/components/markdown/__tests__/hash.test.ts   # one test file

# Backend (run from repo root)
cargo build --release                      # → target/release/zeromux
cargo test                                 # Rust unit tests (inline #[cfg(test)] modules)

# Run
./target/release/zeromux --port 8080 --password "secret"   # legacy auth, prints auto-gen password if omitted
./start.sh --port 8080 --password "secret"                 # rebuilds if binary missing, manages PID file + zeromux.log
```

Release profile is size-optimized (`opt-level = "z"`, `lto = true`, `strip = true`) — release builds are slow; prefer `cargo build` (debug) and `cargo check` while iterating.

## Deploying to the live server (zeromux.keithyu.cloud)

**Always deploy with `./deploy.sh`. Never hand-run `systemctl stop` + `cp` + `systemctl start` — especially not from a zeromux terminal.**

The live site runs from `/usr/local/bin/zeromux` under systemd unit `zeromux.service` (port 8090). Replacing it requires stopping the service first (the running process holds the binary open, so `cp` over it fails with "Text file busy").

### The cgroup self-kill trap (the real cause of repeated 502s)

The 502s were **not** just "someone forgot to run `start`". There is a deterministic trap: **zeromux spawns its PTY shells as child processes, so every terminal it hosts lives inside the `zeromux.service` cgroup.** The unit's `KillMode=control-group` means `systemctl stop zeromux` kills the **entire cgroup**.

So if you run *any* deploy command (even `./deploy.sh`) **from a zeromux terminal** — which is the only terminal you have on a phone — the deploy process is itself in that cgroup. The instant it reaches `systemctl stop zeromux`, systemd kills the deploy process too, *before* it can `start` again. Service stays down → 502, and an auto-rollback can't save it because the rollback code was killed along with everything else. This is why it recurred every time and looked random.

`./deploy.sh` now **escapes the cgroup automatically**: if it detects it is running inside `zeromux.service`'s cgroup, it re-runs the stop→cp→start→health-check→rollback step as a **transient systemd service** (`systemd-run --wait --pipe`), which PID 1 owns in its own cgroup under `system.slice`. `systemctl stop zeromux` can't reach it, so the swap always completes. (It must be a *service*, not `systemd-run --scope` — a scope stays attached to the launching session's cgroup and dies with it; this was verified empirically.) From SSH / code-server / CI (not in the zeromux cgroup) it swaps directly. Either way the swap is atomic, self-verifying, and auto-rolls-back — it never leaves the service stopped.

```bash
./deploy.sh            # reinstall the already-built target/release/zeromux, restart, verify
./deploy.sh --build    # build frontend + cargo release first, then deploy
```

The `--build` step runs as your normal user *before* the cgroup escape, so `npm`/`cargo` never run as root (no `node_modules`/`target` ownership pollution). Only the root-safe swap is detached.

Recovery if found 502 / `inactive`: if the installed binary is already the intended one, `sudo systemctl start zeromux`; otherwise just run `./deploy.sh`. Do **not** switch the unit to `systemctl restart` (it keeps the OLD binary, since `cp` can't overwrite a running binary). And do **not** hand-run `systemctl stop` from a zeromux terminal — that is the trap above; you'll kill your own shell mid-command.

## Architecture

### Session lifecycle & the broadcast fan-out model (core abstraction)

`src/session_manager.rs` is the heart of the system. Every session — `Tmux`, `Claude`, `Kiro`, or `Codex` (the `SessionType` enum) — follows the **same** pattern:

- On creation, a dedicated **fan-out task** is spawned that *exclusively owns* the underlying process (PTY handle or agent process). No other code touches the process directly.
- The task `select!`s between two channels:
  - **output**: process events → `tokio::sync::broadcast::Sender<String>`. Any number of WebSocket clients `subscribe()` independently. Slow clients get `Lagged` (capacity `BROADCAST_CAPACITY = 512`) and skip messages rather than blocking others.
  - **input**: all clients send through one shared `mpsc::Sender<SessionInput>`. `SessionInput` is an enum (`PtyData`, `PtyResize`, `Prompt`, `Cancel`); PTY variants are meaningful only to tmux sessions and silently dropped by agent fan-outs.
- **Cleanup is by Drop**: removing a session from the `HashMap` drops `event_tx`/`input_tx`, which ends the fan-out task, which drops the process. Don't add manual kill plumbing — follow the existing Drop-based teardown.

This is why disconnecting a browser never hangs a session, and why multiple tabs/devices can watch the same session. When adding a new session type, mirror `create_codex_session` + `spawn_codex_fanout` exactly.

### Scrollback / replay

Each session keeps a `VecDeque` scrollback capped at `SCROLLBACK_MAX_BYTES` (2MB). On (re)connect, the WS handler replays the buffer before subscribing to live events. PTY scrollback stores base64 frames; ACP/agent scrollback stores serialized JSON events. ACP replay ends with a `replay_done` marker so the frontend can reset busy state.

### The three agent backends (`src/acp/`)

All three normalize to a common `AcpEvent` enum (`src/acp/process.rs`) that the frontend renders. **They speak three different wire protocols** — this is the main source of per-backend complexity:

- **Claude** (`process.rs`): `claude -p --output-format stream-json --input-format stream-json`. Reads NDJSON from stdout; `translate_event` flattens `assistant.message.content[]` blocks into individual `ContentBlock` events. Note thinking blocks carry prose in a `thinking` field, not `text`.
- **Kiro** (`kiro_process.rs`): `kiro-cli acp --trust-all-tools` over JSON-RPC 2.0 with an `initialize` → `session/new` handshake.
- **Codex** (`codex_process.rs`): `codex mcp-server` driven via the `rmcp` MCP client. The agent turn is a `tools/call("codex")`; streaming text/reasoning arrive as **notifications**, not as the call response. Critical constraint: notification callbacks use **non-blocking `try_send`** into the event loop — awaiting there would deadlock rmcp's transport reader (the same task carrying the in-flight `tools/call` response). The `--codex-reasoning` flag injects `model_reasoning_effort` into the call config and only has effect if the model/provider propagates `thinking`.

`AcpEvent` tag fields use `Cow<'static, str>` (`StaticOrOwnedStr`): emit static literals as `Borrowed` to avoid per-event allocation; only pass-through of arbitrary upstream block types uses `Owned`.

### HTTP/WS surface (`src/web.rs`)

`build_router` composes four route groups: authed `/api/*`, the auth-exempt `/api/me`, OAuth/login routes, and WebSockets (`/ws/term/{id}`, `/ws/acp/{id}`, `/ws/transcribe`). A `/assets/*` route plus SPA fallback serve the embedded frontend. WS auth is via a `?token=` query param verified by `auth::verify_ws_token` (browsers can't set headers on WS upgrades).

### Auth (`src/auth.rs`, `src/oauth.rs`, `src/db.rs`)

Two modes, chosen at startup by whether `--github-client-id`/`--github-client-secret` are set:
- **Legacy**: single SHA-256 password, synthetic admin `CurrentUser::legacy()`, no database.
- **OAuth**: GitHub OAuth + JWT, with a SQLite-backed user table and admin-approval flow (`pending` → `active`). First user to log in becomes admin. Only this mode opens the database.

### Git worktree isolation

Agent sessions (Claude/Kiro/Codex) created inside a git repo get an isolated detached worktree under `.zeromux-worktrees/<short-id>/` (`resolve_work_dir`), removed on session delete. tmux sessions run in the work dir directly. If worktree creation fails, it falls back to the base dir with a warning.

### Notes & voice (peripheral features)

- **Notes** (`src/notes.rs`): markdown files with YAML frontmatter under `~/.zeromux/notes/{dir_hash}/` are the source of truth; SQLite is only a query index. Notes are scoped by working directory, so sessions sharing a `work_dir` share notes.
- **Voice** (`src/transcribe.rs`, `src/aws_sigv4.rs`): the **only** feature touching AWS. Streams mic audio to AWS Transcribe Streaming (hand-rolled SigV4, no SDK) for Chinese transcription; requires `transcribe:StartStreamTranscription`. Absence of AWS creds disables only this feature.

### Frontend (`frontend/src/`)

React 19 + Vite + Tailwind v4. `App.tsx` owns auth state, the session list, and active-session/overlay routing. Views: `TerminalView` (xterm.js + WebGL addon), `AcpChatView` (agent chat), `GitViewer`, `MarkdownViewer`. Switching views uses CSS visibility toggling, not unmount, to preserve terminal/scroll state. Markdown rendering (`components/markdown/`) supports KaTeX math, mermaid diagrams, and syntax highlighting, with content hashing + caching to avoid re-render churn — agents are instructed (Codex via a developer-role preamble) to emit `$...$` math, ```` ```mermaid ```` blocks, and pipe tables to match these renderers.

## Conventions

- Match the bilingual norm: user-facing strings and docs often Chinese; code/comments English.
- Keep the broadcast fan-out invariant: the fan-out task is the sole owner of a session's process. Route all client→process communication through `SessionInput`.
- This is a clone tracked under a research workspace (`github-search/ai/`); the repo's own remote is `github.com/keithyt06/zeromux`. The top-level workspace `CLAUDE.md` (no-secrets, directory-layout rules) still applies to anything you add outside this project tree.
