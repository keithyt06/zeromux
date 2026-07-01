use axum::{
    extract::{DefaultBodyLimit, Query, State},
    http::StatusCode,
    middleware,
    response::{IntoResponse, Response},
    routing::{delete, get, patch, post, put},
    Json, Router,
};
use rust_embed::Embed;
use std::sync::Arc;

use crate::{auth, auth::CurrentUser, AppState};

#[derive(Embed)]
#[folder = "frontend/dist/"]
struct FrontendAssets;

pub fn build_router(state: Arc<AppState>) -> Router {
    // API routes that require active user
    let api = Router::new()
        .route("/api/sessions", get(list_sessions))
        .route("/api/sessions", post(create_session))
        .route("/api/sessions/{id}", delete(delete_session))
        .route("/api/sessions/{id}", patch(update_session))
        .route("/api/sessions/{id}/status", get(session_status))
        .route("/api/sessions/{id}/logs", get(session_logs))
        .route("/api/sessions/{id}/files", get(list_session_files))
        .route("/api/sessions/{id}/file", get(get_session_file))
        .route("/api/sessions/{id}/file/raw", get(get_file_raw))
        .route("/api/sessions/{id}/file", post(write_session_file))
        .route("/api/sessions/{id}/file", delete(delete_session_file))
        .route("/api/sessions/{id}/file/rename", post(rename_session_file))
        .route("/api/sessions/{id}/dir/list", get(list_dir))
        .route("/api/sessions/{id}/upload", post(upload_session_file)
            .layer(DefaultBodyLimit::max(28_311_552)))
        .route("/api/sessions/{id}/dir", post(create_session_dir))
        .route("/api/sessions/{id}/dir", delete(delete_session_dir))
        .route("/api/sessions/{id}/dir/rename", post(rename_session_dir))
        .route("/api/sessions/{id}/git/log", get(git_log))
        .route("/api/sessions/{id}/git/show", get(git_show))
        .route("/api/sessions/{id}/git/worktree", get(git_worktree))
        .route("/api/vault/meta", get(vault_meta))
        .route("/api/vault/list", get(vault_list))
        .route("/api/vault/file", get(vault_file))
        .route("/api/vault/file/raw", get(vault_file_raw))
        .route("/api/vault/search", get(vault_search))
        .route("/api/vault/resolve", get(vault_resolve))
        .route("/api/sessions/{id}/runs", get(get_session_runs))
        .route("/api/sessions/{id}/runs/{run_id}/verdict", post(post_run_verdict))
        .route("/api/sessions/{id}/notes", get(list_notes))
        .route("/api/sessions/{id}/notes", post(create_note))
        .route("/api/sessions/{id}/notes/{note_id}", delete(delete_note))
        .route("/api/prompts", get(list_prompts).post(create_prompt))
        .route("/api/prompts/{id}", put(update_prompt).delete(delete_prompt))
        .route("/api/events", get(list_events))
        .route("/api/events/{id}", delete(delete_event))
        .route("/api/scheduled-tasks", get(list_scheduled).post(create_scheduled))
        .route("/api/scheduled-tasks/confirmations", get(list_confirmations))
        .route("/api/scheduled-tasks/runs/{run_id}/confirm-done", post(confirm_run_done))
        .route("/api/scheduled-tasks/runs/{run_id}/replay", post(replay_run_handler))
        .route("/api/scheduled-tasks/{id}", put(update_scheduled).delete(delete_scheduled))
        .route("/api/scheduled-tasks/{id}/run", post(run_scheduled_now))
        .route("/api/scheduled-tasks/{id}/runs", get(list_scheduled_runs))
        .route("/api/scheduler/health", get(scheduler_health))
        .route("/api/directories", get(list_directories))
        .route("/api/push/vapid-key", get(push_vapid_key))
        .route("/api/push/subscribe", post(push_subscribe))
        .route("/api/push/unsubscribe", post(push_unsubscribe))
        .route("/api/tmux/sessions", get(list_tmux_sessions))
        .route("/api/admin/users", get(crate::admin::list_users))
        .route(
            "/api/admin/users/{id}/approve",
            put(crate::admin::approve_user),
        )
        .route(
            "/api/admin/users/{id}",
            delete(crate::admin::delete_user),
        )
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth::auth_middleware,
        ));

    // /api/me — accessible to both active and pending users (handled in auth middleware)
    let me_api = Router::new()
        .route("/api/me", get(get_me))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth::auth_middleware,
        ));

    // OAuth routes (no auth required)
    let auth_routes = Router::new()
        .route("/auth/github", get(crate::oauth::github_redirect))
        .route(
            "/auth/github/callback",
            get(crate::oauth::github_callback),
        )
        .route("/auth/login", post(legacy_login))
        .route("/auth/mode", get(auth_mode));

    // Events POST — uses token query param auth (like WebSocket) for hook access
    let events_ingest = Router::new()
        .route("/api/events", post(create_event));

    let ws = Router::new()
        .route(
            "/ws/term/{session_id}",
            get(crate::ws_handler::ws_terminal),
        )
        .route(
            "/ws/acp/{session_id}",
            get(crate::acp::ws_handler::ws_acp),
        )
        ;

    Router::new()
        .merge(api)
        .merge(me_api)
        .merge(events_ingest)
        .merge(auth_routes)
        .merge(ws)
        .route("/assets/{*path}", get(serve_asset))
        .fallback(get(spa_fallback))
        .with_state(state)
}

/// GET /auth/mode — tells frontend which auth mode is available
async fn auth_mode(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let oauth = state.github_client_id.is_some() && state.github_client_secret.is_some();
    Json(serde_json::json!({
        "oauth": oauth,
        "legacy": state.password_hash.is_some(),
    }))
}

/// POST /auth/login — legacy password login, returns token for cookie
async fn legacy_login(
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let password = body["password"]
        .as_str()
        .ok_or(StatusCode::BAD_REQUEST)?;
    let remember = body["remember"].as_bool().unwrap_or(false);

    let hash = state.password_hash.as_ref().ok_or(StatusCode::SERVICE_UNAVAILABLE)?;

    if !auth::verify_password(password, hash) {
        return Err(StatusCode::UNAUTHORIZED);
    }

    let max_age = if remember { 2592000 } else { 604800 };
    Ok(Json(serde_json::json!({
        "token": password,
        "max_age": max_age,
        "user": {
            "login": "admin",
            "role": "admin",
            "status": "active",
        }
    })))
}

/// GET /api/me — returns current user info (works for both active and pending)
async fn get_me(
    user: axum::Extension<CurrentUser>,
) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "id": user.id,
        "login": user.login,
        "role": user.role,
        "status": user.status,
        "avatar": user.avatar,
    }))
}

/// Serve static assets from the Vite build output
async fn serve_asset(axum::extract::Path(path): axum::extract::Path<String>) -> Response {
    serve_embedded(&format!("assets/{}", path))
}

/// SPA fallback: serve index.html for any non-API/WS/asset route
async fn spa_fallback(uri: axum::http::Uri) -> Response {
    let path = uri.path().trim_start_matches('/');

    // Try exact file match first (e.g. favicon.svg)
    if !path.is_empty() && !path.contains("..") {
        if let Some(resp) = try_serve_embedded(path) {
            return resp;
        }
    }

    // Fallback to index.html (SPA routing)
    serve_embedded("index.html")
}

fn serve_embedded(path: &str) -> Response {
    try_serve_embedded(path).unwrap_or_else(|| StatusCode::NOT_FOUND.into_response())
}

fn try_serve_embedded(path: &str) -> Option<Response> {
    FrontendAssets::get(path).map(|file| {
        let mime = mime_guess::from_path(path).first_or_octet_stream();
        Response::builder()
            .header("Content-Type", mime.as_ref())
            .header("Cache-Control", "public, max-age=3600")
            // Global CSP backstop (defense-in-depth): even if a raw endpoint were
            // misconfigured, agent-generated content can't execute in the app origin.
            .header(
                "Content-Security-Policy",
                "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; \
                 script-src 'self'; worker-src 'self'; \
                 connect-src 'self' ws: wss:; frame-src 'self'; \
                 object-src 'none'; base-uri 'self'",
            )
            .body(axum::body::Body::from(file.data.to_vec()))
            .unwrap()
    })
}

// ── Directory listing ──

#[derive(serde::Deserialize)]
struct DirQuery {
    path: Option<String>,
    /// Optional browse root override (absolute path). resolve_base_dir enforces
    /// it stays under $HOME; None falls back to the session work_dir.
    base_dir: Option<String>,
}

async fn list_directories(
    Query(query): Query<DirQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/home/ubuntu".to_string());
    let base = query.path.unwrap_or_else(|| home.clone());

    // Security: must be under home directory
    let base_path = std::path::Path::new(&base).canonicalize()
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("Invalid path: {}", e)))?;
    let home_path = std::path::Path::new(&home).canonicalize()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Home dir error: {}", e)))?;

    if !base_path.starts_with(&home_path) {
        return Err((StatusCode::FORBIDDEN, "Access denied: path must be under home directory".to_string()));
    }

    let mut entries = Vec::new();
    let read_dir = std::fs::read_dir(&base_path)
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("Cannot read directory: {}", e)))?;

    for entry in read_dir.flatten() {
        let ft = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        if !ft.is_dir() { continue; }

        let name = entry.file_name().to_string_lossy().to_string();
        // Skip hidden dirs and known noisy dirs
        if name.starts_with('.') { continue; }
        if matches!(name.as_str(), "node_modules" | "target" | "__pycache__" | ".git") { continue; }

        let full = entry.path();
        let is_git = full.join(".git").exists();

        entries.push(serde_json::json!({
            "name": name,
            "path": full.to_string_lossy(),
            "is_git": is_git,
        }));
    }

    entries.sort_by(|a, b| {
        a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or(""))
    });

    Ok(Json(serde_json::json!({
        "current": base_path.to_string_lossy(),
        "home": home,
        "parent": base_path.parent()
            .filter(|p| p.starts_with(&home_path))
            .map(|p| p.to_string_lossy().to_string()),
        "entries": entries,
    })))
}

// ── Tmux session listing ──

async fn list_tmux_sessions() -> Json<serde_json::Value> {
    let output = std::process::Command::new("tmux")
        .args(["ls", "-F", "#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_created}"])
        .output();

    let sessions: Vec<serde_json::Value> = match output {
        Ok(o) if o.status.success() => {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .filter_map(|line| {
                    let fields: Vec<&str> = line.split('\t').collect();
                    if fields.len() >= 4 {
                        Some(serde_json::json!({
                            "name": fields[0],
                            "windows": fields[1].parse::<u32>().unwrap_or(0),
                            "attached": fields[2].parse::<u32>().unwrap_or(0),
                            "created": fields[3].parse::<i64>().unwrap_or(0),
                        }))
                    } else {
                        None
                    }
                })
                .collect()
        }
        _ => Vec::new(),
    };

    Json(serde_json::json!({ "sessions": sessions }))
}

// ── Session CRUD ──

#[derive(serde::Deserialize)]
struct CreateSessionReq {
    name: Option<String>,
    #[serde(rename = "type", default = "default_session_type")]
    session_type: crate::session_manager::SessionType,
    work_dir: Option<String>,
    tmux_target: Option<String>,
    initial_prompt: Option<String>,   // 仅 agent 会话有意义；tmux 忽略
}

fn default_session_type() -> crate::session_manager::SessionType {
    crate::session_manager::SessionType::Tmux
}

/// 启动 Prompt 的 gating 决策（纯函数，便于测试）：
/// 返回 Some(trimmed) 表示应发送该文本；None 表示不发（tmux / 缺省 / 空白）。
fn should_send_initial_prompt(
    session_type: crate::session_manager::SessionType,
    prompt: Option<&str>,
) -> Option<String> {
    if session_type == crate::session_manager::SessionType::Tmux {
        return None;
    }
    let trimmed = prompt?.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Security: a client-supplied work_dir must resolve to a path under HOME.
/// Without this an authenticated user could spawn a shell/agent (and write a
/// git worktree) anywhere on the host the server process can reach (e.g. /etc,
/// another user's home). Shared by interactive session creation and scheduled
/// tasks — the directory picker is advisory only, so the server is the sole gate.
fn validate_work_dir_under_home(work_dir: &str) -> Result<(), (StatusCode, String)> {
    let canonical = std::path::Path::new(work_dir)
        .canonicalize()
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("Invalid work_dir: {}", e)))?;
    let home = std::env::var("HOME").unwrap_or_else(|_| "/home/ubuntu".to_string());
    let home_path = std::path::Path::new(&home)
        .canonicalize()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Home dir error: {}", e)))?;
    if !canonical.starts_with(&home_path) {
        return Err((StatusCode::FORBIDDEN, "work_dir must be under home directory".to_string()));
    }
    Ok(())
}

async fn create_session(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
    Json(req): Json<CreateSessionReq>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let type_label = req.session_type.to_string();
    let work_dir = req.work_dir.unwrap_or_else(|| state.work_dir.clone());

    validate_work_dir_under_home(&work_dir)?;

    let name = req.name.or_else(|| req.tmux_target.clone()).unwrap_or_else(|| {
        // Use directory basename as part of session name
        let dir_name = std::path::Path::new(&work_dir)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let count = state.sessions.list_sessions(None).len();
        if dir_name.is_empty() {
            format!("{}-{}", type_label, count + 1)
        } else {
            format!("{}/{}", dir_name, type_label)
        }
    });

    let owner_id = user.id.clone();

    let id = match req.session_type {
        crate::session_manager::SessionType::Tmux => {
            state.sessions
                .create_pty_session(name.clone(), &state.shell, &work_dir, state.default_cols, state.default_rows, &owner_id, req.tmux_target.as_deref())
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        }
        crate::session_manager::SessionType::Claude => {
            state.sessions
                .create_acp_session(name.clone(), &state.claude_path, &work_dir, state.default_cols, state.default_rows, &owner_id)
                .await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        }
        crate::session_manager::SessionType::Kiro => {
            state.sessions
                .create_kiro_session(name.clone(), &state.kiro_path, &work_dir, state.default_cols, state.default_rows, &owner_id)
                .await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        }
        crate::session_manager::SessionType::Codex => {
            state.sessions
                .create_codex_session(name.clone(), &state.codex_path, &state.codex_reasoning, &work_dir, state.default_cols, state.default_rows, &owner_id)
                .await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        }
    };

    // 启动 Prompt：gating 决策抽到 should_send_initial_prompt（已单测）。
    if let Some(prompt) = should_send_initial_prompt(req.session_type, req.initial_prompt.as_deref()) {
        state.sessions.send_initial_prompt(&id, &prompt).await;
    }

    Ok(Json(serde_json::json!({
        "id": id,
        "name": name,
        "type": type_label,
    })))
}

async fn list_sessions(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
) -> Json<serde_json::Value> {
    let filter = if user.is_admin() {
        None // admin sees all
    } else {
        Some(user.id.as_str())
    };
    let sessions = state.sessions.list_sessions(filter);
    Json(serde_json::json!({ "sessions": sessions }))
}

async fn delete_session(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> StatusCode {
    // Check ownership (admin can delete any)
    if !user.is_admin() && !state.sessions.is_owner(&id, &user.id) {
        return StatusCode::FORBIDDEN;
    }

    if state.sessions.remove_session(&id) {
        if let Some(ref logger) = state.logger {
            logger.remove_session(&id);
        }
        StatusCode::OK
    } else {
        StatusCode::NOT_FOUND
    }
}

async fn session_status(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let stored_dir = state.sessions.work_dir(&id).ok_or(StatusCode::NOT_FOUND)?;

    // Try to get live cwd from /proc/PID/cwd for PTY sessions
    let live_dir = state.sessions.pty_pid(&id).and_then(|pid| {
        std::fs::read_link(format!("/proc/{}/cwd", pid))
            .ok()
            .map(|p| p.to_string_lossy().to_string())
    });

    let work_dir = live_dir.unwrap_or(stored_dir);
    let dir = std::path::Path::new(&work_dir);

    let git_branch = std::process::Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(dir)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());

    let git_dirty = std::process::Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(dir)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| {
            let out = String::from_utf8_lossy(&o.stdout);
            out.lines().count()
        });

    let home = std::env::var("HOME").unwrap_or_default();
    let display_dir = if work_dir.starts_with(&home) {
        work_dir.replacen(&home, "~", 1)
    } else {
        work_dir.clone()
    };

    Ok(Json(serde_json::json!({
        "work_dir": display_dir,
        "git_branch": git_branch,
        "git_dirty": git_dirty.unwrap_or(0),
        "is_git": git_branch.is_some(),
    })))
}

