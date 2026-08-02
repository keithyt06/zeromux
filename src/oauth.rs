use axum::{
    extract::{Query, State},
    response::{IntoResponse, Redirect, Response},
};
use jsonwebtoken::{encode, EncodingKey, Header};
use std::sync::Arc;

use crate::AppState;

#[derive(serde::Deserialize)]
pub struct CallbackQuery {
    pub code: String,
    pub state: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct JwtClaims {
    pub sub: String,        // user id
    pub role: String,       // "admin" | "member"
    pub status: String,     // "active" | "pending"
    pub login: String,      // github username
    pub avatar: Option<String>,
    pub exp: usize,
}

#[derive(serde::Deserialize)]
pub struct RedirectQuery {
    pub remember: Option<bool>,
}

/// Name of the short-lived anti-CSRF cookie that binds an OAuth flow to the browser
/// that started it. (review 2026-08-02, F5)
const OAUTH_STATE_COOKIE: &str = "zeromux_oauth_state";

/// Generate a high-entropy anti-CSRF nonce (base62, 256-bit-ish). rand 0.9.
fn gen_oauth_nonce() -> String {
    (0..43)
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

/// Build the OAuth `state` value: the CSRF nonce plus the remember flag, `<nonce>.<0|1>`.
/// The nonce is the security-bearing half (compared against the browser cookie); the
/// remember suffix is non-security metadata (it only picks the JWT TTL).
fn build_oauth_state(nonce: &str, remember: bool) -> String {
    format!("{nonce}.{}", if remember { "1" } else { "0" })
}

/// Parse `<nonce>.<0|1>` back into (nonce, remember). `None` if malformed. Splits on the
/// FIRST '.' only — a nonce never contains '.', but be defensive.
fn parse_oauth_state(state: &str) -> Option<(&str, bool)> {
    let (nonce, flag) = state.split_once('.')?;
    if nonce.is_empty() {
        return None;
    }
    Some((nonce, flag == "1"))
}

/// Constant-time equality for the nonce comparison (avoid a timing side-channel on the
/// CSRF token). Length-mismatch → false, but the length check itself is not secret.
fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Extract the `zeromux_oauth_state` cookie value from a `Cookie` header.
fn oauth_state_cookie(headers: &axum::http::HeaderMap) -> Option<String> {
    let cookie = headers.get("Cookie")?.to_str().ok()?;
    for part in cookie.split(';') {
        if let Some(val) = part.trim().strip_prefix(&format!("{OAUTH_STATE_COOKIE}=")) {
            return Some(val.to_string());
        }
    }
    None
}

/// `Secure` only when the public URL is HTTPS — the state cookie must not be dropped on
/// a plain-HTTP dev deployment (which would break login: no cookie → callback rejects),
/// matching the posture of the `zeromux_jwt` cookie. Behind a TLS proxy external_url is
/// https, so prod gets `Secure`.
fn secure_attr(external_url: &str) -> &'static str {
    if external_url.starts_with("https://") { "; Secure" } else { "" }
}

/// GET /auth/github — redirect to GitHub authorize URL
pub async fn github_redirect(
    Query(query): Query<RedirectQuery>,
    State(state): State<Arc<AppState>>,
) -> Response {
    let client_id = match &state.github_client_id {
        Some(id) => id,
        None => {
            return (axum::http::StatusCode::SERVICE_UNAVAILABLE, "OAuth not configured")
                .into_response()
        }
    };

    // CSRF defense (F5): mint a per-flow nonce, stash it in a short-lived HttpOnly
    // cookie, AND carry it in the `state` param. The callback accepts the flow only if
    // the two match — so an attacker who lures a victim to a callback URL carrying the
    // ATTACKER's `code` (login fixation) can't succeed: the victim's browser has no
    // matching state cookie. Previously `state` held only the remember flag and the
    // callback never validated it, so any `code`+`state=1` was accepted.
    let nonce = gen_oauth_nonce();
    let remember = query.remember.unwrap_or(false);
    let state_param = build_oauth_state(&nonce, remember);
    let callback_url = format!("{}/auth/github/callback", state.external_url);
    let url = format!(
        "https://github.com/login/oauth/authorize?client_id={}&redirect_uri={}&scope=read:user&state={}",
        client_id,
        urlencoding::encode(&callback_url),
        urlencoding::encode(&state_param),
    );
    // 10-minute TTL: long enough to complete a GitHub login, short enough to bound the
    // window. SameSite=Lax is correct here — the callback is a top-level GET navigation,
    // on which Lax DOES send the cookie (Strict would drop it and break login).
    let set_cookie = format!(
        "{OAUTH_STATE_COOKIE}={nonce}; Path=/; HttpOnly; SameSite=Lax{}; Max-Age=600",
        secure_attr(&state.external_url)
    );
    match Response::builder()
        .status(302)
        .header("Location", url)
        .header("Set-Cookie", set_cookie)
        .body(axum::body::Body::empty())
    {
        Ok(r) => r,
        Err(_) => Redirect::temporary("/").into_response(),
    }
}

/// GET /auth/github/callback — exchange code for token, upsert user, issue JWT
pub async fn github_callback(
    Query(query): Query<CallbackQuery>,
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
) -> Response {
    let (client_id, client_secret) = match (&state.github_client_id, &state.github_client_secret) {
        (Some(id), Some(secret)) => (id, secret),
        _ => {
            return (axum::http::StatusCode::SERVICE_UNAVAILABLE, "OAuth not configured")
                .into_response()
        }
    };

    // CSRF check (F5): the `state` param must carry a nonce that matches the
    // `zeromux_oauth_state` cookie set at redirect. A cross-site login-fixation attempt
    // (victim lured to a callback with the attacker's `code`) has no matching cookie in
    // the victim's browser → reject. The remember flag rides in the state suffix and is
    // read ONLY after this check passes.
    let (remember, csrf_ok) = match (query.state.as_deref().and_then(parse_oauth_state), oauth_state_cookie(&headers)) {
        (Some((nonce, remember)), Some(cookie)) => (remember, constant_time_eq(nonce, &cookie)),
        _ => (false, false),
    };
    if !csrf_ok {
        tracing::warn!("OAuth callback rejected: state/cookie mismatch (CSRF defense)");
        return (axum::http::StatusCode::BAD_REQUEST, "Invalid OAuth state").into_response();
    }

    // Exchange code for access token
    let token_resp = match exchange_code(client_id, client_secret, &query.code).await {
        Ok(t) => t,
        Err(e) => {
            tracing::error!("OAuth token exchange failed: {}", e);
            return (axum::http::StatusCode::BAD_GATEWAY, "OAuth token exchange failed")
                .into_response();
        }
    };

    // Fetch GitHub user info
    let gh_user = match fetch_github_user(&token_resp.access_token).await {
        Ok(u) => u,
        Err(e) => {
            tracing::error!("GitHub user fetch failed: {}", e);
            return (axum::http::StatusCode::BAD_GATEWAY, "Failed to fetch GitHub user")
                .into_response();
        }
    };

    // Upsert user in database
    let db = match &state.db {
        Some(db) => db,
        None => {
            return (axum::http::StatusCode::INTERNAL_SERVER_ERROR, "Database not initialized")
                .into_response()
        }
    };

    let user = match db.upsert_github_user(
        gh_user.id,
        &gh_user.login,
        gh_user.name.as_deref(),
        gh_user.avatar_url.as_deref(),
        &state.allowed_users,
    ) {
        Ok(u) => u,
        Err(e) => {
            tracing::error!("User upsert failed: {}", e);
            return (axum::http::StatusCode::INTERNAL_SERVER_ERROR, "User creation failed")
                .into_response();
        }
    };

    tracing::info!(
        "OAuth login: {} (role={}, status={})",
        user.github_login,
        user.role,
        user.status
    );

    // Issue JWT (remember flag came from the validated state above)
    let jwt = match issue_jwt(&user, &state.jwt_secret, remember) {
        Ok(t) => t,
        Err(e) => {
            tracing::error!("JWT signing failed: {}", e);
            return (axum::http::StatusCode::INTERNAL_SERVER_ERROR, "Token signing failed")
                .into_response();
        }
    };

    // Redirect to frontend with JWT in cookie
    let max_age = if remember { 2592000 } else { 604800 }; // 30 days vs 7 days
    let cookie = format!(
        "zeromux_jwt={}; Path=/; HttpOnly; SameSite=Lax{}; Max-Age={}",
        jwt, secure_attr(&state.external_url), max_age
    );
    // Clear the one-shot CSRF state cookie now that the flow completed.
    let clear_state = format!(
        "{OAUTH_STATE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax{}; Max-Age=0",
        secure_attr(&state.external_url)
    );

    Response::builder()
        .status(302)
        .header("Location", "/")
        .header("Set-Cookie", cookie)
        .header("Set-Cookie", clear_state)
        .body(axum::body::Body::empty())
        .unwrap()
}

pub fn issue_jwt(user: &crate::db::User, secret: &str, remember: bool) -> Result<String, String> {
    let ttl = if remember { 30 * 24 * 3600 } else { 7 * 24 * 3600 };
    let exp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as usize
        + ttl;

    let claims = JwtClaims {
        sub: user.id.clone(),
        role: user.role.clone(),
        status: user.status.clone(),
        login: user.github_login.clone(),
        avatar: user.avatar_url.clone(),
        exp,
    };

    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|e| format!("JWT encode error: {}", e))
}

