use rusqlite::{params, Connection};
use std::path::Path;
use std::sync::Mutex;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AgentEvent {
    pub id: String,
    pub agent: String,
    pub event: String,
    pub summary: String,
    pub session_id: Option<String>,
    pub work_dir: Option<String>,
    pub metadata: Option<serde_json::Value>,
    pub timestamp: String,
}

#[derive(Debug, serde::Deserialize)]
pub struct CreateEventReq {
    pub agent: String,
    pub event: String,
    pub summary: Option<String>,
    pub session_id: Option<String>,
    pub work_dir: Option<String>,
    pub metadata: Option<serde_json::Value>,
    // NOTE: owner_id is intentionally NOT a field here — it is stamped
    // server-side from the authenticated user in `create`, never trusted
    // from the request body (which a hook token holder fully controls).
}

#[derive(Debug, serde::Deserialize, Default)]
pub struct EventsQuery {
    pub session_id: Option<String>,
    pub agent: Option<String>,
    pub event: Option<String>,
    pub since: Option<String>,
    pub limit: Option<usize>,
}

pub struct EventStore {
    conn: Mutex<Connection>,
}

impl EventStore {
    pub fn open(data_dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(data_dir)
            .map_err(|e| format!("Failed to create data dir: {}", e))?;

        let db_path = data_dir.join("events.db");
        let conn = Connection::open(&db_path)
            .map_err(|e| format!("Failed to open events database: {}", e))?;

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS agent_events (
                id          TEXT PRIMARY KEY,
                agent       TEXT NOT NULL,
                event       TEXT NOT NULL,
                summary     TEXT NOT NULL DEFAULT '',
                session_id  TEXT,
                work_dir    TEXT,
                metadata    TEXT,
                timestamp   TEXT NOT NULL,
                owner_id    TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_events_session ON agent_events(session_id);
            CREATE INDEX IF NOT EXISTS idx_events_timestamp ON agent_events(timestamp DESC);
            CREATE INDEX IF NOT EXISTS idx_events_agent ON agent_events(agent);",
        )
        .map_err(|e| format!("Failed to create events table: {}", e))?;

        // Migrate pre-existing DBs that lack the owner_id column (added for
        // per-user authorization). Legacy rows keep owner_id = NULL and are
        // therefore visible only to admins. Ignore the "duplicate column" error.
        let _ = conn.execute("ALTER TABLE agent_events ADD COLUMN owner_id TEXT", []);

        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Insert an event. `owner_id` is stamped server-side from the authenticated
    /// caller (never from the request body) so events are scoped to their owner.
    pub fn create(&self, req: CreateEventReq, owner_id: &str) -> Result<AgentEvent, String> {
        let conn = self.conn.lock().unwrap();
        let id = format!("evt_{}", &uuid::Uuid::new_v4().simple().to_string()[..12]);
        let timestamp = now_iso();
        let metadata_str = req.metadata.as_ref().map(|m| m.to_string());

        conn.execute(
            "INSERT INTO agent_events (id, agent, event, summary, session_id, work_dir, metadata, timestamp, owner_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                id,
                req.agent,
                req.event,
                req.summary.as_deref().unwrap_or(""),
                req.session_id,
                req.work_dir,
                metadata_str,
                timestamp,
                owner_id,
            ],
        )
        .map_err(|e| format!("Failed to insert event: {}", e))?;

        Ok(AgentEvent {
            id,
            agent: req.agent,
            event: req.event,
            summary: req.summary.unwrap_or_default(),
            session_id: req.session_id,
            work_dir: req.work_dir,
            metadata: req.metadata,
            timestamp,
        })
    }