#[derive(serde::Deserialize)]
struct LogsQuery {
    limit: Option<usize>,
    offset: Option<usize>,
}

async fn session_logs(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Query(query): Query<LogsQuery>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let logger = state.logger.as_ref().ok_or(StatusCode::NOT_FOUND)?;
    let limit = query.limit.unwrap_or(100).min(1000);
    let offset = query.offset.unwrap_or(0);
    let entries = logger.recent_logs(&id, limit, offset);
    Ok(Json(serde_json::json!({
        "entries": entries,
        "count": entries.len(),
    })))
}

// ── Session metadata update ──

#[derive(serde::Deserialize)]
struct UpdateSessionReq {
    name: Option<String>,
    description: Option<String>,
    status: Option<crate::session_manager::SessionMeta>,
}

/// Strip control characters (newlines, terminal escapes, etc.) and cap the
/// length of a user-supplied metadata string (char-boundary-safe).
fn sanitize_meta(s: &str, max_chars: usize) -> String {
    s.chars()
        .filter(|c| !c.is_control())
        .take(max_chars)
        .collect()
}

async fn update_session(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(req): Json<UpdateSessionReq>,
) -> StatusCode {
    if !user.is_admin() && !state.sessions.is_owner(&id, &user.id) {
        return StatusCode::FORBIDDEN;
    }
    if req.name.as_deref() == Some("") {
        return StatusCode::BAD_REQUEST;
    }
    // Sanitize free-form fields: strip control chars (incl. newlines, which break
    // the sidebar layout) and cap length, so a renamed session can't bloat every
    // 3s poll payload or smuggle terminal escapes into the UI.
    let name = req.name.map(|n| sanitize_meta(&n, 200));
    let description = req.description.map(|d| sanitize_meta(&d, 1000));
    if state
        .sessions
        .update_session_meta_named(&id, name, description, req.status)
    {
        StatusCode::OK
    } else {
        StatusCode::NOT_FOUND
    }
}

// ── Notes API ──

#[derive(serde::Deserialize)]
struct CreateNoteReq {
    text: String,
    #[serde(default)]
    tags: Vec<String>,
}

#[derive(serde::Deserialize)]
struct CreatePromptReq {
    title: String,
    body: String,
}

#[derive(serde::Deserialize)]
struct UpdatePromptReq {
    title: Option<String>,
    body: Option<String>,
}

async fn list_notes(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let work_dir = state
        .sessions
        .work_dir(&id)
        .ok_or((StatusCode::NOT_FOUND, "Session not found".to_string()))?;

    let notes = state
        .notes
        .list_notes(&work_dir)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(Json(serde_json::json!({
        "notes": notes,
        "work_dir": work_dir,
    })))
}

async fn create_note(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(req): Json<CreateNoteReq>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let work_dir = state
        .sessions
        .work_dir(&id)
        .ok_or((StatusCode::NOT_FOUND, "Session not found".to_string()))?;

    let note = state
        .notes
        .create_note(&work_dir, &req.text, &req.tags, &id, &user.login)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(Json(serde_json::json!(note)))
}

async fn delete_note(
    State(state): State<Arc<AppState>>,
    axum::extract::Path((_session_id, note_id)): axum::extract::Path<(String, String)>,
) -> StatusCode {
    match state.notes.delete_note(&note_id) {
        Ok(true) => StatusCode::OK,
        Ok(false) => StatusCode::NOT_FOUND,
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

// ── Per-run metrics (owner-scoped) ──

#[derive(serde::Deserialize)]
struct RunsQuery {
    limit: Option<usize>,
    before: Option<i64>,
}

/// GET /api/sessions/{id}/runs?limit=&before= — owner-scoped run history + stats.
/// 404 when the session is missing OR not owned by the caller (don't leak existence).
async fn get_session_runs(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Query(query): Query<RunsQuery>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let (runs, stats) = state
        .sessions
        .runs_for_session(&id, &user.id, query.limit, query.before)
        .ok_or(StatusCode::NOT_FOUND)?;
    let (lt_turns, lt_dur, lt_cost) = state
        .sessions
        .session_lifetime(&id)
        .unwrap_or((0, 0, 0.0));
    Ok(Json(serde_json::json!({
        "runs": runs,
        "stats": stats,
        "lifetime": { "turns": lt_turns, "duration_ms": lt_dur, "cost_usd": lt_cost }
    })))
}

#[derive(serde::Deserialize)]
struct VerdictReq {
    verdict: String,
    #[allow(dead_code)] // `note` is accepted but not yet persisted (future seam).
    note: Option<String>,
}

/// POST /api/sessions/{id}/runs/{run_id}/verdict — set a human 👍/👎 verdict.
/// 404 when the session is missing, not owned, or the run_id is unknown.
async fn post_run_verdict(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
    axum::extract::Path((id, run_id)): axum::extract::Path<(String, String)>,
    Json(req): Json<VerdictReq>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    if state
        .sessions
        .set_human_verdict(&id, &user.id, &run_id, &req.verdict)
    {
        Ok(Json(serde_json::json!({ "ok": true })))
    } else {
        Err(StatusCode::NOT_FOUND)
    }
}

// ── Prompt presets (global, not session-scoped) ──

async fn list_prompts(
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let presets = state
        .prompts
        .list()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(serde_json::json!({ "presets": presets })))
}

async fn create_prompt(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CreatePromptReq>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    match state.prompts.create(&req.title, &req.body) {
        Ok(p) => Ok(Json(serde_json::json!(p))),
        // "empty"/"too long" are user-input validation -> 400 (not notes' 500).
        Err(e) => Err((StatusCode::BAD_REQUEST, e)),
    }
}

async fn update_prompt(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(req): Json<UpdatePromptReq>,
) -> StatusCode {
    match state
        .prompts
        .update(&id, req.title.as_deref(), req.body.as_deref())
    {
        Ok(true) => StatusCode::OK,
        Ok(false) => StatusCode::NOT_FOUND, // missing id OR empty PUT
        Err(_) => StatusCode::BAD_REQUEST,  // blank/over-cap field
    }
}

async fn delete_prompt(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> StatusCode {
    match state.prompts.delete(&id) {
        Ok(true) => StatusCode::OK,
        Ok(false) => StatusCode::NOT_FOUND,
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

// ── Session file browser ──

#[derive(serde::Deserialize)]
struct FilesQuery {
    pattern: Option<String>,
    base_dir: Option<String>,
}

async fn list_session_files(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Query(query): Query<FilesQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    require_session_access(&state, &user, &id)?;
    let base = resolve_base_dir(&state, &id, query.base_dir.as_deref())?;

    let pattern = query.pattern.as_deref().unwrap_or("*.md");
    let mut files = Vec::new();

    collect_files(&base, &base, pattern, &mut files, 5);

    files.sort_by(|a, b| a["path"].as_str().unwrap_or("").cmp(b["path"].as_str().unwrap_or("")));

    Ok(Json(serde_json::json!({ "files": files })))
}

/// Recursively collect files matching a glob pattern (simple *.ext matching)
fn collect_files(
    dir: &std::path::Path,
    base: &std::path::Path,
    pattern: &str,
    out: &mut Vec<serde_json::Value>,
    max_depth: u32,
) {
    if max_depth == 0 { return; }

    let ext_filter = pattern.strip_prefix("*.");
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        // Skip hidden and noisy dirs
        if name.starts_with('.') { continue; }
        if matches!(name.as_str(), "node_modules" | "target" | "__pycache__" | ".git") { continue; }

        if path.is_dir() {
            collect_files(&path, base, pattern, out, max_depth - 1);
        } else if path.is_file() {
            let matches = if let Some(ext) = ext_filter {
                path.extension().map(|e| e == ext).unwrap_or(false)
            } else {
                name == pattern
            };

            if matches {
                let rel = path.strip_prefix(base).unwrap_or(&path);
                let meta = std::fs::metadata(&path);
                let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
                let modified = meta.ok()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0);

                out.push(serde_json::json!({
                    "path": rel.to_string_lossy(),
                    "name": name,
                    "size": size,
                    "modified": modified,
                }));
            }
        }
    }
}

#[derive(serde::Deserialize)]
struct FileQuery {
    path: String,
    base_dir: Option<String>,
}

/// Read a text file, capping at 1MB. Over the cap, returns the first 1MB plus
/// truncated=true (reader scenario: partial beats nothing). The slice is decoded
/// with `from_utf8_lossy`, so a multibyte char split at the cap becomes U+FFFD —
/// safe with no panic on a byte boundary. Shared by session and vault readers.
pub(crate) fn read_text_file_capped(
    file_path: &std::path::Path,
) -> Result<(String, bool), (StatusCode, String)> {
    let bytes = std::fs::read(file_path)
        .map_err(|e| (StatusCode::NOT_FOUND, format!("File not found: {}", e)))?;
    const CAP: usize = 1_048_576;
    if bytes.len() <= CAP {
        Ok((String::from_utf8_lossy(&bytes).to_string(), false))
    } else {
        Ok((String::from_utf8_lossy(&bytes[..CAP]).to_string(), true))
    }
}

async fn get_session_file(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Query(query): Query<FileQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    require_session_access(&state, &user, &id)?;
    let base = resolve_base_dir(&state, &id, query.base_dir.as_deref())?;

    // Security: resolve + verify the real path is under base (follows symlinks).
    let file_path = resolve_and_verify(&base, &query.path)?;

    // Refuse credential / sensitive files by name, or any path descending into a
    // sensitive directory (.ssh/.aws/.gnupg/.git) even if the leaf looks innocuous.
    if descends_into_sensitive_dir(&base, &file_path) {
        return Err((StatusCode::FORBIDDEN, "Access to sensitive directory denied".to_string()));
    }
    if let Some(name) = file_path.file_name().and_then(|s| s.to_str()) {
        if is_credential_path(name) {
            return Err((StatusCode::FORBIDDEN, "Credential file access denied".to_string()));
        }
    }

    // Size check (1MB max)
    let meta = std::fs::metadata(&file_path)
        .map_err(|e| (StatusCode::NOT_FOUND, format!("File not found: {}", e)))?;
    if meta.len() > 1_048_576 {
        return Err((StatusCode::BAD_REQUEST, "File too large (max 1MB)".to_string()));
    }

    let content = std::fs::read_to_string(&file_path)
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("Cannot read file: {}", e)))?;

    Ok(Json(serde_json::json!({
        "path": query.path,
        "content": content,
    })))
}

/// raw download triple: never inline-render a user file (prevents same-origin XSS).
fn build_raw_headers(filename: &str) -> (&'static str, &'static str, String) {
    let safe = sanitize_filename(filename);
    ("application/octet-stream", "nosniff", format!("attachment; filename=\"{}\"", safe))
}

async fn get_file_raw(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Query(query): Query<FileQuery>,
) -> Result<Response, (StatusCode, String)> {
    require_session_access(&state, &user, &id)?;
    let base = resolve_base_dir(&state, &id, query.base_dir.as_deref())?;
    let real = resolve_and_verify(&base, &query.path)?;
    if descends_into_sensitive_dir(&base, &real) {
        return Err((StatusCode::FORBIDDEN, "Forbidden".into()));
    }
    let fname = real.file_name().and_then(|s| s.to_str()).unwrap_or("download");
    if is_credential_path(fname) {
        return Err((StatusCode::FORBIDDEN, "Forbidden".into()));
    }
    let bytes = std::fs::read(&real)
        .map_err(|e| (StatusCode::NOT_FOUND, format!("Not found: {e}")))?;
    let (ct, nosniff, disp) = build_raw_headers(fname);
    Ok(Response::builder()
        .header("Content-Type", ct)
        .header("X-Content-Type-Options", nosniff)
        .header("Content-Disposition", disp)
        .body(axum::body::Body::from(bytes))
        .unwrap())
}

/// Owner gate for the file/dir endpoints: an authenticated non-admin user may only
/// touch sessions they own. Mirrors the check used by session delete/patch. Legacy
/// password mode runs as a synthetic admin, so this is a no-op there.
fn require_session_access(
    state: &AppState,
    user: &CurrentUser,
    session_id: &str,
) -> Result<(), (StatusCode, String)> {
    if user.is_admin() || state.sessions.is_owner(session_id, &user.id) {
        Ok(())
    } else {
        Err((StatusCode::FORBIDDEN, "Not your session".to_string()))
    }
}

/// Resolve the effective base directory: use base_dir_override if provided, otherwise session work_dir.
/// Security: the resolved path must be under HOME.
fn resolve_base_dir(
    state: &AppState,
    session_id: &str,
    base_dir_override: Option<&str>,
) -> Result<std::path::PathBuf, (StatusCode, String)> {
    let dir = if let Some(bd) = base_dir_override.filter(|s| !s.is_empty()) {
        bd.to_string()
    } else {
        state.sessions.work_dir(session_id)
            .ok_or((StatusCode::NOT_FOUND, "Session not found".to_string()))?
    };

    ensure_under_home(&dir)
}

/// Canonicalize `dir` and assert it stays under $HOME. This is the load-bearing
/// boundary for base_dir overrides (re-rootable file browsing): anything that
/// resolves outside $HOME — including via symlink — is rejected with 403.
///
/// The base itself must also be a directory that does not sit at or inside a
/// sensitive dir (see `base_dir_at_or_in_sensitive`). The per-request descent guard
/// only inspects components *below* base, so it cannot catch a base that IS the
/// sensitive dir — that check has to live here, anchored at $HOME.
fn ensure_under_home(dir: &str) -> Result<std::path::PathBuf, (StatusCode, String)> {
    validate_browse_root(dir)
}

/// Canonicalize + assert under $HOME + is a directory + not a sensitive dir.
/// Shared by HTTP base-dir validation (`ensure_under_home`) and startup
/// `--vault-dir` validation. Behavior is the verbatim former `ensure_under_home`.
pub(crate) fn validate_browse_root(dir: &str) -> Result<std::path::PathBuf, (StatusCode, String)> {
    let base = std::path::Path::new(dir).canonicalize()
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("Invalid path: {}", e)))?;

    let home = std::env::var("HOME").unwrap_or_else(|_| "/home/ubuntu".to_string());
    let home_path = std::path::Path::new(&home).canonicalize()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Home dir error: {}", e)))?;

    if !base.starts_with(&home_path) {
        return Err((StatusCode::FORBIDDEN, "Path must be under home directory".to_string()));
    }

    if !base.is_dir() {
        return Err((StatusCode::BAD_REQUEST, "Base must be a directory".to_string()));
    }

    // Reject a base that is, or descends into, a sensitive dir. Anchor at $HOME so
    // every component between $HOME and the base is inspected (including the base's
    // own final component, which the below-base guard would miss). This also closes
    // the override leak where base_dir=~/.zeromux would put the data dir's contents
    // (OAuth DB, transcripts) directly below base, where the descent guard — which
    // strips the base prefix — can no longer see the `.zeromux` component.
    if base_dir_at_or_in_sensitive(&home_path, &base) {
        return Err((StatusCode::FORBIDDEN, "Access to sensitive directory denied".to_string()));
    }

    Ok(base)
}

/// Helper: resolve a session work_dir and validate a relative path is under it.
/// Returns (base_canonical, resolved_path). The resolved path may not exist yet (for creates).
fn resolve_session_path(
    state: &AppState,
    session_id: &str,
    rel_path: &str,
) -> Result<(std::path::PathBuf, std::path::PathBuf), (StatusCode, String)> {
    let base = resolve_base_dir(state, session_id, None)?;

    // For new files, parent must exist and be under base
    let joined = base.join(rel_path);

    // Check for path traversal by normalizing components
    let mut normalized = base.clone();
    for component in std::path::Path::new(rel_path).components() {
        match component {
            std::path::Component::Normal(c) => normalized.push(c),
            std::path::Component::ParentDir => {
                normalized.pop();
                if !normalized.starts_with(&base) {
                    return Err((StatusCode::FORBIDDEN, "Path traversal denied".to_string()));
                }
            }
            std::path::Component::CurDir => {}
            _ => return Err((StatusCode::BAD_REQUEST, "Invalid path component".to_string())),
        }
    }

    if !normalized.starts_with(&base) {
        return Err((StatusCode::FORBIDDEN, "Path traversal denied".to_string()));
    }

    Ok((base, joined))
}