// ── GitHub API helpers ──

#[derive(serde::Deserialize)]
struct TokenResponse {
    access_token: String,
}

#[derive(serde::Deserialize)]
struct GitHubUser {
    id: i64,
    login: String,
    name: Option<String>,
    avatar_url: Option<String>,
}

async fn exchange_code(
    client_id: &str,
    client_secret: &str,
    code: &str,
) -> Result<TokenResponse, String> {
    let client = reqwest::Client::new();
    let resp = client
        .post("https://github.com/login/oauth/access_token")
        .header("Accept", "application/json")
        .json(&serde_json::json!({
            "client_id": client_id,
            "client_secret": client_secret,
            "code": code,
        }))
        .send()
        .await
        .map_err(|e| format!("HTTP error: {}", e))?;

    resp.json::<TokenResponse>()
        .await
        .map_err(|e| format!("Parse error: {}", e))
}

async fn fetch_github_user(access_token: &str) -> Result<GitHubUser, String> {
    let client = reqwest::Client::new();
    let resp = client
        .get("https://api.github.com/user")
        .header("Authorization", format!("Bearer {}", access_token))
        .header("User-Agent", "zeromux")
        .send()
        .await
        .map_err(|e| format!("HTTP error: {}", e))?;

    resp.json::<GitHubUser>()
        .await
        .map_err(|e| format!("Parse error: {}", e))
}

