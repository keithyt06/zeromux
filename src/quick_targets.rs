//! 常用目录/笔记的 frecency 排行（quick targets）。
//! 一张表承载两种实例：kind='dir'（会话工作目录）与 kind='note'（vault 笔记）。
//! 与 session_store 同库（~/.zeromux/zeromux.db），总是开启，不依赖 OAuth 模式。
//!
//! 行的身份是 (user_id, kind, path, agent)：同一目录用三个 agent 就是三行，各自
//! 独立累积 frecency。这样每一行都自描述且稳定——单个 last_agent 会被最新一次 bump
//! 覆盖，导致「行上的标签自己变、一击直达的结果跟着变」。
//!
//! 评分：指数半衰期。写入时只更新一行；衰减在 READ 时计算，故无需后台衰减任务
//! 也无需周期性重写全表。衰减刻意在 Rust 里算而不在 SQL 里算——rusqlite 0.31
//! bundled SQLite 不带 pow()，为此开 math 扩展或注册自定义函数不划算。

use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;
use std::sync::Mutex;

/// 半衰期 14 天（毫秒）。两周不碰的目标自然掉出 Top5。
pub const HALF_LIFE_MS: i64 = 14 * 24 * 3600 * 1000;
/// 返回给前端的条数上限。这是 **显示** 上限——表里不删行。
/// 基于排名的表内挤出会清零累积分，把纯 recency 的病重新引入 frecency
/// （长期常用但暂时掉出 Top5 的目标将永远无法回榜）。
pub const TOP_N: usize = 5;
/// SQL 候选上限。约束不是内存而是 **读出时每行都要付一次文件系统守卫**
/// （JuiceFS 上实测约 20ms/行）。为返回 5 行而校验 50 行是 10× 浪费；
/// 16 留足冗余（坏行剔除后仍够凑满 5 条）。
const CANDIDATE_LIMIT: i64 = 16;

#[derive(Debug, Clone, PartialEq)]
pub struct QuickTargetRow {
    pub kind: String,
    pub path: String,
    /// dir: 'claude'|'kiro'|'codex'|'tmux'；note: 空串。
    /// 空串而非 NULL 是刻意的：SQLite 的 PRIMARY KEY 列允许 NULL 且 NULL != NULL，
    /// 可空会让 note（agent 恒空）每打开一次就插一行。
    pub agent: String,
    pub hits: i64,
    pub last_ms: i64,
    pub score_raw: f64,
}

/// 把累积分按距今时长做指数衰减。
/// elapsed 为负（时钟回拨/NTP 校正）时钳到 0，避免放大分数。
pub fn decayed_score(score_raw: f64, last_ms: i64, now_ms: i64) -> f64 {
    let elapsed = (now_ms - last_ms).max(0) as f64;
    score_raw * 0.5_f64.powf(elapsed / HALF_LIFE_MS as f64)
}