// ── Unified path-safety helpers ──
//
// These are the single source of truth for file-endpoint safety, wired into the
// read/write/upload handlers below.

/// Credential / sensitive filenames: never enumerated by `list`, refused by `download`.
/// Operates on the file NAME only (no directory components), case-insensitive.
fn is_credential_path(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n.starts_with(".env")
        || n == ".aws" || n == ".ssh" || n == ".netrc" || n == ".npmrc"
        || n.starts_with("id_")            // id_rsa / id_ed25519 ...
        || n.ends_with(".pem") || n.ends_with(".key") || n.ends_with(".p12")
        || n.ends_with("credentials")
}

/// The single denylist of control / credential directory names. READ and WRITE
/// guards both derive from this list so they can never drift apart — drift (a name
/// added to one guard but not the other) was the root cause of a string of P1s.
///
/// Two classes, equally blocked in both directions:
/// - credential dirs (.ssh/.aws/.gnupg) — read would exfiltrate secrets; write would
///   let a session rooted at $HOME wipe/replace AWS creds or GPG keys.
/// - app/control dirs (.git/.zeromux/.zeromux-worktrees) — .zeromux holds the OAuth
///   user DB, notes/prompts DBs, and agent run transcripts (cross-user exfiltration on
///   read); .git/.zeromux-worktrees hold repo/session internals.
const SENSITIVE_DIR_NAMES: &[&str] = &[
    ".ssh", ".aws", ".gnupg", ".git", ".zeromux", ".zeromux-worktrees",
];

/// True if any path component below `base` is a sensitive/control directory.
/// Only components below `base` are inspected: agent sessions run with a base of
/// `<repo>/.zeromux-worktrees/<id>/`, so checking the full canonical path would (and
/// did) match `.zeromux-worktrees` in the base prefix and 403 *every* op in an agent
/// workspace. A path that isn't under `base` is refused defensively.
fn path_hits_sensitive_dir(base: &std::path::Path, canonical: &std::path::Path) -> bool {
    let rel = match canonical.strip_prefix(base) {
        Ok(r) => r,
        Err(_) => return true,
    };
    rel.components().any(|c| {
        matches!(c, std::path::Component::Normal(s)
            if s.to_str().is_some_and(|name| SENSITIVE_DIR_NAMES.contains(&name)))
    })
}

/// READ guard: refuse any path that descends *into* a sensitive dir (e.g.
/// `.ssh/config`, `.zeromux/zeromux.db`) even when the leaf name looks innocuous.
fn descends_into_sensitive_dir(base: &std::path::Path, canonical: &std::path::Path) -> bool {
    path_hits_sensitive_dir(base, canonical)
}

/// WRITE guard: refuse writes/deletes/renames that touch a control dir OR a
/// control-named leaf below base (so `delete_session_dir(".git")` and `mkdir ".aws"`
/// are refused, not just descents into them). Identical denylist to the read guard.
fn is_write_blocked(base: &std::path::Path, canonical: &std::path::Path) -> bool {
    path_hits_sensitive_dir(base, canonical)
}

/// BASE-ACCEPTANCE guard for `ensure_under_home`: refuse a browse *root* that is, or
/// sits inside (between $HOME and itself), a sensitive dir. Same source list as the
/// descent guard EXCEPT `.zeromux-worktrees`: a worktree-isolated agent session's
/// server-set work_dir legitimately IS `<repo>/.zeromux-worktrees/<id>`, so rejecting
/// it as a base would 403 every file op for those sessions. The descent guard still
/// strips that base prefix, so children of the worktree base are evaluated normally.
/// Deriving from the one source list (minus the single documented exception) keeps the
/// read/write parity intact while allowing the one legitimate sensitive base.
fn base_dir_at_or_in_sensitive(home: &std::path::Path, base: &std::path::Path) -> bool {
    let rel = match base.strip_prefix(home) {
        Ok(r) => r,
        Err(_) => return true,
    };
    rel.components().any(|c| {
        matches!(c, std::path::Component::Normal(s)
            if s.to_str().is_some_and(|name|
                name != ".zeromux-worktrees" && SENSITIVE_DIR_NAMES.contains(&name)))
    })
}

/// Unified resolve + verify: lexical `..` guard → `base.join(rel)` → canonicalize →
/// `starts_with(base_canonical)` recheck. canonicalize failure (dangling / escaping
/// symlink) → 403. canonicalize follows symlinks, so a symlink whose real target is
/// outside base is rejected by the post-canonicalize recheck.
///
/// NOTE: O_NOFOLLOW / openat2 full-descent is the strongest design, but Rust has no
/// cross-platform wrapper. This MVP uses canonicalize + starts_with recheck to shrink
/// the window to near-zero (for reads it is sufficient: the file already exists and
/// canonicalize yields its real path). The residual canonicalize→open TOCTOU window is
/// low-risk in the single-user work_dir scenario; openat2 hardening is a deferred seam.
fn resolve_and_verify(
    base_canonical: &std::path::Path,
    rel: &str,
) -> Result<std::path::PathBuf, (StatusCode, String)> {
    use std::path::{Component, Path};
    // Lexical layer: reject absolute paths and escaping `..`.
    let mut probe = base_canonical.to_path_buf();
    for comp in Path::new(rel).components() {
        match comp {
            Component::Normal(c) => probe.push(c),
            Component::CurDir => {}
            Component::ParentDir => {
                probe.pop();
                if !probe.starts_with(base_canonical) {
                    return Err((StatusCode::FORBIDDEN, "Path traversal denied".into()));
                }
            }
            _ => return Err((StatusCode::BAD_REQUEST, "Invalid path component".into())),
        }
    }
    // Physical layer: after canonicalize (follows symlinks) the path must still be in base.
    let real = probe
        .canonicalize()
        .map_err(|_| (StatusCode::FORBIDDEN, "Path not resolvable under workspace".into()))?;
    if !real.starts_with(base_canonical) {
        return Err((StatusCode::FORBIDDEN, "Path escapes workspace".into()));
    }
    Ok(real)
}

/// Resolve a WRITE/CREATE/RENAME destination whose leaf may not exist yet, giving it
/// the same physical-layer symlink defense `resolve_and_verify` gives reads.
///
/// `resolve_and_verify` canonicalizes the whole path, which requires the target to
/// already exist — wrong for a create/rename-to/mkdir destination. Instead we
/// canonicalize the **parent** (which must exist) and re-check it is under base, then
/// re-attach the leaf. This closes the escape where the destination was resolved
/// lexically (via `resolve_session_path`): a symlinked path component would redirect
/// `std::fs::rename`/`create_dir_all` outside base or into a control dir, invisibly to
/// the literal-component guards. Finally `is_write_blocked` is applied to the resolved
/// real target so a control-dir parent OR a control-named leaf (e.g. mkdir ".git",
/// rename → ".aws") is refused.
fn resolve_write_target(
    base_canonical: &std::path::Path,
    rel: &str,
) -> Result<std::path::PathBuf, (StatusCode, String)> {
    let rel_path = std::path::Path::new(rel);
    let leaf = rel_path
        .file_name()
        .ok_or((StatusCode::BAD_REQUEST, "Invalid path".to_string()))?;
    let parent_rel = rel_path
        .parent()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    // Canonicalize the parent (must exist) and confirm it stays under base after
    // following any symlinks. resolve_and_verify on the empty rel returns base itself.
    let real_parent = resolve_and_verify(base_canonical, &parent_rel)?;
    let target = real_parent.join(leaf);
    if is_write_blocked(base_canonical, &target) {
        return Err((StatusCode::FORBIDDEN, "Writes to control directories denied".to_string()));
    }
    Ok(target)
}

// ── Single-level directory listing (dir/list) ──

struct DirEntryOut {
    name: String,
    kind: &'static str,
    size: u64,
    mtime: u64,
    writable: bool,
}

/// List one directory level (non-recursive). Credential files are never enumerated.
/// Caps at 2000 entries and sets `truncated`. Dirs sort before files, then by name.
fn list_dir_entries(
    base_canonical: &std::path::Path,
    rel: &str,
) -> Result<(Vec<DirEntryOut>, bool), (StatusCode, String)> {
    let dir = if rel.is_empty() {
        base_canonical.to_path_buf()
    } else {
        resolve_and_verify(base_canonical, rel)?
    };
    if descends_into_sensitive_dir(base_canonical, &dir) {
        return Err((StatusCode::FORBIDDEN, "Access to sensitive directory denied".into()));
    }
    if !dir.is_dir() {
        return Err((StatusCode::BAD_REQUEST, "Not a directory".into()));
    }
    let rd = std::fs::read_dir(&dir)
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("Cannot read dir: {e}")))?;
    let mut out = Vec::new();
    let mut truncated = false;
    for entry in rd.flatten() {
        if out.len() >= 2000 {
            truncated = true;
            break;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if is_credential_path(&name) {
            continue; // never enumerate credentials
        }
        let ft = entry.file_type().ok();
        let is_dir = ft.map(|t| t.is_dir()).unwrap_or(false);
        let meta = entry.metadata().ok();
        out.push(DirEntryOut {
            kind: if is_dir { "dir" } else { "file" },
            size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
            mtime: meta
                .as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0),
            writable: !is_write_blocked(base_canonical, &dir.join(&name)),
            name,
        });
    }
    // dirs first ("dir" > "file" reverse-sorted via b.kind), then case-insensitive name
    out.sort_by(|a, b| (b.kind, a.name.to_lowercase()).cmp(&(a.kind, b.name.to_lowercase())));
    Ok((out, truncated))
}

async fn list_dir(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Query(query): Query<DirQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    require_session_access(&state, &user, &id)?;
    let base = resolve_base_dir(&state, &id, query.base_dir.as_deref())?;
    let (entries, truncated) = list_dir_entries(&base, query.path.as_deref().unwrap_or(""))?;
    let arr: Vec<_> = entries
        .iter()
        .map(|e| {
            serde_json::json!({
                "name": e.name, "type": e.kind, "size": e.size, "mtime": e.mtime, "writable": e.writable,
            })
        })
        .collect();
    Ok(Json(serde_json::json!({ "entries": arr, "truncated": truncated })))
}

// ── File write (create/edit) ──

#[derive(serde::Deserialize)]
struct WriteFileReq {
    path: String,
    content: String,
}

async fn write_session_file(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(req): Json<WriteFileReq>,
) -> Result<StatusCode, (StatusCode, String)> {
    require_session_access(&state, &user, &id)?;
    let base = resolve_base_dir(&state, &id, None)?;

    // The parent directory must already exist (we do not implicitly create
    // client-named directory trees). Resolve + verify the real parent is under base,
    // then write the leaf file inside it.
    let rel = std::path::Path::new(&req.path);
    let file_name = rel
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or((StatusCode::BAD_REQUEST, "Invalid file path".to_string()))?;
    let parent_rel = rel.parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    let real_parent = resolve_and_verify(&base, &parent_rel)?;

    if is_write_blocked(&base, &real_parent) {
        return Err((StatusCode::FORBIDDEN, "Writes to control directories denied".to_string()));
    }

    let file_path = real_parent.join(file_name);

    // Refuse to follow an existing symlink leaf out of the workspace (the parent is
    // verified under base, but the leaf name itself could be a symlink). Reads use
    // canonicalize; writes create the file, so guard the leaf explicitly here.
    if let Ok(meta) = std::fs::symlink_metadata(&file_path) {
        if meta.file_type().is_symlink() {
            return Err((StatusCode::FORBIDDEN, "Refusing to write through a symlink".to_string()));
        }
    }

    std::fs::write(&file_path, &req.content)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Write failed: {}", e)))?;

    Ok(StatusCode::OK)
}

// ── File delete ──

async fn delete_session_file(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Query(query): Query<FileQuery>,
) -> Result<StatusCode, (StatusCode, String)> {
    require_session_access(&state, &user, &id)?;
    let (base, _) = resolve_session_path(&state, &id, &query.path)?;

    let file_path = base.join(&query.path).canonicalize()
        .map_err(|e| (StatusCode::NOT_FOUND, format!("File not found: {}", e)))?;

    if !file_path.starts_with(&base) {
        return Err((StatusCode::FORBIDDEN, "Path traversal denied".to_string()));
    }

    if is_write_blocked(&base, &file_path) {
        return Err((StatusCode::FORBIDDEN, "Writes to control directories denied".to_string()));
    }

    if !file_path.is_file() {
        return Err((StatusCode::NOT_FOUND, "Not a file".to_string()));
    }

    std::fs::remove_file(&file_path)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Delete failed: {}", e)))?;

    Ok(StatusCode::OK)
}

// ── File rename ──

#[derive(serde::Deserialize)]
struct RenameReq {
    from: String,
    to: String,
}

async fn rename_session_file(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(req): Json<RenameReq>,
) -> Result<StatusCode, (StatusCode, String)> {
    require_session_access(&state, &user, &id)?;
    let base = resolve_base_dir(&state, &id, None)?;

    let from_path = base.join(&req.from).canonicalize()
        .map_err(|e| (StatusCode::NOT_FOUND, format!("Source not found: {}", e)))?;

    if !from_path.starts_with(&base) {
        return Err((StatusCode::FORBIDDEN, "Path traversal denied".to_string()));
    }

    if is_write_blocked(&base, &from_path) {
        return Err((StatusCode::FORBIDDEN, "Writes to control directories denied".to_string()));
    }

    // Physical-layer resolve of the destination: parent must exist and stay under base
    // after symlink resolution, and the leaf may not be control-named. The destination
    // parent must already exist (no implicit tree creation across a symlink).
    let to_path = resolve_write_target(&base, &req.to)?;

    if to_path.exists() {
        return Err((StatusCode::CONFLICT, "Destination already exists".to_string()));
    }

    std::fs::rename(&from_path, &to_path)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Rename failed: {}", e)))?;

    Ok(StatusCode::OK)
}

// ── File upload (base64) ──

/// 在扩展名前插入 `-N` 后缀。前导点(dotfile)不视为扩展名。
fn next_candidate(name: &str, n: usize) -> String {
    match name.rfind('.').filter(|&i| i > 0) {
        Some(i) => format!("{}-{}{}", &name[..i], n, &name[i..]),
        None => format!("{}-{}", name, n),
    }
}

/// 剥换行/控制字符(< 0x20 及 DEL 0x7f)与路径分隔符(/ \\)。
/// 空或全非法 → "upload"。Unicode 正常字符保留。
fn sanitize_filename(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .filter(|&c| c >= '\u{20}' && c != '\u{7f}' && c != '/' && c != '\\' && c != '"')
        .collect();
    if cleaned.is_empty() { "upload".to_string() } else { cleaned }
}

/// 原子"不存在才建":用 create_new(true) 占位,AlreadyExists 则递增后缀重试。
/// 返回 (打开的写句柄, 实际文件名)。消除 check-then-write 的并发覆盖窗口(E2)。
fn dedupe_and_create(dir: &std::path::Path, name: &str) -> std::io::Result<(std::fs::File, String)> {
    use std::fs::OpenOptions;
    match OpenOptions::new().write(true).create_new(true).open(dir.join(name)) {
        Ok(f) => return Ok((f, name.to_string())),
        Err(e) if e.kind() != std::io::ErrorKind::AlreadyExists => return Err(e),
        Err(_) => {}
    }
    for n in 1..10_000 {
        let candidate = next_candidate(name, n);
        match OpenOptions::new().write(true).create_new(true).open(dir.join(&candidate)) {
            Ok(f) => return Ok((f, candidate)),
            Err(e) if e.kind() != std::io::ErrorKind::AlreadyExists => return Err(e),
            Err(_) => continue,
        }
    }
    Err(std::io::Error::new(std::io::ErrorKind::AlreadyExists, "too many name collisions"))
}

/// Split an upload relative path into (target directory, safe file name). Preserves the
/// directory part (fixes the bug where only file_name() was taken, so uploads always
/// landed in work_dir root regardless of the browsed subdir).
fn split_upload_target(base: &std::path::Path, rel: &str) -> (std::path::PathBuf, String) {
    let p = std::path::Path::new(rel);
    let name = sanitize_filename(p.file_name().and_then(|s| s.to_str()).unwrap_or("upload"));
    let dir = match p.parent() {
        Some(par) if !par.as_os_str().is_empty() => base.join(par),
        _ => base.to_path_buf(),
    };
    (dir, name)
}

