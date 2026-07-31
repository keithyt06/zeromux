use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;
use std::sync::Mutex;

#[derive(Debug, Clone, serde::Serialize)]
pub struct User {
    pub id: String,
    pub github_id: i64,
    pub github_login: String,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    pub role: String,   // "admin" | "member"
    pub status: String, // "active" | "pending"
    pub created_at: String,
    pub last_login: Option<String>,
}

pub struct Database {
    conn: Mutex<Connection>,
}

impl Database {
    /// Open (or create) the SQLite database and initialize tables.
    pub fn open(data_dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(data_dir)
            .map_err(|e| format!("Failed to create data dir: {}", e))?;

        let db_path = data_dir.join("zeromux.db");
        let conn = Connection::open(&db_path)
            .map_err(|e| format!("Failed to open database: {}", e))?;

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                github_id INTEGER UNIQUE NOT NULL,
                github_login TEXT NOT NULL,
                display_name TEXT,
                avatar_url TEXT,
                role TEXT NOT NULL DEFAULT 'member',
                status TEXT NOT NULL DEFAULT 'pending',
                created_at TEXT NOT NULL,
                last_login TEXT
            );",
        )
        .map_err(|e| format!("Failed to create tables: {}", e))?;

        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Upsert a user from GitHub OAuth. Returns the user record.
    /// - First user ever → admin + active
    /// - User in allowed_users list → active
    /// - Otherwise → pending
    pub fn upsert_github_user(
        &self,
        github_id: i64,
        github_login: &str,
        display_name: Option<&str>,
        avatar_url: Option<&str>,
        allowed_users: &[String],
    ) -> Result<User, String> {
        let conn = self.conn.lock().unwrap();
        let now = now_iso();

        // Check if user already exists
        if let Some(mut user) = self.get_user_by_github_id_inner(&conn, github_id)? {
            // Update last_login and possibly changed profile info
            conn.execute(
                "UPDATE users SET github_login = ?1, display_name = ?2, avatar_url = ?3, last_login = ?4 WHERE id = ?5",
                params![github_login, display_name, avatar_url, now, user.id],
            ).map_err(|e| format!("Failed to update user: {}", e))?;
            user.github_login = github_login.to_string();
            user.display_name = display_name.map(|s| s.to_string());
            user.avatar_url = avatar_url.map(|s| s.to_string());
            user.last_login = Some(now);
            return Ok(user);
        }

        // New user — determine role and status
        let user_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM users", [], |row| row.get(0))
            .map_err(|e| format!("Failed to count users: {}", e))?;

        let (role, status) = if user_count == 0 {
            // First user is admin + active
            ("admin", "active")
        } else if allowed_users
            .iter()
            .any(|u| u.eq_ignore_ascii_case(github_login))
        {
            // In whitelist → active
            ("member", "active")
        } else {
            // Needs approval
            ("member", "pending")
        };

        let id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO users (id, github_id, github_login, display_name, avatar_url, role, status, created_at, last_login)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![id, github_id, github_login, display_name, avatar_url, role, status, now, now],
        )
        .map_err(|e| format!("Failed to insert user: {}", e))?;

        Ok(User {
            id,
            github_id,
            github_login: github_login.to_string(),
            display_name: display_name.map(|s| s.to_string()),
            avatar_url: avatar_url.map(|s| s.to_string()),
            role: role.to_string(),
            status: status.to_string(),
            created_at: now.clone(),
            last_login: Some(now),
        })
    }

    pub fn get_user_by_id(&self, id: &str) -> Result<Option<User>, String> {
        let conn = self.conn.lock().unwrap();
        self.get_user_by_id_inner(&conn, id)
    }

    fn get_user_by_id_inner(&self, conn: &Connection, id: &str) -> Result<Option<User>, String> {
        let mut stmt = conn
            .prepare("SELECT id, github_id, github_login, display_name, avatar_url, role, status, created_at, last_login FROM users WHERE id = ?1")
            .map_err(|e| format!("Query error: {}", e))?;

        // `.optional()` — NOT `.ok()`: `.ok()` collapses BOTH "no such row" and a
        // genuine read failure into `Ok(None)`. auth::reconcile_pending_user must tell
        // those apart (row gone → Reject/401; read error → KeepClaim/fail-open); with
        // `.ok()` a transient JuiceFS/SQLite blip looked like a deleted user and hard-401'd
        // a legitimately-pending session, the OPPOSITE of the documented fail-open intent.
        // `.optional()` maps only QueryReturnedNoRows → Ok(None) and propagates any other
        // Err. (review 2026-07-31, F-DB-READ-ERR-SWALLOW)
        let user = stmt
            .query_row(params![id], |row| {
                Ok(User {
                    id: row.get(0)?,
                    github_id: row.get(1)?,
                    github_login: row.get(2)?,
                    display_name: row.get(3)?,
                    avatar_url: row.get(4)?,
                    role: row.get(5)?,
                    status: row.get(6)?,
                    created_at: row.get(7)?,
                    last_login: row.get(8)?,
                })
            })
            .optional()
            .map_err(|e| format!("Query error: {}", e))?;

        Ok(user)
    }

    fn get_user_by_github_id_inner(
        &self,
        conn: &Connection,
        github_id: i64,
    ) -> Result<Option<User>, String> {
        let mut stmt = conn
            .prepare("SELECT id, github_id, github_login, display_name, avatar_url, role, status, created_at, last_login FROM users WHERE github_id = ?1")
            .map_err(|e| format!("Query error: {}", e))?;

        // `.optional()` not `.ok()` — same rationale as get_user_by_id_inner: a genuine
        // read error must propagate as Err rather than masquerade as "no existing user"
        // (which sends upsert_github_user down the new-user INSERT path — the UNIQUE
        // github_id then rejects it with a misleading "Failed to insert user" instead of
        // surfacing the real read failure). (review 2026-07-31, F-DB-READ-ERR-SWALLOW)
        let user = stmt
            .query_row(params![github_id], |row| {
                Ok(User {
                    id: row.get(0)?,
                    github_id: row.get(1)?,
                    github_login: row.get(2)?,
                    display_name: row.get(3)?,
                    avatar_url: row.get(4)?,
                    role: row.get(5)?,
                    status: row.get(6)?,
                    created_at: row.get(7)?,
                    last_login: row.get(8)?,
                })
            })
            .optional()
            .map_err(|e| format!("Query error: {}", e))?;

        Ok(user)
    }

    /// List all users (for admin panel)
    pub fn list_users(&self) -> Result<Vec<User>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, github_id, github_login, display_name, avatar_url, role, status, created_at, last_login FROM users ORDER BY created_at")
            .map_err(|e| format!("Query error: {}", e))?;

        let users = stmt
            .query_map([], |row| {
                Ok(User {
                    id: row.get(0)?,
                    github_id: row.get(1)?,
                    github_login: row.get(2)?,
                    display_name: row.get(3)?,
                    avatar_url: row.get(4)?,
                    role: row.get(5)?,
                    status: row.get(6)?,
                    created_at: row.get(7)?,
                    last_login: row.get(8)?,
                })
            })
            .map_err(|e| format!("Query error: {}", e))?
            .filter_map(|r| r.ok())
            .collect();

        Ok(users)
    }

    /// Approve a pending user (set status to active)
    pub fn approve_user(&self, user_id: &str) -> Result<bool, String> {
        let conn = self.conn.lock().unwrap();
        let rows = conn
            .execute(
                "UPDATE users SET status = 'active' WHERE id = ?1 AND status = 'pending'",
                params![user_id],
            )
            .map_err(|e| format!("Update error: {}", e))?;
        Ok(rows > 0)
    }

    /// Delete a user
    pub fn delete_user(&self, user_id: &str) -> Result<bool, String> {
        let conn = self.conn.lock().unwrap();
        let rows = conn
            .execute("DELETE FROM users WHERE id = ?1", params![user_id])
            .map_err(|e| format!("Delete error: {}", e))?;
        Ok(rows > 0)
    }
}