// URL encoding helper — minimal implementation to avoid extra dependency
mod urlencoding {
    pub fn encode(s: &str) -> String {
        let mut result = String::with_capacity(s.len() * 3);
        for b in s.bytes() {
            match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                    result.push(b as char);
                }
                _ => {
                    result.push('%');
                    result.push_str(&format!("{:02X}", b));
                }
            }
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderMap;

    // F5 (review 2026-08-02): OAuth login-CSRF defense. The `state` param must carry a
    // per-flow nonce that matches the browser's `zeromux_oauth_state` cookie; a
    // login-fixation attempt (victim lured to a callback with the attacker's code) has
    // no matching cookie and must be rejected.

    #[test]
    fn state_roundtrips_nonce_and_remember() {
        let n = gen_oauth_nonce();
        let s_true = build_oauth_state(&n, true);
        let (pn, pr) = parse_oauth_state(&s_true).unwrap();
        assert_eq!(pn, n);
        assert!(pr);
        let s_false = build_oauth_state(&n, false);
        let (pn0, pr0) = parse_oauth_state(&s_false).unwrap();
        assert_eq!(pn0, n);
        assert!(!pr0);
    }

    #[test]
    fn nonce_is_high_entropy_and_url_safe() {
        let n = gen_oauth_nonce();
        assert!(n.len() >= 40, "nonce must be long (>=40 base62 chars)");
        assert!(n.chars().all(|c| c.is_ascii_alphanumeric()), "nonce must be base62 (no '.' — split_once safe)");
        // Two draws must differ (probabilistically certain).
        assert_ne!(gen_oauth_nonce(), n);
    }

    #[test]
    fn parse_state_rejects_malformed() {
        assert!(parse_oauth_state("").is_none());
        assert!(parse_oauth_state("no-dot").is_none());     // legacy bare "1"/"0" no longer valid
        assert!(parse_oauth_state(".1").is_none());          // empty nonce
        assert_eq!(parse_oauth_state("abc.1"), Some(("abc", true)));
        assert_eq!(parse_oauth_state("abc.0"), Some(("abc", false)));
        assert_eq!(parse_oauth_state("abc.garbage"), Some(("abc", false))); // non-"1" → false
    }

    #[test]
    fn constant_time_eq_matches_semantics() {
        assert!(constant_time_eq("abc123", "abc123"));
        assert!(!constant_time_eq("abc123", "abc124"));
        assert!(!constant_time_eq("abc", "abcd")); // length mismatch
        assert!(!constant_time_eq("", "x"));
        assert!(constant_time_eq("", ""));
    }

    fn headers_with_cookie(v: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert("Cookie", v.parse().unwrap());
        h
    }

    #[test]
    fn oauth_state_cookie_extraction() {
        let h = headers_with_cookie("foo=1; zeromux_oauth_state=NONCE123; zeromux_jwt=x");
        assert_eq!(oauth_state_cookie(&h).as_deref(), Some("NONCE123"));
        // Absent → None.
        assert_eq!(oauth_state_cookie(&headers_with_cookie("foo=1; bar=2")), None);
        assert_eq!(oauth_state_cookie(&HeaderMap::new()), None);
    }

    #[test]
    fn csrf_accepts_matching_and_rejects_mismatched_or_missing() {
        // This mirrors the callback's acceptance predicate exactly.
        let check = |state: &str, cookie: Option<&str>| -> bool {
            match (parse_oauth_state(state), cookie) {
                (Some((nonce, _)), Some(c)) => constant_time_eq(nonce, c),
                _ => false,
            }
        };
        // Legit: cookie nonce == state nonce.
        assert!(check("NONCE.1", Some("NONCE")));
        // Attacker's callback: state nonce differs from victim's cookie → reject.
        assert!(!check("ATTACKER.1", Some("VICTIM")));
        // No cookie at all (cross-site GET, victim never started a flow) → reject.
        assert!(!check("NONCE.1", None));
        // Malformed/legacy bare state → reject.
        assert!(!check("1", Some("NONCE")));
    }

    #[test]
    fn secure_attr_only_on_https() {
        assert_eq!(secure_attr("https://zeromux.example.com"), "; Secure");
        assert_eq!(secure_attr("http://0.0.0.0:8090"), "");
    }
}
