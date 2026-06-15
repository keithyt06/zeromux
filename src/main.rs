mod acp;
mod admin;
mod auth;
mod auto_titler;
mod auto_update;
mod aws_sigv4;
mod db;
mod event_stream;
mod events;
mod logger;
mod notes;
mod oauth;
mod prompts;
mod pty_bridge;
mod scheduled_tasks;
mod session_manager;
mod session_store;
mod transcribe;
mod web;
mod ws_handler;

use clap::Parser;
use std::sync::Arc;

#[derive(Parser)]
#[command(name = "zeromux", about = "Web-based tmux - minimal terminal multiplexer in your browser")]
struct Args {
    /// Listen port
    #[arg(short, long, default_value = "8080")]
    port: u16,

    /// Listen host
    #[arg(long, default_value = "0.0.0.0")]
    host: String,

    /// Auth password (legacy mode, used when OAuth is not configured)
    #[arg(long, env = "ZEROMUX_PASSWORD")]
    password: Option<String>,

    /// Shell command to spawn for tmux sessions
    #[arg(long, default_value = "bash")]
    shell: String,

    /// Path to claude CLI binary
    #[arg(long, default_value = "claude")]
    claude_path: String,

    /// Path to kiro-cli binary
    #[arg(long, default_value = "kiro-cli")]
    kiro_path: String,

    /// Path to codex CLI binary
    #[arg(long, default_value = "codex")]
    codex_path: String,

    /// Codex model reasoning effort. One of: off | low | medium | high.
    /// Off (default) leaves the model catalog's default; low/medium/high are
    /// passed as `model_reasoning_effort` config override on each tools/call.
    /// Requires the underlying model + provider (e.g. LiteLLM → Bedrock Claude)
    /// to support and propagate the `thinking` parameter — without that
    /// support, this flag has no effect.
    #[arg(long, default_value = "off", value_parser = ["off", "low", "medium", "high"])]
    codex_reasoning: String,

    /// Working directory for spawned sessions
    #[arg(long, default_value = ".")]
    work_dir: String,

    /// Log directory (enables I/O logging when set)
    #[arg(long)]
    log_dir: Option<String>,

    /// Default terminal columns
    #[arg(long, default_value = "120")]
    cols: u16,

    /// Default terminal rows
    #[arg(long, default_value = "36")]
    rows: u16,

    /// GitHub OAuth client ID
    #[arg(long, env = "GITHUB_CLIENT_ID")]
    github_client_id: Option<String>,

    /// GitHub OAuth client secret
    #[arg(long, env = "GITHUB_CLIENT_SECRET")]
    github_client_secret: Option<String>,

    /// JWT signing secret (auto-generated if not set)
    #[arg(long, env = "ZEROMUX_JWT_SECRET")]
    jwt_secret: Option<String>,

    /// Data directory for SQLite database
    #[arg(long, default_value = "~/.zeromux")]
    data_dir: String,

    /// Pre-approved GitHub usernames (comma-separated)
    #[arg(long, env = "ZEROMUX_ALLOWED_USERS")]
    allowed_users: Option<String>,

    /// External URL for OAuth callback (e.g. https://myserver.com)
    #[arg(long, env = "ZEROMUX_EXTERNAL_URL")]
    external_url: Option<String>,

    /// 监视的 build 产物路径;给定则启用后台自动更新(本机原地升级)。
    /// ⚠️ 监视裸 target/release/zeromux 时,任何 cargo build --release 都会让
    /// live server 在空闲时静默换上去(build=deploy footgun,见 spec)。
    #[arg(long)]
    watch_build: Option<String>,

    /// 自动更新:进入待升级后,等交互会话全空闲的硬上限(秒)。
    /// 调度运行不受此限(永不强制穿透,E1)。默认 600。
    #[arg(long, default_value = "600")]
    auto_update_max_wait: u64,
}

pub struct AppState {
    pub sessions: Arc<session_manager::SessionManager>,
    pub password_hash: Option<String>,
    pub shell: String,
    pub claude_path: String,
    pub kiro_path: String,
    pub codex_path: String,
    pub codex_reasoning: String,
    pub work_dir: String,
    pub default_cols: u16,
    pub default_rows: u16,
    pub logger: Option<logger::Logger>,
    pub db: Option<db::Database>,
    pub notes: notes::NotesStore,
    pub prompts: prompts::PromptPresetStore,
    pub events: Arc<events::EventStore>,
    pub scheduled_tasks: Arc<scheduled_tasks::ScheduledStore>,
    pub sched_heartbeat: Arc<std::sync::atomic::AtomicI64>,
    pub github_client_id: Option<String>,
    pub github_client_secret: Option<String>,
    pub jwt_secret: String,
    pub allowed_users: Vec<String>,
    pub external_url: String,
}

