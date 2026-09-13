# Quick Targets（常用目录/笔记 frecency 快速入口）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 New Session 与 Obsidian 打开笔记时,把最常用的目标（frecency 排序 + 手动 pin）直接摆在首屏,做到「1 次点击、0 次列目录请求」。

**Architecture:** 后端新增一张 `quick_targets` 表（`kind='dir'|'note'` 两种实例共用），bump 只发生在 `web.rs` 的两个交互式 HTTP handler（`create_session` / `vault_file`）成功分支——因此「定时任务不污染 frecency」是架构保证而非条件判断。指数半衰期评分在 Rust 内计算（不在 SQL），读取时对每条重跑与 `list_directories` 相同的路径守卫并剔除+删行自愈。前端一个 `QuickTargets` 组件复用于三处入口。

**Tech Stack:** Rust / Axum / rusqlite 0.31 (bundled) / React 19 / Vite / Tailwind v4 / vitest + @testing-library/react

**Spec:** `docs/superpowers/specs/2026-09-13-quick-targets-design.md`

## Global Constraints

- **语言规范**：用户可见字符串与文档用中文；代码与注释用英文（本 repo 双语惯例）。
- **半衰期常量**：`HALF_LIFE_MS = 14 * 24 * 3600 * 1000`（14 天，以毫秒表示）。
- **Top N 常量**：`TOP_N = 5`。不做可配置。
- **候选上限**：SQL 取候选 `LIMIT 50`。
- **owner-scope 强制**：`quick_targets` 的**每一条** SQL（SELECT/UPDATE/DELETE/UPSERT）都必须带 `user_id = ?`。read 与 write 对称。
- **bump 为 best-effort**：失败只 `eprintln!` 记录，绝不让 session 创建 / 笔记打开返回 5xx。
- **无公开 bump 端点、无 import 端点**。`pin` / `DELETE` 只能改动**已存在**的行，不能凭空插入 path。
- **前端 stale-response 防护**：`QuickTargets` 的 fetch 与所有乐观 mutation 都必须带单调 `reqRef` 令牌（fetch 顶部 bump、每个乐观 setState 前 bump、`await` 后守卫）。
- **构建顺序**：前端必须先 build 才能 `cargo build`（`rust-embed` 编译期读 `frontend/dist/`）。迭代期用 `cargo check` / `cargo test`，不用 `--release`。
- **不改 `session_manager.rs`**：bump 不下沉到 create_* 方法。

---

### Task 1: `quick_targets` 存储层 + frecency 纯函数

**Files:**
- Create: `src/quick_targets.rs`
- Modify: `src/main.rs:120`（`mod` 声明区，紧邻 `mod prompts;` 等）

**Interfaces:**
- Consumes: 无（本任务是根）
- Produces:
  - `pub struct QuickTargetStore`，`pub fn open(data_dir: &Path) -> Result<Self, String>`
  - `pub struct QuickTargetRow { pub kind: String, pub path: String, pub hits: i64, pub last_ms: i64, pub score_raw: f64, pub pinned: bool, pub last_agent: Option<String> }`
  - `pub fn bump(&self, user_id: &str, kind: &str, path: &str, last_agent: Option<&str>, now_ms: i64) -> Result<(), String>`
  - `pub fn candidates(&self, user_id: &str, kind: &str) -> Result<Vec<QuickTargetRow>, String>`
  - `pub fn set_pinned(&self, user_id: &str, kind: &str, path: &str, pinned: bool) -> Result<bool, String>`（返回 false = 行不存在）
  - `pub fn forget(&self, user_id: &str, kind: &str, path: &str) -> Result<(), String>`
  - `pub fn decayed_score(score_raw: f64, last_ms: i64, now_ms: i64) -> f64`
  - `pub fn rank(rows: Vec<QuickTargetRow>, now_ms: i64) -> (Vec<QuickTargetRow>, Vec<QuickTargetRow>)`（返回 `(pinned, top)`）
  - `pub const HALF_LIFE_MS: i64`、`pub const TOP_N: usize`

- [ ] **Step 1: 写失败的测试**

在 `src/quick_targets.rs` 末尾创建（文件此时还没有实现体，先只放测试模块 + 上面列出的签名骨架会编译失败——这是预期的）。完整测试模块：

```rust
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
        s.bump("u1", "dir", "/w/a", Some("claude"), T0).unwrap();
        let rows = s.candidates("u1", "dir").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].hits, 1);
        assert_eq!(rows[0].last_ms, T0);
        assert!((rows[0].score_raw - 1.0).abs() < 1e-9, "first insert must be exactly 1.0");
        assert_eq!(rows[0].last_agent.as_deref(), Some("claude"));
        assert!(!rows[0].pinned);
    }

    #[test]
    fn repeated_bump_accumulates_hits_and_score() {
        let (s, _d) = tmp_store();
        s.bump("u1", "dir", "/w/a", Some("claude"), T0).unwrap();
        s.bump("u1", "dir", "/w/a", Some("codex"), T0 + DAY).unwrap();
        let rows = s.candidates("u1", "dir").unwrap();
        assert_eq!(rows.len(), 1, "same path must upsert, not duplicate");
        assert_eq!(rows[0].hits, 2);
        assert_eq!(rows[0].last_ms, T0 + DAY);
        // 1.0 衰减 1 天后 + 1.0 → 介于 1.0 与 2.0 之间，且严格大于 1.0
        assert!(rows[0].score_raw > 1.0 && rows[0].score_raw < 2.0);
        assert_eq!(rows[0].last_agent.as_deref(), Some("codex"), "last_agent 被最新一次覆盖");
    }

    #[test]
    fn bump_with_none_agent_does_not_erase_existing_agent() {
        // kind='note' 的 bump 传 None；同一 store 里 dir 行的 last_agent 不该被 None 清掉
        let (s, _d) = tmp_store();
        s.bump("u1", "dir", "/w/a", Some("claude"), T0).unwrap();
        s.bump("u1", "dir", "/w/a", None, T0 + DAY).unwrap();
        let rows = s.candidates("u1", "dir").unwrap();
        assert_eq!(rows[0].last_agent.as_deref(), Some("claude"),
                   "None 表示「本次不带类型信息」，不是「清空」");
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
        // 时钟回拨：now < last_ms 不应放大分数
        let s = decayed_score(1.0, T0, T0 - 10 * DAY);
        assert!(s <= 1.0 + 1e-9, "负 elapsed 必须钳到不放大，实际 {}", s);
    }

    #[test]
    fn rank_orders_unpinned_by_decayed_score_desc() {
        let rows = vec![
            QuickTargetRow { kind: "dir".into(), path: "/old-heavy".into(), hits: 20,
                             last_ms: T0 - 60 * DAY, score_raw: 20.0, pinned: false, last_agent: None },
            QuickTargetRow { kind: "dir".into(), path: "/fresh-light".into(), hits: 2,
                             last_ms: T0, score_raw: 2.0, pinned: false, last_agent: None },
        ];
        let (pinned, top) = rank(rows, T0);
        assert!(pinned.is_empty());
        // old-heavy: 20 * 0.5^(60/14) ≈ 1.0；fresh-light: 2.0 → fresh 在前
        assert_eq!(top[0].path, "/fresh-light");
        assert_eq!(top[1].path, "/old-heavy");
    }

    #[test]
    fn rank_pinned_come_first_and_do_not_consume_top_n_slots() {
        let mut rows = vec![QuickTargetRow {
            kind: "dir".into(), path: "/pinned".into(), hits: 1,
            last_ms: T0 - 300 * DAY, score_raw: 1.0, pinned: true, last_agent: None,
        }];
        // 6 条未 pin，分数递减
        for i in 0..6 {
            rows.push(QuickTargetRow {
                kind: "dir".into(), path: format!("/u{}", i), hits: 1,
                last_ms: T0, score_raw: 10.0 - i as f64, pinned: false, last_agent: None,
            });
        }
        let (pinned, top) = rank(rows, T0);
        assert_eq!(pinned.len(), 1, "pinned 全部返回");
        assert_eq!(pinned[0].path, "/pinned", "pinned 即便分数最低也返回");
        assert_eq!(top.len(), TOP_N, "未 pin 部分恰好 TOP_N 条");
        assert_eq!(top[0].path, "/u0");
        assert!(top.iter().all(|r| !r.pinned), "top 不含 pinned 条目");
    }

    #[test]
    fn owner_scope_isolates_users_on_read() {
        let (s, _d) = tmp_store();
        s.bump("u1", "dir", "/w/a", None, T0).unwrap();
        assert_eq!(s.candidates("u1", "dir").unwrap().len(), 1);
        assert!(s.candidates("u2", "dir").unwrap().is_empty(), "u2 不该看到 u1 的行");
    }

    #[test]
    fn kind_scope_isolates_dir_from_note() {
        let (s, _d) = tmp_store();
        s.bump("u1", "dir", "same/path", None, T0).unwrap();
        s.bump("u1", "note", "same/path", None, T0).unwrap();
        assert_eq!(s.candidates("u1", "dir").unwrap().len(), 1);
        assert_eq!(s.candidates("u1", "note").unwrap().len(), 1);
    }

    #[test]
    fn set_pinned_is_owner_scoped_and_requires_existing_row() {
        let (s, _d) = tmp_store();
        s.bump("u1", "dir", "/w/a", None, T0).unwrap();
        // 跨用户 pin 无效
        assert!(!s.set_pinned("u2", "dir", "/w/a", true).unwrap(), "跨用户必须返回 false");
        assert!(!s.candidates("u1", "dir").unwrap()[0].pinned, "u1 的行不该被 u2 改动");
        // 不存在的 path 不能被凭空创建
        assert!(!s.set_pinned("u1", "dir", "/never/seen", true).unwrap());
        assert_eq!(s.candidates("u1", "dir").unwrap().len(), 1, "pin 不得插入新行");
        // 本人 pin 生效
        assert!(s.set_pinned("u1", "dir", "/w/a", true).unwrap());
        assert!(s.candidates("u1", "dir").unwrap()[0].pinned);
    }

    #[test]
    fn forget_is_owner_scoped() {
        let (s, _d) = tmp_store();
        s.bump("u1", "dir", "/w/a", None, T0).unwrap();
        s.forget("u2", "dir", "/w/a").unwrap();
        assert_eq!(s.candidates("u1", "dir").unwrap().len(), 1, "u2 不能删 u1 的行");
        s.forget("u1", "dir", "/w/a").unwrap();
        assert!(s.candidates("u1", "dir").unwrap().is_empty());
    }

    #[test]
    fn candidates_are_capped() {
        let (s, _d) = tmp_store();
        for i in 0..60 {
            s.bump("u1", "dir", &format!("/w/{}", i), None, T0 + i).unwrap();
        }
        let rows = s.candidates("u1", "dir").unwrap();
        assert_eq!(rows.len(), 50, "候选上限 50，防表膨胀时读全表");
        // 最近的先取（last_ms DESC）→ /w/59 必在其中，/w/0 必被截掉
        assert!(rows.iter().any(|r| r.path == "/w/59"));
        assert!(!rows.iter().any(|r| r.path == "/w/0"));
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test quick_targets 2>&1 | tail -20`
Expected: 编译失败——`cannot find type QuickTargetStore` / `cannot find function decayed_score`（实现体还不存在）。

