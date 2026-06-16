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

    /// First-run seeding of the version-controlled starter presets. Idempotent
    /// and user-respecting: it runs at most once per database, gated by
    /// `PRAGMA user_version` (NOT "table is empty" — the live DB persists across
    /// deploys, so emptiness would resurrect presets the user deliberately deleted).
    ///
    /// - `user_version >= 1` → already seeded, never touched again (returns 0).
    /// - otherwise: insert the presets ONLY if the table is empty (don't stack
    ///   onto a hand-populated library), then mark `user_version = 1` regardless.
    ///
    /// The inserts and the `user_version = 1` marker are written in ONE
    /// transaction (SQLite stores `user_version` in the db header and the write
    /// is transactional), so the seed and its marker land atomically — both or
    /// neither. A crash mid-seed rolls back cleanly and the next boot re-seeds
    /// from scratch; there is no reachable "rows present but unmarked" state to
    /// resurrect deleted presets from. The empty-table check still guards against
    /// stacking onto a hand-populated library. Returns the number inserted.
    ///
    /// SQL is inlined under the single held lock — calling `self.create()` would
    /// re-lock the non-reentrant Mutex and deadlock.
    pub fn seed_if_unseeded(&self, presets: &[(&str, &str)]) -> Result<usize, String> {
        let mut conn = self.conn.lock().unwrap();
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(|e| format!("Pragma read error: {}", e))?;
        if version >= 1 {
            return Ok(0);
        }
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM prompt_presets", [], |row| row.get(0))
            .map_err(|e| format!("Count error: {}", e))?;
        let now = now_iso();
        let tx = conn.transaction().map_err(|e| format!("Tx error: {}", e))?;
        let mut inserted = 0usize;
        // Insert ONLY into a fresh empty library; never stack onto user content.
        if count == 0 {
            for (i, (title, body)) in presets.iter().enumerate() {
                tx.execute(
                    "INSERT INTO prompt_presets (id, title, body, created_at, updated_at, sort_order)
                     VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
                    params![short_uuid(), title.trim(), body.trim(), now, (i as i64) + 1],
                )
                .map_err(|e| format!("Seed insert error: {}", e))?;
                inserted += 1;
            }
        }
        // Mark seeded in the same tx — atomic with the inserts (and set even when
        // we skipped a prepopulated library, so it's never reconsidered).
        tx.execute_batch("PRAGMA user_version = 1")
            .map_err(|e| format!("Pragma write error: {}", e))?;
        tx.commit().map_err(|e| format!("Seed commit error: {}", e))?;
        Ok(inserted)
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

    // ── seed_if_unseeded ──
    use crate::prompts_seed::SEED_PRESETS;

    #[test]
    fn seed_inserts_eight_on_fresh_db() {
        let (s, _d) = tmp_store();
        let n = s.seed_if_unseeded(SEED_PRESETS).unwrap();
        assert_eq!(n, SEED_PRESETS.len());
        let all = s.list().unwrap();
        assert_eq!(all.len(), SEED_PRESETS.len());
        // order + content match the embedded array (sort_order = index)
        for (row, (title, body)) in all.iter().zip(SEED_PRESETS.iter()) {
            assert_eq!(&row.title, title);
            assert_eq!(&row.body, body);
        }
    }

    #[test]
    fn seed_is_idempotent() {
        let (s, _d) = tmp_store();
        assert_eq!(s.seed_if_unseeded(SEED_PRESETS).unwrap(), SEED_PRESETS.len());
        // second call is a no-op: marker already set
        assert_eq!(s.seed_if_unseeded(SEED_PRESETS).unwrap(), 0);
        assert_eq!(s.list().unwrap().len(), SEED_PRESETS.len());
    }

    #[test]
    fn seed_does_not_resurrect_after_delete_all() {
        let (s, _d) = tmp_store();
        s.seed_if_unseeded(SEED_PRESETS).unwrap();
        for p in s.list().unwrap() {
            s.delete(&p.id).unwrap();
        }
        assert_eq!(s.list().unwrap().len(), 0);
        // already seeded once → never refill, even though table is empty now
        assert_eq!(s.seed_if_unseeded(SEED_PRESETS).unwrap(), 0);
        assert_eq!(s.list().unwrap().len(), 0);
    }

    #[test]
    fn seed_skips_when_prepopulated() {
        let (s, _d) = tmp_store();
        // a library that already has user content (e.g. hand-POSTed on a live DB)
        s.create("mine", "body").unwrap();
        assert_eq!(s.seed_if_unseeded(SEED_PRESETS).unwrap(), 0); // no stacking
        let all = s.list().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].title, "mine");
        // and still no-op afterwards
        assert_eq!(s.seed_if_unseeded(SEED_PRESETS).unwrap(), 0);
        assert_eq!(s.list().unwrap().len(), 1);
    }

    #[test]
    fn seed_marker_persists_across_reopen() {
        // The marker must be durable on disk (not just in-memory), or every
        // restart/deploy would re-seed. Reopen the SAME db file and confirm the
        // second seed is a no-op. This pins the user_version write as persistent.
        let dir = tempfile::tempdir().unwrap();
        {
            let s = PromptPresetStore::open(dir.path()).unwrap();
            assert_eq!(s.seed_if_unseeded(SEED_PRESETS).unwrap(), SEED_PRESETS.len());
        } // drop closes the connection / flushes
        {
            let s = PromptPresetStore::open(dir.path()).unwrap();
            assert_eq!(s.seed_if_unseeded(SEED_PRESETS).unwrap(), 0);
            assert_eq!(s.list().unwrap().len(), SEED_PRESETS.len());
        }
    }

    #[test]
    fn seed_content_within_caps() {
        for (title, body) in SEED_PRESETS {
            let t = title.trim();
            let b = body.trim();
            assert!(!t.is_empty(), "seed title empty");
            assert!(!b.is_empty(), "seed body empty: {}", t);
            assert!(t.chars().count() <= TITLE_MAX, "seed title too long: {}", t);
            assert!(b.chars().count() <= BODY_MAX, "seed body too long: {}", t);
        }
    }
}
