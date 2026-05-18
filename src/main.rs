mod acp;
mod admin;
mod auth;
mod aws_sigv4;
mod db;
mod event_stream;
mod logger;
mod notes;
mod oauth;
mod pty_bridge;
mod session_manager;
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
}

pub struct AppState {
    pub sessions: session_manager::SessionManager,
    pub password_hash: Option<String>,
    pub shell: String,
    pub claude_path: String,
    pub kiro_path: String,
    pub work_dir: String,
    pub default_cols: u16,
    pub default_rows: u16,
    pub logger: Option<logger::Logger>,
    pub db: Option<db::Database>,
    pub notes: notes::NotesStore,
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

    if oauth_configured {
        println!("GitHub OAuth enabled");
    } else {
        println!("Legacy password auth mode");
    }

    let state = Arc::new(AppState {
        sessions: session_manager::SessionManager::new(),
        password_hash,
        shell: args.shell,
        claude_path: args.claude_path,
        kiro_path: args.kiro_path,
        work_dir: args.work_dir,
        default_cols: args.cols,
        default_rows: args.rows,
        logger,
        db: database,
        notes: notes_store,
        github_client_id: args.github_client_id,
        github_client_secret: args.github_client_secret,
        jwt_secret,
        allowed_users,
        external_url,
    });

    let app = web::build_router(state.clone());

    let addr = format!("{}:{}", args.host, args.port);
    println!("ZeroMux listening on http://{}", addr);

    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
