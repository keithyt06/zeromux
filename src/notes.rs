use rusqlite::{params, Connection};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Debug, Clone, serde::Serialize)]
pub struct NoteEntry {
    pub id: String,
    pub work_dir: String,
    pub text: String,
    pub created_at: String,
    pub session_id: String,
    pub author: String,
    pub tags: Vec<String>,
    pub file_path: String,
}

pub struct NotesStore {
    conn: Mutex<Connection>,
    data_dir: PathBuf,
}

impl NotesStore {
    pub fn open(data_dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(data_dir)
            .map_err(|e| format!("Failed to create data dir: {}", e))?;

        let db_path = data_dir.join("notes.db");
        let conn = Connection::open(&db_path)
            .map_err(|e| format!("Failed to open notes database: {}", e))?;

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS notes (
                id          TEXT PRIMARY KEY,
                work_dir    TEXT NOT NULL,
                title       TEXT NOT NULL,
                created_at  TEXT NOT NULL,
                session_id  TEXT NOT NULL DEFAULT '',
                author      TEXT NOT NULL DEFAULT '',
                tags        TEXT NOT NULL DEFAULT '[]',
                file_path   TEXT NOT NULL,
                content     TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_notes_workdir ON notes(work_dir);
            CREATE INDEX IF NOT EXISTS idx_notes_created ON notes(created_at DESC);",
        )
        .map_err(|e| format!("Failed to create notes table: {}", e))?;

        Ok(Self {
            conn: Mutex::new(conn),
            data_dir: data_dir.to_path_buf(),
        })
    }

    pub fn create_note(
        &self,
        work_dir: &str,
        text: &str,
        tags: &[String],
        session_id: &str,
        author: &str,
    ) -> Result<NoteEntry, String> {
        let id = short_uuid();
        let created_at = now_iso();
        let dir_hash = dir_hash(work_dir);
        let tags_json = serde_json::to_string(tags).unwrap_or_else(|_| "[]".to_string());

        // Title: first line, truncated
        let title = text.lines().next().unwrap_or(text);
        let title = if title.len() > 100 { &title[..100] } else { title };

        // File name: YYYYMMDD_HHMMSS_id.md
        let date_part = created_at.replace('-', "").replace(':', "").replace('T', "_");
        let date_part = date_part.split('.').next().unwrap_or(&date_part);
        let date_part = date_part.trim_end_matches('Z');
        let file_name = format!("{}_{}.md", date_part, &id[..4.min(id.len())]);
        let rel_path = format!("{}/{}", dir_hash, file_name);

        // Write markdown file
        let notes_dir = self.data_dir.join("notes").join(&dir_hash);
        std::fs::create_dir_all(&notes_dir)
            .map_err(|e| format!("Failed to create notes dir: {}", e))?;

        let md_content = format!(
            "---\nid: {}\ncreated: {}\nwork_dir: {}\nsession_id: {}\nauthor: {}\ntags: {}\n---\n\n{}",
            id, created_at, work_dir, session_id, author, tags_json, text
        );
        std::fs::write(notes_dir.join(&file_name), &md_content)
            .map_err(|e| format!("Failed to write note file: {}", e))?;

        // Insert into SQLite index
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO notes (id, work_dir, title, created_at, session_id, author, tags, file_path, content)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![id, work_dir, title, created_at, session_id, author, tags_json, rel_path, text],
        )
        .map_err(|e| format!("Failed to insert note: {}", e))?;