#[derive(serde::Deserialize)]
struct UploadReq {
    path: String,
    /// Base64-encoded file content
    data: String,
}

#[derive(serde::Serialize)]
struct UploadResp {
    /// 实际写入的文件名(去重 + sanitize 后),前端注入 prompt 用。
    path: String,
}

async fn upload_session_file(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(req): Json<UploadReq>,
) -> Result<Json<UploadResp>, (StatusCode, String)> {
    require_session_access(&state, &user, &id)?;
    let base = resolve_base_dir(&state, &id, None)?;

    // Honor the directory part of the upload path (e.g. "sub/dir/pic.png" → base/sub/dir).
    let (target_dir, safe_name) = split_upload_target(&base, &req.path);

    // Verify the target directory's real path is under base. Its relative part is the
    // upload path with the leaf name stripped; the directory must already exist.
    let parent_rel = target_dir
        .strip_prefix(&base)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let real_target = resolve_and_verify(&base, &parent_rel)?;

    if is_write_blocked(&base, &real_target) {
        return Err((StatusCode::FORBIDDEN, "Writes to control directories denied".to_string()));
    }

    let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &req.data)
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("Invalid base64: {}", e)))?;

    if bytes.len() > 20_971_520 {
        return Err((StatusCode::BAD_REQUEST, "File too large (max 20MB)".to_string()));
    }

    let (mut file, actual_name) = dedupe_and_create(&real_target, &safe_name)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Create failed: {}", e)))?;
    use std::io::Write;
    file.write_all(&bytes)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Write failed: {}", e)))?;

    Ok(Json(UploadResp { path: actual_name }))
}

// ── Directory operations ──

#[derive(serde::Deserialize)]
struct DirOpReq {
    path: String,
}

async fn create_session_dir(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(req): Json<DirOpReq>,
) -> Result<StatusCode, (StatusCode, String)> {
    require_session_access(&state, &user, &id)?;
    let base = resolve_base_dir(&state, &id, None)?;
    // Physical-layer resolve: the parent must exist and stay under base after symlink
    // resolution; a control-named leaf is refused. Closes the symlinked-parent escape
    // that lexical resolution (resolve_session_path) left open for mkdir.
    let dir_path = resolve_write_target(&base, &req.path)?;

    std::fs::create_dir_all(&dir_path)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Cannot create dir: {}", e)))?;

    Ok(StatusCode::CREATED)
}

async fn delete_session_dir(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Query(query): Query<DirOpReq>,
) -> Result<StatusCode, (StatusCode, String)> {
    require_session_access(&state, &user, &id)?;
    let (base, _) = resolve_session_path(&state, &id, &query.path)?;

    let dir_path = base.join(&query.path).canonicalize()
        .map_err(|e| (StatusCode::NOT_FOUND, format!("Directory not found: {}", e)))?;

    if !dir_path.starts_with(&base) {
        return Err((StatusCode::FORBIDDEN, "Path traversal denied".to_string()));
    }

    if is_write_blocked(&base, &dir_path) {
        return Err((StatusCode::FORBIDDEN, "Writes to control directories denied".to_string()));
    }

    if !dir_path.is_dir() {
        return Err((StatusCode::BAD_REQUEST, "Not a directory".to_string()));
    }

    // Don't allow deleting the work_dir root itself
    if dir_path == base {
        return Err((StatusCode::FORBIDDEN, "Cannot delete work directory root".to_string()));
    }

    std::fs::remove_dir_all(&dir_path)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Delete failed: {}", e)))?;

    Ok(StatusCode::OK)
}

async fn rename_session_dir(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(req): Json<RenameReq>,
) -> Result<StatusCode, (StatusCode, String)> {
    require_session_access(&state, &user, &id)?;
    let base = resolve_base_dir(&state, &id, None)?;

    let from_path = base.join(&req.from).canonicalize()
        .map_err(|e| (StatusCode::NOT_FOUND, format!("Source not found: {}", e)))?;

    if !from_path.starts_with(&base) {
        return Err((StatusCode::FORBIDDEN, "Path traversal denied".to_string()));
    }

    if is_write_blocked(&base, &from_path) {
        return Err((StatusCode::FORBIDDEN, "Writes to control directories denied".to_string()));
    }

    if !from_path.is_dir() {
        return Err((StatusCode::BAD_REQUEST, "Not a directory".to_string()));
    }

    // Physical-layer resolve of the destination (parent canonicalized under base,
    // control-named leaf refused) — closes the symlinked-parent escape on dir rename.
    let to_path = resolve_write_target(&base, &req.to)?;

    if to_path.exists() {
        return Err((StatusCode::CONFLICT, "Destination already exists".to_string()));
    }

    std::fs::rename(&from_path, &to_path)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Rename failed: {}", e)))?;

    Ok(StatusCode::OK)
}

// ── Git log / show ──

#[derive(serde::Deserialize)]
struct GitLogQuery {
    limit: Option<usize>,
}

async fn git_log(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Query(query): Query<GitLogQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    require_session_access(&state, &user, &id)?;
    let work_dir = state
        .sessions
        .work_dir(&id)
        .ok_or((StatusCode::NOT_FOUND, "Session not found".to_string()))?;

    let limit = query.limit.unwrap_or(100).min(500);

    // Use --graph --all to show branch/merge topology.
    // COMMIT_START marker distinguishes commit lines from graph-only lines.
    let marker = "COMMIT_START";
    let sep = "\x01"; // ASCII SOH as field separator — won't appear in commit data
    let format_str = format!(
        "{marker}{sep}%H{sep}%h{sep}%an{sep}%aI{sep}%s{sep}%D"
    );

    let output = std::process::Command::new("git")
        .args([
            "log",
            "--all",
            "--graph",
            &format!("--format={}", format_str),
            &format!("-{}", limit),
        ])
        .current_dir(&work_dir)
        .output()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("git log failed: {}", e)))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err((StatusCode::BAD_REQUEST, format!("git log error: {}", stderr)));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);

    // Parse lines into entries: each has `graph` (the ASCII art prefix) and optionally `commit`
    let mut entries = Vec::new();
    for line in stdout.lines() {
        if let Some(marker_pos) = line.find(marker) {
            // Commit line: graph chars before marker, commit data after
            let graph = &line[..marker_pos];
            let data = &line[marker_pos + marker.len()..];
            let fields: Vec<&str> = data.split(sep).collect();
            // fields[0] is empty (sep before hash), so fields are: ["", hash, short, author, date, subject, refs]
            if fields.len() >= 6 {
                entries.push(serde_json::json!({
                    "graph": graph,
                    "commit": {
                        "hash": fields[1],
                        "short_hash": fields[2],
                        "author": fields[3],
                        "date": fields[4],
                        "subject": fields[5],
                        "refs": fields.get(6).unwrap_or(&""),
                    }
                }));
            }
        } else {
            // Graph-only line (connector between commits)
            entries.push(serde_json::json!({
                "graph": line,
                "commit": null
            }));
        }
    }

    // Total commit count across all branches
    let total = std::process::Command::new("git")
        .args(["rev-list", "--count", "--all"])
        .current_dir(&work_dir)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().parse::<usize>().unwrap_or(0))
        .unwrap_or(0);

    Ok(Json(serde_json::json!({
        "entries": entries,
        "total": total,
    })))
}

#[derive(serde::Deserialize)]
struct GitShowQuery {
    commit: String,
}

async fn git_show(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Query(query): Query<GitShowQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    require_session_access(&state, &user, &id)?;
    let work_dir = state
        .sessions
        .work_dir(&id)
        .ok_or((StatusCode::NOT_FOUND, "Session not found".to_string()))?;

    // Only allow hex chars to prevent command injection
    if !query.commit.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err((StatusCode::BAD_REQUEST, "Invalid commit hash".to_string()));
    }

    // Commit metadata
    let sep = "---FIELD---";
    let format_str = format!("%H{sep}%h{sep}%an{sep}%aI{sep}%s{sep}%b");
    let meta_output = std::process::Command::new("git")
        .args(["log", "-1", &format!("--format={}", format_str), &query.commit])
        .current_dir(&work_dir)
        .output()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("git show failed: {}", e)))?;

    if !meta_output.status.success() {
        return Err((StatusCode::NOT_FOUND, "Commit not found".to_string()));
    }

    let meta_str = String::from_utf8_lossy(&meta_output.stdout);
    let fields: Vec<&str> = meta_str.split(sep).collect();
    let meta = if fields.len() >= 5 {
        serde_json::json!({
            "hash": fields[0].trim(),
            "short_hash": fields[1].trim(),
            "author": fields[2].trim(),
            "date": fields[3].trim(),
            "subject": fields[4].trim(),
            "body": fields.get(5).unwrap_or(&"").trim(),
        })
    } else {
        serde_json::json!({})
    };

    // Diff content
    let diff_output = std::process::Command::new("git")
        .args(["show", "--format=", "--patch", &query.commit])
        .current_dir(&work_dir)
        .output()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("git show failed: {}", e)))?;

    let diff = String::from_utf8_lossy(&diff_output.stdout).to_string();

    // Changed files with line counts
    let files: Vec<serde_json::Value> = std::process::Command::new("git")
        .args(["show", "--format=", "--numstat", &query.commit])
        .current_dir(&work_dir)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .filter(|l| !l.trim().is_empty())
                .filter_map(|line| {
                    let parts: Vec<&str> = line.split('\t').collect();
                    if parts.len() >= 3 {
                        Some(serde_json::json!({
                            "additions": parts[0].parse::<i32>().unwrap_or(-1),
                            "deletions": parts[1].parse::<i32>().unwrap_or(-1),
                            "path": parts[2],
                        }))
                    } else {
                        None
                    }
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(Json(serde_json::json!({
        "commit": meta,
        "diff": diff,
        "files": files,
    })))
}

#[derive(serde::Serialize)]
struct WorktreeFile {
    path: String,
    status: String, // two-char porcelain code (index col + worktree col)
    staged: bool,
    old_path: Option<String>,
}

/// Parse `git status --porcelain=v1 -z` output into structured entries.
/// Records are NUL-terminated; rename/copy (R/C) records consume a second
/// NUL segment holding the old path (new path comes first under -z).
fn parse_porcelain_z(raw: &str) -> Vec<WorktreeFile> {
    let mut segs = raw.split('\0').filter(|s| !s.is_empty());
    let mut out = Vec::new();
    while let Some(seg) = segs.next() {
        if seg.len() < 4 {
            continue; // need "XY " + at least 1 path char
        }
        let code = &seg[0..2];
        let path = seg[3..].to_string();
        let x = code.as_bytes()[0] as char;
        let staged = x != ' ' && x != '?';
        let old_path = if x == 'R' || x == 'C' {
            segs.next().map(|s| s.to_string())
        } else {
            None
        };
        out.push(WorktreeFile { path, status: code.to_string(), staged, old_path });
    }
    out
}

/// Truncate a diff string to a byte budget, returning (text, was_truncated).
/// Truncates on a char boundary at or below the limit.
fn truncate_diff(diff: &str, limit: usize) -> (String, bool) {
    if diff.len() <= limit {
        return (diff.to_string(), false);
    }
    let mut end = limit;
    while end > 0 && !diff.is_char_boundary(end) {
        end -= 1;
    }
    (diff[..end].to_string(), true)
}

/// Single source of truth for "must not surface in the worktree view": a path is
/// excluded if ANY component is a SENSITIVE_DIR_NAMES dir (.ssh/.aws/.git/...) OR the
/// leaf is a credential file per `is_credential_path` (.env/*.pem/id_*/*credentials/...).
/// The file-browser read path already blocks the latter (`get_file_raw`/`list_dir`);
/// deriving both the worktree file list AND the diff exclusion from this one predicate
/// keeps them from drifting — the drift that leaked tracked .env/*.pem diffs before.
fn worktree_path_excluded(path: &str) -> bool {
    let p = std::path::Path::new(path);
    let dir_hit = p.components().any(|c| matches!(c, std::path::Component::Normal(n)
        if n.to_str().is_some_and(|s| SENSITIVE_DIR_NAMES.contains(&s))));
    let leaf_hit = p
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(is_credential_path);
    dir_hit || leaf_hit
}

/// Drop files whose path is excluded (sensitive dir component or credential leaf),
/// so a worktree diff can never surface .ssh/.aws/.env/*.pem contents.
fn filter_sensitive_files(files: Vec<WorktreeFile>) -> Vec<WorktreeFile> {
    files
        .into_iter()
        .filter(|f| !worktree_path_excluded(&f.path))
        .collect()
}

/// Strip whole per-file sections from a `git diff` body whose path is excluded.
/// The git-side pathspec already drops sensitive *dirs*; this second pass closes
/// credential *leaf* files (.env/*.pem/id_*/...) that pathspec globs translate
/// imperfectly, using the SAME predicate as the file list so the two can't drift.
/// A section starts at a `diff --git a/<p> b/<p>` line and runs until the next one.
fn filter_diff_excluded(diff: &str) -> String {
    let mut out = String::with_capacity(diff.len());
    let mut skipping = false;
    for line in diff.split_inclusive('\n') {
        if let Some(rest) = line.strip_prefix("diff --git ") {
            // `a/<path> b/<path>` — take the b/ side (new path); fall back to a/.
            let path = rest
                .rsplit_once(" b/")
                .map(|(_, b)| b.trim_end_matches(['\n', '\r']))
                .or_else(|| rest.strip_prefix("a/").map(|s| s.split(' ').next().unwrap_or(s)))
                .unwrap_or("");
            skipping = worktree_path_excluded(path);
        }
        if !skipping {
            out.push_str(line);
        }
    }
    out
}

async fn git_worktree(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    require_session_access(&state, &user, &id)?;
    let stored_dir = state
        .sessions
        .work_dir(&id)
        .ok_or((StatusCode::NOT_FOUND, "session not found".into()))?;
    // live cwd for PTY sessions; agent sessions have no pty_pid → stored (correct).
    let live_dir = state.sessions.pty_pid(&id).and_then(|pid| {
        std::fs::read_link(format!("/proc/{}/cwd", pid))
            .ok()
            .map(|p| p.to_string_lossy().to_string())
    });
    let work_dir = live_dir.unwrap_or(stored_dir);

    // Safety: refuse if work_dir is $HOME itself or sits in a sensitive dir —
    // `git diff` would otherwise leak .aws/.ssh/.env contents wholesale. Fail CLOSED:
    // if the path can't be canonicalized (missing/escaping symlink), refuse rather
    // than fall through to running git in an unverified dir.
    let home = std::env::var("HOME").unwrap_or_default();
    let home_path = std::path::Path::new(&home);
    let safe_empty = Json(serde_json::json!({
        "is_git": false, "files": [], "diff": "", "truncated": false
    }));
    match std::fs::canonicalize(&work_dir) {
        Ok(canon) if canon == home_path || base_dir_at_or_in_sensitive(home_path, &canon) => {
            return Ok(safe_empty);
        }
        Ok(_) => {}
        Err(_) => return Ok(safe_empty),
    }
    let dir = std::path::Path::new(&work_dir);

    // porcelain status (-z); non-git repo → is_git:false
    let status = std::process::Command::new("git")
        .args(["status", "--porcelain=v1", "-z"])
        .current_dir(dir)
        .output();
    let status = match status {
        Ok(o) if o.status.success() => o,
        _ => {
            return Ok(Json(serde_json::json!({
                "is_git": false, "files": [], "diff": "", "truncated": false
            })));
        }
    };
    let raw = String::from_utf8_lossy(&status.stdout);
    let files = filter_sensitive_files(parse_porcelain_z(&raw));

    // diff HEAD, but only if HEAD exists (fresh repo with no commits → empty).
    let has_head = std::process::Command::new("git")
        .args(["rev-parse", "--verify", "-q", "HEAD"])
        .current_dir(dir)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    let diff_raw = if has_head {
        // Exclude every sensitive-named dir from the diff body via git pathspec
        // magic, so a tracked-and-modified file under .ssh/.aws/.git/etc. can
        // never leak its hunk (the file LIST is already filtered, but the diff
        // text is whole-repo otherwise). Two pathspecs per name cover the dir at
        // repo root and at any depth.
        let mut diff_args: Vec<String> =
            vec!["diff".into(), "HEAD".into(), "--".into(), ".".into()];
        for name in SENSITIVE_DIR_NAMES {
            diff_args.push(format!(":(exclude,glob){}/**", name));
            diff_args.push(format!(":(exclude,glob)**/{}/**", name));
            diff_args.push(format!(":(exclude,glob){name}")); // file/dir named <name> at root
            diff_args.push(format!(":(exclude,glob)**/{name}")); // ...at any depth
        }
        let raw = std::process::Command::new("git")
            .args(&diff_args)
            .current_dir(dir)
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
            .unwrap_or_default();
        // Second pass: drop credential-leaf file sections (.env/*.pem/id_*/...) that
        // the dir-only pathspec can't express, via the shared file-list predicate.
        filter_diff_excluded(&raw)
    } else {
        String::new()
    };
    let (diff, truncated) = truncate_diff(&diff_raw, 512 * 1024);

    Ok(Json(serde_json::json!({
        "is_git": true, "files": files, "diff": diff, "truncated": truncated
    })))
}

// ── Agent Events ──

/// POST /api/events — create event (token auth via query param, for hooks)
async fn create_event(
    State(state): State<Arc<AppState>>,
    Query(query): Query<crate::auth::TokenQuery>,
    Json(req): Json<crate::events::CreateEventReq>,
) -> Result<(StatusCode, Json<serde_json::Value>), (StatusCode, String)> {
    // Authenticate via token query param (same scheme as WebSocket upgrades).
    // The resolved user owns the event — owner_id is stamped from the token,
    // never trusted from the request body.
    let user = query
        .token
        .as_ref()
        .and_then(|t| crate::auth::verify_ws_token(&state, t))
        .ok_or((StatusCode::UNAUTHORIZED, "Unauthorized".to_string()))?;

    let event = state
        .events
        .create(req, &user.id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok((
        StatusCode::CREATED,
        Json(serde_json::json!({
            "id": event.id,
            "timestamp": event.timestamp,
        })),
    ))
}

/// GET /api/events — list events (requires auth middleware). Non-admins see
/// only their own events; admins see all.
async fn list_events(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
    Query(query): Query<crate::events::EventsQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let owner_filter = if user.is_admin() { None } else { Some(user.id.as_str()) };
    let events = state
        .events
        .list(&query, owner_filter)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(Json(serde_json::json!({
        "total": events.len(),
        "events": events,
    })))
}

/// DELETE /api/events/{id} — delete single event. Non-admins can only delete
/// their own events.
async fn delete_event(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<StatusCode, (StatusCode, String)> {
    let owner_filter = if user.is_admin() { None } else { Some(user.id.as_str()) };
    let deleted = state
        .events
        .delete_one(&id, owner_filter)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    if deleted {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err((StatusCode::NOT_FOUND, "Event not found".to_string()))
    }
}

// ---- Scheduled tasks (owner-scoped: each user manages only their own) ----

#[derive(serde::Deserialize)]
struct ScheduledTaskReq {
    name: String,
    schedule: crate::scheduled_tasks::ScheduleInput,
    work_dir: String,
    prompt: String,
    #[serde(default = "default_true")]
    enabled: bool,
    #[serde(default = "default_retention")]
    retention_n: i64,
    #[serde(default)]
    side_effects: bool,
    #[serde(default)]
    max_runtime_min: Option<i64>,
    #[serde(default)]
    idle_timeout_min: Option<i64>,
}
fn default_true() -> bool {
    true
}
fn default_retention() -> i64 {
    20
}

/// GET /api/scheduled-tasks — list the caller's own task configs.
async fn list_scheduled(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let tasks = state
        .scheduled_tasks
        .list_for_owner(&user.id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(serde_json::json!({ "tasks": tasks })))
}

/// POST /api/scheduled-tasks — create a task config. The schedule is converted
/// to a cron string and validated before persisting.
async fn create_scheduled(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
    Json(req): Json<ScheduledTaskReq>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let cron = crate::scheduled_tasks::schedule_to_cron(&req.schedule);
    <cron::Schedule as std::str::FromStr>::from_str(&cron)
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("invalid schedule: {e}")))?;
    validate_work_dir_under_home(&req.work_dir)?;
    let config = crate::scheduled_tasks::TaskConfig {
        id: uuid::Uuid::new_v4().to_string(),
        owner_id: user.id.clone(),
        name: req.name,
        trigger_type: "cron".into(),
        trigger_spec: cron,
        tz: "Asia/Shanghai".into(),
        agent_type: "claude".into(),
        work_dir: req.work_dir,
        prompt: req.prompt,
        enabled: req.enabled,
        retention_n: req.retention_n,
        created_ms: chrono::Utc::now().timestamp_millis(),
        side_effects: req.side_effects,
        max_runtime_min: req.max_runtime_min.map(|m| m.clamp(1, 1440)),
        idle_timeout_min: req.idle_timeout_min.map(|m| m.clamp(1, 1440)),
    };
    state
        .scheduled_tasks
        .upsert_config(&config)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(serde_json::to_value(config).unwrap()))
}