- [ ] **Step 3: 写最小实现**

在 `src/quick_targets.rs` **顶部**（测试模块之前）写入：

```rust
//! 常用目录/笔记的 frecency 排行（quick targets）。
//! 一张表承载两种实例：kind='dir'（会话工作目录）与 kind='note'（vault 笔记）。
//! 与 session_store 同库（~/.zeromux/zeromux.db），总是开启，不依赖 OAuth 模式。
//!
//! 评分：指数半衰期。写入时只更新一行；衰减在 READ 时计算，故无需后台衰减任务
//! 也无需周期性重写全表。衰减刻意在 Rust 里算而不在 SQL 里算——rusqlite 0.31
//! bundled SQLite 不带 pow(),为此开 math 扩展或注册自定义函数不划算。

use rusqlite::{params, Connection};
use std::path::Path;
use std::sync::Mutex;

/// 半衰期 14 天（毫秒）。两周不碰的目标自然掉出 Top5。
pub const HALF_LIFE_MS: i64 = 14 * 24 * 3600 * 1000;
/// 未 pin 的返回条数。pinned 不占这些名额。
pub const TOP_N: usize = 5;
/// SQL 候选上限。实际量级是几十条，此上限只为防表意外膨胀时把全表读进内存。
const CANDIDATE_LIMIT: i64 = 50;

#[derive(Debug, Clone, PartialEq)]
pub struct QuickTargetRow {
    pub kind: String,
    pub path: String,
    pub hits: i64,
    pub last_ms: i64,
    pub score_raw: f64,
    pub pinned: bool,
    /// 仅 kind='dir' 有意义：上次在此目录创建的会话类型。
    pub last_agent: Option<String>,
}

/// 把累积分按距今时长做指数衰减。
/// elapsed 为负（时钟回拨/NTP 调整）时钳到 0，避免放大分数。
pub fn decayed_score(score_raw: f64, last_ms: i64, now_ms: i64) -> f64 {
    let elapsed = (now_ms - last_ms).max(0) as f64;
    score_raw * 0.5_f64.powf(elapsed / HALF_LIFE_MS as f64)
}

/// 拆成 (pinned, top)。pinned 全部返回且不占 TOP_N 名额——pin 是用户显式声明的
/// 「常见目录」，若与算法竞争名额，pin 3 个就只剩 2 个自动推荐位，功能互相抵消。
pub fn rank(rows: Vec<QuickTargetRow>, now_ms: i64) -> (Vec<QuickTargetRow>, Vec<QuickTargetRow>) {
    let (mut pinned, mut rest): (Vec<_>, Vec<_>) = rows.into_iter().partition(|r| r.pinned);
    let by_score_desc = |a: &QuickTargetRow, b: &QuickTargetRow| {
        decayed_score(b.score_raw, b.last_ms, now_ms)
            .partial_cmp(&decayed_score(a.score_raw, a.last_ms, now_ms))
            .unwrap_or(std::cmp::Ordering::Equal)
    };
    pinned.sort_by(by_score_desc);
    rest.sort_by(by_score_desc);
    rest.truncate(TOP_N);
    (pinned, rest)
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
                hits        INTEGER NOT NULL DEFAULT 0,
                last_ms     INTEGER NOT NULL,
                score_raw   REAL    NOT NULL DEFAULT 0,
                pinned      INTEGER NOT NULL DEFAULT 0,
                last_agent  TEXT,
                PRIMARY KEY (user_id, kind, path)
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
    /// last_agent=None 表示「本次不带类型信息」（kind='note' 恒为 None），
    /// 不是「清空」——用 COALESCE 保留已有值。
    ///
    /// 衰减刻意用「先读后写」而不是在 SQL 的 ON CONFLICT 分支里算：SQLite 没有
    /// pow()，无法在 UPDATE 里做指数衰减。读与写在同一把 Mutex 内，故不存在
    /// read-modify-write 竞态。
    pub fn bump(
        &self,
        user_id: &str,
        kind: &str,
        path: &str,
        last_agent: Option<&str>,
        now_ms: i64,
    ) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        let existing: Option<(f64, i64)> = conn
            .query_row(
                "SELECT score_raw, last_ms FROM quick_targets
                 WHERE user_id = ?1 AND kind = ?2 AND path = ?3",
                params![user_id, kind, path],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|e| format!("bump read failed: {}", e))?;

        match existing {
            None => {
                conn.execute(
                    "INSERT INTO quick_targets
                       (user_id, kind, path, hits, last_ms, score_raw, pinned, last_agent)
                     VALUES (?1, ?2, ?3, 1, ?4, 1.0, 0, ?5)",
                    params![user_id, kind, path, now_ms, last_agent],
                )
                .map_err(|e| format!("bump insert failed: {}", e))?;
            }
            Some((score_raw, last_ms)) => {
                let next = decayed_score(score_raw, last_ms, now_ms) + 1.0;
                conn.execute(
                    "UPDATE quick_targets SET
                       hits       = hits + 1,
                       score_raw  = ?4,
                       last_ms    = ?5,
                       last_agent = COALESCE(?6, last_agent)
                     WHERE user_id = ?1 AND kind = ?2 AND path = ?3",
                    params![user_id, kind, path, next, now_ms, last_agent],
                )
                .map_err(|e| format!("bump update failed: {}", e))?;
            }
        }
        Ok(())
    }

    /// 取候选行（不评分、不排序——那是 rank 的职责）。
    /// ORDER BY last_ms DESC 保证截断时留下的是最近用过的。
    pub fn candidates(&self, user_id: &str, kind: &str) -> Result<Vec<QuickTargetRow>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT kind, path, hits, last_ms, score_raw, pinned, last_agent
                 FROM quick_targets
                 WHERE user_id = ?1 AND kind = ?2
                 ORDER BY pinned DESC, last_ms DESC
                 LIMIT ?3",
            )
            .map_err(|e| format!("prepare failed: {}", e))?;
        let rows = stmt
            .query_map(params![user_id, kind, CANDIDATE_LIMIT], |row| {
                Ok(QuickTargetRow {
                    kind: row.get(0)?,
                    path: row.get(1)?,
                    hits: row.get(2)?,
                    last_ms: row.get(3)?,
                    score_raw: row.get(4)?,
                    pinned: row.get::<_, i64>(5)? != 0,
                    last_agent: row.get(6)?,
                })
            })
            .map_err(|e| format!("query failed: {}", e))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| format!("row failed: {}", e))?);
        }
        Ok(out)
    }

    /// 置/取消 pin。只能改动已存在的行——返回 false 表示没有匹配行（不存在，
    /// 或属于别的 user）。刻意不 upsert：能凭空插入 path 的写端点等于让前端
    /// 伪造使用历史，与被否决的公开 bump 端点是同一个洞。
    pub fn set_pinned(&self, user_id: &str, kind: &str, path: &str, pinned: bool) -> Result<bool, String> {
        let conn = self.conn.lock().unwrap();
        let n = conn
            .execute(
                "UPDATE quick_targets SET pinned = ?4
                 WHERE user_id = ?1 AND kind = ?2 AND path = ?3",
                params![user_id, kind, path, pinned as i64],
            )
            .map_err(|e| format!("set_pinned failed: {}", e))?;
        Ok(n > 0)
    }

    /// 从榜上移除。owner-scope 与 read 对称（教训：2026-08-09 push 订阅跨用户劫持）。
    pub fn forget(&self, user_id: &str, kind: &str, path: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM quick_targets WHERE user_id = ?1 AND kind = ?2 AND path = ?3",
            params![user_id, kind, path],
        )
        .map_err(|e| format!("forget failed: {}", e))?;
        Ok(())
    }
}
```