        Ok(NoteEntry {
            id,
            work_dir: work_dir.to_string(),
            text: text.to_string(),
            created_at,
            session_id: session_id.to_string(),
            author: author.to_string(),
            tags: tags.to_vec(),
            file_path: rel_path,
        })
    }

    pub fn list_notes(&self, work_dir: &str) -> Result<Vec<NoteEntry>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, work_dir, content, created_at, session_id, author, tags, file_path
                 FROM notes WHERE work_dir = ?1 ORDER BY created_at DESC",
            )
            .map_err(|e| format!("Query error: {}", e))?;

        let notes = stmt
            .query_map(params![work_dir], |row| {
                let tags_str: String = row.get(6)?;
                let tags: Vec<String> =
                    serde_json::from_str(&tags_str).unwrap_or_default();
                Ok(NoteEntry {
                    id: row.get(0)?,
                    work_dir: row.get(1)?,
                    text: row.get(2)?,
                    created_at: row.get(3)?,
                    session_id: row.get(4)?,
                    author: row.get(5)?,
                    tags,
                    file_path: row.get(7)?,
                })
            })
            .map_err(|e| format!("Query error: {}", e))?
            .filter_map(|r| r.ok())
            .collect();

        Ok(notes)
    }

    /// Delete a note, scoped to a work_dir. The delete only succeeds when the
    /// note's stored `work_dir` matches — binding the operation to a session
    /// that legitimately shares that work_dir. Without this scope the delete
    /// keyed on `note_id` alone, so any authenticated user could remove any
    /// note by id, ignoring the session in the route entirely (authz gap).
    pub fn delete_note(&self, note_id: &str, work_dir: &str) -> Result<bool, String> {
        // Get file path before deleting from index — only for the matching
        // (id, work_dir) pair, so a mismatched work_dir touches nothing.
        let file_path = {
            let conn = self.conn.lock().unwrap();
            let path: Option<String> = conn
                .query_row(
                    "SELECT file_path FROM notes WHERE id = ?1 AND work_dir = ?2",
                    params![note_id, work_dir],
                    |row| row.get(0),
                )
                .ok();
            path
        };

        // Delete markdown file
        if let Some(ref rel_path) = file_path {
            let full_path = self.data_dir.join("notes").join(rel_path);
            let _ = std::fs::remove_file(&full_path);
        }

        // Delete from index (same scope)
        let conn = self.conn.lock().unwrap();
        let rows = conn
            .execute(
                "DELETE FROM notes WHERE id = ?1 AND work_dir = ?2",
                params![note_id, work_dir],
            )
            .map_err(|e| format!("Delete error: {}", e))?;

        Ok(rows > 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    // Unique temp dir per test invocation so parallel runs don't collide on the
    // shared sqlite file (mirrors the resolve_wikilink_* test hygiene).
    static SEQ: AtomicUsize = AtomicUsize::new(0);
    fn tmp_store() -> NotesStore {
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("zeromux_notes_test_{}_{}", std::process::id(), n));
        let _ = std::fs::remove_dir_all(&dir);
        NotesStore::open(&dir).unwrap()
    }

    #[test]
    fn delete_note_scoped_to_work_dir() {
        let store = tmp_store();
        let note = store
            .create_note("/home/u/repoA", "note text", &[], "sess-a", "alice")
            .unwrap();

        // Deleting with the WRONG work_dir must not remove the note (this is the
        // authz gap: a note_id harvested from another session's work_dir).
        assert_eq!(
            store.delete_note(&note.id, "/home/u/repoB").unwrap(),
            false,
            "delete with mismatched work_dir must be a no-op"
        );
        assert_eq!(
            store.list_notes("/home/u/repoA").unwrap().len(),
            1,
            "note must survive a mismatched-work_dir delete"
        );

        // Deleting with the CORRECT work_dir succeeds.
        assert_eq!(
            store.delete_note(&note.id, "/home/u/repoA").unwrap(),
            true
        );
        assert_eq!(store.list_notes("/home/u/repoA").unwrap().len(), 0);
    }
}

fn short_uuid() -> String {
    uuid::Uuid::new_v4().to_string().replace('-', "")[..8].to_string()
}

fn dir_hash(work_dir: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(work_dir.as_bytes());
    let result = hasher.finalize();
    hex::encode(&result[..4]) // 8 hex chars
}

fn now_iso() -> String {
    let d = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = d.as_secs();
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