/// PUT /api/scheduled-tasks/{id} — update an existing config (owner only).
async fn update_scheduled(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(req): Json<ScheduledTaskReq>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let existing = state
        .scheduled_tasks
        .get_config(&id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .ok_or((StatusCode::NOT_FOUND, "Task not found".to_string()))?;
    if existing.owner_id != user.id {
        return Err((StatusCode::FORBIDDEN, "Forbidden".to_string()));
    }
    let cron = crate::scheduled_tasks::schedule_to_cron(&req.schedule);
    <cron::Schedule as std::str::FromStr>::from_str(&cron)
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("invalid schedule: {e}")))?;
    validate_work_dir_under_home(&req.work_dir)?;
    let config = crate::scheduled_tasks::TaskConfig {
        id: existing.id,
        owner_id: existing.owner_id,
        name: req.name,
        trigger_type: "cron".into(),
        trigger_spec: cron,
        tz: "Asia/Shanghai".into(),
        agent_type: "claude".into(),
        work_dir: req.work_dir,
        prompt: req.prompt,
        enabled: req.enabled,
        retention_n: req.retention_n,
        created_ms: existing.created_ms,
        side_effects: req.side_effects,
        max_runtime_min: req.max_runtime_min.map(|m| m.clamp(1, 1440)),
        idle_timeout_min: req.idle_timeout_min.map(|m| m.clamp(1, 1440)),
    };
    state
        .scheduled_tasks
        .upsert_config(&config)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(serde_json::to_value(config).unwrap()))
}

/// DELETE /api/scheduled-tasks/{id} — delete a config (owner only).
async fn delete_scheduled(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<StatusCode, (StatusCode, String)> {
    let existing = state
        .scheduled_tasks
        .get_config(&id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .ok_or((StatusCode::NOT_FOUND, "Task not found".to_string()))?;
    if existing.owner_id != user.id {
        return Err((StatusCode::FORBIDDEN, "Forbidden".to_string()));
    }
    state
        .scheduled_tasks
        .delete_config(&id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(StatusCode::NO_CONTENT)
}

/// POST /api/scheduled-tasks/{id}/run — run the task now (owner only). Skips if
/// the task already has an active run (overlap guard, mirroring the scheduler).
async fn run_scheduled_now(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let cfg = state
        .scheduled_tasks
        .get_config(&id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .ok_or((StatusCode::NOT_FOUND, "Task not found".to_string()))?;
    if cfg.owner_id != user.id {
        return Err((StatusCode::FORBIDDEN, "Forbidden".to_string()));
    }
    let active = state
        .scheduled_tasks
        .active_states_for_task(&id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let active_refs: Vec<&str> = active.iter().map(|s| s.as_str()).collect();
    if crate::scheduled_tasks::should_skip_overlap(&active_refs) {
        return Ok(Json(serde_json::json!({ "skipped": true, "reason": "overlap" })));
    }
    let now = chrono::Utc::now().timestamp_millis();
    let run = crate::scheduled_tasks::TaskRun {
        id: uuid::Uuid::new_v4().to_string(),
        task_id: id.clone(),
        scheduled_for_ms: now,
        state: "claimed".into(),
        session_id: None,
        verdict: None,
        failure_kind: None,
        started_ms: Some(now),
        ended_ms: None,
        input_snapshot: None,
        confirm_status: None,
        replay_of: None,
    };
    // Honor the atomic claim: if another caller (the scheduler, or a double-click)
    // already took this slot, INSERT OR IGNORE matches 0 rows. Spawning anyway
    // would create a duplicate session whose run has no DB row to update.
    let claimed = state
        .scheduled_tasks
        .claim_run(&run)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    if !claimed {
        return Ok(Json(serde_json::json!({ "skipped": true, "reason": "already_claimed" })));
    }
    let sid = match state
        .sessions
        .trigger_run(
            &run.id,
            format!("{} · 手动", cfg.name),
            &cfg.work_dir,
            &user.id,
            &id,
            cfg.prompt.clone(),
        )
        .await
    {
        Ok(sid) => sid,
        Err(e) => {
            // Mirror the scheduler path: a claimed run whose spawn fails must be
            // finalized, or the overlap guard wedges every future fire of the task.
            let now = chrono::Utc::now().timestamp_millis();
            let _ = state.scheduled_tasks.set_run_state(
                &run.id, "failed", None, None, Some("spawn_failed"), Some(now),
            );
            return Err((StatusCode::INTERNAL_SERVER_ERROR, e));
        }
    };
    Ok(Json(serde_json::json!({ "session_id": sid, "run_id": run.id })))
}

/// GET /api/scheduled-tasks/{id}/runs — recent run history (owner only).
async fn list_scheduled_runs(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let cfg = state
        .scheduled_tasks
        .get_config(&id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .ok_or((StatusCode::NOT_FOUND, "Task not found".to_string()))?;
    if cfg.owner_id != user.id {
        return Err((StatusCode::FORBIDDEN, "Forbidden".to_string()));
    }
    let runs = state
        .scheduled_tasks
        .runs_for_task(&id, 50)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(serde_json::json!({ "runs": runs })))
}

/// GET /api/scheduled-tasks/confirmations — caller's pending-confirmation runs.
/// Each run carries its task name (so the card shows WHICH task is pending) and a
/// short tail of captured output (the evidence a person uses to judge whether the
/// side effect landed — spec §4.4). verdict is ~always NULL on a timeout/orphan,
/// so the tail is the only signal the human has.
async fn list_confirmations(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let pairs = state.scheduled_tasks.confirmation_queue(&user.id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let count = pairs.len();
    let runs: Vec<serde_json::Value> = pairs.into_iter().map(|(run, task_name)| {
        let tail = crate::scheduled_tasks::run_output_tail(&run.id, 6);
        let mut v = serde_json::to_value(&run).unwrap_or_else(|_| serde_json::json!({}));
        if let Some(obj) = v.as_object_mut() {
            obj.insert("task_name".into(), serde_json::Value::String(task_name));
            obj.insert("output_tail".into(), serde_json::json!(tail));
        }
        v
    }).collect();
    Ok(Json(serde_json::json!({ "runs": runs, "count": count })))
}

/// load run's task config + enforce ownership.
async fn owned_run_cfg(state: &AppState, user_id: &str, run_id: &str)
    -> Result<crate::scheduled_tasks::TaskConfig, (StatusCode, String)> {
    let task_id = state.scheduled_tasks.task_id_of_run(run_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .ok_or((StatusCode::NOT_FOUND, "Run not found".to_string()))?;
    let cfg = state.scheduled_tasks.get_config(&task_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .ok_or((StatusCode::NOT_FOUND, "Task not found".to_string()))?;
    if cfg.owner_id != user_id { return Err((StatusCode::FORBIDDEN, "Forbidden".to_string())); }
    Ok(cfg)
}

/// POST /api/scheduled-tasks/runs/{run_id}/confirm-done
async fn confirm_run_done(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
    axum::extract::Path(run_id): axum::extract::Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    owned_run_cfg(&state, &user.id, &run_id).await?;
    let ok = state.scheduled_tasks.set_confirm_status(&run_id, "confirmed_done")
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(serde_json::json!({ "ok": ok })))
}

#[derive(serde::Deserialize)]
struct ReplayQuery { #[serde(default)] from_queue: bool }

/// POST /api/scheduled-tasks/runs/{run_id}/replay?from_queue=<bool>
async fn replay_run_handler(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
    axum::extract::Path(run_id): axum::extract::Path<String>,
    axum::extract::Query(q): axum::extract::Query<ReplayQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let cfg = owned_run_cfg(&state, &user.id, &run_id).await?;
    if !q.from_queue {
        // plain run-history replay: refuse an unconfirmed side-effecting unknown run.
        if state.scheduled_tasks.is_unconfirmed_side_effect_unknown(&run_id)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))? {
            return Err((StatusCode::CONFLICT, "must confirm via queue before replay".to_string()));
        }
    }
    // overlap guard — skip if the task already has an active run.
    let active = state.scheduled_tasks.active_states_for_task(&cfg.id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let refs: Vec<&str> = active.iter().map(|s| s.as_str()).collect();
    if crate::scheduled_tasks::should_skip_overlap(&refs) {
        return Ok(Json(serde_json::json!({ "skipped": true, "reason": "overlap" })));
    }
    // Claim + spawn FIRST; consume the confirmation only once the replay is
    // actually live. If the snapshot is missing (claim_replay errors) or the
    // spawn fails, the queue item stays put — a side-effecting unknown run is
    // NEVER silently dropped from the queue without a replay (spec §4.5).
    let (new_id, snap) = state.scheduled_tasks.claim_replay(&run_id)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    // TOCTOU close: the overlap check above and claim_replay's INSERT aren't one
    // transaction (claim_replay uses a fresh uuid+now, so it never collides on
    // the UNIQUE(task_id, scheduled_for_ms) slot the scheduler relies on). Two
    // replay clicks a few ms apart could both pass the pre-check and both claim,
    // double-spawning a side-effecting task (double PR/push). After our own claim,
    // re-read active runs: if anything other than our row is active, a rival won —
    // finalize ours and skip rather than double-fire.
    {
        let active = state.scheduled_tasks.active_states_for_task(&cfg.id)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
        if active.len() > 1 {
            // Finalize the loser as 'skipped', NOT aborted+unknown — it never
            // spawned, so it produced no side effect and must NOT enter the
            // confirmation queue (whose predicate is aborted + watchdog/orphaned).
            let now = chrono::Utc::now().timestamp_millis();
            let _ = state.scheduled_tasks.set_run_state(
                &new_id, "skipped", None, None, Some("overlap"), Some(now),
            );
            return Ok(Json(serde_json::json!({ "skipped": true, "reason": "overlap" })));
        }
    }
    let name = format!("{} · replay", cfg.name);
    if let Err(e) = state.sessions.replay_run(&new_id, &cfg.id, &cfg.owner_id, name, &snap).await {
        // Finalize the claimed run, else it sits in 'claimed' forever and the
        // overlap guard wedges every future fire of the task (mirrors run_scheduled_now).
        let now = chrono::Utc::now().timestamp_millis();
        let _ = state.scheduled_tasks.set_run_state(
            &new_id, "failed", None, None, Some("spawn_failed"), Some(now),
        );
        return Err((StatusCode::INTERNAL_SERVER_ERROR, e));
    }
    // Replay is live — now consume the confirmation (queue path only). Gated by
    // the queue predicate inside set_confirm_status, so it's a safe no-op if the
    // original run wasn't actually a queue item.
    if q.from_queue {
        let _ = state.scheduled_tasks.set_confirm_status(&run_id, "replayed")
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    }
    Ok(Json(serde_json::json!({ "run_id": new_id, "replay_of": run_id })))
}

/// GET /api/scheduler/health — scheduler heartbeat freshness.
async fn scheduler_health(
    State(state): State<Arc<AppState>>,
    _user: axum::Extension<CurrentUser>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    use std::sync::atomic::Ordering;
    let hb = state.sched_heartbeat.load(Ordering::Relaxed);
    let now = chrono::Utc::now().timestamp_millis();
    let healthy = hb != 0 && now - hb < 180_000;
    Ok(Json(serde_json::json!({ "heartbeat_ms": hb, "healthy": healthy })))
}

pub(crate) struct VaultIndex {
    /// Wikilink resolution: basename (sans extension) → vault-relative path.
    /// First-seen wins on collision (Obsidian disambiguates by proximity; phase 1
    /// keeps it simple). Lossy by design — do NOT use this for search.
    pub by_basename: std::collections::HashMap<String, String>,
    /// Every .md vault-relative path, deduplicated by nothing. Search iterates this
    /// so collisions (per-folder README.md / index.md / 2026.md) stay findable —
    /// `by_basename.values()` would silently drop all but the first of each basename.
    /// Also the source for folder-qualified wikilink resolution (`[[folder/Note]]`).
    pub all_paths: Vec<String>,
    /// Lowercased basename → vault-relative path, for case-insensitive wikilink
    /// resolution (Obsidian wikilinks ignore case). First-seen wins, like `by_basename`.
    pub by_basename_lc: std::collections::HashMap<String, String>,
}

/// Resolve a wikilink target (as produced by the frontend `remarkWikilink` plugin)
/// to a vault-relative `.md` path. Handles the real-world Obsidian link forms that a
/// bare `by_basename.get(name)` misses: `[[folder/Note]]` (folder-qualified — ~18% of
/// links in a real vault), `[[Note.md]]` (explicit extension), and case differences.
///
/// Precedence: exact folder-qualified path (case-insensitive) → basename
/// (case-insensitive). The heading/alias were already stripped client-side.
pub(crate) fn resolve_wikilink(idx: &VaultIndex, name: &str) -> Option<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return None;
    }
    // Drop an explicit .md extension the author may have typed.
    let bare = trimmed
        .strip_suffix(".md")
        .or_else(|| trimmed.strip_suffix(".MD"))
        .unwrap_or(trimmed);

    if bare.contains('/') {
        // Folder-qualified: match the full relative path case-insensitively. The index
        // stores paths WITH the .md suffix, so compare against `<bare>.md`.
        let want = format!("{}.md", bare).to_ascii_lowercase();
        if let Some(p) = idx
            .all_paths
            .iter()
            .find(|p| p.to_ascii_lowercase() == want)
        {
            return Some(p.clone());
        }
        // Fall back to the last segment as a plain basename (Obsidian tolerates a stale
        // folder prefix when the note was moved).
        let leaf = bare.rsplit('/').next().unwrap_or(bare);
        return idx.by_basename_lc.get(&leaf.to_ascii_lowercase()).cloned();
    }

    idx.by_basename_lc.get(&bare.to_ascii_lowercase()).cloned()
}

/// Walk the vault recursively, building the wikilink basename index and the full
/// .md path list. On basename collision the first seen wins for `by_basename`, but
/// every path is kept in `all_paths`.
///
/// Symlinked directories are NOT followed: `entry.file_type()` reports the link
/// itself (unlike `path.is_dir()`, which follows it), so a symlink cycle inside the
/// vault can't make this walk loop forever, and a symlink to a large external tree
/// (e.g. $HOME) can't make it index far past the vault. This matters because the
/// walk runs synchronously in `main()` before the HTTP listener binds — an unbounded
/// walk would hang the entire boot, not just the vault feature.
pub(crate) fn build_vault_index(vault_dir: &std::path::Path) -> VaultIndex {
    let mut by_basename = std::collections::HashMap::new();
    let mut by_basename_lc = std::collections::HashMap::new();
    let mut all_paths = Vec::new();
    let mut stack = vec![vault_dir.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let rd = match std::fs::read_dir(&dir) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for entry in rd.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            } // skip .obsidian/.trash/.git
            // file_type() does NOT follow symlinks — a symlinked dir reports is_symlink(),
            // not is_dir(), so we never descend into it (cycle / external-tree guard).
            let ft = match entry.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            if ft.is_symlink() {
                continue;
            }
            if ft.is_dir() {
                stack.push(path);
            } else if name.to_ascii_lowercase().ends_with(".md") {
                if let Ok(rel) = path.strip_prefix(vault_dir) {
                    let rel_str = rel.to_string_lossy().to_string();
                    let base = name.trim_end_matches(".md").trim_end_matches(".MD").to_string();
                    by_basename_lc
                        .entry(base.to_ascii_lowercase())
                        .or_insert_with(|| rel_str.clone());
                    by_basename
                        .entry(base)
                        .or_insert_with(|| rel_str.clone());
                    all_paths.push(rel_str);
                }
            }
        }
    }
    VaultIndex { by_basename, all_paths, by_basename_lc }
}

/// Case-insensitive substring match over relative paths (filename + path).
/// Empty query → no results. Caps at 100.
fn vault_search_filter(paths: &[String], q: &str) -> Vec<String> {
    if q.trim().is_empty() {
        return Vec::new();
    }
    let ql = q.to_ascii_lowercase();
    paths
        .iter()
        .filter(|p| p.to_ascii_lowercase().contains(&ql))
        .take(100)
        .cloned()
        .collect()
}

/// True if any component of the vault-relative path starts with '.'. The vault is
/// strictly a `.md` reader; `.obsidian/` (plugin data, sometimes plugin API tokens in
/// `data.json`), `.trash/`, `.git/` are not notes. The startup index already skips
/// dot-prefixed names; the read endpoints (list/file/raw) must match it so a hand-crafted
/// `?path=.obsidian/...` can't read non-note files the tree never surfaces.
fn vault_path_has_dot_component(rel: &str) -> bool {
    rel.split('/').any(|seg| seg.starts_with('.') && seg != "." && seg != "..")
}

/// vault endpoints: require admin (legacy mode synthesizes admin) and a configured vault.
fn vault_base<'a>(
    state: &'a AppState,
    user: &CurrentUser,
) -> Result<&'a str, (StatusCode, String)> {
    if !user.is_admin() {
        return Err((StatusCode::FORBIDDEN, "Admin only".into()));
    }
    state
        .vault_dir
        .as_deref()
        .ok_or((StatusCode::NOT_FOUND, "Vault not configured".into()))
}

/// Vault folder basename, but only when the vault is enabled for this caller.
/// Returns "" when not enabled so non-admins can't learn the folder name.
fn vault_meta_name(enabled: bool, vault_dir: Option<&str>) -> String {
    if !enabled {
        return String::new();
    }
    vault_dir
        .and_then(|v| {
            std::path::Path::new(v)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
        })
        .unwrap_or_default()
}

async fn vault_meta(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
) -> Json<serde_json::Value> {
    let enabled = user.is_admin() && state.vault_dir.is_some();
    let name = vault_meta_name(enabled, state.vault_dir.as_deref());
    Json(serde_json::json!({ "enabled": enabled, "name": name }))
}

#[derive(serde::Deserialize)]
struct VaultListQuery {
    path: Option<String>,
}

async fn vault_list(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
    Query(q): Query<VaultListQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let base = vault_base(&state, &user)?;
    let rel = q.path.as_deref().unwrap_or("");
    if vault_path_has_dot_component(rel) {
        return Err((StatusCode::FORBIDDEN, "Access to dot-directory denied".into()));
    }
    let base_path = std::path::Path::new(base);
    let (entries, truncated) = list_dir_entries(base_path, rel)?;
    // Never enumerate dot-entries (.obsidian/.git/.trash/.zeromux). list_dir_entries is
    // shared with the session file browser and does not filter them; the vault index
    // itself skips dot-names, so the reader API must match — the API is the trust
    // boundary, not the frontend's filterVaultEntries.
    let arr: Vec<_> = entries
        .iter()
        .filter(|e| !e.name.starts_with('.'))
        .map(|e| {
            serde_json::json!({
                "name": e.name, "type": e.kind, "size": e.size, "mtime": e.mtime, "writable": e.writable,
            })
        })
        .collect();
    Ok(Json(serde_json::json!({ "entries": arr, "truncated": truncated })))
}

#[derive(serde::Deserialize)]
struct VaultFileQuery {
    path: String,
}

async fn vault_file(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
    Query(q): Query<VaultFileQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let base = vault_base(&state, &user)?;
    if vault_path_has_dot_component(&q.path) {
        return Err((StatusCode::FORBIDDEN, "Access to dot-directory denied".into()));
    }
    let base_path = std::path::Path::new(base);
    let real = resolve_and_verify(base_path, &q.path)?;
    if descends_into_sensitive_dir(base_path, &real) {
        return Err((StatusCode::FORBIDDEN, "Access to sensitive directory denied".into()));
    }
    if let Some(n) = real.file_name().and_then(|s| s.to_str()) {
        if is_credential_path(n) {
            return Err((StatusCode::FORBIDDEN, "Credential file access denied".into()));
        }
    }
    let (content, truncated) = read_text_file_capped(&real)?;
    Ok(Json(serde_json::json!({ "path": q.path, "content": content, "truncated": truncated })))
}

/// Whitelist of inline-renderable image types for the vault raw endpoint.
/// SVG is deliberately excluded (executable XSS vector) → falls back to download.
fn vault_image_mime(name: &str) -> Option<&'static str> {
    let n = name.to_ascii_lowercase();
    if n.ends_with(".png") {
        Some("image/png")
    } else if n.ends_with(".jpg") || n.ends_with(".jpeg") {
        Some("image/jpeg")
    } else if n.ends_with(".gif") {
        Some("image/gif")
    } else if n.ends_with(".webp") {
        Some("image/webp")
    } else {
        None
    }
}