    /// List events. `owner_filter` scopes results to one user's events; pass
    /// `None` for an admin (sees all, including legacy NULL-owner rows).
    pub fn list(&self, query: &EventsQuery, owner_filter: Option<&str>) -> Result<Vec<AgentEvent>, String> {
        let conn = self.conn.lock().unwrap();
        let limit = query.limit.unwrap_or(50).min(500);

        let mut sql = String::from(
            "SELECT id, agent, event, summary, session_id, work_dir, metadata, timestamp FROM agent_events WHERE 1=1"
        );
        let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

        if let Some(owner) = owner_filter {
            param_values.push(Box::new(owner.to_string()));
            sql.push_str(&format!(" AND owner_id = ?{}", param_values.len()));
        }
        if let Some(ref sid) = query.session_id {
            param_values.push(Box::new(sid.clone()));
            sql.push_str(&format!(" AND session_id = ?{}", param_values.len()));
        }
        if let Some(ref agent) = query.agent {
            param_values.push(Box::new(agent.clone()));
            sql.push_str(&format!(" AND agent = ?{}", param_values.len()));
        }
        if let Some(ref event) = query.event {
            param_values.push(Box::new(event.clone()));
            sql.push_str(&format!(" AND event = ?{}", param_values.len()));
        }
        if let Some(ref since) = query.since {
            param_values.push(Box::new(since.clone()));
            sql.push_str(&format!(" AND timestamp > ?{}", param_values.len()));
        }

        sql.push_str(" ORDER BY timestamp DESC");
        param_values.push(Box::new(limit as i64));
        sql.push_str(&format!(" LIMIT ?{}", param_values.len()));

        let mut stmt = conn.prepare(&sql).map_err(|e| format!("Query error: {}", e))?;

        let params_refs: Vec<&dyn rusqlite::types::ToSql> = param_values.iter().map(|p| p.as_ref()).collect();

        let events = stmt
            .query_map(params_refs.as_slice(), |row| {
                let metadata_str: Option<String> = row.get(6)?;
                let metadata = metadata_str.and_then(|s| serde_json::from_str(&s).ok());
                Ok(AgentEvent {
                    id: row.get(0)?,
                    agent: row.get(1)?,
                    event: row.get(2)?,
                    summary: row.get(3)?,
                    session_id: row.get(4)?,
                    work_dir: row.get(5)?,
                    metadata,
                    timestamp: row.get(7)?,
                })
            })
            .map_err(|e| format!("Query error: {}", e))?
            .filter_map(|r| r.ok())
            .collect();

        Ok(events)
    }

    /// Delete one event by id. `owner_filter` (None for admin) restricts the
    /// delete to the caller's own events so users can't delete others' rows.
    pub fn delete_one(&self, id: &str, owner_filter: Option<&str>) -> Result<bool, String> {
        let conn = self.conn.lock().unwrap();
        let rows = match owner_filter {
            Some(owner) => conn.execute(
                "DELETE FROM agent_events WHERE id = ?1 AND owner_id = ?2",
                params![id, owner],
            ),
            None => conn.execute("DELETE FROM agent_events WHERE id = ?1", params![id]),
        }
        .map_err(|e| format!("Delete error: {}", e))?;
        Ok(rows > 0)
    }

    pub fn delete_by_session(&self, session_id: &str) -> Result<usize, String> {
        let conn = self.conn.lock().unwrap();
        let rows = conn
            .execute("DELETE FROM agent_events WHERE session_id = ?1", params![session_id])
            .map_err(|e| format!("Delete error: {}", e))?;
        Ok(rows)
    }

    pub fn delete_before(&self, before: &str) -> Result<usize, String> {
        let conn = self.conn.lock().unwrap();
        let rows = conn
            .execute("DELETE FROM agent_events WHERE timestamp < ?1", params![before])
            .map_err(|e| format!("Delete error: {}", e))?;
        Ok(rows)
    }

    /// Drop events older than `days` (retention). `agent_events` grows by one row
    /// per agent turn with no cap, so without periodic pruning a long-lived
    /// server's DB grows unbounded.
    pub fn prune_older_than_days(&self, days: u64) -> Result<usize, String> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let cutoff = iso_from_secs(now.saturating_sub(days * 86400));
        self.delete_before(&cutoff)
    }
}

/// Truncate a free-form agent result to a short, single-line summary suitable
/// for the dashboard. Char-boundary-safe (`AcpEvent::Result.text` is arbitrary
/// model output, often multi-byte UTF-8 — naive byte slicing would panic).
pub fn summarize(text: &str, max_chars: usize) -> String {
    let one_line = text.replace('\n', " ");
    let trimmed = one_line.trim();
    if trimmed.chars().count() <= max_chars {
        trimmed.to_string()
    } else {
        let truncated: String = trimmed.chars().take(max_chars).collect();
        format!("{}…", truncated.trim_end())
    }
}

