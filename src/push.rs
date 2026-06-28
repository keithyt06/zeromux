use std::path::Path;
use std::sync::Mutex;
use base64::Engine;
use rusqlite::{params, Connection};

#[derive(Clone)]
pub struct Vapid {
    pub pkcs8_pem: String,         // 私钥 PKCS8 PEM,喂 web-push from_pem
    pub public_key_b64url: String, // uncompressed point base64url,给前端 applicationServerKey
}

#[derive(serde::Serialize, serde::Deserialize)]
struct VapidFile {
    pkcs8_pem: String,
    public_key_b64url: String,
}

/// 读 ~/.zeromux/vapid.json;不存在则用 p256 生成 P-256 对、落盘(0600)。
pub fn load_or_generate_vapid(dir: &Path) -> Result<Vapid, String> {
    let path = dir.join("vapid.json");
    if let Ok(bytes) = std::fs::read(&path) {
        if let Ok(vf) = serde_json::from_slice::<VapidFile>(&bytes) {
            return Ok(Vapid {
                pkcs8_pem: vf.pkcs8_pem,
                public_key_b64url: vf.public_key_b64url,
            });
        }
    }
    // 生成
    use p256::ecdsa::SigningKey;
    use p256::pkcs8::EncodePrivateKey;
    // p256 0.13 uses rand_core 0.6; access via elliptic_curve re-export to avoid version conflicts
    let mut rng = p256::elliptic_curve::rand_core::OsRng;
    let sk = SigningKey::random(&mut rng);
    let pkcs8_pem = sk
        .to_pkcs8_pem(p256::pkcs8::LineEnding::LF)
        .map_err(|e| format!("pkcs8 pem: {e}"))?
        .to_string();
    // 公钥 uncompressed point (0x04 || X || Y) → base64url no-pad
    let vk = sk.verifying_key();
    let point = vk.to_encoded_point(false); // uncompressed
    let public_key_b64url =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(point.as_bytes());

    let vf = VapidFile {
        pkcs8_pem: pkcs8_pem.clone(),
        public_key_b64url: public_key_b64url.clone(),
    };
    std::fs::create_dir_all(dir).map_err(|e| format!("mkdir: {e}"))?;
    let json = serde_json::to_vec_pretty(&vf).map_err(|e| format!("ser: {e}"))?;
    std::fs::write(&path, &json).map_err(|e| format!("write: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(Vapid {
        pkcs8_pem,
        public_key_b64url,
    })
}

// ── Push subscriptions ────────────────────────────────────────────────────────

pub struct Subscription {
    pub endpoint: String,
    pub p256dh: String,
    pub auth: String,
}

pub struct PushStore {
    conn: Mutex<Connection>,
}

const CREATE_SQL: &str = "
CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint   TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    p256dh     TEXT NOT NULL,
    auth       TEXT NOT NULL,
    created_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);
";

impl PushStore {
    fn init(conn: Connection) -> Result<Self, String> {
        conn.execute_batch(CREATE_SQL)
            .map_err(|e| format!("push_store init: {e}"))?;
        Ok(PushStore { conn: Mutex::new(conn) })
    }

    pub fn open(db_path: &Path) -> Result<Self, String> {
        let conn = Connection::open(db_path)
            .map_err(|e| format!("push_store open: {e}"))?;
        Self::init(conn)
    }

    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory()
            .map_err(|e| format!("push_store in_memory: {e}"))?;
        Self::init(conn)
    }

    pub fn upsert(&self, user_id: &str, endpoint: &str, p256dh: &str, auth: &str) -> Result<(), String> {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_ms)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(endpoint) DO UPDATE SET
                 user_id    = excluded.user_id,
                 p256dh     = excluded.p256dh,
                 auth       = excluded.auth,
                 created_ms = excluded.created_ms",
            params![endpoint, user_id, p256dh, auth, now_ms],
        )
        .map_err(|e| format!("upsert: {e}"))?;
        Ok(())
    }

    pub fn list_for_user(&self, user_id: &str) -> Vec<Subscription> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = match conn.prepare(
            "SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?1",
        ) {
            Ok(s) => s,
            Err(_) => return vec![],
        };
        stmt.query_map(params![user_id], |row| {
            Ok(Subscription {
                endpoint: row.get(0)?,
                p256dh: row.get(1)?,
                auth: row.get(2)?,
            })
        })
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default()
    }

    pub fn delete(&self, endpoint: &str) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "DELETE FROM push_subscriptions WHERE endpoint = ?1",
            params![endpoint],
        );
    }

    /// Delete a subscription only if it belongs to `user_id`.
    /// Used by the /api/push/unsubscribe handler to prevent cross-user deletion.
    /// The internal 410-cleanup path uses `delete` (no user context available there).
    pub fn delete_for_user(&self, endpoint: &str, user_id: &str) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "DELETE FROM push_subscriptions WHERE endpoint = ?1 AND user_id = ?2",
            params![endpoint, user_id],
        );
    }
}

