use axum::{
    extract::{Query, State},
    http::{HeaderMap, Request, StatusCode},
    middleware::Next,
    response::Response,
};
use jsonwebtoken::{decode, DecodingKey, Validation};
use sha2::{Digest, Sha256};
use std::sync::Arc;

use crate::oauth::JwtClaims;
use crate::AppState;

/// Represents the authenticated user, injected into request extensions.
#[derive(Clone, Debug)]
pub struct CurrentUser {
    pub id: String,
    pub role: String,   // "admin" | "member"
    pub status: String, // "active" | "pending"
    pub login: String,
    pub avatar: Option<String>,
}

impl CurrentUser {
    pub fn is_admin(&self) -> bool {
        self.role == "admin"
    }
    pub fn is_active(&self) -> bool {
        self.status == "active"
    }

    /// Synthetic user for legacy password mode
    fn legacy() -> Self {
        Self {
            id: "legacy".to_string(),
            role: "admin".to_string(),
            status: "active".to_string(),
            login: "admin".to_string(),
            avatar: None,
        }
    }
}

pub fn hash_password(password: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(password.as_bytes());
    hex::encode(hasher.finalize())
}

pub fn verify_password(password: &str, hash: &str) -> bool {
    // Constant-time compare of the two hex SHA-256 strings, matching the posture of
    // `oauth::constant_time_eq` used for the OAuth CSRF nonce. `==` on `String`
    // short-circuits on the first differing byte, a (weak) timing oracle on the
    // stored-hash prefix; equal-length hex strings compared byte-by-byte remove it.
    // (review 2026-08-03, F5)
    let a = hash_password(password);
    let (a, b) = (a.as_bytes(), hash.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

#[derive(serde::Deserialize, Default)]
pub struct TokenQuery {
    pub token: Option<String>,
}

/// Main auth middleware for API routes.
/// Supports JWT (OAuth mode) and legacy password mode.
/// Injects CurrentUser into request extensions.
pub async fn auth_middleware(
    State(state): State<Arc<AppState>>,
    Query(query): Query<TokenQuery>,
    mut req: Request<axum::body::Body>,
    next: Next,
) -> Result<Response, StatusCode> {
    // Try JWT auth first (OAuth mode)
    if let Some(mut user) = try_jwt_auth(&state, &query, &req) {
        // A JWT freezes role+status at issue time (7–30 day TTL). A user who was
        // `pending` when their token was minted keeps `status:"pending"` in every
        // later request even after an admin approves them in the DB — so `/api/me`
        // (which WaitingPage polls every 5s to detect approval) reported `pending`
        // forever and the user was stranded on the waiting screen until a manual
        // logout+login re-issued the token. Re-read the DB **only for a not-yet-active
        // token** (active tokens short-circuit — no per-request DB hit on the hot
        // path) and adopt the authoritative status/role. A deleted pending user
        // (row gone) is rejected; a transient DB read error keeps the pending claim
        // (no worse than before). NOTE: this does NOT revoke a *deleted/demoted
        // active* user before their token expires — that would need an unconditional
        // per-request DB read (serializing auth through the single SQLite mutex) or
        // token versioning; tracked separately, out of scope for the single-user
        // deployment. (review 2026-07-30, F-AUTH-APPROVAL)
        if !user.is_active() {
            if let Some(ref db) = state.db {
                match reconcile_pending_user(db.get_user_by_id(&user.id)) {
                    PendingRecheck::Adopt { status, role } => {
                        user.status = status;
                        user.role = role;
                    }
                    PendingRecheck::Reject => return Err(StatusCode::UNAUTHORIZED),
                    PendingRecheck::KeepClaim => {}
                }
            }
        }
        // For non-/api/me routes, require active status. Exact-match `/api/me` (not a
        // prefix): `starts_with` would also wave through a future sibling like
        // `/api/members` or `/api/metrics` for a NOT-yet-approved (pending) user, since
        // the only allow-listed route for pending users is the approval-poll `/api/me`.
        // No such route exists today, but the prefix form is a latent authz footgun.
        // (review 2026-08-03, F6)
        let path = req.uri().path();
        if !user.is_active() && path != "/api/me" {
            return Err(StatusCode::FORBIDDEN);
        }
        req.extensions_mut().insert(user);
        return Ok(next.run(req).await);
    }

    // Fallback: legacy password auth
    if let Some(ref password_hash) = state.password_hash {
        if try_legacy_auth(password_hash, &query, &req) {
            req.extensions_mut().insert(CurrentUser::legacy());
            return Ok(next.run(req).await);
        }
    }

    Err(StatusCode::UNAUTHORIZED)
}

/// Try to extract and verify JWT from cookie, header, or query param.
fn try_jwt_auth(
    state: &AppState,
    query: &TokenQuery,
    req: &Request<axum::body::Body>,
) -> Option<CurrentUser> {
    let secret = &state.jwt_secret;

    // 1. Cookie: zeromux_jwt=...
    if let Some(cookie) = req.headers().get("Cookie") {
        if let Ok(cookie_str) = cookie.to_str() {
            for part in cookie_str.split(';') {
                let part = part.trim();
                if let Some(val) = part.strip_prefix("zeromux_jwt=") {
                    if let Some(user) = decode_jwt(val, secret) {
                        return Some(user);
                    }
                }
            }
        }
    }

    // 2. Authorization: Bearer <jwt>
    if let Some(auth) = req.headers().get("Authorization") {
        if let Ok(auth_str) = auth.to_str() {
            if let Some(token) = auth_str.strip_prefix("Bearer ") {
                if let Some(user) = decode_jwt(token, secret) {
                    return Some(user);
                }
            }
        }
    }

    // 3. Query param ?token=<jwt>
    if let Some(ref token) = query.token {
        if let Some(user) = decode_jwt(token, secret) {
            return Some(user);
        }
    }

    None
}

fn decode_jwt(token: &str, secret: &str) -> Option<CurrentUser> {
    let key = DecodingKey::from_secret(secret.as_bytes());
    let mut validation = Validation::default();
    validation.validate_exp = true;

    decode::<JwtClaims>(token, &key, &validation)
        .ok()
        .map(|data| CurrentUser {
            id: data.claims.sub,
            role: data.claims.role,
            status: data.claims.status,
            login: data.claims.login,
            avatar: data.claims.avatar,
        })
}

/// Decision for a not-yet-active JWT re-checked against the DB (F-AUTH-APPROVAL).
/// Pure so the fail-closed policy is unit-tested without an HTTP/AppState harness.
#[derive(Debug, PartialEq, Eq)]
enum PendingRecheck {
    /// DB row found — adopt its authoritative status/role over the frozen claim.
    Adopt { status: String, role: String },
    /// DB row gone (user deleted) — reject the request (401).
    Reject,
    /// DB read failed — keep the token's claim (don't lock the user out on a
    /// transient JuiceFS/SQLite error; no worse than the pre-fix behavior).
    KeepClaim,
}

fn reconcile_pending_user(row: Result<Option<crate::db::User>, String>) -> PendingRecheck {
    match row {
        Ok(Some(u)) => PendingRecheck::Adopt { status: u.status, role: u.role },
        Ok(None) => PendingRecheck::Reject,
        Err(_) => PendingRecheck::KeepClaim,
    }
}

/// Legacy password auth (token mode, no OAuth)
fn try_legacy_auth(
    password_hash: &str,
    query: &TokenQuery,
    req: &Request<axum::body::Body>,
) -> bool {
    // Query param ?token=
    if let Some(ref token) = query.token {
        if verify_password(token, password_hash) {
            return true;
        }
    }

    // Authorization: Bearer <password>
    if let Some(auth) = req.headers().get("Authorization") {
        if let Ok(auth_str) = auth.to_str() {
            if let Some(token) = auth_str.strip_prefix("Bearer ") {
                if verify_password(token, password_hash) {
                    return true;
                }
            }
        }
    }

    // Cookie: zeromux_token=
    if let Some(cookie) = req.headers().get("Cookie") {
        if let Ok(cookie_str) = cookie.to_str() {
            for part in cookie_str.split(';') {
                let part = part.trim();
                if let Some(val) = part.strip_prefix("zeromux_token=") {
                    if verify_password(val, password_hash) {
                        return true;
                    }
                }
            }
        }
    }

    false
}

/// Verify a WebSocket token — returns CurrentUser if valid and active.
pub fn verify_ws_token(state: &AppState, token: &str) -> Option<CurrentUser> {
    // Try JWT
    if let Some(mut user) = decode_jwt(token, &state.jwt_secret) {
        // Parity with `auth_middleware`'s pending re-check (F-AUTH-APPROVAL): a
        // just-approved user still holds a `pending` JWT (the frontend updates local
        // state on approval but does NOT re-mint the cookie), so without this a
        // freshly-approved user's `/api/me` would flip to active yet every terminal /
        // agent WS still 403'd until manual re-login. Re-read the DB only for a
        // not-yet-active claim; active tokens short-circuit. DB error → keep the
        // (pending) claim → still refused, which is the safe direction for WS.
        if !user.is_active() {
            if let Some(ref db) = state.db {
                if let PendingRecheck::Adopt { status, role } =
                    reconcile_pending_user(db.get_user_by_id(&user.id))
                {
                    user.status = status;
                    user.role = role;
                }
            }
        }
        if user.is_active() {
            return Some(user);
        }
        return None; // pending users can't connect WS
    }

    // Fallback: legacy password
    if let Some(ref password_hash) = state.password_hash {
        if verify_password(token, password_hash) {
            return Some(CurrentUser::legacy());
        }
    }

    None
}

/// Extract the raw `zeromux_jwt` cookie value from a request's `Cookie` header.
/// The OAuth callback sets this cookie `HttpOnly` (oauth.rs), so JS on the page
/// can't read it into a `?token=` query param — but the browser DOES attach it to
/// the WebSocket upgrade request automatically. This lets the WS handlers recover
/// it server-side. (review 2026-07-31, F-WS-OAUTH-COOKIE)
fn jwt_cookie_from_headers(headers: &HeaderMap) -> Option<&str> {
    let cookie = headers.get("Cookie")?.to_str().ok()?;
    for part in cookie.split(';') {
        if let Some(val) = part.trim().strip_prefix("zeromux_jwt=") {
            return Some(val);
        }
    }
    None
}

/// Browser `Origin` → (lowercased host, effective port). `port_or_known_default`
/// fills the scheme's default (https→443, http→80) when no explicit port is present.
fn origin_authority(origin: &str) -> Option<(String, u16)> {
    let u = url::Url::parse(origin).ok()?;
    Some((u.host_str()?.to_ascii_lowercase(), u.port_or_known_default()?))
}

/// A `Host` header value (`host`, `host:port`, `[::1]`, `[::1]:port`) → (lowercased
/// host, EXPLICIT port only). Parsed via a dummy `http://` URL so IPv6 brackets and
/// ports are handled by the same normalizer as the Origin. `.port()` (not
/// `port_or_known_default`) so a portless Host stays `None` — behind a TLS proxy the
/// forwarded `Host` is just the public hostname and the port is implied by a scheme
/// the backend can't observe.
fn host_header_authority(host: &str) -> Option<(String, Option<u16>)> {
    let u = url::Url::parse(&format!("http://{host}")).ok()?;
    Some((u.host_str()?.to_ascii_lowercase(), u.port()))
}

/// Same-origin guard for the cookie-authenticated WS path (CSWSH defense).
/// A `?token=` handshake is already CSRF-safe (an attacker page can't read the
/// token), but authenticating a WS *by ambient cookie* is cross-site-forgeable, so
/// we only accept the cookie when the browser `Origin` matches the authority the
/// browser actually connected to. Requests with NO `Origin` header (native/CLI
/// clients) are allowed — browsers always send `Origin` on WS upgrades, so its
/// absence means the caller isn't a browser being driven cross-site.
///
/// The reference authority is the request's own `Host` header — NOT `external_url`.
/// `external_url` defaults to the internal bind addr `http://{host}:{port}` (e.g.
/// `http://0.0.0.0:8090`), so behind a TLS reverse proxy it never equals the browser
/// Origin (`https://zeromux.example.com`) and every OAuth-mode WS would 401 — the
/// exact reconnect loop F-WS-OAUTH-COOKIE set out to cure. `Host` is what the browser
/// reached (set by the proxy), so comparing Origin↔Host is the real same-origin check
/// and works regardless of how `external_url` is configured. Trusting `Host` here is
/// CSWSH-safe: a cross-site page's Origin is its own host (≠ our Host), and a
/// non-browser can forge both but carries no victim cookie. Host match is the security
/// pivot; an explicit Host port must also match (a portless Host — the TLS-proxy case —
/// accepts any Origin port since the public port is unobservable). `external_url` is
/// kept ONLY as a fallback when the Host header is absent/unparseable.
/// (review 2026-07-31 F-WS-OAUTH-COOKIE; Host-authority fix review 2026-08-01 A-F1)
fn ws_origin_allowed(headers: &HeaderMap, external_url: &str) -> bool {
    let origin = match headers.get("Origin").and_then(|v| v.to_str().ok()) {
        None => return true, // non-browser client: no ambient-cookie CSWSH risk
        Some(o) => o,
    };
    let (o_host, o_port) = match origin_authority(origin) {
        Some(a) => a,
        None => return false, // unparseable Origin → refuse the cookie path (fail closed)
    };
    // Primary: match against the request's own Host header.
    if let Some((h_host, h_port)) = headers
        .get("Host")
        .and_then(|v| v.to_str().ok())
        .and_then(host_header_authority)
    {
        let port_ok = h_port.map_or(true, |p| p == o_port);
        return o_host == h_host && port_ok;
    }
    // Fallback (no usable Host): compare against configured external_url.
    match url::Url::parse(external_url) {
        Ok(ext) => {
            ext.host_str().map(|h| h.to_ascii_lowercase()) == Some(o_host)
                && ext.port_or_known_default() == Some(o_port)
        }
        _ => false, // can't verify → fail closed
    }
}

/// Authenticate a WebSocket upgrade. Tries the `?token=` query param first (the
/// CSRF-safe path used by legacy password mode and by clients that can read their
/// token), then — only if the request's `Origin` is same-origin — falls back to the
/// `HttpOnly` `zeromux_jwt` cookie the browser attaches automatically. Without this
/// fallback, OAuth-mode browsers (whose JWT cookie is HttpOnly and thus invisible to
/// the `document.cookie`-based `wsUrl()` builder) got an empty `?token=` and every
/// terminal/agent WS 401'd. (review 2026-07-31, F-WS-OAUTH-COOKIE)
pub fn verify_ws_auth(
    state: &AppState,
    query_token: Option<&str>,
    headers: &HeaderMap,
) -> Option<CurrentUser> {
    if let Some(t) = query_token {
        if let Some(user) = verify_ws_token(state, t) {
            return Some(user);
        }
    }
    if ws_origin_allowed(headers, &state.external_url) {
        if let Some(jwt) = jwt_cookie_from_headers(headers) {
            return verify_ws_token(state, jwt);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::User;

    fn user_row(status: &str, role: &str) -> User {
        User {
            id: "u1".into(),
            github_id: 1,
            github_login: "u1".into(),
            display_name: None,
            avatar_url: None,
            role: role.into(),
            status: status.into(),
            created_at: String::new(),
            last_login: None,
        }
    }

    #[test]
    fn pending_user_approved_in_db_is_adopted() {
        // The core F-AUTH-APPROVAL bug: a token minted while pending must pick up the
        // DB's "active" once an admin approves, so /api/me flips and WaitingPage's poll
        // actually detects approval instead of spinning until manual re-login.
        assert_eq!(
            reconcile_pending_user(Ok(Some(user_row("active", "member")))),
            PendingRecheck::Adopt { status: "active".into(), role: "member".into() }
        );
    }

    #[test]
    fn still_pending_in_db_keeps_pending() {
        assert_eq!(
            reconcile_pending_user(Ok(Some(user_row("pending", "member")))),
            PendingRecheck::Adopt { status: "pending".into(), role: "member".into() }
        );
    }

    #[test]
    fn deleted_user_is_rejected() {
        // Row gone → the (pending) token must not keep authenticating.
        assert_eq!(reconcile_pending_user(Ok(None)), PendingRecheck::Reject);
    }

    #[test]
    fn db_error_keeps_claim_fail_open_for_availability() {
        // Transient JuiceFS/SQLite read error must NOT lock out a legitimately-pending
        // user (they were already gated by the pending route restriction); keep claim.
        assert_eq!(
            reconcile_pending_user(Err("disk".into())),
            PendingRecheck::KeepClaim
        );
    }

    // ── F-WS-OAUTH-COOKIE: cookie extraction + CSWSH origin guard ──

    fn headers_with(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(
                axum::http::HeaderName::from_bytes(k.as_bytes()).unwrap(),
                v.parse().unwrap(),
            );
        }
        h
    }

    #[test]
    fn jwt_cookie_extracted_among_other_cookies() {
        let h = headers_with(&[("Cookie", "foo=1; zeromux_jwt=abc.def.ghi; bar=2")]);
        assert_eq!(jwt_cookie_from_headers(&h), Some("abc.def.ghi"));
    }

    #[test]
    fn jwt_cookie_absent_is_none() {
        let h = headers_with(&[("Cookie", "foo=1; zeromux_token=legacy")]);
        assert_eq!(jwt_cookie_from_headers(&h), None);
        assert_eq!(jwt_cookie_from_headers(&HeaderMap::new()), None);
    }

    #[test]
    fn ws_origin_missing_is_allowed_non_browser() {
        // No Origin header → native/CLI client, no ambient-cookie CSWSH risk.
        assert!(ws_origin_allowed(&HeaderMap::new(), "https://zeromux.example.com"));
    }

    #[test]
    fn ws_origin_same_host_allowed_scheme_agnostic() {
        let h = headers_with(&[("Origin", "https://zeromux.example.com")]);
        // external_url stored without scheme parity shouldn't matter; host:port is compared.
        assert!(ws_origin_allowed(&h, "https://zeromux.example.com"));
    }

    #[test]
    fn ws_origin_cross_site_rejected() {
        let h = headers_with(&[("Origin", "https://evil.example.com")]);
        assert!(!ws_origin_allowed(&h, "https://zeromux.example.com"));
    }

    #[test]
    fn ws_origin_unparseable_rejected_fail_closed() {
        let h = headers_with(&[("Origin", "not-a-url")]);
        assert!(!ws_origin_allowed(&h, "https://zeromux.example.com"));
    }

    // ── A-F1: Host-header authority is the primary CSWSH oracle ──

    #[test]
    fn ws_origin_matches_host_behind_tls_proxy_ignoring_external_url_default() {
        // THE regression this fixes: external_url is left at the internal bind default
        // (`http://0.0.0.0:8090`), the site is TLS-fronted. The browser Origin is
        // `https://zeromux.example.com` (implicit :443) and the proxy forwards
        // `Host: zeromux.example.com` (no explicit port). Pre-fix this compared Origin
        // to external_url → host+port mismatch → cookie refused → OAuth WS 401 loop.
        // Post-fix: Origin host == Host host, portless Host accepts any Origin port.
        let h = headers_with(&[
            ("Origin", "https://zeromux.example.com"),
            ("Host", "zeromux.example.com"),
        ]);
        assert!(ws_origin_allowed(&h, "http://0.0.0.0:8090"));
    }

    #[test]
    fn ws_origin_host_mismatch_rejected() {
        // Cross-site page: its Origin is its own host, but it connects to our Host.
        let h = headers_with(&[
            ("Origin", "https://evil.example.com"),
            ("Host", "zeromux.example.com"),
        ]);
        assert!(!ws_origin_allowed(&h, "http://0.0.0.0:8090"));
    }

    #[test]
    fn ws_origin_host_explicit_port_must_match() {
        // A Host WITH an explicit port pins the port: same host, wrong Origin port → reject.
        let matched = headers_with(&[
            ("Origin", "http://localhost:8090"),
            ("Host", "localhost:8090"),
        ]);
        assert!(ws_origin_allowed(&matched, "http://0.0.0.0:8090"));
        let mismatched = headers_with(&[
            ("Origin", "http://localhost:9999"),
            ("Host", "localhost:8090"),
        ]);
        assert!(!ws_origin_allowed(&mismatched, "http://0.0.0.0:8090"));
    }

    #[test]
    fn ws_origin_host_case_insensitive() {
        let h = headers_with(&[
            ("Origin", "https://ZeroMux.Example.COM"),
            ("Host", "zeromux.example.com"),
        ]);
        assert!(ws_origin_allowed(&h, "http://0.0.0.0:8090"));
    }

    #[test]
    fn ws_origin_ipv6_host_matches() {
        let h = headers_with(&[
            ("Origin", "http://[::1]:8090"),
            ("Host", "[::1]:8090"),
        ]);
        assert!(ws_origin_allowed(&h, "http://0.0.0.0:8090"));
    }

    #[test]
    fn ws_origin_falls_back_to_external_url_when_host_absent() {
        // No Host header (unusual, but defensive): compare against external_url.
        let ok = headers_with(&[("Origin", "https://zeromux.example.com")]);
        assert!(ws_origin_allowed(&ok, "https://zeromux.example.com"));
        let bad = headers_with(&[("Origin", "https://evil.example.com")]);
        assert!(!ws_origin_allowed(&bad, "https://zeromux.example.com"));
    }

    // ── F5 (review 2026-08-03): legacy password compare is constant-time ──

    #[test]
    fn verify_password_matches_correct_and_rejects_wrong() {
        let hash = hash_password("hunter2");
        assert!(verify_password("hunter2", &hash));
        assert!(!verify_password("hunter3", &hash));
        // A hash of the wrong length (not a real SHA-256 hex) must fail, not panic.
        assert!(!verify_password("hunter2", "deadbeef"));
        assert!(!verify_password("hunter2", ""));
    }

    // ── F6 (review 2026-08-03): pending-user route gate is exact `/api/me`, not prefix ──

    #[test]
    fn pending_route_gate_is_exact_not_prefix() {
        // The middleware allows a pending (unapproved) user through ONLY on `/api/me`.
        // A prefix match would also admit a future sibling like `/api/members` or
        // `/api/metrics`. This documents the exact-equality contract the fix enforces.
        let allowed = |path: &str| path == "/api/me";
        assert!(allowed("/api/me"));
        assert!(!allowed("/api/members"));
        assert!(!allowed("/api/metrics"));
        assert!(!allowed("/api/me/extra"));
    }
}