顶部 import 用（`optional()` 需要 `OptionalExtension`）：

```rust
use rusqlite::{params, Connection, OptionalExtension};
```

- [ ] **Step 4: 注册模块**

在 `src/main.rs` 的 mod 声明区（`mod prompts;` 附近）加一行：

```rust
mod quick_targets;
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cargo test quick_targets 2>&1 | tail -20`
Expected: PASS，13 个测试全绿。

- [ ] **Step 6: Commit**

```bash
git add src/quick_targets.rs src/main.rs
git commit -m "feat(quick-targets): frecency 存储层 + 指数半衰期评分纯函数

一张 quick_targets 表承载 kind='dir'|'note' 两种实例。衰减在 Rust 算不在
SQL 算(rusqlite bundled 无 pow(),不为此加构建依赖);bump 的 read-modify-write
在同一把 Mutex 内故无竞态。pinned 不占 TOP_N 名额;set_pinned/forget 与读
对称地 owner-scope,且 set_pinned 只能改已存在的行(不能凭空插入 path)。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: 接入 AppState + 两处 bump 落点

**Files:**
- Modify: `src/main.rs:129-155`（`AppState` 加字段）、`src/main.rs:261`（open store 并注入）
- Modify: `src/web.rs:395`（`create_session` 成功分支 bump）、`src/web.rs:3448`（`vault_file` 成功分支 bump）

**Interfaces:**
- Consumes: Task 1 的 `QuickTargetStore::open` / `bump`
- Produces: `AppState.quick_targets: Arc<crate::quick_targets::QuickTargetStore>`（Task 3 的 handler 读它）

- [ ] **Step 1: AppState 加字段**

`src/main.rs` 的 `pub struct AppState`（约 `L129`）在 `pub vault_index:` 之后加：

```rust
    pub quick_targets: Arc<quick_targets::QuickTargetStore>,
```

- [ ] **Step 2: 启动时 open store**

`src/main.rs` 中 `session_store` 那一段（约 `L261`）之后加：

```rust
    // 常用目录/笔记 frecency。与 sessions 同库、总是开启（不依赖 OAuth 模式）：
    // legacy 模式的 CurrentUser::legacy().id 是固定 "legacy"，owner-scope 仍成立。
    let quick_targets_store = Arc::new(
        quick_targets::QuickTargetStore::open(std::path::Path::new(&data_dir_str))
            .expect("Failed to initialize quick targets store"),
    );
```

并在构造 `AppState { ... }` 的字面量里加一行 `quick_targets: quick_targets_store,`（紧随 `vault_index` 之后，保持与结构体字段同序）。

- [ ] **Step 3: `create_session` 成功分支 bump**

`src/web.rs` 的 `create_session`（`L395`）中，`let id = match req.session_type { ... };` 之后、返回 `Json` 之前插入：

```rust
    // 记一次「用户真的去了那里」。刻意写在 HTTP handler 层而不下沉到
    // session_manager 的 create_* 方法：定时任务走 create_acp_session_tagged
    // 那条独立路径，把 bump 留在这里，「cron 不污染 frecency」就是架构保证，
    // 而不是一行在未来重构里容易丢失的 if。
    //
    // 记 req 提交的 work_dir 而非 resolve_work_dir 之后的 effective_dir:
    // 开启 --worktree-isolation 时后者是 .zeromux-worktrees/<id>/ 这类一次性
    // 路径,记它下次点击必然失效。
    //
    // best-effort: 一个「记住我去过哪」的功能没有资格让会话创建失败。
    if let Err(e) = state.quick_targets.bump(
        &owner_id,
        "dir",
        &work_dir,
        Some(&type_label),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0),
    ) {
        eprintln!("quick_targets bump (dir) skipped: {}", e);
    }
```

（已核实 `session_manager.rs:259` 的 `now_millis` **没有** `pub`，故不能跨模块调用——
上面内联 `SystemTime` 即最终形态，无需再判断。）

- [ ] **Step 4: `vault_file` 成功分支 bump**

`src/web.rs` 的 `vault_file`（`L3448`）末尾，`let (content, truncated) = read_text_file_capped(&real)?;` 之后、`Ok(Json(...))` 之前插入：

```rust
    // 笔记打开成功才记（失败/403 分支不记）。kind='note' 无 agent 概念 → None。
    if let Err(e) = state.quick_targets.bump(
        &user.id,
        "note",
        &q.path,
        None,
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0),
    ) {
        eprintln!("quick_targets bump (note) skipped: {}", e);
    }
```

- [ ] **Step 5: 编译验证**

Run: `cargo check 2>&1 | tail -20`
Expected: 无错误。若报 `AppState` 字段缺失，检查是否所有构造 `AppState` 的地方（含测试）都加了新字段。

Run: `cargo test 2>&1 | tail -15`
Expected: 全部既有测试仍绿 + Task 1 的 13 个绿。

- [ ] **Step 6: Commit**

```bash
git add src/main.rs src/web.rs
git commit -m "feat(quick-targets): 接入 AppState + create_session/vault_file 两处 bump

bump 只写在 web.rs 的交互式 handler,不下沉 session_manager——定时任务走
create_acp_session_tagged 独立路径,故「cron 不污染 frecency」是架构保证。
记 req.work_dir 而非 effective_dir(worktree 隔离下后者是一次性路径)。
两处 bump 均 best-effort,失败只记日志不影响主流程。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: 三个 REST 端点 + 读出时守卫自愈

**Files:**
- Modify: `src/web.rs:65`（路由注册，authed `/api/*` 组内）
- Modify: `src/web.rs`（新增 3 个 handler + 1 个纯函数，建议紧邻 `list_directories` 之后即 `L300` 附近）