// ── SSRF guard ────────────────────────────────────────────────────────────────

/// True if an IPv4 address must not be the target of an outbound push request.
fn ipv4_blocked(v4: std::net::Ipv4Addr) -> bool {
    let o = v4.octets();
    v4.is_loopback()
        || v4.is_private()
        || v4.is_link_local()        // 169.254.0.0/16, incl. cloud metadata 169.254.169.254
        || v4.is_unspecified()
        || v4.is_broadcast()
        // CGNAT / shared address space 100.64.0.0/10 (is_shared() is still unstable)
        || (o[0] == 100 && (o[1] & 0xc0) == 64)
}

/// True if an IPv6 address must not be the target of an outbound push request.
/// IPv4-mapped/compatible forms are reclassified through `ipv4_blocked` so that
/// re-encoding an internal IPv4 as a v6 literal cannot bypass the v4 denylist.
fn ipv6_blocked(v6: std::net::Ipv6Addr) -> bool {
    if let Some(v4) = v6.to_ipv4_mapped() {
        return ipv4_blocked(v4);
    }
    v6.is_loopback()
        || v6.is_unspecified()
        || v6.is_unique_local()        // fc00::/7
        || v6.is_unicast_link_local()  // fe80::/10
}

pub fn endpoint_is_safe(endpoint: &str) -> bool {
    let url = match url::Url::parse(endpoint) {
        Ok(u) => u,
        Err(_) => return false,
    };
    if url.scheme() != "https" {
        return false;
    }
    // Use url::Host enum to correctly handle IPv4, IPv6, and domain cases.
    // NOTE: a domain that *resolves* to an internal IP (DNS rebinding) is not
    // caught here — that requires resolve-and-pin at connect time and is a
    // separate, larger change; the attacker model here is an approved user.
    match url.host() {
        None => false,
        Some(url::Host::Domain(d)) => !d.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(v4)) => !ipv4_blocked(v4),
        Some(url::Host::Ipv6(v6)) => !ipv6_blocked(v6),
    }
}

// ── Turn-done debounce + long-wait gate ──────────────────────────────────────

/// Pure function: should we send a turn_done push notification?
/// - turn_dur_ms < 60_000 → no (fast turns not worth waking phone)
/// - last_push_ms within 30_000 ms of now → no (debounce)
/// - otherwise → yes
pub fn should_push_turn_done(now_ms: i64, last_push_ms: Option<i64>, turn_dur_ms: i64) -> bool {
    if turn_dur_ms < 60_000 {
        return false;
    }
    match last_push_ms {
        Some(l) if now_ms - l < 30_000 => false,
        _ => true,
    }
}

/// Debounce for stuck pushes: at least 5 minutes between pushes per session.
/// The silence-threshold (600s) gating is done by the caller; this only
/// suppresses repeats. Uses a SEPARATE debounce map from turn_done so the two
/// kinds never overwrite each other.
pub fn should_push_stuck(now_ms: i64, last_push_ms: Option<i64>) -> bool {
    match last_push_ms {
        Some(l) if now_ms - l < 5 * 60_000 => false,
        _ => true,
    }
}

// ── PushPayload + text generation ────────────────────────────────────────────

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct PushPayload {
    pub kind: String,
    pub session_id: String,
    pub title: String,
    pub body: String,
}

fn failure_kind_zh(fk: Option<&str>) -> &'static str {
    match fk {
        Some("idle_timeout") => "因空闲超时中断",
        Some("watchdog_timeout") => "因运行超时中断",
        Some("orphaned_restart") => "因重启中断",
        Some("cli_error") => "传输错误",
        Some("cli_exited") => "进程退出",
        _ => "运行中断",
    }
}