fn gen_random_string(len: usize) -> String {
    (0..len)
        .map(|_| {
            let idx = rand::random::<u8>() % 62;
            match idx {
                0..=9 => (b'0' + idx) as char,
                10..=35 => (b'a' + idx - 10) as char,
                _ => (b'A' + idx - 36) as char,
            }
        })
        .collect()
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    let args = Args::parse();

    let oauth_configured =
        args.github_client_id.is_some() && args.github_client_secret.is_some();

    // In OAuth mode, password is optional fallback. In legacy mode, it's required.
    let password_hash = if oauth_configured {
        args.password.map(|pw| auth::hash_password(&pw))
    } else {
        let password = args.password.unwrap_or_else(|| {
            let pw = gen_random_string(16);
            println!("========================================");
            println!("  ZeroMux Auto-Generated Password:");
            println!("  {}", pw);
            println!("========================================");
            pw
        });
        Some(auth::hash_password(&password))
    };

    let jwt_secret = args
        .jwt_secret
        .unwrap_or_else(|| gen_random_string(32));

    // Resolve data dir (expand ~)
    let data_dir_str = if args.data_dir.starts_with("~/") {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/home/ubuntu".to_string());
        args.data_dir.replacen("~", &home, 1)
    } else {
        args.data_dir.clone()
    };

    // Initialize database if OAuth is configured
    let database = if oauth_configured {
        match db::Database::open(std::path::Path::new(&data_dir_str)) {
            Ok(db) => {
                println!("Database initialized: {}/zeromux.db", data_dir_str);
                Some(db)
            }
            Err(e) => {
                eprintln!("WARNING: Failed to initialize database: {}", e);
                None
            }
        }
    } else {
        None
    };

    let allowed_users: Vec<String> = args
        .allowed_users
        .map(|s| s.split(',').map(|u| u.trim().to_string()).filter(|u| !u.is_empty()).collect())
        .unwrap_or_default();

    if !allowed_users.is_empty() {
        println!("Pre-approved users: {}", allowed_users.join(", "));
    }

    let external_url = args.external_url.unwrap_or_else(|| {
        format!("http://{}:{}", args.host, args.port)
    });

    let logger = logger::Logger::start(args.log_dir.as_deref());
    if logger.is_some() {
        println!("Logging enabled: {}", args.log_dir.as_deref().unwrap_or(""));
    }

    let notes_store = notes::NotesStore::open(std::path::Path::new(&data_dir_str))
        .expect("Failed to initialize notes store");

    let prompts_store = prompts::PromptPresetStore::open(std::path::Path::new(&data_dir_str))
        .expect("Failed to open prompts store");

    let event_store = Arc::new(
        events::EventStore::open(std::path::Path::new(&data_dir_str))
            .expect("Failed to initialize event store"),
    );

    let session_store = Arc::new(
        session_store::SessionStore::open(std::path::Path::new(&data_dir_str))
            .expect("Failed to initialize session store"),
    );

    let scheduled_store = Arc::new(
        scheduled_tasks::ScheduledStore::open(std::path::Path::new(&data_dir_str))
            .expect("Failed to initialize scheduled store"),
    );

    if oauth_configured {
        println!("GitHub OAuth enabled");
    } else {
        println!("Legacy password auth mode");
    }

    let state = Arc::new(AppState {
        sessions: session_manager::SessionManager::new(
            event_store.clone(),
            session_store.clone(),
            args.claude_path.clone(),
            args.kiro_path.clone(),
            args.codex_path.clone(),
            args.codex_reasoning.clone(),
            args.shell.clone(),
        ),
        password_hash,
        shell: args.shell,
        claude_path: args.claude_path,
        kiro_path: args.kiro_path,
        codex_path: args.codex_path,
        codex_reasoning: args.codex_reasoning,
        work_dir: args.work_dir,
        default_cols: args.cols,
        default_rows: args.rows,
        logger,
        db: database,
        notes: notes_store,
        prompts: prompts_store,
        events: event_store,
        scheduled_tasks: scheduled_store.clone(),
        sched_heartbeat: Arc::new(std::sync::atomic::AtomicI64::new(0)),
        github_client_id: args.github_client_id,
        github_client_secret: args.github_client_secret,
        jwt_secret,
        allowed_users,
        external_url,
    });

    // Restore persisted session metadata (running=None until respawned).
    state.sessions.load_persisted();

    // Scheduled tasks: wire the store into the manager, reconcile orphans from a
    // prior process, then start the supervised scheduler loop.
    state.sessions.set_scheduled_store(state.scheduled_tasks.clone());
    let _ = state.scheduled_tasks.reconcile_orphans(None);
    scheduled_tasks::spawn_scheduler(
        state.sessions.clone(),
        state.scheduled_tasks.clone(),
        state.sched_heartbeat.clone(),
    );

    // Periodically prune the agent-events table (one row per turn, otherwise
    // unbounded). Prune once at startup, then daily. 30-day retention.
    {
        let events = state.events.clone();
        tokio::spawn(async move {
            const RETENTION_DAYS: u64 = 30;
            let mut tick = tokio::time::interval(std::time::Duration::from_secs(24 * 3600));
            loop {
                tick.tick().await;
                match events.prune_older_than_days(RETENTION_DAYS) {
                    Ok(n) if n > 0 => tracing::info!("pruned {} agent events older than {} days", n, RETENTION_DAYS),
                    Ok(_) => {}
                    Err(e) => tracing::warn!("event prune failed: {}", e),
                }
            }
        });
    }

    // 后台自动更新:仅当 --watch-build 提供时启用(默认关闭)。
    if let Some(watch) = args.watch_build.clone() {
        // installed_path = swap 的目标(被替换的文件);self baseline 则取 /proc/self/exe
        // 的内容哈希。正常 systemd 部署下两者是同一文件,故一致。read_link 解析失败
        // (或带 " (deleted)" 后缀,即运行中 binary 已被带外替换)时回退到约定安装路径。
        let installed = std::fs::read_link("/proc/self/exe")
            .unwrap_or_else(|_| std::path::PathBuf::from("/usr/local/bin/zeromux"));
        let cfg = auto_update::AutoUpdateConfig {
            watch_path: std::path::PathBuf::from(watch),
            installed_path: installed,
            service_name: "zeromux".to_string(),
            health_url: format!("http://127.0.0.1:{}/", args.port),
            max_wait_secs: args.auto_update_max_wait,
            poll_secs: auto_update::POLL_SECS,
        };
        auto_update::spawn_auto_updater(cfg, Arc::downgrade(&state.sessions));
    }

    let app = web::build_router(state.clone());

    let addr = format!("{}:{}", args.host, args.port);
    println!("ZeroMux listening on http://{}", addr);

    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