/// 按衰减后分数降序取前 TOP_N 条。
pub fn rank(rows: Vec<QuickTargetRow>, now_ms: i64) -> Vec<QuickTargetRow> {
    let mut rows = rows;
    rows.sort_by(|a, b| {
        decayed_score(b.score_raw, b.last_ms, now_ms)
            .partial_cmp(&decayed_score(a.score_raw, a.last_ms, now_ms))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    rows.truncate(TOP_N);
    rows
}

pub struct QuickTargetStore {
    conn: Mutex<Connection>,
}

impl QuickTargetStore {
    pub fn open(data_dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(data_dir)
            .map_err(|e| format!("Failed to create data dir: {}", e))?;
        let db_path = data_dir.join("zeromux.db");
        let conn = Connection::open(&db_path)
            .map_err(|e| format!("Failed to open quick targets db: {}", e))?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS quick_targets (
                user_id     TEXT NOT NULL,
                kind        TEXT NOT NULL,
                path        TEXT NOT NULL,
                agent       TEXT NOT NULL DEFAULT '',
                hits        INTEGER NOT NULL DEFAULT 0,
                last_ms     INTEGER NOT NULL,
                score_raw   REAL    NOT NULL DEFAULT 0,
                PRIMARY KEY (user_id, kind, path, agent)
            );
            CREATE INDEX IF NOT EXISTS idx_qt_lookup
                ON quick_targets(user_id, kind, last_ms DESC);",
        )
        .map_err(|e| format!("Failed to create quick_targets table: {}", e))?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    /// 记录一次「用户真的去了那里」。
    /// 首次插入直接置 score_raw=1.0（没有前一个 last_ms 可衰减）；再次 bump 时
    /// 先把旧分衰减到 now 再 +1.0。
    ///
    /// 衰减刻意用「先读后写」而不是在 SQL 的 ON CONFLICT 分支里算：SQLite 没有
    /// pow()，无法在 UPDATE 里做指数衰减。读与写在同一把 Mutex 内，故不存在
    /// read-modify-write 竞态。
    pub fn bump(
        &self,
        user_id: &str,
        kind: &str,
        path: &str,
        agent: &str,
        now_ms: i64,
    ) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        let existing: Option<(f64, i64)> = conn
            .query_row(
                "SELECT score_raw, last_ms FROM quick_targets
                 WHERE user_id = ?1 AND kind = ?2 AND path = ?3 AND agent = ?4",
                params![user_id, kind, path, agent],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|e| format!("bump read failed: {}", e))?;

        match existing {
            None => {
                conn.execute(
                    "INSERT INTO quick_targets
                       (user_id, kind, path, agent, hits, last_ms, score_raw)
                     VALUES (?1, ?2, ?3, ?4, 1, ?5, 1.0)",
                    params![user_id, kind, path, agent, now_ms],
                )
                .map_err(|e| format!("bump insert failed: {}", e))?;
            }
            Some((score_raw, last_ms)) => {
                let next = decayed_score(score_raw, last_ms, now_ms) + 1.0;
                conn.execute(
                    "UPDATE quick_targets SET
                       hits      = hits + 1,
                       score_raw = ?5,
                       last_ms   = ?6
                     WHERE user_id = ?1 AND kind = ?2 AND path = ?3 AND agent = ?4",
                    params![user_id, kind, path, agent, next, now_ms],
                )
                .map_err(|e| format!("bump update failed: {}", e))?;
            }
        }
        Ok(())
    }

    /// One-shot cold-start backfill from the caller's session history.
    ///
    /// WHY: when this feature ships, the table is empty — but the user's `sessions`
    /// table already holds exactly the data it wants: (work_dir, type, owner_id).
    /// Without a backfill the first screen renders an empty list, fires `onEmpty`,
    /// and the UI jumps straight to the type picker — which reads to the user as
    /// "the dialog flashed and vanished" (observed live 2026-09-13).
    ///
    /// Idempotent by whole-table check, deliberately: if ANY row exists the seed is
    /// skipped entirely. Two reasons — (a) re-seeding on every restart would add +1
    /// hit to historical dirs each boot, drowning the user's real usage frequency in
    /// a count of how often the process restarted; (b) once the user has real bumps,
    /// resurfacing long-dropped dirs would fight the frecency ranking.
    ///
    /// `history` entries are `(owner_id, work_dir, session_type, created_ms)`. The
    /// caller is responsible for passing only interactive sessions and for path
    /// canonicalization — mirroring what the `create_session` bump site does.
    pub fn seed_from_history(
        &self,
        history: &[(String, String, String, i64)],
    ) -> Result<usize, String> {
        let conn = self.conn.lock().unwrap();
        let existing: i64 = conn
            .query_row("SELECT COUNT(*) FROM quick_targets", [], |row| row.get(0))
            .map_err(|e| format!("seed count failed: {}", e))?;
        if existing > 0 {
            return Ok(0);
        }
        let mut n = 0;
        for (owner, path, agent, created_ms) in history {
            conn.execute(
                "INSERT INTO quick_targets (user_id, kind, path, agent, hits, last_ms, score_raw)
                 VALUES (?1, 'dir', ?2, ?3, 1, ?4, 1.0)
                 ON CONFLICT(user_id, kind, path, agent) DO UPDATE SET
                   last_ms = max(last_ms, excluded.last_ms)",
                params![owner, path, agent, created_ms],
            )
            .map_err(|e| format!("seed insert failed: {}", e))?;
            n += 1;
        }
        Ok(n)
    }

    /// 取候选行（不评分、不排序——那是 rank 的职责）。
    /// ORDER BY last_ms DESC 保证截断时留下的是最近用过的。
    pub fn candidates(&self, user_id: &str, kind: &str) -> Result<Vec<QuickTargetRow>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT kind, path, agent, hits, last_ms, score_raw
                 FROM quick_targets
                 WHERE user_id = ?1 AND kind = ?2
                 ORDER BY last_ms DESC
                 LIMIT ?3",
            )
            .map_err(|e| format!("prepare failed: {}", e))?;
        let rows = stmt
            .query_map(params![user_id, kind, CANDIDATE_LIMIT], |row| {
                Ok(QuickTargetRow {
                    kind: row.get(0)?,
                    path: row.get(1)?,
                    agent: row.get(2)?,
                    hits: row.get(3)?,
                    last_ms: row.get(4)?,
                    score_raw: row.get(5)?,
                })
            })
            .map_err(|e| format!("query failed: {}", e))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| format!("row failed: {}", e))?);
        }
        Ok(out)
    }

    /// 从榜上移除一行。owner-scope 与 read 对称（教训：2026-08-09 push 订阅跨用户劫持）。
    /// agent 参与匹配：只删指定的「目录 + agent」组合，同目录其它 agent 的行不受影响。
    pub fn forget(&self, user_id: &str, kind: &str, path: &str, agent: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM quick_targets
             WHERE user_id = ?1 AND kind = ?2 AND path = ?3 AND agent = ?4",
            params![user_id, kind, path, agent],
        )
        .map_err(|e| format!("forget failed: {}", e))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_store() -> (QuickTargetStore, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let store = QuickTargetStore::open(dir.path()).unwrap();
        (store, dir)
    }

    const T0: i64 = 1_700_000_000_000;
    const DAY: i64 = 24 * 3600 * 1000;

    #[test]
    fn first_bump_inserts_with_score_one() {
        let (s, _d) = tmp_store();
        s.bump("u1", "dir", "/w/a", "claude", T0).unwrap();
        let rows = s.candidates("u1", "dir").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].hits, 1);
        assert_eq!(rows[0].last_ms, T0);
        assert!((rows[0].score_raw - 1.0).abs() < 1e-9, "首次插入必须恰好 1.0");
        assert_eq!(rows[0].agent, "claude");
    }

    #[test]
    fn repeated_bump_same_agent_accumulates_in_one_row() {
        let (s, _d) = tmp_store();
        s.bump("u1", "dir", "/w/a", "claude", T0).unwrap();
        s.bump("u1", "dir", "/w/a", "claude", T0 + DAY).unwrap();
        let rows = s.candidates("u1", "dir").unwrap();
        assert_eq!(rows.len(), 1, "同 (path, agent) 必须 upsert 而非新增行");
        assert_eq!(rows[0].hits, 2);
        assert_eq!(rows[0].last_ms, T0 + DAY);
        // 1.0 衰减 1 天后 + 1.0 → 严格介于 1.0 与 2.0 之间
        assert!(rows[0].score_raw > 1.0 && rows[0].score_raw < 2.0);
    }

    #[test]
    fn same_path_different_agents_are_separate_rows() {
        // 这是 v2 的核心：同一目录用三个 agent → 三行，各自一击直达、标签稳定不漂移。
        // v1 只有一个 last_agent 被覆盖，导致「行上的标签自己变」。
        let (s, _d) = tmp_store();
        s.bump("u1", "dir", "/w/a", "claude", T0).unwrap();
        s.bump("u1", "dir", "/w/a", "codex", T0 + DAY).unwrap();
        s.bump("u1", "dir", "/w/a", "tmux", T0 + 2 * DAY).unwrap();
        let rows = s.candidates("u1", "dir").unwrap();
        assert_eq!(rows.len(), 3, "三个 agent 三行");
        let mut agents: Vec<&str> = rows.iter().map(|r| r.agent.as_str()).collect();
        agents.sort();
        assert_eq!(agents, vec!["claude", "codex", "tmux"]);
        // 各自独立累积：claude 只 bump 过一次
        let claude = rows.iter().find(|r| r.agent == "claude").unwrap();
        assert_eq!(claude.hits, 1);
    }

    #[test]
    fn note_rows_use_empty_agent_and_still_dedupe() {
        // 回归测试：已实测 SQLite 的 PK 列允许 NULL 且 NULL != NULL，
        // 所以若 agent 可空，note（agent 恒空）每打开一次就插一行 → frecency 报废。
        // 空串是真值，PK 正常去重。
        let (s, _d) = tmp_store();
        for i in 0..3 {
            s.bump("u1", "note", "projects/a.md", "", T0 + i * DAY).unwrap();
        }
        let rows = s.candidates("u1", "note").unwrap();
        assert_eq!(rows.len(), 1, "同一篇笔记连开 3 次必须仍是 1 行");
        assert_eq!(rows[0].hits, 3);
        assert_eq!(rows[0].agent, "");
    }

    #[test]
    fn decayed_score_halves_after_one_half_life() {
        let s = decayed_score(1.0, T0, T0 + HALF_LIFE_MS);
        assert!((s - 0.5).abs() < 1e-6, "14 天后应衰减到一半，实际 {}", s);
    }

    #[test]
    fn decayed_score_is_identity_at_zero_elapsed() {
        assert!((decayed_score(3.0, T0, T0) - 3.0).abs() < 1e-9);
    }

    #[test]
    fn decayed_score_clamps_negative_elapsed() {
        // 时钟回拨 / NTP 校正：now < last_ms 不应放大分数
        let s = decayed_score(1.0, T0, T0 - 10 * DAY);
        assert!(s <= 1.0 + 1e-9, "负 elapsed 必须钳到不放大，实际 {}", s);
    }

    #[test]
    fn rank_orders_by_decayed_score_desc() {
        let row = |path: &str, last_ms: i64, score_raw: f64| QuickTargetRow {
            kind: "dir".into(), path: path.into(), agent: "claude".into(),
            hits: 1, last_ms, score_raw,
        };
        // old-heavy: 20 * 0.5^(60/14) ≈ 1.0；fresh-light: 2.0 → fresh 在前
        let out = rank(vec![row("/old-heavy", T0 - 60 * DAY, 20.0),
                            row("/fresh-light", T0, 2.0)], T0);
        assert_eq!(out[0].path, "/fresh-light");
        assert_eq!(out[1].path, "/old-heavy");
    }

    #[test]
    fn rank_truncates_to_top_n() {
        let rows: Vec<_> = (0..9).map(|i| QuickTargetRow {
            kind: "dir".into(), path: format!("/u{}", i), agent: "claude".into(),
            hits: 1, last_ms: T0, score_raw: 10.0 - i as f64,
        }).collect();
        let out = rank(rows, T0);
        assert_eq!(out.len(), TOP_N, "恰好 TOP_N 条（显示上限）");
        assert_eq!(out[0].path, "/u0", "最高分在前");
    }

    #[test]
    fn owner_scope_isolates_users_on_read() {
        let (s, _d) = tmp_store();
        s.bump("u1", "dir", "/w/a", "claude", T0).unwrap();
        assert_eq!(s.candidates("u1", "dir").unwrap().len(), 1);
        assert!(s.candidates("u2", "dir").unwrap().is_empty(), "u2 不该看到 u1 的行");
    }

    #[test]
    fn kind_scope_isolates_dir_from_note() {
        let (s, _d) = tmp_store();
        s.bump("u1", "dir", "same/path", "claude", T0).unwrap();
        s.bump("u1", "note", "same/path", "", T0).unwrap();
        assert_eq!(s.candidates("u1", "dir").unwrap().len(), 1);
        assert_eq!(s.candidates("u1", "note").unwrap().len(), 1);
    }

    #[test]
    fn forget_is_owner_scoped_and_agent_specific() {
        let (s, _d) = tmp_store();
        s.bump("u1", "dir", "/w/a", "claude", T0).unwrap();
        s.bump("u1", "dir", "/w/a", "codex", T0).unwrap();
        // 跨用户删无效
        s.forget("u2", "dir", "/w/a", "claude").unwrap();
        assert_eq!(s.candidates("u1", "dir").unwrap().len(), 2, "u2 不能删 u1 的行");
        // 只删指定 agent 那一行
        s.forget("u1", "dir", "/w/a", "claude").unwrap();
        let rows = s.candidates("u1", "dir").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].agent, "codex", "另一个 agent 的行不受影响");
    }

    #[test]
    fn seed_from_history_is_one_shot_and_idempotent() {
        // 冷启动回填：新功能上线时表是空的，而用户的 sessions 表里已经有现成的
        // (work_dir, type, owner) 历史。不回填的话首屏空列表 → onEmpty → 自动跳
        // pick-type，用户看到的就是「对话框闪一下就跳走」(2026-09-13 线上实测)。
        let (s, _d) = tmp_store();
        let hist = vec![
            ("u1".to_string(), "/w/a".to_string(), "claude".to_string(), T0),
            ("u1".to_string(), "/w/b".to_string(), "tmux".to_string(), T0 + DAY),
        ];
        let n = s.seed_from_history(&hist).unwrap();
        assert_eq!(n, 2, "首次应回填 2 行");
        let rows = s.candidates("u1", "dir").unwrap();
        assert_eq!(rows.len(), 2);
        // 回填用会话自己的 created_ms 作 last_ms，这样最近开过的目录自然排在前
        let b = rows.iter().find(|r| r.path == "/w/b").unwrap();
        assert_eq!(b.last_ms, T0 + DAY);

        // 幂等：表非空即整体跳过，绝不重复累加分数（否则每次重启都给历史目录 +1，
        // 用户真实的使用频率会被启动次数淹没）
        let n2 = s.seed_from_history(&hist).unwrap();
        assert_eq!(n2, 0, "表非空时必须整体跳过");
        assert_eq!(s.candidates("u1", "dir").unwrap().len(), 2);
        for r in s.candidates("u1", "dir").unwrap() {
            assert_eq!(r.hits, 1, "幂等：hits 不得被重复回填抬高");
        }
    }

    #[test]
    fn seed_from_history_skips_when_table_already_has_rows() {
        // 用户已经真实用过（表里有 bump 出来的行）→ 回填必须整体不介入，
        // 免得把早已掉出榜的旧目录重新顶上来。
        let (s, _d) = tmp_store();
        s.bump("u1", "dir", "/w/real", "claude", T0).unwrap();
        let n = s.seed_from_history(&[("u1".into(), "/w/old".into(), "claude".into(), T0)]).unwrap();
        assert_eq!(n, 0);
        let rows = s.candidates("u1", "dir").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].path, "/w/real");
    }

    #[test]
    fn candidates_are_capped_at_candidate_limit() {
        let (s, _d) = tmp_store();
        for i in 0..30 {
            s.bump("u1", "dir", &format!("/w/{}", i), "claude", T0 + i).unwrap();
        }
        let rows = s.candidates("u1", "dir").unwrap();
        assert_eq!(rows.len(), 16, "候选上限 16（per-row 守卫 IO 是真正的约束）");
        // 最近的先取（last_ms DESC）
        assert!(rows.iter().any(|r| r.path == "/w/29"));
        assert!(!rows.iter().any(|r| r.path == "/w/0"));
    }
}