pub fn payload_for(kind: &str, name: &str, session_id: &str, fk: Option<&str>) -> PushPayload {
    let (title, body) = match kind {
        "turn_done" => (format!("✅ {name} 完成"), "本轮已结束".to_string()),
        "run_failed" => (
            format!("⚠️ {name} 失败"),
            // strip leading "因" for body, keep the rest
            failure_kind_zh(fk)
                .trim_start_matches('因')
                .to_string(),
        ),
        "confirm" => (
            format!("❓ {name} 需确认"),
            format!("{},等待确认", failure_kind_zh(fk)),
        ),
        "stuck" => (
            format!("⚠️ {name} 可能卡住"),
            "已静默约 10 分钟无输出".to_string(),
        ),
        _ => (name.to_string(), String::new()),
    };
    PushPayload {
        kind: kind.to_string(),
        session_id: session_id.to_string(),
        title,
        body,
    }
}

pub fn confirm_batch_payload(n: usize) -> PushPayload {
    PushPayload {
        kind: "confirm".into(),
        session_id: String::new(),
        title: format!("❓ {n} 个任务待确认"),
        body: "重启后需逐一确认".into(),
    }
}

// ── Delivery outcome + 410 pruning ───────────────────────────────────────────

#[derive(PartialEq, Debug)]
pub enum DeliveryOutcome {
    Ok,
    Gone,
    TransientErr,
}

pub fn handle_delivery_outcome(store: &PushStore, endpoint: &str, o: DeliveryOutcome) {
    if o == DeliveryOutcome::Gone {
        store.delete(endpoint);
    }
}

// ── PushService ───────────────────────────────────────────────────────────────

pub struct PushService {
    pub vapid: Vapid,
    /// VAPID keypair parsed once at construction; ES256KeyPair is Send+Sync (plain p256 bytes)
    vapid_kp: web_push_native::jwt_simple::algorithms::ES256KeyPair,
    pub store: std::sync::Arc<PushStore>,
    pub client: reqwest::Client,
    /// Debounce map: (user_id, session_id) → last turn_done push epoch_ms
    pub debounce: Mutex<std::collections::HashMap<(String, String), i64>>,
    /// Separate debounce map for stuck pushes: (user_id, session_id) → last stuck push epoch_ms.
    /// Distinct from `debounce` so stuck and turn_done never overwrite each other.
    pub stuck_debounce: Mutex<std::collections::HashMap<(String, String), i64>>,
}

impl PushService {
    pub fn new(vapid: Vapid, store: std::sync::Arc<PushStore>, client: reqwest::Client) -> Result<Self, String> {
        let vapid_kp = web_push_native::jwt_simple::algorithms::ES256KeyPair::from_pem(
            &vapid.pkcs8_pem,
        )
        .map_err(|e| format!("push: load vapid key: {e}"))?;
        Ok(PushService {
            vapid,
            vapid_kp,
            store,
            client,
            debounce: Mutex::new(std::collections::HashMap::new()),
            stuck_debounce: Mutex::new(std::collections::HashMap::new()),
        })
    }

    /// Returns the VAPID public key as a base64url string (for the frontend).
    pub fn vapid_public_key(&self) -> String {
        self.vapid.public_key_b64url.clone()
    }

    /// Returns a reference to the underlying push subscription store.
    pub fn store(&self) -> &PushStore {
        &self.store
    }

    /// Returns the last epoch_ms at which a turn_done push was sent for this
    /// (user_id, session_id) pair. None if never pushed.
    /// Note: 0 is treated as "never pushed" (epoch_ms is always > 0 in practice).
    pub fn last_turn_push(&self, user_id: &str, session_id: &str) -> Option<i64> {
        let map = self.debounce.lock().unwrap();
        let v = map.get(&(user_id.to_string(), session_id.to_string())).copied()?;
        if v == 0 { None } else { Some(v) }
    }

    /// Record that we just sent a turn_done push for this (user_id, session_id).
    pub fn mark_turn_pushed(&self, user_id: &str, session_id: &str, now_ms: i64) {
        let mut map = self.debounce.lock().unwrap();
        map.insert((user_id.to_string(), session_id.to_string()), now_ms);
    }

    /// Returns the last epoch_ms at which a stuck push was sent for this
    /// (user_id, session_id) pair. None if never pushed. Reads the separate
    /// stuck_debounce map (never the turn_done map).
    pub fn last_stuck_push(&self, user_id: &str, session_id: &str) -> Option<i64> {
        let map = self.stuck_debounce.lock().unwrap();
        map.get(&(user_id.to_string(), session_id.to_string())).copied()
    }