async fn vault_file_raw(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
    Query(q): Query<VaultFileQuery>,
) -> Result<Response, (StatusCode, String)> {
    let base = vault_base(&state, &user)?;
    if vault_path_has_dot_component(&q.path) {
        return Err((StatusCode::FORBIDDEN, "Forbidden".into()));
    }
    let base_path = std::path::Path::new(base);
    let real = resolve_and_verify(base_path, &q.path)?;
    if descends_into_sensitive_dir(base_path, &real) {
        return Err((StatusCode::FORBIDDEN, "Forbidden".into()));
    }
    let fname = real.file_name().and_then(|s| s.to_str()).unwrap_or("download");
    if is_credential_path(fname) {
        return Err((StatusCode::FORBIDDEN, "Forbidden".into()));
    }
    let bytes = std::fs::read(&real)
        .map_err(|e| (StatusCode::NOT_FOUND, format!("Not found: {e}")))?;
    let resp = match vault_image_mime(fname) {
        Some(mime) => Response::builder()
            .header("Content-Type", mime)
            .header("X-Content-Type-Options", "nosniff")
            .header("Content-Disposition", "inline")
            .body(axum::body::Body::from(bytes))
            .unwrap(),
        None => {
            // non-image (incl. svg): force download, never inline-render
            let safe = sanitize_filename(fname);
            Response::builder()
                .header("Content-Type", "application/octet-stream")
                .header("X-Content-Type-Options", "nosniff")
                .header("Content-Disposition", format!("attachment; filename=\"{}\"", safe))
                .body(axum::body::Body::from(bytes))
                .unwrap()
        }
    };
    Ok(resp)
}

#[derive(serde::Deserialize)]
struct VaultSearchQuery {
    q: String,
}

async fn vault_search(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
    Query(query): Query<VaultSearchQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let _base = vault_base(&state, &user)?;
    // Search the FULL path list, not by_basename.values() — the latter is deduped
    // by basename (first-wins), so per-folder README.md / index.md / 2026.md would be
    // unsearchable past the first one.
    let paths: Vec<String> = state
        .vault_index
        .as_ref()
        .map(|idx| idx.all_paths.clone())
        .unwrap_or_default();
    let results: Vec<serde_json::Value> = vault_search_filter(&paths, &query.q)
        .into_iter()
        .map(|p| {
            let name = std::path::Path::new(&p)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            serde_json::json!({ "path": p, "name": name })
        })
        .collect();
    Ok(Json(serde_json::json!({ "results": results })))
}

#[derive(serde::Deserialize)]
struct VaultResolveQuery {
    name: String,
}

async fn vault_resolve(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
    Query(q): Query<VaultResolveQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let _base = vault_base(&state, &user)?;
    let path = state
        .vault_index
        .as_ref()
        .and_then(|idx| resolve_wikilink(idx, &q.name))
        .ok_or((StatusCode::NOT_FOUND, "Wikilink target not found".into()))?;
    Ok(Json(serde_json::json!({ "path": path })))
}

#[cfg(test)]
mod path_safety_tests {
    use super::*;
    use std::os::unix::fs::symlink;

    #[test]
    fn vault_meta_name_hidden_when_not_enabled() {
        assert_eq!(vault_meta_name(true, Some("/home/u/obsidian")), "obsidian");
        assert_eq!(vault_meta_name(false, Some("/home/u/obsidian")), "");
        assert_eq!(vault_meta_name(true, None), "");
    }

    #[test]
    fn vault_image_mime_whitelist() {
        assert_eq!(vault_image_mime("a.png"), Some("image/png"));
        assert_eq!(vault_image_mime("A.JPG"), Some("image/jpeg"));
        assert_eq!(vault_image_mime("b.jpeg"), Some("image/jpeg"));
        assert_eq!(vault_image_mime("c.gif"), Some("image/gif"));
        assert_eq!(vault_image_mime("d.webp"), Some("image/webp"));
        assert_eq!(vault_image_mime("e.svg"), None); // SVG not inlined (XSS)
        assert_eq!(vault_image_mime("f.md"), None);
    }

    #[test]
    fn vault_path_dot_component_guard() {
        assert!(vault_path_has_dot_component(".obsidian"));
        assert!(vault_path_has_dot_component(".obsidian/plugins/x/data.json"));
        assert!(vault_path_has_dot_component("knowledge/.trash/old.md"));
        assert!(vault_path_has_dot_component(".git/config"));
        assert!(!vault_path_has_dot_component(""));
        assert!(!vault_path_has_dot_component("knowledge/aws/note.md"));
        assert!(!vault_path_has_dot_component("a/b.c.md")); // dot in filename, not a dot-dir
    }