fn now_iso() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    iso_from_secs(secs)
}

/// Format a Unix-epoch second count as `YYYY-MM-DDTHH:MM:SSZ`.
fn iso_from_secs(secs: u64) -> String {
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

    fn mem_store() -> EventStore {
        // Reuse the schema by opening against a temp dir under the OS temp root.
        let dir = std::env::temp_dir().join(format!("zeromux-events-test-{}", uuid::Uuid::new_v4()));
        EventStore::open(&dir).unwrap()
    }

    fn req(agent: &str, event: &str, session: Option<&str>) -> CreateEventReq {
        CreateEventReq {
            agent: agent.to_string(),
            event: event.to_string(),
            summary: Some("did a thing".to_string()),
            session_id: session.map(String::from),
            work_dir: None,
            metadata: None,
        }
    }

    #[test]
    fn create_then_list_roundtrips() {
        let store = mem_store();
        let created = store.create(req("claude-code", "task_done", Some("sess-1")), "u1").unwrap();
        assert!(created.id.starts_with("evt_"));

        let all = store.list(&EventsQuery::default(), None).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].agent, "claude-code");
        assert_eq!(all[0].event, "task_done");
    }

    #[test]
    fn list_filters_by_session_and_agent() {
        let store = mem_store();
        store.create(req("claude-code", "task_done", Some("sess-1")), "u1").unwrap();
        store.create(req("codex", "task_done", Some("sess-2")), "u1").unwrap();
        store.create(req("kiro", "tool_use", Some("sess-1")), "u1").unwrap();

        let by_session = store.list(&EventsQuery {
            session_id: Some("sess-1".to_string()),
            ..Default::default()
        }, None).unwrap();
        assert_eq!(by_session.len(), 2);

        let by_agent = store.list(&EventsQuery {
            agent: Some("codex".to_string()),
            ..Default::default()
        }, None).unwrap();
        assert_eq!(by_agent.len(), 1);
        assert_eq!(by_agent[0].agent, "codex");
    }

    #[test]
    fn delete_one_removes_event() {
        let store = mem_store();
        let e = store.create(req("kiro", "task_done", None), "u1").unwrap();
        assert!(store.delete_one(&e.id, None).unwrap());
        assert!(!store.delete_one(&e.id, None).unwrap());
        assert_eq!(store.list(&EventsQuery::default(), None).unwrap().len(), 0);
    }

    #[test]
    fn list_scopes_to_owner() {
        let store = mem_store();
        store.create(req("claude-code", "task_done", Some("s1")), "alice").unwrap();
        store.create(req("codex", "task_done", Some("s2")), "bob").unwrap();

        // Each user sees only their own events.
        let alice = store.list(&EventsQuery::default(), Some("alice")).unwrap();
        assert_eq!(alice.len(), 1);
        assert_eq!(alice[0].agent, "claude-code");

        let bob = store.list(&EventsQuery::default(), Some("bob")).unwrap();
        assert_eq!(bob.len(), 1);
        assert_eq!(bob[0].agent, "codex");

        // Admin (None) sees all.
        assert_eq!(store.list(&EventsQuery::default(), None).unwrap().len(), 2);
    }

    #[test]
    fn delete_one_respects_owner_scope() {
        let store = mem_store();
        let e = store.create(req("kiro", "task_done", None), "alice").unwrap();

        // Bob cannot delete Alice's event.
        assert!(!store.delete_one(&e.id, Some("bob")).unwrap());
        assert_eq!(store.list(&EventsQuery::default(), None).unwrap().len(), 1);

        // Alice can.
        assert!(store.delete_one(&e.id, Some("alice")).unwrap());
        assert_eq!(store.list(&EventsQuery::default(), None).unwrap().len(), 0);
    }

    #[test]
    fn summarize_is_char_boundary_safe() {
        // Multi-byte UTF-8 that would panic under naive byte slicing.
        let s = "完成了登录页面的实现".repeat(40);
        let out = summarize(&s, 200);
        assert!(out.chars().count() <= 201); // 200 + ellipsis
        assert!(out.ends_with('…'));

        // Short input is returned as-is (newlines flattened).
        assert_eq!(summarize("line1\nline2", 200), "line1 line2");
    }
}
