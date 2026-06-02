//! 会话元数据持久化（SQLite）。总是开启（不依赖 OAuth 模式），
//! 使 zeromux 重启后能懒装载、按 ResumeToken 重生会话进程。
//! 镜像 events.rs 的 EventStore::open 模式。

use rusqlite::{params, Connection};
use std::path::Path;
use std::sync::Mutex;

use crate::session_manager::{ResumeToken, SessionType};

/// 从 SQLite 读回的一条会话元数据（不含运行态）。
#[derive(Debug, Clone, PartialEq)]
pub struct PersistedSession {
    pub id: String,
    pub name: String,
    pub session_type: SessionType,
    pub work_dir: String,
    pub owner_id: String,
    pub description: String,
    pub resume_token: Option<ResumeToken>,
    pub worktree_path: Option<String>,
    pub created_ms: i64,
}

pub struct SessionStore {
    conn: Mutex<Connection>,
}

impl SessionStore {
    pub fn open(data_dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(data_dir)
            .map_err(|e| format!("Failed to create data dir: {}", e))?;
        let db_path = data_dir.join("zeromux.db");
        let conn = Connection::open(&db_path)
            .map_err(|e| format!("Failed to open session db: {}", e))?;
        conn.execute(
            "CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                type TEXT NOT NULL,
                work_dir TEXT NOT NULL,
                owner_id TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                resume_kind TEXT,
                resume_value TEXT,
                worktree_path TEXT,
                created_ms INTEGER NOT NULL
            )",
            [],
        )
        .map_err(|e| format!("Failed to create sessions table: {}", e))?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    pub fn upsert(&self, s: &PersistedSession) -> Result<(), String> {
        let (rk, rv) = match &s.resume_token {
            Some(t) => { let (k, v) = t.to_kind_value(); (Some(k.to_string()), Some(v)) }
            None => (None, None),
        };
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO sessions (id,name,type,work_dir,owner_id,description,resume_kind,resume_value,worktree_path,created_ms)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
             ON CONFLICT(id) DO UPDATE SET
               name=?2, type=?3, work_dir=?4, owner_id=?5, description=?6,
               resume_kind=?7, resume_value=?8, worktree_path=?9",
            params![s.id, s.name, s.session_type.to_string(), s.work_dir, s.owner_id,
                    s.description, rk, rv, s.worktree_path, s.created_ms],
        )
        .map_err(|e| format!("upsert failed: {}", e))?;
        Ok(())
    }

    pub fn update_resume_token(&self, id: &str, token: Option<&ResumeToken>) -> Result<(), String> {
        let (rk, rv) = match token {
            Some(t) => { let (k, v) = t.to_kind_value(); (Some(k.to_string()), Some(v)) }
            None => (None, None),
        };
        let conn = self.conn.lock().unwrap();
        conn.execute("UPDATE sessions SET resume_kind=?2, resume_value=?3 WHERE id=?1",
                     params![id, rk, rv])
            .map_err(|e| format!("update_resume_token failed: {}", e))?;
        Ok(())
    }

    pub fn update_name(&self, id: &str, name: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute("UPDATE sessions SET name=?2 WHERE id=?1", params![id, name])
            .map_err(|e| format!("update_name failed: {}", e))?;
        Ok(())
    }

    pub fn update_description(&self, id: &str, description: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute("UPDATE sessions SET description=?2 WHERE id=?1", params![id, description])
            .map_err(|e| format!("update_description failed: {}", e))?;
        Ok(())
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM sessions WHERE id=?1", params![id])
            .map_err(|e| format!("delete failed: {}", e))?;
        Ok(())
    }

    pub fn load_all(&self) -> Result<Vec<PersistedSession>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id,name,type,work_dir,owner_id,description,resume_kind,resume_value,worktree_path,created_ms FROM sessions")
            .map_err(|e| format!("prepare failed: {}", e))?;
        let rows = stmt.query_map([], |row| {
            let type_str: String = row.get(2)?;
            let rk: Option<String> = row.get(6)?;
            let rv: Option<String> = row.get(7)?;
            let resume_token = match (rk, rv) {
                (Some(k), Some(v)) => ResumeToken::from_kind_value(&k, &v),
                _ => None,
            };
            Ok(PersistedSession {
                id: row.get(0)?,
                name: row.get(1)?,
                session_type: SessionType::from_str_lenient(&type_str),
                work_dir: row.get(3)?,
                owner_id: row.get(4)?,
                description: row.get(5)?,
                resume_token,
                worktree_path: row.get(8)?,
                created_ms: row.get(9)?,
            })
        }).map_err(|e| format!("query failed: {}", e))?;
        let mut out = Vec::new();
        for r in rows { out.push(r.map_err(|e| format!("row failed: {}", e))?); }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_manager::{ResumeToken, SessionType};

    fn tmp_store() -> (SessionStore, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::open(dir.path()).unwrap();
        (store, dir)
    }

    fn sample(id: &str, token: Option<ResumeToken>) -> PersistedSession {
        PersistedSession {
            id: id.into(), name: "n".into(), session_type: SessionType::Claude,
            work_dir: "/w".into(), owner_id: "u".into(), description: "d".into(),
            resume_token: token, worktree_path: Some("/wt".into()), created_ms: 1000,
        }
    }

    #[test]
    fn upsert_then_load() {
        let (s, _d) = tmp_store();
        s.upsert(&sample("a", Some(ResumeToken::Claude("sid".into())))).unwrap();
        let all = s.load_all().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0], sample("a", Some(ResumeToken::Claude("sid".into()))));
    }

    #[test]
    fn upsert_is_idempotent_update() {
        let (s, _d) = tmp_store();
        s.upsert(&sample("a", None)).unwrap();
        let mut updated = sample("a", None); updated.name = "renamed".into();
        s.upsert(&updated).unwrap();
        let all = s.load_all().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].name, "renamed");
    }

    #[test]
    fn update_resume_token_roundtrip() {
        let (s, _d) = tmp_store();
        s.upsert(&sample("a", None)).unwrap();
        s.update_resume_token("a", Some(&ResumeToken::Kiro("kid".into()))).unwrap();
        assert_eq!(s.load_all().unwrap()[0].resume_token, Some(ResumeToken::Kiro("kid".into())));
        s.update_resume_token("a", None).unwrap();
        assert_eq!(s.load_all().unwrap()[0].resume_token, None);
    }

    #[test]
    fn delete_removes_row() {
        let (s, _d) = tmp_store();
        s.upsert(&sample("a", None)).unwrap();
        s.delete("a").unwrap();
        assert!(s.load_all().unwrap().is_empty());
    }
}
