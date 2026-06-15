use rusqlite::{params, Connection};
use std::path::Path;
use std::sync::Mutex;

/// Caps: guard against abuse / runaway payloads. body is generous (a preset
/// can be a long instruction) but bounded.
const TITLE_MAX: usize = 200;
const BODY_MAX: usize = 20_000;

#[derive(Debug, Clone, serde::Serialize, PartialEq)]
pub struct PromptPreset {
    pub id: String,
    pub title: String,
    pub body: String,
    pub created_at: String,
    pub updated_at: String,
    pub sort_order: i64,
}

pub struct PromptPresetStore {
    conn: Mutex<Connection>,
}

impl PromptPresetStore {
    pub fn open(data_dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(data_dir)
            .map_err(|e| format!("Failed to create data dir: {}", e))?;
        let db_path = data_dir.join("prompts.db");
        let conn = Connection::open(&db_path)
            .map_err(|e| format!("Failed to open prompts database: {}", e))?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS prompt_presets (
                id          TEXT PRIMARY KEY,
                title       TEXT NOT NULL,
                body        TEXT NOT NULL,
                created_at  TEXT NOT NULL,
                updated_at  TEXT NOT NULL,
                sort_order  INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_prompt_presets_sort
                ON prompt_presets(sort_order, created_at);",
        )
        .map_err(|e| format!("Failed to create prompt_presets table: {}", e))?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    pub fn list(&self) -> Result<Vec<PromptPreset>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, title, body, created_at, updated_at, sort_order
                 FROM prompt_presets ORDER BY sort_order, created_at",
            )
            .map_err(|e| format!("Query error: {}", e))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(PromptPreset {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    body: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                    sort_order: row.get(5)?,
                })
            })
            .map_err(|e| format!("Query error: {}", e))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| format!("Row error: {}", e))?);
        }
        Ok(out)
    }

    /// Returns Err("empty") when title or body is blank, Err("too long")
    /// when over caps. Never logs the body (may hold secrets).
    pub fn create(&self, title: &str, body: &str) -> Result<PromptPreset, String> {
        let title = title.trim();
        let body = body.trim();
        if title.is_empty() || body.is_empty() {
            return Err("empty".into());
        }
        if title.chars().count() > TITLE_MAX || body.chars().count() > BODY_MAX {
            return Err("too long".into());
        }
        let id = short_uuid();
        let now = now_iso();
        let conn = self.conn.lock().unwrap();
        // Hold ONE lock across MAX + INSERT so concurrent creates don't race sort_order.
        let next: i64 = conn
            .query_row(
                "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM prompt_presets",
                [],
                |row| row.get(0),
            )
            .map_err(|e| format!("Query error: {}", e))?;
        conn.execute(
            "INSERT INTO prompt_presets (id, title, body, created_at, updated_at, sort_order)
             VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
            params![id, title, body, now, next],
        )
        .map_err(|e| format!("Insert error: {}", e))?;
        Ok(PromptPreset {
            id,
            title: title.to_string(),
            body: body.to_string(),
            created_at: now.clone(),
            updated_at: now,
            sort_order: next,
        })
    }

    /// Updates only the provided fields. Both None (empty PUT) -> Ok(false),
    /// no row touched. Blank/over-cap field -> Err. Returns whether a row matched.
    pub fn update(
        &self,
        id: &str,
        title: Option<&str>,
        body: Option<&str>,
    ) -> Result<bool, String> {
        if title.is_none() && body.is_none() {
            return Ok(false);
        }
        let title = match title {
            Some(t) => {
                let t = t.trim();
                if t.is_empty() {
                    return Err("empty".into());
                }
                if t.chars().count() > TITLE_MAX {
                    return Err("too long".into());
                }
                Some(t.to_string())
            }
            None => None,
        };
        let body = match body {
            Some(b) => {
                let b = b.trim();
                if b.is_empty() {
                    return Err("empty".into());
                }
                if b.chars().count() > BODY_MAX {
                    return Err("too long".into());
                }
                Some(b.to_string())
            }
            None => None,
        };
        let now = now_iso();
        let conn = self.conn.lock().unwrap();
        let rows = match (title, body) {
            (Some(t), Some(b)) => conn.execute(
                "UPDATE prompt_presets SET title=?2, body=?3, updated_at=?4 WHERE id=?1",
                params![id, t, b, now],
            ),
            (Some(t), None) => conn.execute(
                "UPDATE prompt_presets SET title=?2, updated_at=?3 WHERE id=?1",
                params![id, t, now],
            ),
            (None, Some(b)) => conn.execute(
                "UPDATE prompt_presets SET body=?2, updated_at=?3 WHERE id=?1",
                params![id, b, now],
            ),
            (None, None) => unreachable!(),
        }
        .map_err(|e| format!("Update error: {}", e))?;
        Ok(rows > 0)
    }

    pub fn delete(&self, id: &str) -> Result<bool, String> {
        let conn = self.conn.lock().unwrap();
        let rows = conn
            .execute("DELETE FROM prompt_presets WHERE id = ?1", params![id])
            .map_err(|e| format!("Delete error: {}", e))?;
        Ok(rows > 0)
    }
}