**Interfaces:**
- Consumes: Task 2 的 `state.quick_targets`；既有守卫 `validate_browse_root`（`web.rs:1075`）、`read_hits_home_dotdir`（`web.rs:1242`）、`vault_base`（`web.rs:3364`）、`resolve_and_verify`
- Produces: HTTP 端点
  - `GET /api/quick-targets?kind=dir|note` → `{ pinned: [...], top: [...] }`
  - `POST /api/quick-targets/pin` ← `{ kind, path, pinned }`
  - `DELETE /api/quick-targets` ← `{ kind, path }`
  - 条目 JSON：`{ kind, path, display, hint, pinned, last_agent, is_git }`

- [ ] **Step 1: 写失败的测试**

在 `src/web.rs` 既有的 `#[cfg(test)] mod tests` 内追加（该模块已存在，见 `web.rs:3732` 附近的 `validate_browse_root_accepts_normal_rejects_sensitive`）：

```rust
    #[test]
    fn quick_target_display_and_hint_for_dir() {
        // dir: display=basename, hint=以 ~ 缩写的父路径
        let (d, h) = dir_display_hint("/home/ubuntu/s3-workspace/keith-space/ai/zeromux", "/home/ubuntu");
        assert_eq!(d, "zeromux");
        assert_eq!(h, "~/s3-workspace/keith-space/ai");
    }

    #[test]
    fn quick_target_display_hint_for_dir_directly_under_home() {
        let (d, h) = dir_display_hint("/home/ubuntu/drafts", "/home/ubuntu");
        assert_eq!(d, "drafts");
        assert_eq!(h, "~");
    }

    #[test]
    fn quick_target_display_and_hint_for_note() {
        // note: display=笔记名去 .md, hint=父目录相对路径
        let (d, h) = note_display_hint("projects/long-term/考研英语/_index.md");
        assert_eq!(d, "_index");
        assert_eq!(h, "projects/long-term/考研英语");
    }

    #[test]
    fn quick_target_note_at_vault_root_has_empty_hint() {
        let (d, h) = note_display_hint("README.md");
        assert_eq!(d, "README");
        assert_eq!(h, "", "顶层笔记 hint 为空串");
    }

    #[test]
    fn quick_target_note_display_strips_md_case_insensitively() {
        let (d, _) = note_display_hint("a/B.MD");
        assert_eq!(d, "B");
    }
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test quick_target_ 2>&1 | tail -15`
Expected: 编译失败——`cannot find function dir_display_hint` / `note_display_hint`。

- [ ] **Step 3: 写两个纯函数**

在 `src/web.rs` 的 `list_directories` 之后（`L300` 附近）加：

```rust
/// dir 条目的展示对：(display=basename, hint=以 ~ 缩写的父路径)。
/// hint 存在的意义是区分同名 basename（多个 repo 都有 `scripts/`）。
fn dir_display_hint(path: &str, home: &str) -> (String, String) {
    let p = std::path::Path::new(path);
    let display = p
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string());
    let parent = p
        .parent()
        .map(|x| x.to_string_lossy().to_string())
        .unwrap_or_default();
    let hint = if !home.is_empty() && parent.starts_with(home) {
        parent.replacen(home, "~", 1)
    } else {
        parent
    };
    (display, hint)
}

/// note 条目的展示对：(display=笔记名去 .md, hint=父目录相对路径)。
/// vault 内 `_index.md` 不止一个,只显示 basename 无法分辨 → 必须带父目录。
fn note_display_hint(rel_path: &str) -> (String, String) {
    let (dir, base) = match rel_path.rfind('/') {
        Some(i) => (&rel_path[..i], &rel_path[i + 1..]),
        None => ("", rel_path),
    };
    let display = if base.to_ascii_lowercase().ends_with(".md") {
        base[..base.len() - 3].to_string()
    } else {
        base.to_string()
    };
    (display, dir.to_string())
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cargo test quick_target_ 2>&1 | tail -15`
Expected: PASS，5 个绿。

- [ ] **Step 5: 写三个 handler**

紧随上面两个纯函数加入：

```rust
#[derive(serde::Deserialize)]
struct QuickTargetQuery {
    kind: String,
}

#[derive(serde::Deserialize)]
struct QuickTargetPinReq {
    kind: String,
    path: String,
    pinned: bool,
}

#[derive(serde::Deserialize)]
struct QuickTargetForgetReq {
    kind: String,
    path: String,
}

/// 只接受这两种 kind；其它一律 400（防止用任意 kind 字符串把表当通用 KV 用）。
fn validate_kind(kind: &str) -> Result<(), (StatusCode, String)> {
    if kind == "dir" || kind == "note" {
        Ok(())
    } else {
        Err((StatusCode::BAD_REQUEST, "kind must be 'dir' or 'note'".into()))
    }
}

/// 读出时对每条重新校验，失败即剔除 + 删行（自愈）。
///
/// 存的是历史，而历史里的路径可能已被删除、已被替换为指向 ~/.ssh 的 symlink、
/// 或守卫规则本身已升级加严。所以这里跑与 list_directories 完全相同的守卫组合
/// （validate_browse_root + read_hits_home_dotdir），而不是「存的时候合法所以
/// 永远合法」。顺手删行，避免同一条坏路径每次都重复校验。
async fn list_quick_targets(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
    Query(q): Query<QuickTargetQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    validate_kind(&q.kind)?;
    // note 的可见性跟 vault 一致：vault 未配置或调用者非 admin → 空列表（而不是
    // 泄漏「有哪些笔记曾被打开」）。
    if q.kind == "note" && vault_base(&state, &user).is_err() {
        return Ok(Json(serde_json::json!({ "pinned": [], "top": [] })));
    }

    let rows = state
        .quick_targets
        .candidates(&user.id, &q.kind)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    let home = std::env::var("HOME").unwrap_or_else(|_| "/home/ubuntu".to_string());
    let mut alive = Vec::new();
    for r in rows {
        if quick_target_still_valid(&state, &user, &r) {
            alive.push(r);
        } else {
            // 坏行就地清理；失败只忽略（下次还会再试）。
            let _ = state.quick_targets.forget(&user.id, &r.kind, &r.path);
        }
    }

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let (pinned, top) = crate::quick_targets::rank(alive, now_ms);

    let to_json = |r: &crate::quick_targets::QuickTargetRow| {
        let (display, hint) = if r.kind == "dir" {
            dir_display_hint(&r.path, &home)
        } else {
            note_display_hint(&r.path)
        };
        let is_git = r.kind == "dir" && std::path::Path::new(&r.path).join(".git").exists();
        serde_json::json!({
            "kind": r.kind,
            "path": r.path,
            "display": display,
            "hint": hint,
            "pinned": r.pinned,
            "last_agent": r.last_agent,
            "is_git": is_git,
        })
    };

    Ok(Json(serde_json::json!({
        "pinned": pinned.iter().map(to_json).collect::<Vec<_>>(),
        "top": top.iter().map(to_json).collect::<Vec<_>>(),
    })))
}

/// 一条历史行现在还能不能用。
/// dir：与 list_directories 同一组守卫 + 仍是目录。
/// note：仍在 vault 内、无 dot 组件、非敏感、文件仍存在。
fn quick_target_still_valid(
    state: &AppState,
    user: &CurrentUser,
    r: &crate::quick_targets::QuickTargetRow,
) -> bool {
    if r.kind == "dir" {
        let canonical = match validate_browse_root(&r.path) {
            Ok(p) => p,
            Err(_) => return false,
        };
        if read_hits_home_dotdir(&canonical) {
            return false;
        }
        return canonical.is_dir();
    }
    // note
    let base = match vault_base(state, user) {
        Ok(b) => b,
        Err(_) => return false,
    };
    if vault_path_has_dot_component(&r.path) {
        return false;
    }
    let base_path = std::path::Path::new(base);
    let real = match resolve_and_verify(base_path, &r.path) {
        Ok(p) => p,
        Err(_) => return false,
    };
    if descends_into_sensitive_dir(base_path, &real) || vault_real_hits_dot_component(base_path, &real) {
        return false;
    }
    real.is_file()
}

/// 置/取消 pin。404 = 该 user 名下无此行——刻意不 upsert：能凭空插入 path 的
/// 写端点等于伪造使用历史，与被否决的公开 bump 端点是同一个洞。
async fn pin_quick_target(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
    Json(req): Json<QuickTargetPinReq>,
) -> Result<StatusCode, (StatusCode, String)> {
    validate_kind(&req.kind)?;
    let updated = state
        .quick_targets
        .set_pinned(&user.id, &req.kind, &req.path, req.pinned)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    if updated {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err((StatusCode::NOT_FOUND, "quick target not found".into()))
    }
}

async fn forget_quick_target(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
    Json(req): Json<QuickTargetForgetReq>,
) -> Result<StatusCode, (StatusCode, String)> {
    validate_kind(&req.kind)?;
    state
        .quick_targets
        .forget(&user.id, &req.kind, &req.path)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(StatusCode::NO_CONTENT)
}
```