    /// Record that we just sent a stuck push for this (user_id, session_id).
    pub fn mark_stuck_pushed(&self, user_id: &str, session_id: &str, now_ms: i64) {
        let mut map = self.stuck_debounce.lock().unwrap();
        map.insert((user_id.to_string(), session_id.to_string()), now_ms);
    }

    /// Fire-and-forget: call via tokio::spawn.
    /// Sends `payload` to every subscription of `user_id`.
    /// Each subscription is tried independently; errors are logged, not propagated.
    /// Debounce/filtering for turn_done is the caller's responsibility (session_manager
    /// uses should_push_turn_done + mark_turn_pushed before calling this).
    pub async fn send_to_user(&self, user_id: &str, payload: &PushPayload) {
        let subs = self.store.list_for_user(user_id);
        let json_bytes = match serde_json::to_vec(payload) {
            Ok(b) => b,
            Err(e) => {
                tracing::warn!("push: serialize payload: {e}");
                return;
            }
        };

        let urgency = if payload.kind == "turn_done" { "low" } else { "high" };

        for sub in subs {
            if !endpoint_is_safe(&sub.endpoint) {
                tracing::warn!("push: skipping unsafe endpoint: {}", sub.endpoint);
                continue;
            }

            let outcome = self
                .deliver_one(&sub, &json_bytes, &self.vapid_kp, urgency)
                .await;
            handle_delivery_outcome(&self.store, &sub.endpoint, outcome);
        }
    }

    async fn deliver_one(
        &self,
        sub: &Subscription,
        body: &[u8],
        vapid_kp: &web_push_native::jwt_simple::algorithms::ES256KeyPair,
        urgency: &str,
    ) -> DeliveryOutcome {
        use base64::Engine;
        use web_push_native::{Auth, WebPushBuilder};

        // Decode subscription keys
        let p256dh_bytes = match base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(&sub.p256dh)
        {
            Ok(b) => b,
            Err(e) => {
                tracing::warn!("push: decode p256dh for {}: {e}", sub.endpoint);
                return DeliveryOutcome::TransientErr;
            }
        };
        let auth_bytes = match base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(&sub.auth) {
            Ok(b) => b,
            Err(e) => {
                tracing::warn!("push: decode auth for {}: {e}", sub.endpoint);
                return DeliveryOutcome::TransientErr;
            }
        };

        let ua_public =
            match web_push_native::p256::PublicKey::from_sec1_bytes(&p256dh_bytes) {
                Ok(k) => k,
                Err(e) => {
                    tracing::warn!("push: parse p256dh for {}: {e}", sub.endpoint);
                    return DeliveryOutcome::TransientErr;
                }
            };

        if auth_bytes.len() != 16 {
            tracing::warn!(
                "push: auth must be 16 bytes for {}, got {}",
                sub.endpoint,
                auth_bytes.len()
            );
            return DeliveryOutcome::TransientErr;
        }
        let ua_auth = Auth::clone_from_slice(&auth_bytes);

        let endpoint_uri: http::Uri = match sub.endpoint.parse() {
            Ok(u) => u,
            Err(e) => {
                tracing::warn!("push: parse endpoint uri for {}: {e}", sub.endpoint);
                return DeliveryOutcome::TransientErr;
            }
        };

        let builder =
            WebPushBuilder::new(endpoint_uri, ua_public, ua_auth)
                .with_vapid(vapid_kp, "mailto:admin@zeromux.keithyu.cloud");

        let req: http::Request<Vec<u8>> = match builder.build(body.to_vec()) {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!("push: build request for {}: {e}", sub.endpoint);
                return DeliveryOutcome::TransientErr;
            }
        };

        // Convert http::Request → reqwest request
        let mut rb = self.client.post(&sub.endpoint);
        for (name, value) in req.headers() {
            rb = rb.header(name, value);
        }
        rb = rb
            .header("Urgency", urgency)
            .body(req.into_body());

