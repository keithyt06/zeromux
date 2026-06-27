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
}

// ── SSRF guard ────────────────────────────────────────────────────────────────

pub fn endpoint_is_safe(endpoint: &str) -> bool {
    let url = match url::Url::parse(endpoint) {
        Ok(u) => u,
        Err(_) => return false,
    };
    if url.scheme() != "https" {
        return false;
    }
    // Use url::Host enum to correctly handle IPv4, IPv6, and domain cases
    match url.host() {
        None => return false,
        Some(url::Host::Domain(d)) => {
            if d.eq_ignore_ascii_case("localhost") {
                return false;
            }
        }
        Some(url::Host::Ipv4(v4)) => {
            if v4.is_loopback() || v4.is_private() || v4.is_link_local() || v4.is_unspecified() {
                return false;
            }
        }
        Some(url::Host::Ipv6(v6)) => {
            if v6.is_loopback() || v6.is_unspecified() {
                return false;
            }
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

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