    #[test]
    fn build_vault_index_maps_basename_to_relpath() {
        let dir = std::env::temp_dir().join(format!("zmx_vidx_{}", std::process::id()));
        std::fs::create_dir_all(dir.join("knowledge/aws")).unwrap();
        std::fs::write(dir.join("knowledge/aws/EKS 网络模型.md"), b"x").unwrap();
        std::fs::write(dir.join("待处理区.md"), b"y").unwrap();
        let idx = build_vault_index(&dir);
        assert_eq!(idx.by_basename.get("EKS 网络模型").map(|s| s.as_str()),
                   Some("knowledge/aws/EKS 网络模型.md"));
        assert_eq!(idx.by_basename.get("待处理区").map(|s| s.as_str()), Some("待处理区.md"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn build_vault_index_keeps_basename_collisions_in_all_paths() {
        // Two notes share basename "README" in different folders. by_basename is
        // first-wins (lossy), but all_paths must keep BOTH so search finds both.
        let dir = std::env::temp_dir().join(format!("zmx_vidx_col_{}", std::process::id()));
        std::fs::create_dir_all(dir.join("a")).unwrap();
        std::fs::create_dir_all(dir.join("b")).unwrap();
        std::fs::write(dir.join("a/README.md"), b"x").unwrap();
        std::fs::write(dir.join("b/README.md"), b"y").unwrap();
        let idx = build_vault_index(&dir);
        assert_eq!(idx.by_basename.len(), 1, "by_basename dedupes by basename");
        let mut readmes: Vec<&String> =
            idx.all_paths.iter().filter(|p| p.ends_with("README.md")).collect();
        readmes.sort();
        assert_eq!(readmes, vec![&"a/README.md".to_string(), &"b/README.md".to_string()],
                   "all_paths keeps both colliding notes");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn build_vault_index_does_not_follow_symlinked_dirs() {
        use std::os::unix::fs::symlink;
        // A symlink cycle inside the vault must not make the walk loop forever.
        let dir = std::env::temp_dir().join(format!("zmx_vidx_sym_{}", std::process::id()));
        std::fs::create_dir_all(dir.join("real")).unwrap();
        std::fs::write(dir.join("real/note.md"), b"x").unwrap();
        // self-referential cycle: dir/loop -> dir
        let _ = symlink(&dir, dir.join("loop"));
        let idx = build_vault_index(&dir); // must terminate
        assert_eq!(idx.by_basename.get("note").map(|s| s.as_str()), Some("real/note.md"));
        // The symlinked dir was not descended, so no duplicate "loop/real/note.md".
        assert!(idx.all_paths.iter().all(|p| !p.starts_with("loop/")),
                "symlinked dir must not be walked: {:?}", idx.all_paths);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_text_file_capped_truncates_over_1mb() {
        use std::io::Write;
        let dir = std::env::temp_dir().join(format!("zmx_cap_test_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let big = dir.join("big.md");
        let mut f = std::fs::File::create(&big).unwrap();
        f.write_all(&vec![b'x'; 1_048_576 + 100]).unwrap();
        let (content, truncated) = read_text_file_capped(&big).unwrap();
        assert!(truncated);
        assert_eq!(content.len(), 1_048_576);
        let small = dir.join("small.md");
        std::fs::write(&small, b"hello").unwrap();
        let (c2, t2) = read_text_file_capped(&small).unwrap();
        assert!(!t2);
        assert_eq!(c2, "hello");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn validate_browse_root_accepts_normal_rejects_sensitive() {
        let home = std::env::var("HOME").unwrap();
        // a normal existing dir under home: home itself's parent won't do; use home/.. is outside.
        // Use HOME itself (a dir under home boundary check: home starts_with home = ok, is_dir ok,
        // but base_dir_at_or_in_sensitive(home, home) → rel empty → false → accepted).
        assert!(validate_browse_root(&home).is_ok());
        let ssh = format!("{}/.ssh", home);
        std::fs::create_dir_all(&ssh).ok();
        assert!(validate_browse_root(&ssh).is_err()); // sensitive
    }

    #[test]
    fn resolve_and_verify_rejects_symlink_escape() {
        let tmp = std::env::temp_dir().join(format!("zmfb-{}", std::process::id()));
        let base = tmp.join("work");
        std::fs::create_dir_all(&base).unwrap();
        let outside = tmp.join("secret.txt");
        std::fs::write(&outside, "topsecret").unwrap();
        // base/leak -> ../secret.txt (escapes base)
        let _ = symlink(&outside, base.join("leak"));
        let base_c = base.canonicalize().unwrap();
        // 跟随 symlink 后 canonical 落在 base 外 → 必须拒
        assert!(resolve_and_verify(&base_c, "leak").is_err());
        // 正常文件放行
        std::fs::write(base.join("ok.txt"), "hi").unwrap();
        assert!(resolve_and_verify(&base_c, "ok.txt").is_ok());
    }

    #[test]
    fn write_target_rejects_symlinked_parent_escape() {
        // The create/rename DESTINATION must get the same physical-layer symlink
        // defense reads get. Pre-fix it was resolved lexically (resolve_session_path),
        // so a symlinked path component redirected the write outside base — into a
        // control dir or another tree — undetected by the literal-component guards.
        let tmp = std::env::temp_dir().join(format!("zmwt-{}", std::process::id()));
        let base = tmp.join("work");
        std::fs::create_dir_all(&base).unwrap();
        let outside = tmp.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        // base/link -> ../outside : a dir symlink whose real target escapes base.
        let _ = symlink(&outside, base.join("link"));
        let base_c = base.canonicalize().unwrap();

        // Writing/creating through the symlinked parent must be refused: the real
        // parent canonicalizes outside base.
        assert!(resolve_write_target(&base_c, "link/evil").is_err());

        // A normal nested target whose parent exists is allowed.
        std::fs::create_dir_all(base.join("sub")).unwrap();
        assert!(resolve_write_target(&base_c, "sub/newfile.txt").is_ok());

        // A leaf named like a control dir is refused even under a normal parent
        // (e.g. rename a dir TO ".git", or mkdir ".aws").
        assert!(resolve_write_target(&base_c, "sub/.git").is_err());
        assert!(resolve_write_target(&base_c, ".aws").is_err());
    }

    #[test]
    fn build_raw_headers_are_safe() {
        let h = build_raw_headers("evil.html");
        assert_eq!(h.0, "application/octet-stream");
        assert_eq!(h.1, "nosniff");
        assert!(h.2.contains("attachment"));
    }

    #[test]
    fn credential_names_flagged() {
        assert!(is_credential_path(".env"));
        assert!(is_credential_path("id_rsa"));
        assert!(is_credential_path("server.pem"));
        assert!(is_credential_path(".aws"));
        assert!(!is_credential_path("README.md"));
    }

    #[test]
    fn sensitive_dir_descent_blocked() {
        let base = std::path::Path::new("/home/u/work");
        // Descending into a sensitive dir is blocked even if the leaf looks innocuous.
        assert!(descends_into_sensitive_dir(base, std::path::Path::new("/home/u/work/.ssh/config")));
        assert!(descends_into_sensitive_dir(base, std::path::Path::new("/home/u/work/.aws/credentials")));
        assert!(descends_into_sensitive_dir(base, std::path::Path::new("/home/u/work/.git/config")));
        assert!(descends_into_sensitive_dir(base, std::path::Path::new("/home/u/work/sub/.gnupg/x")));
        // App state / control dirs must be READ-blocked too, not only write-blocked:
        // ~/.zeromux holds zeromux.db (OAuth user table), notes/prompts DBs, and
        // runs/*/events.ndjson (agent transcripts); .zeromux-worktrees holds other
        // sessions' isolated checkouts. Pre-fix these were write-blocked but readable
        // via get_file_raw/list_dir with base_dir=$HOME — a cross-user exfiltration.
        assert!(descends_into_sensitive_dir(base, std::path::Path::new("/home/u/work/.zeromux/zeromux.db")));
        assert!(descends_into_sensitive_dir(base, std::path::Path::new("/home/u/work/.zeromux/runs/r1/events.ndjson")));
        assert!(descends_into_sensitive_dir(base, std::path::Path::new("/home/u/work/.zeromux-worktrees/other/secret.md")));
        // Normal paths pass.
        assert!(!descends_into_sensitive_dir(base, std::path::Path::new("/home/u/work/src/main.rs")));
        assert!(!descends_into_sensitive_dir(base, std::path::Path::new("/home/u/work/README.md")));
        // Anything outside base is refused defensively.
        assert!(descends_into_sensitive_dir(base, std::path::Path::new("/etc/passwd")));
    }

    #[test]
    fn read_and_write_denylists_are_identical() {
        // Root cause of the recurring sensitive-dir P1s: the read guard
        // (descends_into_sensitive_dir) and the write guard (is_write_blocked) were
        // hand-maintained denylists that drifted (.zeromux was added to writes only).
        // Both now delegate to one shared list, so for every candidate the two guards
        // must agree. This test fails the instant they diverge again.
        let base = std::path::Path::new("/home/u/work");
        for sub in [
            ".git", ".zeromux", ".zeromux-worktrees", ".ssh", ".aws", ".gnupg",
            "src", "README.md", "notes",
        ] {
            let p = base.join(sub).join("leaf");
            assert_eq!(
                descends_into_sensitive_dir(base, &p),
                is_write_blocked(base, &p),
                "read/write guards disagree on {sub}",
            );
        }
    }

    #[test]
    fn write_blocked_for_control_dirs() {
        let base = std::path::Path::new("/home/u/work");
        // A control dir *below* base is blocked.
        assert!(is_write_blocked(base, std::path::Path::new("/home/u/work/.git/config")));
        // The bare control-dir leaf itself is blocked too — this is the delete/rename
        // vector: delete_session_dir(".git") resolves to the dir node, not a child of
        // it, so the guard must fire on the directory itself, not only on descents.
        assert!(is_write_blocked(base, std::path::Path::new("/home/u/work/.git")));
        assert!(is_write_blocked(base, std::path::Path::new("/home/u/work/.zeromux")));
        assert!(is_write_blocked(base, std::path::Path::new("/home/u/work/.zeromux-worktrees")));
        // Credential dirs that are READ-blocked must also be WRITE-blocked, else a
        // session rooted at $HOME could delete_session_dir(".aws"/".gnupg") and wipe
        // AWS creds / GPG keys — read-blocked but, pre-fix, deletable/renamable.
        assert!(is_write_blocked(base, std::path::Path::new("/home/u/work/.aws")));
        assert!(is_write_blocked(base, std::path::Path::new("/home/u/work/.aws/credentials")));
        assert!(is_write_blocked(base, std::path::Path::new("/home/u/work/.gnupg")));
        // A normal file below base is allowed.
        assert!(!is_write_blocked(base, std::path::Path::new("/home/u/work/src/main.rs")));
    }

    #[test]
    fn write_not_blocked_for_agent_worktree_base() {
        // Regression: agent sessions run with base = <repo>/.zeromux-worktrees/<id>/.
        // The base prefix contains ".zeromux-worktrees", which previously tripped the
        // full-path check and 403'd EVERY write in an agent workspace.
        let base = std::path::Path::new("/home/u/repo/.zeromux-worktrees/abc123");
        // Normal file directly under the worktree base → writable.
        assert!(!is_write_blocked(base, std::path::Path::new("/home/u/repo/.zeromux-worktrees/abc123/notes.md")));
        // Subdir under the worktree base → writable.
        assert!(!is_write_blocked(base, std::path::Path::new("/home/u/repo/.zeromux-worktrees/abc123/docs/a.md")));
        // But a real .git INSIDE the worktree is still blocked.
        assert!(is_write_blocked(base, std::path::Path::new("/home/u/repo/.zeromux-worktrees/abc123/.git/config")));
        // A path outside base is refused defensively.
        assert!(is_write_blocked(base, std::path::Path::new("/home/u/other/x.md")));
    }

    #[test]
    fn list_dir_filters_credentials_and_marks_types() {
        let tmp = std::env::temp_dir().join(format!("zmld-{}", std::process::id()));
        std::fs::create_dir_all(tmp.join("sub")).unwrap();
        std::fs::write(tmp.join("a.txt"), "x").unwrap();
        std::fs::write(tmp.join(".env"), "SECRET=1").unwrap();
        let base = tmp.canonicalize().unwrap();
        let (entries, _trunc) = list_dir_entries(&base, "").unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"a.txt"));
        assert!(names.contains(&"sub"));
        assert!(!names.contains(&".env")); // credential 不枚举
        let sub = entries.iter().find(|e| e.name == "sub").unwrap();
        assert_eq!(sub.kind, "dir");
    }

    #[test]
    fn list_dir_entries_lists_an_arbitrary_root_subtree() {
        // Re-rooting: listing a directory other than work_dir returns its own
        // children. This is what base_dir threading enables in list_dir.
        let tmp = std::env::temp_dir().join(format!("zmld-root-{}", std::process::id()));
        let other = tmp.join("other-project");
        std::fs::create_dir_all(other.join("nested")).unwrap();
        std::fs::write(other.join("readme.md"), "hi").unwrap();
        let base = other.canonicalize().unwrap();
        let (entries, _trunc) = list_dir_entries(&base, "").unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"readme.md"));
        assert!(names.contains(&"nested"));
    }

    #[test]
    fn ensure_under_home_rejects_outside_accepts_inside() {
        // The $HOME boundary is the only thing standing between a base_dir
        // override and arbitrary filesystem reads. Pin it: a path that
        // canonicalizes outside $HOME is rejected with 403; one inside is ok.
        // resolve_base_dir delegates to ensure_under_home for exactly this.
        let _guard = crate::session_manager::HOME_ENV_LOCK.lock().unwrap();
        let prev = std::env::var("HOME").ok();
        let home = std::env::temp_dir()
            .join(format!("zmfb-home-{}", std::process::id()))
            .canonicalize()
            .unwrap_or_else(|_| {
                let p = std::env::temp_dir().join(format!("zmfb-home-{}", std::process::id()));
                std::fs::create_dir_all(&p).unwrap();
                p.canonicalize().unwrap()
            });
        let inside = home.join("inside-dir");
        std::fs::create_dir_all(&inside).unwrap();
        std::env::set_var("HOME", &home);

        let inside_canon = inside.canonicalize().unwrap();
        let inside_res = ensure_under_home(inside_canon.to_str().unwrap());
        // / is guaranteed to exist and to be outside our fake temp HOME.
        let outside_res = ensure_under_home("/");

        match prev {
            Some(h) => std::env::set_var("HOME", h),
            None => std::env::remove_var("HOME"),
        }

        assert!(inside_res.is_ok(), "path inside $HOME must be accepted");
        assert!(
            matches!(outside_res, Err((StatusCode::FORBIDDEN, _))),
            "path outside $HOME must be 403, got {outside_res:?}"
        );
    }

    #[test]
    fn ensure_under_home_rejects_base_at_or_in_sensitive_dir() {
        // Regression: the re-rootable browser lets base_dir be ANY dir under
        // $HOME — including a sensitive one. descends_into_sensitive_dir only
        // inspects components *below* base, so a base that IS .ssh/.aws/.git
        // passed every per-request guard and exposed .ssh/config, known_hosts,
        // .aws/config, .git/config — files whose leaf names aren't credential-
        // shaped. The boundary must reject the base itself, anchored at $HOME.
        let _guard = crate::session_manager::HOME_ENV_LOCK.lock().unwrap();
        let prev = std::env::var("HOME").ok();
        let home = std::env::temp_dir()
            .join(format!("zmfb-sens-{}", std::process::id()))
            .canonicalize()
            .unwrap_or_else(|_| {
                let p = std::env::temp_dir().join(format!("zmfb-sens-{}", std::process::id()));
                std::fs::create_dir_all(&p).unwrap();
                p.canonicalize().unwrap()
            });
        let ssh = home.join(".ssh");
        let git_cfg_dir = home.join("proj").join(".git");
        let zeromux = home.join(".zeromux");
        std::fs::create_dir_all(&ssh).unwrap();
        std::fs::create_dir_all(&git_cfg_dir).unwrap();
        std::fs::create_dir_all(&zeromux).unwrap();
        let ok_dir = home.join("proj").join("src");
        std::fs::create_dir_all(&ok_dir).unwrap();
        std::env::set_var("HOME", &home);

        let ssh_res = ensure_under_home(ssh.canonicalize().unwrap().to_str().unwrap());
        let git_res = ensure_under_home(git_cfg_dir.canonicalize().unwrap().to_str().unwrap());
        // base_dir=~/.zeromux would otherwise expose the OAuth DB / transcripts: the
        // .zeromux component becomes the (stripped) base prefix, invisible to the
        // descent guard, so the base-acceptance guard must reject it here.
        let zeromux_res = ensure_under_home(zeromux.canonicalize().unwrap().to_str().unwrap());
        let ok_res = ensure_under_home(ok_dir.canonicalize().unwrap().to_str().unwrap());

        match prev {
            Some(h) => std::env::set_var("HOME", h),
            None => std::env::remove_var("HOME"),
        }

        assert!(
            matches!(ssh_res, Err((StatusCode::FORBIDDEN, _))),
            "base_dir == ~/.ssh must be 403, got {ssh_res:?}"
        );
        assert!(
            matches!(git_res, Err((StatusCode::FORBIDDEN, _))),
            "base_dir descending into .git must be 403, got {git_res:?}"
        );
        assert!(
            matches!(zeromux_res, Err((StatusCode::FORBIDDEN, _))),
            "base_dir == ~/.zeromux must be 403, got {zeromux_res:?}"
        );
        assert!(ok_res.is_ok(), "a normal project dir under $HOME must be accepted");
    }

    #[test]
    fn ensure_under_home_accepts_worktree_isolated_base() {
        // Regression guard for the fix that added .zeromux-worktrees to the descent
        // denylist: a worktree-isolated agent session's server-set work_dir IS
        // <repo>/.zeromux-worktrees/<id>. The base-acceptance guard must NOT reject
        // it (that would 403 every file op for worktree sessions), even though the
        // descent guard blocks .zeromux-worktrees components below an arbitrary base.
        let _guard = crate::session_manager::HOME_ENV_LOCK.lock().unwrap();
        let prev = std::env::var("HOME").ok();
        let home = std::env::temp_dir()
            .join(format!("zmfb-wt-{}", std::process::id()))
            .canonicalize()
            .unwrap_or_else(|_| {
                let p = std::env::temp_dir().join(format!("zmfb-wt-{}", std::process::id()));
                std::fs::create_dir_all(&p).unwrap();
                p.canonicalize().unwrap()
            });
        let wt = home.join("repo").join(".zeromux-worktrees").join("abc123");
        std::fs::create_dir_all(&wt).unwrap();
        std::env::set_var("HOME", &home);

        let wt_res = ensure_under_home(wt.canonicalize().unwrap().to_str().unwrap());

        match prev {
            Some(h) => std::env::set_var("HOME", h),
            None => std::env::remove_var("HOME"),
        }

        assert!(
            wt_res.is_ok(),
            "a worktree-isolated session base must be accepted, got {wt_res:?}"
        );
    }

    #[test]
    fn ensure_under_home_rejects_non_directory_base() {
        // base_dir must be a directory. A base pointing at a file (e.g.
        // ~/.ssh/config) with an empty rel path would otherwise resolve the
        // file itself as the read target, sidestepping the rel-path + leaf
        // guards. Reject non-dirs at the boundary.
        let _guard = crate::session_manager::HOME_ENV_LOCK.lock().unwrap();
        let prev = std::env::var("HOME").ok();
        let home = std::env::temp_dir()
            .join(format!("zmfb-file-{}", std::process::id()))
            .canonicalize()
            .unwrap_or_else(|_| {
                let p = std::env::temp_dir().join(format!("zmfb-file-{}", std::process::id()));
                std::fs::create_dir_all(&p).unwrap();
                p.canonicalize().unwrap()
            });
        let file = home.join("a-file.txt");
        std::fs::write(&file, "x").unwrap();
        std::env::set_var("HOME", &home);

        let res = ensure_under_home(file.canonicalize().unwrap().to_str().unwrap());

        match prev {
            Some(h) => std::env::set_var("HOME", h),
            None => std::env::remove_var("HOME"),
        }

        assert!(
            matches!(res, Err((StatusCode::BAD_REQUEST, _))),
            "base_dir pointing at a file must be rejected, got {res:?}"
        );
    }

    #[test]
    fn parse_porcelain_z_handles_all_states() {
        // " M a.txt\0": worktree-modified, not staged
        // "M  b.txt\0": index-modified, staged
        // "A  c.txt\0": added (staged)
        // " D d.txt\0": deleted in worktree
        // "?? e.txt\0": untracked
        // "R  new.txt\0old.txt\0": rename, new first then old
        let raw = " M a.txt\0M  b.txt\0A  c.txt\0 D d.txt\0?? e.txt\0R  new.txt\0old.txt\0";
        let files = parse_porcelain_z(raw);
        assert_eq!(files.len(), 6);
        assert_eq!(files[0].path, "a.txt");
        assert_eq!(files[0].status, " M");
        assert!(!files[0].staged);
        assert_eq!(files[1].status, "M ");
        assert!(files[1].staged);
        assert_eq!(files[2].status, "A ");
        assert!(files[2].staged);
        assert_eq!(files[4].status, "??");
        assert!(!files[4].staged);
        assert_eq!(files[5].path, "new.txt");
        assert_eq!(files[5].old_path.as_deref(), Some("old.txt"));
        assert_eq!(files[5].status, "R ");
    }

    #[test]
    fn parse_porcelain_z_empty_is_empty() {
        assert!(parse_porcelain_z("").is_empty());
    }

    #[test]
    fn truncate_diff_marks_when_over_limit() {
        let big = "x".repeat(600_000);
        let (d, t) = truncate_diff(&big, 512 * 1024);
        assert!(t);
        assert_eq!(d.len(), 512 * 1024);
        let small = "abc";
        let (d2, t2) = truncate_diff(small, 512 * 1024);
        assert!(!t2);
        assert_eq!(d2, "abc");
    }

    #[test]
    fn filter_sensitive_files_drops_denylisted_paths() {
        let files = vec![
            WorktreeFile { path: "src/main.rs".into(), status: " M".into(), staged: false, old_path: None },
            WorktreeFile { path: ".ssh/config".into(), status: " M".into(), staged: false, old_path: None },
            WorktreeFile { path: ".aws/credentials".into(), status: " M".into(), staged: false, old_path: None },
        ];
        let out = filter_sensitive_files(files);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].path, "src/main.rs");
    }

    #[test]
    fn filter_sensitive_files_drops_credential_leaf_files() {
        // Parity with the file-browser read guard (is_credential_path): a tracked-
        // and-modified .env / *.pem / id_rsa / *credentials must NOT surface in the
        // worktree file list (and, via worktree_excluded, not in the diff body either),
        // even though none of these are SENSITIVE_DIR_NAMES *directories*.
        let files = vec![
            WorktreeFile { path: "src/main.rs".into(), status: " M".into(), staged: false, old_path: None },
            WorktreeFile { path: ".env".into(), status: " M".into(), staged: false, old_path: None },
            WorktreeFile { path: "config/.env.production".into(), status: " M".into(), staged: false, old_path: None },
            WorktreeFile { path: "deploy.pem".into(), status: " M".into(), staged: false, old_path: None },
            WorktreeFile { path: "keys/id_rsa".into(), status: " M".into(), staged: false, old_path: None },
            WorktreeFile { path: "aws-credentials".into(), status: " M".into(), staged: false, old_path: None },
        ];
        let out = filter_sensitive_files(files);
        assert_eq!(out.len(), 1, "only the non-credential file survives");
        assert_eq!(out[0].path, "src/main.rs");
    }

    #[test]
    fn filter_diff_excluded_drops_credential_and_dir_sections() {
        // A real-shaped multi-file diff: .env and .ssh/config sections must be
        // stripped wholesale; main.rs survives intact.
        let diff = "\
diff --git a/.env b/.env
index 1..2 100644
--- a/.env
+++ b/.env
+SECRET=LEAKED
diff --git a/src/main.rs b/src/main.rs
index 3..4 100644
--- a/src/main.rs
+++ b/src/main.rs
+let x = 1;
diff --git a/.ssh/config b/.ssh/config
index 5..6 100644
--- a/.ssh/config
+++ b/.ssh/config
+Host leaked
";
        let out = filter_diff_excluded(diff);
        assert!(!out.contains("LEAKED"), "credential .env hunk must be gone");
        assert!(!out.contains("Host leaked"), ".ssh/config hunk must be gone");
        assert!(out.contains("let x = 1;"), "main.rs hunk must survive");
        assert!(out.contains("diff --git a/src/main.rs"));
        assert!(!out.contains("diff --git a/.env"));
    }

    #[test]
    fn worktree_excluded_matches_filter_for_credentials_and_dirs() {
        // The diff-exclusion predicate MUST drop exactly what the file-list filter
        // drops, so a file can never appear in one but leak through the other.
        for p in [".ssh/config", ".aws/credentials", ".env", "config/.env.local",
                  "deploy.pem", "keys/id_ed25519", "x.key", "aws-credentials"] {
            assert!(worktree_path_excluded(p), "{p} must be excluded");
        }
        for p in ["src/main.rs", "README.md", "Cargo.toml"] {
            assert!(!worktree_path_excluded(p), "{p} must NOT be excluded");
        }
    }

    #[test]
    fn vault_search_matches_name_and_path() {
        let idx_paths = vec![
            "knowledge/aws/EKS 网络模型.md".to_string(),
            "journals/2026-06-29.md".to_string(),
        ];
        let r = vault_search_filter(&idx_paths, "eks");
        assert_eq!(r.len(), 1);
        assert_eq!(r[0], "knowledge/aws/EKS 网络模型.md");
        let r2 = vault_search_filter(&idx_paths, "journals");
        assert_eq!(r2.len(), 1);
        let r3 = vault_search_filter(&idx_paths, "");
        assert_eq!(r3.len(), 0); // empty query → no results
    }

    fn wikilink_idx() -> VaultIndex {
        let dir = std::env::temp_dir().join(format!("zmx_wl_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("knowledge/aws")).unwrap();
        std::fs::create_dir_all(dir.join("a")).unwrap();
        std::fs::create_dir_all(dir.join("b")).unwrap();
        std::fs::write(dir.join("knowledge/aws/EKS 网络模型.md"), b"x").unwrap();
        std::fs::write(dir.join("a/README.md"), b"x").unwrap();
        std::fs::write(dir.join("b/README.md"), b"y").unwrap();
        let idx = build_vault_index(&dir);
        let _ = std::fs::remove_dir_all(&dir);
        idx
    }

    #[test]
    fn resolve_wikilink_plain_basename() {
        let idx = wikilink_idx();
        assert_eq!(resolve_wikilink(&idx, "EKS 网络模型").as_deref(),
                   Some("knowledge/aws/EKS 网络模型.md"));
    }

    #[test]
    fn resolve_wikilink_folder_qualified() {
        // [[knowledge/aws/EKS 网络模型]] — the 18% of real links that used to 404.
        let idx = wikilink_idx();
        assert_eq!(resolve_wikilink(&idx, "knowledge/aws/EKS 网络模型").as_deref(),
                   Some("knowledge/aws/EKS 网络模型.md"));
    }

    #[test]
    fn resolve_wikilink_explicit_extension() {
        let idx = wikilink_idx();
        assert_eq!(resolve_wikilink(&idx, "EKS 网络模型.md").as_deref(),
                   Some("knowledge/aws/EKS 网络模型.md"));
    }

    #[test]
    fn resolve_wikilink_case_insensitive() {
        // Obsidian wikilinks are case-insensitive; ASCII case must fold.
        let idx = wikilink_idx();
        assert_eq!(resolve_wikilink(&idx, "eks 网络模型").as_deref(),
                   Some("knowledge/aws/EKS 网络模型.md"));
    }

    #[test]
    fn resolve_wikilink_folder_disambiguates_collision() {
        // Two notes share basename README. A folder-qualified link must land in the
        // right folder, not first-wins basename.
        let idx = wikilink_idx();
        assert_eq!(resolve_wikilink(&idx, "b/README").as_deref(), Some("b/README.md"));
        assert_eq!(resolve_wikilink(&idx, "a/README").as_deref(), Some("a/README.md"));
    }

    #[test]
    fn resolve_wikilink_not_found() {
        let idx = wikilink_idx();
        assert_eq!(resolve_wikilink(&idx, "does not exist"), None);
    }

    #[test]
    fn vault_dot_entry_hidden_from_list() {
        // vault_list filters entries whose name is a dot-entry (.obsidian/.git/.trash),
        // matching the index's own dot-skip — the API is the trust boundary, not the UI.
        assert!(vault_path_has_dot_component(".obsidian"));
        assert!(vault_path_has_dot_component(".git"));
        assert!(!vault_path_has_dot_component("note.md"));
        assert!(!vault_path_has_dot_component("a.b.md"));
    }
}

#[cfg(test)]
mod upload_helpers_tests {
    use super::*;

    #[test]
    fn next_candidate_adds_suffix_before_ext() {
        assert_eq!(next_candidate("a.png", 1), "a-1.png");
        assert_eq!(next_candidate("a.png", 2), "a-2.png");
    }

    #[test]
    fn next_candidate_no_extension() {
        assert_eq!(next_candidate("log", 1), "log-1");
    }

    #[test]
    fn next_candidate_dotfile_treated_as_no_ext() {
        assert_eq!(next_candidate(".gitignore", 1), ".gitignore-1");
    }

    #[test]
    fn sanitize_strips_control_and_separators() {
        assert_eq!(sanitize_filename("a\nb.png"), "ab.png");
        assert_eq!(sanitize_filename("x/y\\z.txt"), "xyz.txt");
        assert_eq!(sanitize_filename("ok\u{7f}name"), "okname");
        // Strip double-quote so the Content-Disposition header stays RFC 6266-clean.
        assert_eq!(sanitize_filename("foo\"bar.txt"), "foobar.txt");
    }

    #[test]
    fn embedded_response_has_csp() {
        if let Some(resp) = try_serve_embedded("index.html") {
            let csp = resp
                .headers()
                .get("Content-Security-Policy")
                .expect("CSP header present")
                .to_str()
                .unwrap();
            assert!(csp.contains("script-src 'self'"));
            assert!(csp.contains("worker-src 'self'"));
            assert!(!csp.contains("blob:"), "blob: should not be in CSP after voice removal");
        } // index.html is always present in the bundle
    }

    #[test]
    fn sanitize_keeps_unicode_and_normal() {
        assert_eq!(sanitize_filename("截图.png"), "截图.png");
    }

    #[test]
    fn sanitize_empty_falls_back() {
        assert_eq!(sanitize_filename(""), "upload");
        assert_eq!(sanitize_filename("///"), "upload");
        assert_eq!(sanitize_filename("\n\n"), "upload");
    }

    #[test]
    fn dedupe_creates_first_then_suffixes() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();

        let (mut f1, n1) = dedupe_and_create(d, "a.png").unwrap();
        assert_eq!(n1, "a.png");
        use std::io::Write;
        f1.write_all(b"one").unwrap();

        let (_f2, n2) = dedupe_and_create(d, "a.png").unwrap();
        assert_eq!(n2, "a-1.png");

        let (_f3, n3) = dedupe_and_create(d, "a.png").unwrap();
        assert_eq!(n3, "a-2.png");

        assert_eq!(std::fs::read(d.join("a.png")).unwrap(), b"one");
    }

    #[test]
    fn upload_targets_subdir_not_root() {
        // Pure helper behavior: base + "sub/dir/pic.png" → dir base/sub/dir, name pic.png.
        let base = std::path::Path::new("/home/u/work");
        let (dir, name) = split_upload_target(base, "sub/dir/pic.png");
        assert_eq!(dir, std::path::Path::new("/home/u/work/sub/dir"));
        assert_eq!(name, "pic.png");
        // Bare filename → lands in base.
        let (dir2, name2) = split_upload_target(base, "pic.png");
        assert_eq!(dir2, base);
        assert_eq!(name2, "pic.png");
    }

    #[test]
    fn traversal_names_collapse_to_safe_basename() {
        use std::path::Path;
        // 模拟 handler 的取名两步:file_name() 取末段 → sanitize。
        // 任何 ../ 前缀在 file_name() 处被剥掉,绝不逃出 work_dir。
        let take = |p: &str| -> String {
            sanitize_filename(Path::new(p).file_name().and_then(|s| s.to_str()).unwrap_or("upload"))
        };
        assert_eq!(take("../../../etc/passwd"), "passwd");
        assert_eq!(take("a/../../etc/x"), "x");
        assert_eq!(take(".."), "upload");        // file_name() 对 ".." 返回 None
        assert_eq!(take("/abs/path/file.png"), "file.png");
    }
}

// ── Push notification REST endpoints ──────────────────────────────────────────

async fn push_vapid_key(
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    match state.push.as_ref() {
        Some(p) => Ok(Json(serde_json::json!({ "key": p.vapid_public_key() }))),
        None => Err(StatusCode::SERVICE_UNAVAILABLE),
    }
}

#[derive(serde::Deserialize)]
struct SubscribeReq {
    endpoint: String,
    keys: SubKeys,
}

#[derive(serde::Deserialize)]
struct SubKeys {
    p256dh: String,
    auth: String,
}

async fn push_subscribe(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
    Json(req): Json<SubscribeReq>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let p = state.push.as_ref().ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    if !crate::push::endpoint_is_safe(&req.endpoint) {
        return Err(StatusCode::BAD_REQUEST);
    }
    p.store()
        .upsert(&user.id, &req.endpoint, &req.keys.p256dh, &req.keys.auth)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(serde::Deserialize)]
struct UnsubReq {
    endpoint: String,
}

async fn push_unsubscribe(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
    Json(req): Json<UnsubReq>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    if let Some(p) = state.push.as_ref() {
        p.store().delete_for_user(&req.endpoint, &user.id);
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[cfg(test)]
mod create_session_req_tests {
    use super::CreateSessionReq;
    use super::should_send_initial_prompt;
    use crate::session_manager::SessionType;

    #[test]
    fn gating_sends_only_for_nonblank_agent_prompt() {
        // 非空 agent prompt → 发（trim 后）
        assert_eq!(
            should_send_initial_prompt(SessionType::Claude, Some("hi")),
            Some("hi".to_string())
        );
        assert_eq!(
            should_send_initial_prompt(SessionType::Kiro, Some("  x  ")),
            Some("x".to_string()),
            "应 trim 后发送"
        );
        // 空白 / None → 不发
        assert_eq!(should_send_initial_prompt(SessionType::Claude, Some("   ")), None);
        assert_eq!(should_send_initial_prompt(SessionType::Codex, None), None);
        // tmux → 永不发（即使有 prompt）
        assert_eq!(should_send_initial_prompt(SessionType::Tmux, Some("hi")), None);
    }

    #[test]
    fn initial_prompt_defaults_to_none_when_absent() {
        // 老前端不发 initial_prompt 字段 → 必须反序列化为 None（向后兼容）。
        let json = r#"{"type":"claude"}"#;
        let req: CreateSessionReq = serde_json::from_str(json).unwrap();
        assert!(req.initial_prompt.is_none());
    }

    #[test]
    fn initial_prompt_parses_when_present() {
        let json = r#"{"type":"claude","initial_prompt":"hello"}"#;
        let req: CreateSessionReq = serde_json::from_str(json).unwrap();
        assert_eq!(req.initial_prompt.as_deref(), Some("hello"));
    }
}