本 handler 用到的六个守卫已核实全部位于 `web.rs` 同文件内，直接可调，无需改可见性：
`validate_browse_root`（`L1075`）、`descends_into_sensitive_dir`（`L1222`）、
`read_hits_home_dotdir`（`L1242`）、`resolve_and_verify`（`L1491`）、
`vault_path_has_dot_component`（`L3341`）、`vault_real_hits_dot_component`（`L3352`）。

- [ ] **Step 6: 注册路由**

`src/web.rs` 的 authed `/api/*` 组内（`L65` 的 `.route("/api/directories", ...)` 之后）加：

```rust
        .route("/api/quick-targets", get(list_quick_targets).delete(forget_quick_target))
        .route("/api/quick-targets/pin", post(pin_quick_target))
```

- [ ] **Step 7: 编译 + 全量测试**

Run: `cargo test 2>&1 | tail -15`
Expected: 全绿（既有 + Task 1 的 13 + Task 3 的 5）。

- [ ] **Step 8: Commit**

```bash
git add src/web.rs
git commit -m "feat(quick-targets): 三个 REST 端点 + 读出时守卫自愈

GET 对每条历史行重跑 list_directories 同一组守卫(validate_browse_root +
read_hits_home_dotdir)并剔除+删行——存的是历史,路径可能已被删/改指向
~/.ssh/守卫已加严,不能「存时合法即永远合法」。note 的可见性跟随 vault_base,
未配置或非 admin 返回空列表而不泄漏曾打开过哪些笔记。pin 只改已存在的行,
无匹配返回 404 而不 upsert。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: 前端 API 封装 + `last_agent` 白名单纯函数

**Files:**
- Modify: `frontend/src/lib/api.ts`（类型 + 3 个封装，建议加在 `listDirectories` 之后即 `L190` 附近）
- Create: `frontend/src/lib/quickTargets.ts`
- Test: `frontend/src/lib/__tests__/quickTargets.test.ts`

**Interfaces:**
- Consumes: Task 3 的三个端点；既有 `api()` helper（`api.ts:92`）、`SessionType`（`api.ts:1`）
- Produces:
  - `export interface QuickTarget { kind: 'dir' | 'note'; path: string; display: string; hint: string; pinned: boolean; last_agent: string | null; is_git: boolean }`
  - `export interface QuickTargetList { pinned: QuickTarget[]; top: QuickTarget[] }`
  - `listQuickTargets(kind: 'dir' | 'note'): Promise<QuickTargetList>`
  - `pinQuickTarget(kind, path, pinned): Promise<void>`
  - `forgetQuickTarget(kind, path): Promise<void>`
  - `coerceAgent(v: string | null | undefined): SessionType | null`（`quickTargets.ts`）
  - `flatten(list: QuickTargetList): QuickTarget[]`（`quickTargets.ts`）

- [ ] **Step 1: 写失败的测试**

创建 `frontend/src/lib/__tests__/quickTargets.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { coerceAgent, flatten } from '../quickTargets'
import type { QuickTarget, QuickTargetList } from '../api'

const t = (over: Partial<QuickTarget> = {}): QuickTarget => ({
  kind: 'dir', path: '/w/a', display: 'a', hint: '~', pinned: false,
  last_agent: null, is_git: false, ...over,
})

describe('coerceAgent', () => {
  it('接受当前四种 SessionType', () => {
    expect(coerceAgent('claude')).toBe('claude')
    expect(coerceAgent('codex')).toBe('codex')
    expect(coerceAgent('kiro')).toBe('kiro')
    expect(coerceAgent('tmux')).toBe('tmux')
  })

  it('null / undefined → null（旧行或首次记录，退化到 pick-type）', () => {
    expect(coerceAgent(null)).toBeNull()
    expect(coerceAgent(undefined)).toBeNull()
  })

  it('未知字符串 → null，绝不把脏值发给后端', () => {
    // 某个 agent 类型日后被移除时，库里的旧行会留下已失效的字符串。
    expect(coerceAgent('gemini')).toBeNull()
    expect(coerceAgent('')).toBeNull()
    expect(coerceAgent('CLAUDE')).toBeNull()   // 大小写敏感，不做宽松匹配
  })
})