fn now_iso() -> String {
    let d = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = d.as_secs();
    // Simple ISO format without chrono
    let days = secs / 86400;
    let time_secs = secs % 86400;
    let h = time_secs / 3600;
    let m = (time_secs % 3600) / 60;
    let s = time_secs % 60;

    let mut y = 1970i64;
    let mut remaining = days as i64;
    loop {
        let diy = if is_leap(y) { 366 } else { 365 };
        if remaining < diy {
            break;
        }
        remaining -= diy;
        y += 1;
    }
    let months = if is_leap(y) {
        [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    };
    let mut mo = 1;
    for &md in &months {
        if remaining < md {
            break;
        }
        remaining -= md;
        mo += 1;
    }
    let day = remaining + 1;
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", y, mo, day, h, m, s)
}

fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open_tmp() -> (tempfile::TempDir, Database) {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path()).unwrap();
        (dir, db)
    }

    #[test]
    fn get_user_by_id_missing_row_is_ok_none() {
        // A genuinely absent user must be Ok(None) (→ reconcile_pending_user Reject → 401),
        // NOT an Err. This half must stay correct after the fix.
        let (_d, db) = open_tmp();
        assert!(matches!(db.get_user_by_id("nope"), Ok(None)));
    }

    #[test]
    fn get_user_by_id_read_error_is_err_not_none() {
        // REGRESSION GUARD (review 2026-07-31, F-DB-READ-ERR-SWALLOW): a genuine
        // query_row error (here forced with a type-incompatible github_id so the
        // i64 column map fails — a stand-in for any non-`QueryReturnedNoRows`
        // failure, e.g. a transient JuiceFS/SQLite read error) must surface as
        // Err, so auth's `reconcile_pending_user` can take its documented
        // `Err(_) => KeepClaim` (fail-open) branch. With the old `.ok()` the error
        // collapsed to `Ok(None)` → the row looked *deleted* → a pending user was
        // hard-401'd on a transient blip, the OPPOSITE of the fail-open intent, and
        // auth's `db_error_keeps_claim_fail_open_for_availability` test guarded a
        // path the real wiring could never reach.
        let (_d, db) = open_tmp();
        {
            let conn = db.conn.lock().unwrap();
            // SQLite is dynamically typed by default, so a TEXT github_id inserts fine
            // but breaks the `row.get::<_, i64>(1)` map at read time.
            conn.execute(
                "INSERT INTO users (id, github_id, github_login, role, status, created_at)
                 VALUES ('u1', 'not-an-integer', 'u1', 'member', 'pending', '1970-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
        }
        assert!(
            db.get_user_by_id("u1").is_err(),
            "a non-NoRows query_row error must propagate as Err, not be swallowed to Ok(None)"
        );
    }
}