        match rb.send().await {
            Ok(resp) => {
                let status = resp.status().as_u16();
                if status == 404 || status == 410 {
                    DeliveryOutcome::Gone
                } else if (200..300).contains(&status) {
                    DeliveryOutcome::Ok
                } else {
                    tracing::warn!(
                        "push: transient error {} for {}",
                        status,
                        sub.endpoint
                    );
                    DeliveryOutcome::TransientErr
                }
            }
            Err(e) => {
                tracing::warn!("push: send error for {}: {e}", sub.endpoint);
                DeliveryOutcome::TransientErr
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn payload_text_by_kind() {
        let t = payload_for("turn_done", "重构会话", "s1", None);
        assert!(t.title.contains("重构会话") && t.title.contains("完成"));
        let f = payload_for("run_failed", "夜跑", "s2", Some("idle_timeout"));
        assert!(f.title.contains("失败"));
        assert!(f.body.contains("空闲") || f.body.contains("超时")); // failure_kind 中文
        let c = payload_for("confirm", "备份任务", "s3", Some("watchdog_timeout"));
        assert!(c.title.contains("需确认"));
        assert!(c.body.contains("中断")); // 含中断原因
        let batch = confirm_batch_payload(3);
        assert!(batch.title.contains("3") && batch.title.contains("确认"));
    }

    #[test]
    fn gone_outcome_removes_subscription() {
        let store = PushStore::open_in_memory().unwrap();
        store.upsert("u1", "https://ep/gone", "p", "a").unwrap();
        handle_delivery_outcome(&store, "https://ep/gone", DeliveryOutcome::Gone);
        assert_eq!(store.list_for_user("u1").len(), 0);
        store.upsert("u1", "https://ep/ok", "p", "a").unwrap();
        handle_delivery_outcome(&store, "https://ep/ok", DeliveryOutcome::TransientErr);
        assert_eq!(store.list_for_user("u1").len(), 1); // 非 Gone 不删
    }

    #[test]
    fn endpoint_ssrf_validation() {
        assert!(endpoint_is_safe("https://fcm.googleapis.com/fcm/send/abc"));
        assert!(endpoint_is_safe("https://updates.push.services.mozilla.com/wpush/v2/x"));
        assert!(!endpoint_is_safe("http://fcm.googleapis.com/x"));   // 非 https
        assert!(!endpoint_is_safe("https://localhost/x"));
        assert!(!endpoint_is_safe("https://127.0.0.1/x"));
        assert!(!endpoint_is_safe("https://10.0.0.5/x"));
        assert!(!endpoint_is_safe("https://192.168.1.1/x"));
        assert!(!endpoint_is_safe("https://[::1]/x"));
        assert!(!endpoint_is_safe("not a url"));
        // IPv6 parity (regression): the v6 branch previously only checked
        // loopback/unspecified, so IPv4-mapped, ULA and link-local v6 all slipped
        // through — including the cloud metadata address re-encoded as v6.
        assert!(!endpoint_is_safe("https://[::ffff:127.0.0.1]/x"));      // mapped loopback
        assert!(!endpoint_is_safe("https://[::ffff:169.254.169.254]/x")); // mapped metadata
        assert!(!endpoint_is_safe("https://[::ffff:10.0.0.5]/x"));        // mapped RFC1918
        assert!(!endpoint_is_safe("https://[fc00::1]/x"));               // unique-local
        assert!(!endpoint_is_safe("https://[fe80::1]/x"));               // link-local
        assert!(!endpoint_is_safe("https://169.254.169.254/x"));         // metadata stays blocked
        assert!(!endpoint_is_safe("https://100.64.0.1/x"));              // CGNAT / shared
    }

    #[test]
    fn push_store_upsert_list_delete() {
        let store = PushStore::open_in_memory().unwrap();
        store.upsert("u1", "https://ep/a", "p1", "a1").unwrap();
        store.upsert("u1", "https://ep/b", "p2", "a2").unwrap();
        store.upsert("u1", "https://ep/a", "p1b", "a1b").unwrap(); // 同 endpoint upsert
        store.upsert("u2", "https://ep/c", "p3", "a3").unwrap();
        let mut u1 = store.list_for_user("u1");
        u1.sort_by(|a, b| a.endpoint.cmp(&b.endpoint));
        assert_eq!(u1.len(), 2);                       // a(更新后) + b,不重复
        assert_eq!(u1[0].p256dh, "p1b");               // upsert 覆盖
        store.delete("https://ep/a");
        assert_eq!(store.list_for_user("u1").len(), 1);
    }

    #[test]
    fn delete_for_user_scopes_to_owner() {
        let store = PushStore::open_in_memory().unwrap();
        // Two users, each with their own distinct endpoint
        store.upsert("u1", "https://ep/u1", "p1", "a1").unwrap();
        store.upsert("u2", "https://ep/u2", "p2", "a2").unwrap();

        // u2 tries to delete u1's endpoint — must be a no-op
        store.delete_for_user("https://ep/u1", "u2");
        assert_eq!(store.list_for_user("u1").len(), 1, "u1 sub must survive u2 delete attempt");

        // u2's sub must also be untouched after the failed cross-user delete
        assert_eq!(store.list_for_user("u2").len(), 1, "u2 sub must be unaffected");

        // u1 deletes their own endpoint — must succeed
        store.delete_for_user("https://ep/u1", "u1");
        assert_eq!(store.list_for_user("u1").len(), 0, "u1 sub must be gone after owner deletes it");

        // u2's sub is still untouched
        assert_eq!(store.list_for_user("u2").len(), 1, "u2 sub must remain after u1 deletes their own");
    }

    #[test]
    fn turn_done_debounce_and_threshold() {
        // 久候门槛 60s + 去抖 30s
        assert!(!should_push_turn_done(100_000, None, 5_000));               // turn 仅5s < 60s 不推
        assert!(should_push_turn_done(100_000, None, 70_000));               // 70s 久候 推
        assert!(!should_push_turn_done(100_000, Some(90_000), 70_000));      // 距上次 10s < 30s 去抖
        assert!(should_push_turn_done(200_000, Some(90_000), 70_000));       // 距上次 110s 推
    }

    #[test]
    fn should_push_stuck_debounces() {
        // never pushed → push
        assert!(should_push_stuck(1_000_000, None));
        // pushed 4min ago → still debounced (< 5min)
        assert!(!should_push_stuck(1_000_000, Some(1_000_000 - 4 * 60_000)));
        // pushed 6min ago → push again
        assert!(should_push_stuck(1_000_000, Some(1_000_000 - 6 * 60_000)));
    }

    #[test]
    fn stuck_payload_shape() {
        let p = payload_for("stuck", "my-sess", "sid123", None);
        assert!(p.title.contains("卡住"));
        assert_eq!(p.kind, "stuck");
    }

    #[test]
    fn stuck_and_turn_done_debounce_isolated() {
        // Real isolation test: the two debounce kinds use SEPARATE maps, so marking
        // a stuck push must not be visible to the turn_done lookup, and vice versa.
        // PushService::new only parses the VAPID PEM (no network), so a bare instance
        // is cheap to build here — same in-memory pattern as the vapid/store tests.
        let dir = std::env::temp_dir().join(format!("zmx-push-isolate-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let _ = fs::remove_file(dir.join("vapid.json"));
        let vapid = load_or_generate_vapid(&dir).unwrap();
        let store = std::sync::Arc::new(PushStore::open_in_memory().unwrap());
        let svc = PushService::new(vapid, store, reqwest::Client::new()).unwrap();

        let (u, s, t) = ("u1", "sess1", 1_000_000_i64);

        // Marking a stuck push must NOT leak into the turn_done map.
        svc.mark_stuck_pushed(u, s, t);
        assert_eq!(svc.last_stuck_push(u, s), Some(t));
        assert_eq!(svc.last_turn_push(u, s), None, "stuck mark must not appear in turn_done map");

        // And vice versa: marking a turn_done push must NOT leak into the stuck map.
        let (u2, s2, t2) = ("u2", "sess2", 2_000_000_i64);
        svc.mark_turn_pushed(u2, s2, t2);
        assert_eq!(svc.last_turn_push(u2, s2), Some(t2));
        assert_eq!(svc.last_stuck_push(u2, s2), None, "turn_done mark must not appear in stuck map");

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn vapid_load_or_generate_idempotent() {
        let dir = std::env::temp_dir().join(format!("zmx-vapid-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let _ = fs::remove_file(dir.join("vapid.json"));
        let a = load_or_generate_vapid(&dir).unwrap();
        let b = load_or_generate_vapid(&dir).unwrap(); // 第二次应读回同一对
        assert_eq!(a.pkcs8_pem, b.pkcs8_pem);
        assert_eq!(a.public_key_b64url, b.public_key_b64url);
        assert!(a.pkcs8_pem.contains("BEGIN PRIVATE KEY")); // PKCS8
        assert!(!a.public_key_b64url.contains('+') && !a.public_key_b64url.contains('/')); // base64url 无 +/
        assert!(a.public_key_b64url.len() > 80); // uncompressed P-256 point = 65 bytes → ~87 b64url chars
        fs::remove_dir_all(&dir).ok();
    }
}