describe('flatten', () => {
  it('pinned 在前，top 在后，顺序保持后端给的', () => {
    const list: QuickTargetList = {
      pinned: [t({ path: '/p1', pinned: true }), t({ path: '/p2', pinned: true })],
      top: [t({ path: '/t1' }), t({ path: '/t2' })],
    }
    expect(flatten(list).map(x => x.path)).toEqual(['/p1', '/p2', '/t1', '/t2'])
  })

  it('空列表安全', () => {
    expect(flatten({ pinned: [], top: [] })).toEqual([])
  })

  it('后端字段缺失时不崩（防御性：老后端/部分部署）', () => {
    expect(flatten({} as QuickTargetList)).toEqual([])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd frontend && npx vitest run src/lib/__tests__/quickTargets.test.ts`
Expected: FAIL — `Failed to resolve import "../quickTargets"`。

- [ ] **Step 3: 写实现**

创建 `frontend/src/lib/quickTargets.ts`：

```ts
import type { SessionType, QuickTarget, QuickTargetList } from './api'

// 当前支持的会话类型。last_agent 是库里的字符串：某个 agent 类型日后被移除时
// （如 kiro），旧行会留下已失效的值。用白名单校验后再用，而不是把脏字符串
// 原样发给后端。
const AGENTS: readonly SessionType[] = ['tmux', 'claude', 'kiro', 'codex']

/** 把库里的 last_agent 收敛为合法 SessionType；不合法/缺失返回 null（调用方退化到选类型）。 */
export function coerceAgent(v: string | null | undefined): SessionType | null {
  return AGENTS.includes(v as SessionType) ? (v as SessionType) : null
}

/** pinned 在前、top 在后拍平成一个渲染列表。字段缺失时返回空数组而不抛。 */
export function flatten(list: QuickTargetList): QuickTarget[] {
  return [...(list?.pinned ?? []), ...(list?.top ?? [])]
}
```

在 `frontend/src/lib/api.ts` 的 `listDirectories` 之后（`L190` 附近）加：

```ts
// ── Quick targets（常用目录/笔记 frecency）──

export interface QuickTarget {
  kind: 'dir' | 'note'
  path: string
  display: string
  hint: string
  pinned: boolean
  last_agent: string | null
  is_git: boolean
}

export interface QuickTargetList {
  pinned: QuickTarget[]
  top: QuickTarget[]
}

export async function listQuickTargets(kind: 'dir' | 'note'): Promise<QuickTargetList> {
  const res = await api(`/api/quick-targets?kind=${kind}`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function pinQuickTarget(kind: 'dir' | 'note', path: string, pinned: boolean): Promise<void> {
  const res = await api('/api/quick-targets/pin', {
    method: 'POST',
    body: JSON.stringify({ kind, path, pinned }),
  })
  if (!res.ok) throw new Error(await res.text())
}

export async function forgetQuickTarget(kind: 'dir' | 'note', path: string): Promise<void> {
  const res = await api('/api/quick-targets', {
    method: 'DELETE',
    body: JSON.stringify({ kind, path }),
  })
  if (!res.ok) throw new Error(await res.text())
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd frontend && npx vitest run src/lib/__tests__/quickTargets.test.ts`
Expected: PASS，9 个绿。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/api.ts frontend/src/lib/quickTargets.ts frontend/src/lib/__tests__/quickTargets.test.ts
git commit -m "feat(quick-targets): 前端 API 封装 + last_agent 白名单收敛

coerceAgent 用白名单把库里的 last_agent 收敛为合法 SessionType:某个 agent
类型日后被移除时旧行会留下失效字符串,不能原样发给后端。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `QuickTargets` 组件（含 stale-response 防护）

**Files:**
- Create: `frontend/src/components/QuickTargets.tsx`
- Test: `frontend/src/components/__tests__/QuickTargets.stale.test.tsx`

**Interfaces:**
- Consumes: Task 4 的 `listQuickTargets` / `pinQuickTarget` / `forgetQuickTarget` / `coerceAgent` / `flatten`
- Produces: 默认导出组件，props：
  ```ts
  {
    kind: 'dir' | 'note'
    onPick: (path: string, agent: SessionType | null) => void
    onPickType?: (path: string) => void   // 点 ▸ 时改选类型；不传则不渲染 ▸
    emptyHint?: string
  }
  ```

- [ ] **Step 1: 写失败的测试**

创建 `frontend/src/components/__tests__/QuickTargets.stale.test.tsx`：

```tsx
import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import QuickTargets from '../QuickTargets'
import * as api from '../../lib/api'
import type { QuickTargetList, QuickTarget } from '../../lib/api'

// 本 repo 已因 stale-response clobber 修过 12 次（AgentDashboard / GitViewer /
// FileBrowser / MarkdownViewer / SessionInfoBar / usePromptPresets…）。本组件
// 同时具备「慢 GET」与「乐观 mutation」两个条件，是该 bug 的教科书场景，
// 第一版就必须带 reqRef。
describe('QuickTargets stale-response 防护', () => {
  beforeEach(() => vi.restoreAllMocks())

  const t = (over: Partial<QuickTarget> = {}): QuickTarget => ({
    kind: 'dir', path: '/w/a', display: 'a', hint: '~', pinned: false,
    last_agent: 'claude', is_git: false, ...over,
  })
  const list = (top: QuickTarget[], pinned: QuickTarget[] = []): QuickTargetList => ({ pinned, top })

  it('慢的首次 GET 不能覆盖 forget 之后的新 GET', async () => {
    // 场景：面板打开触发 GET#1（JuiceFS 慢）；用户在旧快照上点「移除」，
    // 乐观移除 + 触发 GET#2（快，已不含该条）；GET#1 迟到若写入，
    // 被移除的条目会复活成 ghost。
    let resolveSlow: (v: QuickTargetList) => void = () => {}
    const slow = new Promise<QuickTargetList>(r => { resolveSlow = r })
    let call = 0
    vi.spyOn(api, 'listQuickTargets').mockImplementation(() => {
      call += 1
      if (call === 1) return slow
      return Promise.resolve(list([t({ path: '/w/keep', display: 'keep' })]))
    })
    vi.spyOn(api, 'forgetQuickTarget').mockResolvedValue(undefined)

    render(<QuickTargets kind="dir" onPick={() => {}} />)

    // GET#1 迟到前先让它有内容可显示：先解析 GET#1，再做 forget，
    // 然后让一个更旧的响应尝试写入 —— 用第二轮 GET 作为「新」响应。
    resolveSlow(list([t({ path: '/w/gone', display: 'gone' }), t({ path: '/w/keep', display: 'keep' })]))
    await screen.findByText('gone')

    // 点「移除」→ 乐观移除 + refetch（GET#2 不含 gone）
    const row = screen.getByText('gone').closest('li')!
    ;(row.querySelector('[data-testid="qt-forget"]') as HTMLElement).click()

    await waitFor(() => expect(screen.queryByText('gone')).not.toBeInTheDocument())
    expect(screen.getByText('keep')).toBeInTheDocument()
  })

  it('乐观 pin 之后到达的旧 GET 不能把 pin 状态回滚', async () => {
    let resolveStale: (v: QuickTargetList) => void = () => {}
    const stale = new Promise<QuickTargetList>(r => { resolveStale = r })
    let call = 0
    vi.spyOn(api, 'listQuickTargets').mockImplementation(() => {
      call += 1
      if (call === 1) return Promise.resolve(list([t({ path: '/w/a', display: 'a', pinned: false })]))
      return stale   // pin 后触发的 refetch 很慢
    })
    vi.spyOn(api, 'pinQuickTarget').mockResolvedValue(undefined)

    render(<QuickTargets kind="dir" onPick={() => {}} />)
    await screen.findByText('a')

    const row = screen.getByText('a').closest('li')!
    ;(row.querySelector('[data-testid="qt-pin"]') as HTMLElement).click()
    // 乐观置 pin：图标状态立即变为已 pin
    await waitFor(() =>
      expect(row.querySelector('[data-testid="qt-pin"]')!.getAttribute('data-pinned')).toBe('true'))

    // 此时一个「pin 之前」的旧快照迟到（pinned=false）——必须被丢弃
    resolveStale(list([t({ path: '/w/a', display: 'a', pinned: false })]))
    await new Promise(r => setTimeout(r, 0))
    expect(screen.getByText('a').closest('li')!
      .querySelector('[data-testid="qt-pin"]')!.getAttribute('data-pinned')).toBe('true')
  })

  it('last_agent 为未知字符串时点行走 onPickType，不把脏值传给 onPick', async () => {
    vi.spyOn(api, 'listQuickTargets').mockResolvedValue(
      list([t({ path: '/w/x', display: 'x', last_agent: 'gemini' })]))
    const onPick = vi.fn()
    const onPickType = vi.fn()
    render(<QuickTargets kind="dir" onPick={onPick} onPickType={onPickType} />)

    ;(await screen.findByText('x')).click()
    expect(onPick).not.toHaveBeenCalled()
    expect(onPickType).toHaveBeenCalledWith('/w/x')
  })

  it('last_agent 合法时点行直接 onPick 带类型', async () => {
    vi.spyOn(api, 'listQuickTargets').mockResolvedValue(
      list([t({ path: '/w/y', display: 'y', last_agent: 'codex' })]))
    const onPick = vi.fn()
    render(<QuickTargets kind="dir" onPick={onPick} onPickType={() => {}} />)

    ;(await screen.findByText('y')).click()
    expect(onPick).toHaveBeenCalledWith('/w/y', 'codex')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd frontend && npx vitest run src/components/__tests__/QuickTargets.stale.test.tsx`
Expected: FAIL — `Failed to resolve import "../QuickTargets"`。

- [ ] **Step 3: 写实现**

创建 `frontend/src/components/QuickTargets.tsx`：

```tsx
import { useState, useEffect, useCallback, useRef } from 'react'
import { Pin, PinOff, X, Folder, FolderGit2, FileText, ChevronRight } from 'lucide-react'
import type { SessionType, QuickTarget, QuickTargetList } from '../lib/api'
import { listQuickTargets, pinQuickTarget, forgetQuickTarget } from '../lib/api'
import { coerceAgent, flatten } from '../lib/quickTargets'

/** 常用目录/笔记快速入口。一份实现服务三处：New Session 首屏、pick-dir 顶部、
 *  VaultReader 的「最近打开」。kind 决定数据源与图标，其余行为一致。 */
export default function QuickTargets({ kind, onPick, onPickType, emptyHint }: {
  kind: 'dir' | 'note'
  onPick: (path: string, agent: SessionType | null) => void
  onPickType?: (path: string) => void
  emptyHint?: string
}) {
  const [items, setItems] = useState<QuickTarget[]>([])
  const [loaded, setLoaded] = useState(false)

  // 单调请求令牌。本组件同时具备「慢 GET」（JuiceFS/S3）与「乐观 mutation」
  // （pin/forget 立即改本地 state 后 refetch）两个条件，正是本 repo 修过 12 次的
  // stale-response clobber 场景：一个乐观写之前发出的旧 GET 迟到，会把刚 pin 的
  // 条目回滚、把刚移除的条目复活成 ghost。fetch 顶部 bump，每个乐观写前也 bump，
  // await 后守卫 —— 两侧都护。
  const reqRef = useRef(0)

  const load = useCallback(async () => {
    const req = ++reqRef.current
    try {
      const data: QuickTargetList = await listQuickTargets(kind)
      if (reqRef.current !== req) return
      setItems(flatten(data))
    } catch {
      if (reqRef.current !== req) return
      // 快速入口是加速器,不是主路径:加载失败就安静地什么都不显示,
      // 让用户回落到目录浏览,而不是弹错误挡住新建会话。
      setItems([])
    }
    if (reqRef.current === req) setLoaded(true)
  }, [kind])

  useEffect(() => { load() }, [load])

  const togglePin = useCallback(async (it: QuickTarget) => {
    const next = !it.pinned
    reqRef.current++      // 使任何在途 GET 失效，否则旧快照会回滚这次乐观写
    setItems(prev => prev.map(x => x.path === it.path ? { ...x, pinned: next } : x))
    try { await pinQuickTarget(kind, it.path, next) } catch { /* 下次 load 会纠正 */ }
    load()
  }, [kind, load])

  const forget = useCallback(async (it: QuickTarget) => {
    reqRef.current++      // 同上：防止在途 GET 让被移除的条目复活
    setItems(prev => prev.filter(x => x.path !== it.path))
    try { await forgetQuickTarget(kind, it.path) } catch { /* 下次 load 会纠正 */ }
    load()
  }, [kind, load])

  const pick = (it: QuickTarget) => {
    const agent = coerceAgent(it.last_agent)
    // agent 不合法（库里的旧类型已被移除）或本来就没有 → 交给调用方选类型，
    // 绝不把脏字符串当 SessionType 发出去。
    if (kind === 'dir' && !agent && onPickType) { onPickType(it.path); return }
    onPick(it.path, agent)
  }

  if (!loaded || items.length === 0) {
    return emptyHint && loaded
      ? <div className="px-3 py-2 text-[10px] text-[var(--text-muted)]">{emptyHint}</div>
      : null
  }

  return (
    <ul className="border-b border-[var(--border)]">
      {items.map(it => (
        <li key={it.path} className="group flex items-center gap-1 pr-1 hover:bg-[var(--bg-hover)]">
          <button
            type="button"
            onClick={() => pick(it)}
            className="flex items-center gap-2 flex-1 min-w-0 px-3 py-1.5 text-left"
            title={it.path}
          >
            {kind === 'note'
              ? <FileText size={13} className="text-[var(--text-muted)] shrink-0" />
              : it.is_git
                ? <FolderGit2 size={13} className="text-[var(--accent-green-text)] shrink-0" />
                : <Folder size={13} className="text-[var(--text-muted)] shrink-0" />}
            <span className="truncate text-xs text-[var(--text-primary)]">{it.display}</span>
            {it.hint && (
              <span className="truncate text-[10px] text-[var(--text-muted)] shrink min-w-0">{it.hint}</span>
            )}
            {kind === 'dir' && coerceAgent(it.last_agent) && (
              <span className="ml-auto shrink-0 text-[10px] text-[var(--text-muted)] uppercase">
                {coerceAgent(it.last_agent)}
              </span>
            )}
          </button>
          {kind === 'dir' && onPickType && (
            <button
              type="button"
              data-testid="qt-picktype"
              onClick={() => onPickType(it.path)}
              className="p-0.5 opacity-0 group-hover:opacity-100 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              title="改用其它类型"
            >
              <ChevronRight size={12} />
            </button>
          )}
          <button
            type="button"
            data-testid="qt-pin"
            data-pinned={it.pinned ? 'true' : 'false'}
            onClick={() => togglePin(it)}
            className="p-0.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            title={it.pinned ? '取消置顶' : '置顶'}
          >
            {it.pinned ? <Pin size={12} /> : <PinOff size={12} className="opacity-0 group-hover:opacity-100" />}
          </button>
          <button
            type="button"
            data-testid="qt-forget"
            onClick={() => forget(it)}
            className="p-0.5 opacity-0 group-hover:opacity-100 text-[var(--text-secondary)] hover:text-[var(--accent-red)]"
            title="从列表移除"
          >
            <X size={12} />
          </button>
        </li>
      ))}
    </ul>
  )
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd frontend && npx vitest run src/components/__tests__/QuickTargets.stale.test.tsx`
Expected: PASS，4 个绿。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/QuickTargets.tsx frontend/src/components/__tests__/QuickTargets.stale.test.tsx
git commit -m "feat(quick-targets): QuickTargets 组件(第一版即带 stale-response 防护)

本组件同时具备慢 GET 与乐观 mutation 两个条件,是本 repo 修过 12 次的
stale-response clobber 教科书场景:reqRef 在 fetch 顶部与每个乐观写前双侧 bump。
last_agent 经 coerceAgent 白名单收敛,不合法则退化到选类型。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: 接入三个入口

**Files:**
- Modify: `frontend/src/components/Sidebar.tsx`（新增 step `quick` 作首屏 + `pick-dir` 顶部嵌入）
- Modify: `frontend/src/components/DirectoryPicker.tsx`（顶部嵌入）
- Modify: `frontend/src/components/VaultReader.tsx:121`（「最近打开」换后端源 + 显示父目录）
- Modify: `frontend/src/lib/vault.ts`（删除 localStorage recent 三函数 + KEY）
- Modify: `frontend/src/lib/__tests__/vault.test.ts`（删除对应测试）

**Interfaces:**
- Consumes: Task 5 的 `QuickTargets` 组件；既有 `onCreate(type, workDir, tmuxTarget, initialPrompt)`（`Sidebar.tsx:22`）
- Produces: 无新导出（纯接线）

- [ ] **Step 1: Sidebar 首屏改为 `quick`**

`Sidebar.tsx:63` 的 step 联合类型加 `'quick'`：

```ts
type NewSessionStep = 'closed' | 'quick' | 'pick-type' | 'pick-terminal-mode' | 'pick-dir' | 'pick-tmux' | 'pick-prompt' | 'manage-prompts'
```

`openTypePicker`（`Sidebar.tsx:172`）改为开在 `quick`：

```ts
  const openTypePicker = () => {
    setStep('quick')
    setPendingType(null)
  }
```

在 `step === 'pick-type'` 的 JSX 块**之前**加入 `quick` 块：

```tsx
              {step === 'quick' && (
                <>
                  <div className="flex items-center gap-1 px-2 py-1.5 border-b border-[var(--border)]">
                    <span className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider truncate flex-1">
                      新建会话
                    </span>
                  </div>
                  {/* 一击直达：点一行 = 用该目录上次的 agent 类型直接创建，
                      0 次列目录请求。刻意跳过 prompt 页——中间插一页就退化成
                      「少点两下的老流程」，带 prompt 的场景走 ▸ 或「其他目录…」。 */}
                  <QuickTargets
                    kind="dir"
                    onPick={(path, agent) => {
                      if (!agent) { setPendingType(null); setStep('pick-type'); return }
                      onCreate(agent, path)
                      setStep('closed')
                    }}
                    onPickType={(path) => { setPendingDir(path); setStep('pick-type') }}
                  />
                  <button
                    type="button"
                    onClick={() => { setPendingDir(null); setStep('pick-type') }}
                    className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors"
                  >
                    <Folder size={13} className="shrink-0" />
                    <span>其他目录…</span>
                  </button>
                </>
              )}
```

`selectType`（`Sidebar.tsx:176`）需要照顾「从 ▸ 进来时已有 pendingDir」的情况——改为：

```ts
  const selectType = (type: SessionType) => {
    setPendingType(type)
    if (type === 'tmux') {
      setStep('pick-terminal-mode')
    } else if (pendingDir) {
      // 从快速卡片的 ▸ 进来：目录已定，只是改类型 → 直接进 prompt 页
      setPromptDraft('')
      presetStore.reload()
      setStep('pick-prompt')
    } else {
      setStep('pick-dir')
      loadDirs()
    }
  }
```

同时 `pick-type` 块里的「返回」按钮（若存在）目标改为 `setStep('quick')`；`close()`（`Sidebar.tsx:215`）保持不变（已清 `pendingDir`）。

顶部 import 加：

```ts
import QuickTargets from './QuickTargets'
```

- [ ] **Step 2: Sidebar `pick-dir` 顶部嵌入**

在 `pick-dir` 块的「Current path display + use-this button」`</div>` 之后、「Navigation: parent」之前插入：

```tsx
                  {/* 已选定类型后的捷径：命中就是 1 次点击 0 次列目录 */}
                  <QuickTargets kind="dir" onPick={(path) => selectDir(path)} />
```

- [ ] **Step 3: DirectoryPicker 顶部嵌入**

`DirectoryPicker.tsx` 的「Current path + use-this button」`</div>` 之后插入同一行（该组件的提交语义是 `onSelect`）：

```tsx
      <QuickTargets kind="dir" onPick={(path) => onSelect(path)} />
```

并加 import：

```ts
import QuickTargets from './QuickTargets'
```

- [ ] **Step 4: VaultReader 换后端源**

`VaultReader.tsx` 改动三处：

(a) 删除 `recent` state 与 localStorage 调用。把
```ts
import { filterVaultEntries, resolveVaultImageSrc, getRecentNotes, pushRecentNote, removeRecentNote } from '../lib/vault'
```
改为
```ts
import { filterVaultEntries, resolveVaultImageSrc } from '../lib/vault'
```
并加
```ts
import QuickTargets from './QuickTargets'
```

(b) 删除 `const [recent, setRecent] = useState<string[]>(() => getRecentNotes())`。

(c) `openNote` 内删掉 `pushRecentNote(path); setRecent(getRecentNotes())`（后端 `vault_file` 已在成功分支 bump），以及 catch 里的 `removeRecentNote(path); setRecent(getRecentNotes())`（读出时守卫已自愈删行）。catch 保留 alert：

```ts
    }).catch(() => {
      if (openReqRef.current !== req) return
      // 一条失效的历史条目（笔记已在 Obsidian 中删除/移动）会 404。后端的读出
      // 守卫会在下次列表时剔除并删行，这里只需告知用户。
      alert('无法打开笔记(可能已被删除或移动):' + path)
    })
```

(d) 把「最近打开」那段（`L119-125` 区域）整体替换为：

```tsx
            {cwd === '' && (
              <QuickTargets kind="note" onPick={(path) => openNote(path)} />
            )}
```

- [ ] **Step 5: 删除 vault.ts 的 localStorage recent**

`frontend/src/lib/vault.ts` 删除 `RECENT_KEY`、`getRecentNotes`、`pushRecentNote`、`removeRecentNote` 四项（本次改动使其成为死代码，属清理自己造成的 mess）。

同步删除 `frontend/src/lib/__tests__/vault.test.ts` 中针对这三个函数的 describe 块。先跑 `grep -n "RecentNote" frontend/src/lib/__tests__/vault.test.ts` 定位。

- [ ] **Step 6: 跑全量前端测试**

Run: `cd frontend && npm test 2>&1 | tail -25`
Expected: 全绿。若 `VaultReader.test.tsx` 因「最近打开」断言失败，更新该断言为新的 `QuickTargets` 渲染（它在无数据时返回 `null`，故需 mock `listQuickTargets` 返回空 list）。

Run: `cd frontend && npm run lint 2>&1 | tail -10`
Expected: 无 error。

- [ ] **Step 7: 构建验证（前端必须先 build）**

Run: `cd frontend && npm run build 2>&1 | tail -5`
Expected: 成功产出 `frontend/dist/`。

Run: `cargo check 2>&1 | tail -5`
Expected: 无错误。

- [ ] **Step 8: Commit**

```bash
git add frontend/src/components/Sidebar.tsx frontend/src/components/DirectoryPicker.tsx frontend/src/components/VaultReader.tsx frontend/src/lib/vault.ts frontend/src/lib/__tests__/vault.test.ts
git commit -m "feat(quick-targets): 接入 New Session 首屏 / pick-dir 顶部 / Obsidian 最近打开

New Session 首屏改为快速卡片(点一行=用该目录上次的 agent 直接创建,跳过
prompt 页),「其他目录…」兜底走原 类型→目录 流程;pick-dir 与 DirectoryPicker
顶部同样嵌入。VaultReader 的「最近打开」从 localStorage 换到后端 frecency,
并显示父目录以区分同名 _index.md;vault.ts 的 localStorage recent 三函数
随之删除(本次改动使其成为死代码)。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: 端到端手测 + 部署

**Files:**
- 无代码改动（若手测发现问题，回到对应 Task 修）

**Interfaces:**
- Consumes: Task 1-6 全部
- Produces: 可用的线上功能

- [ ] **Step 1: 全量测试**

Run: `cargo test 2>&1 | tail -8`
Expected: 全绿。

Run: `cd frontend && npm test 2>&1 | tail -8`
Expected: 全绿。

- [ ] **Step 2: 本地起服务手测**

Run: `cd frontend && npm run build && cd .. && cargo build && ./target/debug/zeromux --port 8099 --password test`

在浏览器打开 `http://localhost:8099`，逐条验证（对应 spec 的验证标准第 4 项）：

1. 全新库：点 ＋ 新建会话 → 首屏应显示「其他目录…」且无快速卡片（空列表返回 `null`）
2. 走「其他目录…」创建 3 个不同目录的 claude 会话
3. 重开 ＋ → 首屏出现 3 条，最近创建的在最前，每条右侧显示 `CLAUDE`
4. 点第 1 条 → 应**直接创建**会话（不经过 prompt 页），且新会话 work_dir 正确
5. hover 第 2 条点 pin 图标 → 该条移到最前且 pin 图标常亮
6. 创建 ≥6 个不同目录的会话后重开 → pin 的那条仍在最前，且未 pin 部分显示 **5** 条（pin 不占名额）
7. hover 某条点 × → 该条消失；重开面板确认未复活
8. 点某条的 ▸ → 进类型选择，选 codex → 进 prompt 页（目录已定，不再让选目录）
9. Obsidian（需 `--vault-dir`）：打开 2 篇不同目录的 `_index.md` → 列表两条能通过 hint 父目录区分

- [ ] **Step 3: 验证定时任务不污染**

在 Settings → 定时任务里建一个 5 分钟后触发的任务，work_dir 指向一个**从未手动开过会话**的目录。等它触发一次后重开 ＋ 面板。

Expected: 该目录**不**出现在快速卡片中（bump 只在 `web.rs` 的交互式 handler，定时任务走 `create_acp_session_tagged` 独立路径）。

- [ ] **Step 4: 验证守卫自愈**

```bash
# 手动往表里插一条指向 ~/.ssh 的行（模拟历史行 + 守卫加严）
sqlite3 ~/.zeromux/zeromux.db \
  "INSERT INTO quick_targets (user_id,kind,path,hits,last_ms,score_raw,pinned,last_agent)
   VALUES ('legacy','dir','$HOME/.ssh',9,$(date +%s000),9.0,0,'claude');"
# 再插一条不存在的目录
sqlite3 ~/.zeromux/zeromux.db \
  "INSERT INTO quick_targets (user_id,kind,path,hits,last_ms,score_raw,pinned,last_agent)
   VALUES ('legacy','dir','$HOME/definitely-not-here-$RANDOM',9,$(date +%s000),9.0,0,'claude');"
```

重开 ＋ 面板 → 两条都**不**显示。然后确认已被删行：

```bash
sqlite3 ~/.zeromux/zeromux.db \
  "SELECT path FROM quick_targets WHERE path LIKE '%.ssh%' OR path LIKE '%definitely-not-here%';"
```
Expected: 空输出（读出时剔除 + 删行生效）。

- [ ] **Step 5: 部署**

Run: `./deploy.sh --build`

**必须用 `./deploy.sh`。** 绝不手跑 `systemctl stop` + `cp` + `start`——尤其不要从 zeromux 终端里跑（cgroup 自杀陷阱，见项目 CLAUDE.md）。`deploy.sh` 会自动逃出 cgroup 并自带健康检查 + 自动回滚。

Expected: 输出健康检查通过；`https://zeromux.keithyu.cloud` 可访问且快速卡片可见。

- [ ] **Step 6: Commit（若手测有修补）**

```bash
git add -A
git commit -m "fix(quick-targets): 手测修补

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```
