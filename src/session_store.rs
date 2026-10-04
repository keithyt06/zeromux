//! 会话元数据持久化（SQLite）。总是开启（不依赖 OAuth 模式），
//! 使 zeromux 重启后能懒装载、按 ResumeToken 重生会话进程。
//! 镜像 events.rs 的 EventStore::open 模式。

use rusqlite::{params, Connection};
use std::path::Path;
use std::sync::Mutex;

use crate::session_manager::{ResumeToken, SessionType};

/// The persisted subset of triage posture (S5 U3). `current_step` / approvals are
/// turn-internal and deliberately absent: after a restart no turn is running.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct PersistedPosture {
    pub last_outcome: Option<String>,
    pub last_outcome_ms: Option<i64>,
    pub last_snippet: Option<String>,
    pub awaiting_input: bool,
}

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
    pub source_task_id: Option<String>,
    pub name_is_auto: bool,   // true=占位名/可自动命名; false=用户已锁定
    pub tmux_origin: Option<String>,
    pub cols: u16,
    pub rows: u16,
    /// Set while a tmux close is inside its undo window; reconciled at startup.
    pub pending_kill_until: Option<i64>,
    /// Written ONLY by `update_posture`; `upsert` ignores it (spec §1.2).
    pub posture: PersistedPosture,
    /// S5 U1. Gateway raw values: mode `""|crew`, agent e.g. `kirocrew-conductor`;
    /// origin `zeromux|external` decides slot ownership (U2). Empty/zeromux for non-Crew.
    pub crew_mode: String,
    pub crew_agent: String,
    pub crew_origin: String,
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
        // Best-effort migration for older DBs (ignores duplicate-column error).
        let _ = conn.execute("ALTER TABLE sessions ADD COLUMN source_task_id TEXT", []);
        // name_is_auto: 1 = 占位名/可自动命名; 0 = 用户已锁定。旧行默认 1。
        let _ = conn.execute("ALTER TABLE sessions ADD COLUMN name_is_auto INTEGER NOT NULL DEFAULT 1", []);
        let _ = conn.execute("ALTER TABLE sessions ADD COLUMN tmux_origin TEXT", []);
        let _ = conn.execute("ALTER TABLE sessions ADD COLUMN cols INTEGER NOT NULL DEFAULT 80", []);
        let _ = conn.execute("ALTER TABLE sessions ADD COLUMN rows INTEGER NOT NULL DEFAULT 24", []);
        let _ = conn.execute("ALTER TABLE sessions ADD COLUMN pending_kill_until INTEGER", []);
        // S5 U1: posture (F1) + Crew slot metadata (G2/R4). Column names are shared with S6/S7.
        let _ = conn.execute("ALTER TABLE sessions ADD COLUMN last_outcome TEXT", []);
        let _ = conn.execute("ALTER TABLE sessions ADD COLUMN last_outcome_ms INTEGER", []);
        let _ = conn.execute("ALTER TABLE sessions ADD COLUMN last_snippet TEXT", []);
        let _ = conn.execute("ALTER TABLE sessions ADD COLUMN awaiting_input INTEGER NOT NULL DEFAULT 0", []);
        let _ = conn.execute("ALTER TABLE sessions ADD COLUMN crew_mode TEXT NOT NULL DEFAULT ''", []);
        let _ = conn.execute("ALTER TABLE sessions ADD COLUMN crew_agent TEXT NOT NULL DEFAULT ''", []);
        let _ = conn.execute("ALTER TABLE sessions ADD COLUMN crew_origin TEXT NOT NULL DEFAULT 'zeromux'", []);
        Ok(Self { conn: Mutex::new(conn) })
    }

    pub fn upsert(&self, s: &PersistedSession) -> Result<(), String> {
        let (rk, rv) = match &s.resume_token {
            Some(t) => { let (k, v) = t.to_kind_value(); (Some(k.to_string()), Some(v)) }
            None => (None, None),
        };
        let conn = self.conn.lock().unwrap();
        // Posture columns are intentionally absent: they are per-turn runtime state
        // written only by update_posture, never by a metadata write.
        conn.execute(
            "INSERT INTO sessions (id,name,type,work_dir,owner_id,description,resume_kind,resume_value,worktree_path,created_ms,source_task_id,name_is_auto,tmux_origin,cols,rows,pending_kill_until,crew_mode,crew_agent,crew_origin)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)
             ON CONFLICT(id) DO UPDATE SET
               name=?2, type=?3, work_dir=?4, owner_id=?5, description=?6,
               resume_kind=?7, resume_value=?8, worktree_path=?9, name_is_auto=?12,
               tmux_origin=?13, cols=?14, rows=?15, pending_kill_until=?16,
               crew_mode=?17, crew_agent=?18, crew_origin=?19",
            params![s.id, s.name, s.session_type.to_string(), s.work_dir, s.owner_id,
                    s.description, rk, rv, s.worktree_path, s.created_ms, s.source_task_id,
                    s.name_is_auto as i64, s.tmux_origin, s.cols as i64, s.rows as i64, s.pending_kill_until,
                    s.crew_mode, s.crew_agent, s.crew_origin],
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

    pub fn update_size(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute("UPDATE sessions SET cols=?2, rows=?3 WHERE id=?1",
                     params![id, cols as i64, rows as i64])
            .map_err(|e| format!("update_size failed: {}", e))?;
        Ok(())
    }

    pub fn set_pending_kill(&self, id: &str, until: Option<i64>) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute("UPDATE sessions SET pending_kill_until=?2 WHERE id=?1", params![id, until])
            .map_err(|e| format!("set_pending_kill failed: {}", e))?;
        Ok(())
    }

    pub fn update_name(&self, id: &str, name: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute("UPDATE sessions SET name=?2 WHERE id=?1", params![id, name])
            .map_err(|e| format!("update_name failed: {}", e))?;
        Ok(())
    }

    pub fn update_name_is_auto(&self, id: &str, is_auto: bool) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute("UPDATE sessions SET name_is_auto=?2 WHERE id=?1",
                     params![id, is_auto as i64])
            .map_err(|e| format!("update_name_is_auto failed: {}", e))?;
        Ok(())
    }

    pub fn update_description(&self, id: &str, description: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute("UPDATE sessions SET description=?2 WHERE id=?1", params![id, description])
            .map_err(|e| format!("update_description failed: {}", e))?;
        Ok(())
    }

    /// U3: one UPDATE per settled turn. The row may not exist (in-memory test
    /// sessions) — zero rows affected is not an error.
    pub fn update_posture(&self, id: &str, p: &PersistedPosture) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE sessions SET last_outcome=?2, last_outcome_ms=?3, last_snippet=?4, awaiting_input=?5 WHERE id=?1",
            params![id, p.last_outcome, p.last_outcome_ms, p.last_snippet, p.awaiting_input as i64])
            .map_err(|e| format!("update_posture failed: {}", e))?;
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
            "SELECT id,name,type,work_dir,owner_id,description,resume_kind,resume_value,worktree_path,created_ms,source_task_id,name_is_auto,tmux_origin,cols,rows,pending_kill_until,last_outcome,last_outcome_ms,last_snippet,awaiting_input,crew_mode,crew_agent,crew_origin FROM sessions")
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
                source_task_id: row.get(10)?,
                name_is_auto: row.get::<_, i64>(11)? != 0,
                tmux_origin: row.get(12)?,
                cols: row.get::<_, i64>(13)? as u16,
                rows: row.get::<_, i64>(14)? as u16,
                pending_kill_until: row.get(15)?,
                posture: PersistedPosture {
                    last_outcome: row.get(16)?,
                    last_outcome_ms: row.get(17)?,
                    last_snippet: row.get(18)?,
                    awaiting_input: row.get::<_, i64>(19)? != 0,
                },
                crew_mode: row.get(20)?,
                crew_agent: row.get(21)?,
                crew_origin: row.get(22)?,
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
            source_task_id: None,
            name_is_auto: true,
            tmux_origin: None, cols: 80, rows: 24, pending_kill_until: None,
            posture: PersistedPosture::default(),
            crew_mode: String::new(), crew_agent: String::new(), crew_origin: "zeromux".into(),
        }
    }

    #[test]
    fn persists_tmux_origin_and_size() {
        let d = tempfile::tempdir().unwrap();
        let st = SessionStore::open(d.path()).unwrap();
        let mut p = sample("a", Some(ResumeToken::Tmux("zmx-a".into())));
        p.tmux_origin = Some("external".into());
        p.cols = 132; p.rows = 40;
        st.upsert(&p).unwrap();
        st.update_size("a", 100, 30).unwrap();
        let r = st.load_all().unwrap().into_iter().find(|x| x.id == "a").unwrap();
        assert_eq!(r.tmux_origin.as_deref(), Some("external"));
        assert_eq!((r.cols, r.rows), (100, 30));
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
        s.update_resume_token("a", Some(&ResumeToken::Crew("zmx-kid".into()))).unwrap();
        assert_eq!(s.load_all().unwrap()[0].resume_token, Some(ResumeToken::Crew("zmx-kid".into())));
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

    #[test]
    fn open_twice_is_idempotent() {
        let d = tempfile::tempdir().unwrap();
        SessionStore::open(d.path()).unwrap();
        // Second open re-runs every ALTER; duplicate-column errors must be swallowed.
        let st = SessionStore::open(d.path()).unwrap();
        st.upsert(&sample("a", None)).unwrap();
        assert_eq!(st.load_all().unwrap().len(), 1);
    }

    #[test]
    fn update_posture_round_trips() {
        let (st, _d) = tmp_store();
        st.upsert(&sample("a", None)).unwrap();
        let p = PersistedPosture {
            last_outcome: Some("completed".into()), last_outcome_ms: Some(1234),
            last_snippet: Some("全部通过".into()), awaiting_input: true,
        };
        st.update_posture("a", &p).unwrap();
        assert_eq!(st.load_all().unwrap()[0].posture, p);
    }

    #[test]
    fn upsert_does_not_clobber_posture() {
        // posture is per-turn runtime state; a metadata write (rename, resize,
        // resume-token) must never reset it (spec §1.2).
        let (st, _d) = tmp_store();
        st.upsert(&sample("a", None)).unwrap();
        let p = PersistedPosture { last_outcome: Some("errored".into()), last_outcome_ms: Some(9), ..Default::default() };
        st.update_posture("a", &p).unwrap();
        let mut renamed = sample("a", None);
        renamed.name = "renamed".into();
        renamed.posture = PersistedPosture::default();   // whatever the caller carries is ignored
        st.upsert(&renamed).unwrap();
        let r = &st.load_all().unwrap()[0];
        assert_eq!(r.name, "renamed");
        assert_eq!(r.posture, p);
    }

    #[test]
    fn crew_columns_round_trip_through_upsert() {
        let (st, _d) = tmp_store();
        let mut p = sample("c", Some(ResumeToken::Crew("zmx-k".into())));
        p.session_type = SessionType::Crew;
        p.crew_mode = "crew".into();
        p.crew_agent = "kirocrew-conductor".into();
        p.crew_origin = "external".into();
        st.upsert(&p).unwrap();
        let r = st.load_all().unwrap().into_iter().find(|x| x.id == "c").unwrap();
        assert_eq!((r.crew_mode.as_str(), r.crew_agent.as_str(), r.crew_origin.as_str()),
                   ("crew", "kirocrew-conductor", "external"));
    }

    #[test]
    fn pre_s5_rows_load_with_empty_posture_and_zeromux_origin() {
        // A DB written by the pre-S5 binary: none of the seven columns exist yet.
        let d = tempfile::tempdir().unwrap();
        {
            let conn = Connection::open(d.path().join("zeromux.db")).unwrap();
            conn.execute_batch(
                "CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
                   work_dir TEXT NOT NULL, owner_id TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
                   resume_kind TEXT, resume_value TEXT, worktree_path TEXT, created_ms INTEGER NOT NULL,
                   source_task_id TEXT, name_is_auto INTEGER NOT NULL DEFAULT 1, tmux_origin TEXT,
                   cols INTEGER NOT NULL DEFAULT 80, rows INTEGER NOT NULL DEFAULT 24, pending_kill_until INTEGER);
                 INSERT INTO sessions (id,name,type,work_dir,owner_id,created_ms) VALUES ('old','n','crew','/w','u',1);"
            ).unwrap();
        }
        let st = SessionStore::open(d.path()).unwrap();
        let r = st.load_all().unwrap().into_iter().find(|x| x.id == "old").unwrap();
        assert_eq!(r.posture, PersistedPosture::default());
        assert_eq!((r.crew_mode.as_str(), r.crew_agent.as_str(), r.crew_origin.as_str()), ("", "", "zeromux"));
    }
}