// Private to notes.rs — duplicated here (two tiny fns, not worth a shared util).
fn short_uuid() -> String {
    uuid::Uuid::new_v4().to_string().replace('-', "")[..8].to_string()
}

fn now_iso() -> String {
    // The store only needs a monotonic, comparable timestamp string (never parsed
    // back, only displayed/ordered). UTC epoch seconds is sufficient.
    let d = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}", d.as_secs())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Mirror session_store.rs: return the TempDir guard so it isn't dropped
    // (which would delete the DB out from under the store mid-test).
    fn tmp_store() -> (PromptPresetStore, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let store = PromptPresetStore::open(dir.path()).unwrap();
        (store, dir)
    }

    #[test]
    fn create_then_list_orders_by_sort() {
        let (s, _d) = tmp_store();
        let a = s.create("first", "body1").unwrap();
        let b = s.create("second", "body2").unwrap();
        let all = s.list().unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].id, a.id);
        assert_eq!(all[1].id, b.id);
        assert!(b.sort_order > a.sort_order);
    }

    #[test]
    fn create_rejects_empty() {
        let (s, _d) = tmp_store();
        assert!(s.create("", "body").is_err());
        assert!(s.create("title", "   ").is_err());
        assert_eq!(s.list().unwrap().len(), 0);
    }

    #[test]
    fn create_rejects_too_long() {
        let (s, _d) = tmp_store();
        let long_title: String = "x".repeat(TITLE_MAX + 1);
        assert!(s.create(&long_title, "body").is_err());
        let long_body: String = "y".repeat(BODY_MAX + 1);
        assert!(s.create("title", &long_body).is_err());
    }

    #[test]
    fn update_title_only_keeps_body_and_bumps_updated_at() {
        let (s, _d) = tmp_store();
        let p = s.create("t", "b").unwrap();
        let hit = s.update(&p.id, Some("t2"), None).unwrap();
        assert!(hit);
        let row = s.list().unwrap().into_iter().next().unwrap();
        assert_eq!(row.title, "t2");
        assert_eq!(row.body, "b");
        assert!(row.updated_at >= p.updated_at);
    }

    #[test]
    fn update_missing_id_returns_false() {
        let (s, _d) = tmp_store();
        assert_eq!(s.update("nope", Some("x"), None).unwrap(), false);
    }

    #[test]
    fn update_empty_put_is_noop_false() {
        let (s, _d) = tmp_store();
        let p = s.create("t", "b").unwrap();
        assert_eq!(s.update(&p.id, None, None).unwrap(), false);
        let row = s.list().unwrap().into_iter().next().unwrap();
        assert_eq!(row.updated_at, p.updated_at); // untouched
    }

    #[test]
    fn update_blank_field_errors() {
        let (s, _d) = tmp_store();
        let p = s.create("t", "b").unwrap();
        assert!(s.update(&p.id, Some("   "), None).is_err());
        let row = s.list().unwrap().into_iter().next().unwrap();
        assert_eq!(row.title, "t"); // not changed
    }

    #[test]
    fn delete_hit_then_miss() {
        let (s, _d) = tmp_store();
        let p = s.create("t", "b").unwrap();
        assert_eq!(s.delete(&p.id).unwrap(), true);
        assert_eq!(s.list().unwrap().len(), 0);
        assert_eq!(s.delete(&p.id).unwrap(), false);
    }
}
