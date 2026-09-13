# Quick Targets（常用目录/笔记 frecency 快速入口）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 New Session 与 Obsidian 打开笔记时,把最常用的目标（frecency 排序）直接摆在首屏,做到「1 次点击、0 次列目录请求」,且列表随用户操作实时重排。

**Architecture:** 后端新增一张 `quick_targets` 表，行的身份是 `(user_id, kind, path, agent)`——同一目录用三个 agent 就是三行，各自独立累积 frecency、标签稳定不漂移。bump 只发生在 `web.rs` 的两个交互式 HTTP handler（`create_session` / `vault_file`）成功分支——因此「定时任务不污染 frecency」是架构保证而非条件判断。指数半衰期评分在 Rust 内计算（不在 SQL），读取时对每条重跑与 `list_directories` 相同的路径守卫，三态自愈（确定性拒绝才删行，瞬时 IO 错误只剔除）。前端一个 `QuickTargets` 组件复用于三处入口，通过模块级 `quickTargetsBus` 实现事件驱动刷新。

**本计划为 v2**，对应 spec 的 v2 修订（纳入两条新约束 + CTO/PM 交叉 review）。v1 相对 v2 的主要差异：砍掉 pin 全套、行身份加 `agent`、砍 `is_git`、hover-only 控件改行级操作单、手机弹层宽度、Obsidian 保底入口、`spawn_blocking`、`DELETE` 改 query param。

**Tech Stack:** Rust / Axum / rusqlite 0.31 (bundled) / React 19 / Vite / Tailwind v4 / vitest + @testing-library/react

**Spec:** `docs/superpowers/specs/2026-09-13-quick-targets-design.md`

## Global Constraints

- **语言规范**：用户可见字符串与文档用中文；代码与注释用英文（本 repo 双语惯例）。
- **半衰期常量**：`HALF_LIFE_MS = 14 * 24 * 3600 * 1000`（14 天，以毫秒表示）。
- **Top N 常量**：`TOP_N = 5`。不做可配置。**这是显示上限，表里不删行**（挤出即清零会把纯 recency 的病重新引入 frecency）。
- **候选上限**：`CANDIDATE_LIMIT = 16`（不是 50）。上限的约束是 per-row 文件系统守卫的 IO（JuiceFS 实测约 20ms/行），不是内存。
- **无 pin 机制**：不做 `pinned` 列、不做 pin 端点、不做行内 pin 按钮。
- **行身份含 agent**：`PRIMARY KEY (user_id, kind, path, agent)`，`agent TEXT NOT NULL DEFAULT ''`。**必须 NOT NULL**——SQLite 的 PK 列允许 NULL 且 `NULL != NULL`，可空会让 `kind='note'`（agent 恒空）每打开一次笔记插一行（已实测：NULL 插 3 次得 3 行，空串插 3 次得 1 行）。
- **无 `is_git` 字段**：占 per-row IO 成本一半却只用于选图标；行首图标改为显示 agent 品牌图标。
- **禁止 hover-only 控件**：Tailwind v4 把 `group-hover:*` 编译进 `@media (hover:hover)`（已在 `frontend/dist/assets/index-*.css` 实测），手机上整条规则不生效 → 元素永久 `opacity:0` 但仍可点击 = 隐形按钮。用户主设备是手机，一律改为「整行主目标 + 一个 `⌄` 行级操作单」。
- **DELETE 用 query param**，不带 JSON body（`api.ts` 全部 7 处 DELETE 零先例，且 nginx 在前会丢 body）。
- **事件驱动刷新**：前端发射点必须精确镜像后端两处 bump，不多不少。
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
- Modify: `src/main.rs`（mod 声明区，**实际在 `L1-20`**，`mod prompts;` 在 `L12`）

**Interfaces:**
- Consumes: 无（本任务是根）
- Produces:
  - `pub struct QuickTargetStore`，`pub fn open(data_dir: &Path) -> Result<Self, String>`
  - `pub struct QuickTargetRow { pub kind: String, pub path: String, pub agent: String, pub hits: i64, pub last_ms: i64, pub score_raw: f64 }`
  - `pub fn bump(&self, user_id: &str, kind: &str, path: &str, agent: &str, now_ms: i64) -> Result<(), String>`
  - `pub fn candidates(&self, user_id: &str, kind: &str) -> Result<Vec<QuickTargetRow>, String>`
  - `pub fn forget(&self, user_id: &str, kind: &str, path: &str, agent: &str) -> Result<(), String>`
  - `pub fn decayed_score(score_raw: f64, last_ms: i64, now_ms: i64) -> f64`
  - `pub fn rank(rows: Vec<QuickTargetRow>, now_ms: i64) -> Vec<QuickTargetRow>`
  - `pub const HALF_LIFE_MS: i64`、`pub const TOP_N: usize`

- [ ] **Step 1: 先注册模块（必须在写测试之前）**

在 `src/main.rs` 的 mod 声明区（**`L1-20`**，紧邻 `mod prompts;`（`L12`））加一行：

```rust
mod quick_targets;
```

并创建空文件 `src/quick_targets.rs`（内容随后写）。

**为什么这一步必须最先做**：Rust 不编译未在 crate root 声明的模块。若先写测试再声明 mod，
`cargo test` 会输出 `running 0 tests ... ok`（退出码 0），而不是编译失败 —— TDD 的
「先看红灯」这一步会假绿，实现者会以为命令写错或环境坏了。

- [ ] **Step 2: 写失败的测试**

把以下内容写入 `src/quick_targets.rs`（此时只有测试模块，无实现体）：

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
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cargo test quick_targets 2>&1 | tail -20`
Expected: **编译失败** —— `cannot find type QuickTargetStore in this scope` /
`cannot find function decayed_score`。（因为 Step 1 已声明 mod，所以这里是真编译错，
不是 "0 tests ok"。）

- [ ] **Step 4: 写实现**

在 `src/quick_targets.rs` 的测试模块**之前**插入：

```rust
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
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cargo test quick_targets 2>&1 | tail -20`
Expected: PASS，13 个测试全绿。

- [ ] **Step 6: Commit**

```bash
git add src/quick_targets.rs src/main.rs
git commit -m "feat(quick-targets): frecency 存储层 + 指数半衰期评分纯函数

行的身份是 (user_id, kind, path, agent):同一目录用三个 agent 就是三行,各自独立
累积 frecency、标签稳定不漂移(单个 last_agent 会被最新一次 bump 覆盖,导致行上
标签自己变)。agent 用 NOT NULL DEFAULT '' 而非可空:已实测 SQLite 的 PK 列允许
NULL 且 NULL!=NULL,可空会让 note(agent 恒空)每打开一次就插一行。

衰减在 Rust 算不在 SQL 算(rusqlite bundled 无 pow());bump 的 read-modify-write
在同一把 Mutex 内故无竞态。TOP_N 是显示上限,表里不删行——基于排名的挤出会清零
累积分,把纯 recency 的病重新引入 frecency。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: 接入 AppState + 两处 bump 落点

**Files:**
- Modify: `src/main.rs:129-155`（`AppState` 加字段）、`src/main.rs:260-263` 之后（open store）
- Modify: `src/web.rs:395`（`create_session` 成功分支 bump）、`src/web.rs:3448`（`vault_file` 成功分支 bump）

**Interfaces:**
- Consumes: Task 1 的 `QuickTargetStore::open` / `bump`
- Produces: `AppState.quick_targets: Arc<crate::quick_targets::QuickTargetStore>`（Task 3 的 handler 读它）

- [ ] **Step 1: AppState 加字段**

`src/main.rs` 的 `pub struct AppState`（`L129-155`）在 `pub vault_index:` 之后加：

```rust
    pub quick_targets: Arc<quick_targets::QuickTargetStore>,
```

- [ ] **Step 2: 启动时 open store**

`src/main.rs` 中 `session_store` 那一段（`L260-263`）之后加：

```rust
    // 常用目录/笔记 frecency。与 sessions 同库、总是开启（不依赖 OAuth 模式）：
    // legacy 模式的 CurrentUser::legacy().id 是固定 "legacy"，owner-scope 仍成立。
    let quick_targets_store = Arc::new(
        quick_targets::QuickTargetStore::open(std::path::Path::new(&data_dir_str))
            .expect("Failed to initialize quick targets store"),
    );
```

并在构造 `AppState { ... }` 的字面量里加 `quick_targets: quick_targets_store,`
（紧随 `vault_index` 之后，与结构体字段同序）。

- [ ] **Step 3: `create_session` 成功分支 bump**

`src/web.rs` 的 `create_session`（`L395`）中，`let id = match req.session_type { ... };`
之后、返回 `Json` 之前插入：

```rust
    // 记一次「用户真的去了那里」。刻意写在 HTTP handler 层而不下沉到
    // session_manager 的 create_* 方法：定时任务走 create_acp_session_tagged
    // 那条独立路径，把 bump 留在这里，「cron 不污染 frecency」就是架构保证，
    // 而不是一行在未来重构里容易丢失的 if。
    //
    // 三个刻意的取舍：
    // 1. 记 req 提交的 work_dir 而非 resolve_work_dir 之后的 effective_dir——
    //    开启 --worktree-isolation 时后者是 .zeromux-worktrees/<id>/ 这类一次性
    //    路径，记它下次点击必然失效。
    // 2. 用 canonicalize 后的路径，否则 /home/ubuntu/x 与 /home/ubuntu/x/ 会存成
    //    两行。canonicalize 只解 symlink，不是 resolve_work_dir 的 worktree 改写，
    //    所以与上一条不冲突。
    // 3. attach 既有 host tmux（tmux_target.is_some()）不记：那条路径上用户没有
    //    选目录，work_dir 是 state.work_dir 的兜底值（线上即 --work-dir
    //    /home/ubuntu），记它等于往榜上插一条用户从未选择过的 ~。
    //
    // best-effort：一个「记住我去过哪」的功能没有资格让会话创建失败。
    if req.tmux_target.is_none() {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        // now_ms == 0 只在系统时钟早于 UNIX_EPOCH 时出现。写进 last_ms 会让该行的
        // 衰减基准永久错位，而 bump 本就允许失败，所以直接跳过。
        if now_ms > 0 {
            let canonical_dir = std::path::Path::new(&work_dir)
                .canonicalize()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|_| work_dir.clone());
            if let Err(e) = state.quick_targets.bump(
                &owner_id, "dir", &canonical_dir, &type_label, now_ms,
            ) {
                eprintln!("quick_targets bump (dir) skipped: {}", e);
            }
        }
    }
```

**注意 `type_label` 对 tmux 就是 `"tmux"`，这是刻意保留的**（`web.rs:400`）：在某目录开
一个终端确实是「用户真的去了那里」，而 `(path, "tmux")` 是独立一行，不会污染同目录的
`(path, "claude")`。

- [ ] **Step 4: `vault_file` 成功分支 bump**

`src/web.rs` 的 `vault_file`（`L3448`）末尾，`let (content, truncated) = read_text_file_capped(&real)?;`
之后、`Ok(Json(...))` 之前插入：

```rust
    // 笔记打开成功才记（失败/403 分支不记）。
    //
    // 记规范化后的 vault-relative 路径而非 q.path：resolve_and_verify 接受
    // CurDir/ParentDir 组件，所以 "a/b.md"、"./a/b.md"、"a/../a/b.md" 解析到同一
    // 文件，直接记 q.path 会存成 3 行、各自累积、首屏出现 3 条同名条目——与本功能
    // 「靠父目录区分同名 _index.md」的目标正好相反。
    //
    // agent 传空串：note 无 agent 概念。空串而非 NULL 是 PK 去重的前提。
    if let Some(rel) = real.strip_prefix(base_path).ok().map(|p| p.to_string_lossy().to_string()) {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        if now_ms > 0 {
            if let Err(e) = state.quick_targets.bump(&user.id, "note", &rel, "", now_ms) {
                eprintln!("quick_targets bump (note) skipped: {}", e);
            }
        }
    }
```

- [ ] **Step 5: 编译 + 全量测试**

Run: `cargo check 2>&1 | tail -20`
Expected: 无错误。若报 `AppState` 字段缺失，检查所有构造 `AppState` 的地方（含测试）
是否都加了新字段。

Run: `cargo test 2>&1 | tail -15`
Expected: 既有测试全绿 + Task 1 的 13 个绿。

- [ ] **Step 6: Commit**

```bash
git add src/main.rs src/web.rs
git commit -m "feat(quick-targets): 接入 AppState + create_session/vault_file 两处 bump

bump 只写在 web.rs 的交互式 handler,不下沉 session_manager——定时任务走
create_acp_session_tagged 独立路径,故「cron 不污染 frecency」是架构保证。
三处刻意取舍:记 work_dir 而非 effective_dir(worktree 隔离下后者是一次性路径);
canonicalize 以免尾斜杠存两行;attach 既有 host tmux 不记(那条路径用户没选目录,
work_dir 是兜底的 ~)。note 侧记 strip_prefix 后的相对路径,否则 ./a.md 与 a.md
会存成两行。now_ms==0(时钟早于 epoch)直接跳过,不把坏基准写进 last_ms。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---
### Task 3: 两个 REST 端点 + 三态守卫自愈（含 `spawn_blocking`）

**Files:**
- Modify: `src/web.rs:65`（路由注册，authed `/api/*` 组内，`/api/directories` 之后）
- Modify: `src/web.rs`（新增 2 个 handler + 3 个纯函数，建议紧邻 `list_directories` 之后即 `L300` 附近）

**Interfaces:**
- Consumes: Task 2 的 `state.quick_targets`；既有守卫（**全部已核实位于 `web.rs` 同文件，直接可调**）：
  `validate_browse_root`（`L1075`）、`descends_into_sensitive_dir`（`L1222`）、
  `read_hits_home_dotdir`（`L1242`）、`resolve_and_verify`（`L1491`）、
  `vault_path_has_dot_component`（`L3341`）、`vault_real_hits_dot_component`（`L3352`）、
  `vault_base`（`L3364`）
- Produces:
  - `GET /api/quick-targets?kind=dir|note` → `{ top: [...] }`
  - `DELETE /api/quick-targets?kind=&path=&agent=` → 204
  - 条目 JSON：`{ kind, path, agent, display, hint }`
  - `fn dir_display_hint(path: &str, home: &str) -> (String, String)`
  - `fn note_display_hint(rel_path: &str) -> (String, String)`
  - `enum TargetValidity { Valid, Invalid, Unknown }`

- [ ] **Step 1: 写失败的测试**

在 `src/web.rs` 既有的路径安全测试模块内追加（模块名 `path_safety_tests`，
锚点：`validate_browse_root_accepts_normal_rejects_sensitive` 在 `L3732` 附近）：

```rust
    #[test]
    fn quick_target_display_and_hint_for_dir() {
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
    fn quick_target_dir_hint_does_not_abbreviate_sibling_of_home() {
        // /home/ubuntu-backup 只是与 $HOME 共前缀的兄弟目录，不能被缩写成 "~-backup"。
        // 纯字符串 starts_with 会误判，必须按路径边界比较。
        let (_, h) = dir_display_hint("/home/ubuntu-backup/x/y", "/home/ubuntu");
        assert_eq!(h, "/home/ubuntu-backup/x", "共前缀的兄弟目录不得缩写");
    }

    #[test]
    fn quick_target_display_and_hint_for_note() {
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
Expected: 编译失败 —— `cannot find function dir_display_hint` / `note_display_hint`。

- [ ] **Step 3: 写三个纯函数**

在 `src/web.rs` 的 `list_directories` 之后（`L300` 附近）加：

```rust
/// dir 条目的展示对：(display=basename, hint=以 ~ 缩写的父路径)。
/// hint 的存在意义是区分同名 basename（多个 repo 都有 `scripts/`）。
///
/// 用 Path::strip_prefix 而非字符串 starts_with：后者会把 /home/ubuntu-backup
/// 误判为 $HOME 的子路径，缩写成 "~-backup"。
fn dir_display_hint(path: &str, home: &str) -> (String, String) {
    let p = std::path::Path::new(path);
    let display = p
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string());
    let parent = match p.parent() {
        Some(x) => x,
        None => return (display, String::new()),
    };
    let hint = match parent.strip_prefix(home) {
        Ok(rel) if rel.as_os_str().is_empty() => "~".to_string(),
        Ok(rel) => format!("~/{}", rel.to_string_lossy()),
        Err(_) => parent.to_string_lossy().to_string(),
    };
    (display, hint)
}

/// note 条目的展示对：(display=笔记名去 .md, hint=父目录相对路径)。
/// vault 内 `_index.md` 不止一个，只显示 basename 无法分辨 → 必须带父目录。
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

/// 一条历史行现在还能不能用。三态而非 bool 是刻意的 —— 见 Invalid/Unknown 的区别。
enum TargetValidity {
    /// 校验通过，返回给前端。
    Valid,
    /// 确定性拒绝（不在 $HOME 下 / 命中敏感目录 / 不是目录 / NotFound）→ 删行。
    Invalid,
    /// 瞬时 IO 失败（JuiceFS 抖动让 canonicalize 失败）→ 本次不返回，但保留行。
    /// 若把这种情况也删行，用户的常用目录会因为一次文件系统抖动丢掉几周累积的
    /// frecency。
    Unknown,
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cargo test quick_target_ 2>&1 | tail -15`
Expected: PASS，6 个绿。

- [ ] **Step 5: 写校验函数 + 两个 handler**

紧随上面三个纯函数加入：

```rust
/// dir 行的校验：与 list_directories 完全相同的守卫组合（web.rs:248-252），
/// 而不是「存的时候合法所以永远合法」—— 存的是历史，路径可能已被删除、已被替换为
/// 指向 ~/.ssh 的 symlink、或守卫规则本身已升级加严。
fn validate_dir_target(path: &str) -> TargetValidity {
    let p = std::path::Path::new(path);
    // 先用 symlink_metadata 区分「不存在」（确定性）与「其它 IO 错误」（瞬时）。
    match p.symlink_metadata() {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return TargetValidity::Invalid,
        Err(_) => return TargetValidity::Unknown,
    }
    let canonical = match p.canonicalize() {
        Ok(c) => c,
        // 路径存在但 canonicalize 失败 → 瞬时 IO / 权限，保留行。
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return TargetValidity::Invalid,
        Err(_) => return TargetValidity::Unknown,
    };
    // validate_browse_root 做 canonicalize + under-$HOME + is-dir + 敏感目录拒绝。
    // 它内部会再 canonicalize 一次；这里已确认路径可 canonicalize，故其失败即确定性拒绝。
    if validate_browse_root(path).is_err() {
        return TargetValidity::Invalid;
    }
    if read_hits_home_dotdir(&canonical) || !canonical.is_dir() {
        return TargetValidity::Invalid;
    }
    TargetValidity::Valid
}

/// note 行的校验：仍在 vault 内、无 dot 组件、非敏感、文件仍存在。
fn validate_note_target(base: &str, rel: &str) -> TargetValidity {
    if vault_path_has_dot_component(rel) {
        return TargetValidity::Invalid;
    }
    let base_path = std::path::Path::new(base);
    let joined = base_path.join(rel);
    match joined.symlink_metadata() {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return TargetValidity::Invalid,
        Err(_) => return TargetValidity::Unknown,
    }
    let real = match resolve_and_verify(base_path, rel) {
        Ok(p) => p,
        Err(_) => return TargetValidity::Invalid,
    };
    if descends_into_sensitive_dir(base_path, &real)
        || vault_real_hits_dot_component(base_path, &real)
        || !real.is_file()
    {
        return TargetValidity::Invalid;
    }
    TargetValidity::Valid
}

#[derive(serde::Deserialize)]
struct QuickTargetQuery {
    kind: String,
}

#[derive(serde::Deserialize)]
struct QuickTargetForgetQuery {
    kind: String,
    path: String,
    #[serde(default)]
    agent: String,
}

/// 只接受这两种 kind；其它一律 400（防止用任意 kind 字符串把表当通用 KV 用，
/// 也防止 still_valid 的 else 分支把未知 kind 当 note 处理）。
fn validate_kind(kind: &str) -> Result<(), (StatusCode, String)> {
    if kind == "dir" || kind == "note" {
        Ok(())
    } else {
        Err((StatusCode::BAD_REQUEST, "kind must be 'dir' or 'note'".into()))
    }
}

async fn list_quick_targets(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
    Query(q): Query<QuickTargetQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    validate_kind(&q.kind)?;
    // note 的可见性跟 vault 一致：vault 未配置或调用者非 admin → 空列表（而不是
    // 泄漏「有哪些笔记曾被打开」）。注意这个早退也保护了历史数据：不走到下面的
    // 校验循环，就不会因为 vault 暂时未配置而把全部 note 行删光。
    let vault_dir: Option<String> = match vault_base(&state, &user) {
        Ok(b) => Some(b.to_string()),
        Err(_) if q.kind == "note" => {
            return Ok(Json(serde_json::json!({ "top": [] })));
        }
        Err(_) => None,
    };

    let rows = state
        .quick_targets
        .candidates(&user.id, &q.kind)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    let home = std::env::var("HOME").unwrap_or_else(|_| "/home/ubuntu".to_string());

    // 每行的守卫都是同步文件系统 IO，JuiceFS 上实测约 20ms/行（canonicalize 约
    // 10ms + metadata 约 10ms）。候选上限 16 → 最坏约 320ms。绝不能在 tokio worker
    // 上同步阻塞这么久（只有 8 个 worker，且首屏每次打开都会走这条路径，事件驱动
    // 刷新还会把频率乘上去）。挪进 spawn_blocking。
    let kind = q.kind.clone();
    let rows_for_task = rows.clone();
    let vault_for_task = vault_dir.clone();
    let (alive, dead) = tokio::task::spawn_blocking(move || {
        let mut alive = Vec::new();
        let mut dead = Vec::new();
        for r in rows_for_task {
            let verdict = if kind == "dir" {
                validate_dir_target(&r.path)
            } else {
                match vault_for_task.as_deref() {
                    Some(base) => validate_note_target(base, &r.path),
                    None => TargetValidity::Unknown,
                }
            };
            match verdict {
                TargetValidity::Valid => alive.push(r),
                TargetValidity::Invalid => dead.push(r),
                TargetValidity::Unknown => {} // 本次不返回，保留行
            }
        }
        (alive, dead)
    })
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("validation task failed: {}", e)))?;

    // 确定性失效的行就地清理；失败只忽略（下次还会再试）。
    for r in &dead {
        let _ = state.quick_targets.forget(&user.id, &r.kind, &r.path, &r.agent);
    }

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let top = crate::quick_targets::rank(alive, now_ms);

    let items: Vec<_> = top
        .iter()
        .map(|r| {
            let (display, hint) = if r.kind == "dir" {
                dir_display_hint(&r.path, &home)
            } else {
                note_display_hint(&r.path)
            };
            serde_json::json!({
                "kind": r.kind,
                "path": r.path,
                "agent": r.agent,
                "display": display,
                "hint": hint,
            })
        })
        .collect();

    Ok(Json(serde_json::json!({ "top": items })))
}

/// 从榜上移除。用 query param 而不是 JSON body：api.ts 全部 7 处 DELETE 调用都没有
/// body（如 deleteSessionFile 用 ?path=），DELETE-with-body 在 RFC 9110 里语义未定义
/// 且会被中间层（这里是 nginx 反代）丢弃 → axum 的 Json 提取器 400 → 前端 catch
/// 静默吞掉 → 表现为「移除按钮不管用」。
async fn forget_quick_target(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
    Query(q): Query<QuickTargetForgetQuery>,
) -> Result<StatusCode, (StatusCode, String)> {
    validate_kind(&q.kind)?;
    state
        .quick_targets
        .forget(&user.id, &q.kind, &q.path, &q.agent)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(StatusCode::NO_CONTENT)
}
```

**`QuickTargetRow` 需要 `Clone`**（上面 `rows.clone()` 用到）—— Task 1 的定义已带
`#[derive(Debug, Clone, PartialEq)]`，无需改动。

- [ ] **Step 6: 注册路由**

`src/web.rs` 的 authed `/api/*` 组内（`L65` 的 `.route("/api/directories", ...)` 之后）加：

```rust
        .route("/api/quick-targets", get(list_quick_targets).delete(forget_quick_target))
```

- [ ] **Step 7: 编译 + 全量测试**

Run: `cargo test 2>&1 | tail -15`
Expected: 全绿（既有 + Task 1 的 13 + Task 3 的 6）。

- [ ] **Step 8: Commit**

```bash
git add src/web.rs
git commit -m "feat(quick-targets): 两个 REST 端点 + 三态守卫自愈

GET 对每条历史行重跑 list_directories 同一组守卫,但三态而非 bool:确定性拒绝
(不在 $HOME/命中敏感目录/不是目录/NotFound)才删行,瞬时 IO 失败只剔除保留行——
否则用户常用目录会因一次 JuiceFS 抖动丢掉几周累积的 frecency。守卫循环整体挪进
spawn_blocking:每行约 20ms 同步 IO,候选 16 行最坏约 320ms,不能占 tokio worker。

DELETE 用 query param 而非 JSON body(api.ts 全部 7 处 DELETE 零先例,且 nginx
反代会丢 body → axum Json 提取器 400 → 前端静默吞掉 → 表现为按钮不管用)。
dir_display_hint 用 Path::strip_prefix 而非字符串 starts_with,否则
/home/ubuntu-backup 会被误缩写成 ~-backup。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: 前端 API 封装 + agent 白名单 + 事件总线

**Files:**
- Modify: `frontend/src/lib/api.ts`（类型 + 2 个封装，加在 `listDirectories` 之后即 `L190` 附近）
- Create: `frontend/src/lib/quickTargets.ts`
- Create: `frontend/src/lib/quickTargetsBus.ts`
- Test: `frontend/src/lib/__tests__/quickTargets.test.ts`

**Interfaces:**
- Consumes: Task 3 的两个端点；既有 `api()` helper（`api.ts:92`）、`SessionType`（`api.ts:1`）
- Produces:
  - `export interface QuickTarget { kind: 'dir' | 'note'; path: string; agent: string; display: string; hint: string }`
  - `listQuickTargets(kind: 'dir' | 'note'): Promise<{ top: QuickTarget[] }>`
  - `forgetQuickTarget(kind, path, agent): Promise<void>`
  - `coerceAgent(v: string | null | undefined): SessionType | null`
  - `notifyQuickTargetsChanged(): void`、`subscribeQuickTargets(fn): () => void`

- [ ] **Step 1: 写失败的测试**

创建 `frontend/src/lib/__tests__/quickTargets.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest'
import { coerceAgent } from '../quickTargets'
import { notifyQuickTargetsChanged, subscribeQuickTargets } from '../quickTargetsBus'

describe('coerceAgent', () => {
  it('接受当前四种 SessionType', () => {
    expect(coerceAgent('claude')).toBe('claude')
    expect(coerceAgent('codex')).toBe('codex')
    expect(coerceAgent('kiro')).toBe('kiro')
    expect(coerceAgent('tmux')).toBe('tmux')
  })

  it('空串 → null（note 行不参与 agent 校验）', () => {
    expect(coerceAgent('')).toBeNull()
  })

  it('null / undefined → null', () => {
    expect(coerceAgent(null)).toBeNull()
    expect(coerceAgent(undefined)).toBeNull()
  })

  it('未知字符串 → null，绝不把脏值发给后端', () => {
    // 某个 agent 类型日后被移除时，库里的旧行会留下已失效的字符串。
    expect(coerceAgent('gemini')).toBeNull()
    expect(coerceAgent('CLAUDE')).toBeNull()   // 大小写敏感，不做宽松匹配
  })
})

describe('quickTargetsBus', () => {
  it('notify 触发所有订阅者', () => {
    const a = vi.fn()
    const b = vi.fn()
    const offA = subscribeQuickTargets(a)
    const offB = subscribeQuickTargets(b)
    notifyQuickTargetsChanged()
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    offA(); offB()
  })

  it('退订后不再收到通知（组件 unmount 后不能泄漏）', () => {
    const f = vi.fn()
    const off = subscribeQuickTargets(f)
    off()
    notifyQuickTargetsChanged()
    expect(f).not.toHaveBeenCalled()
  })

  it('无订阅者时 notify 不抛', () => {
    expect(() => notifyQuickTargetsChanged()).not.toThrow()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd frontend && npx vitest run src/lib/__tests__/quickTargets.test.ts`
Expected: FAIL — `Failed to resolve import "../quickTargets"`。

- [ ] **Step 3: 写实现**

创建 `frontend/src/lib/quickTargets.ts`：

```ts
import type { SessionType } from './api'

// 当前支持的会话类型。agent 是库里的字符串：某个 agent 类型日后被移除时（如 kiro），
// 旧行会留下已失效的值。用白名单校验后再用，而不是把脏字符串原样发给后端。
// note 行的 agent 是空串，不在白名单里 → 返回 null，由调用方走 Obsidian 路径。
const AGENTS: readonly SessionType[] = ['tmux', 'claude', 'kiro', 'codex']

/** 把库里的 agent 收敛为合法 SessionType；不合法/缺失返回 null。 */
export function coerceAgent(v: string | null | undefined): SessionType | null {
  return AGENTS.includes(v as SessionType) ? (v as SessionType) : null
}
```

创建 `frontend/src/lib/quickTargetsBus.ts`：

```ts
// quick_targets 变更的进程内广播。
//
// bump 发生在后端（create_session / vault_file 的副作用），前端只有在自己触发了
// 那些动作时才知道要刷新——所以由动作发起方 notify()，所有挂载中的 QuickTargets
// 重新 GET。没有它，列表就是「挂载时取一次」的静态快照：VaultReader 在 App.tsx
// 里常驻挂载（用 hidden 切换可见性，刻意不 unmount 以保留滚动状态），会一直显示
// 几小时前的顺序。
//
// 刻意不用 props refreshKey：三个入口分布在 Sidebar / FileBrowser(modal) /
// ScheduledTasksPanel / VaultReader 四条不同的树路径上，穿 props 会让「一份实现
// 多处复用」退化成每加一个入口改一次调用链。
const listeners = new Set<() => void>()

export function notifyQuickTargetsChanged(): void {
  // 复制一份再遍历：监听者在回调里退订（组件 unmount）不会破坏本次迭代。
  for (const f of Array.from(listeners)) f()
}

export function subscribeQuickTargets(f: () => void): () => void {
  listeners.add(f)
  return () => { listeners.delete(f) }
}
```

在 `frontend/src/lib/api.ts` 的 `listDirectories` 之后（`L190` 附近）加：

```ts
// ── Quick targets（常用目录/笔记 frecency）──

export interface QuickTarget {
  kind: 'dir' | 'note'
  path: string
  /** dir: claude|kiro|codex|tmux；note: 空串 */
  agent: string
  display: string
  hint: string
}

export async function listQuickTargets(kind: 'dir' | 'note'): Promise<{ top: QuickTarget[] }> {
  const res = await api(`/api/quick-targets?kind=${kind}`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function forgetQuickTarget(kind: 'dir' | 'note', path: string, agent: string): Promise<void> {
  const params = new URLSearchParams({ kind, path, agent })
  const res = await api(`/api/quick-targets?${params}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(await res.text())
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd frontend && npx vitest run src/lib/__tests__/quickTargets.test.ts`
Expected: PASS，8 个绿。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/api.ts frontend/src/lib/quickTargets.ts frontend/src/lib/quickTargetsBus.ts frontend/src/lib/__tests__/quickTargets.test.ts
git commit -m "feat(quick-targets): 前端 API 封装 + agent 白名单 + 事件总线

coerceAgent 用白名单把库里的 agent 收敛为合法 SessionType(某个类型日后被移除时
旧行会留下失效字符串,不能原样发给后端)。quickTargetsBus 是 12 行的进程内广播,
用于事件驱动刷新——没有它列表就是「挂载时取一次」的静态快照,而 VaultReader 在
App.tsx 里常驻挂载不 unmount,会一直显示几小时前的顺序。不用 props refreshKey:
四个入口分布在四条不同树路径上,穿 props 会让「一份实现多处复用」退化。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---
### Task 5: `QuickTargets` 组件（两行版式 + 行级操作单 + 事件驱动 + stale 防护）

**Files:**
- Create: `frontend/src/components/QuickTargets.tsx`
- Test: `frontend/src/components/__tests__/QuickTargets.test.tsx`

**Interfaces:**
- Consumes: Task 4 的 `listQuickTargets` / `forgetQuickTarget` / `coerceAgent` / `subscribeQuickTargets`；
  既有 `SessionTypeIcon` 的图标来源 `BrandIcons`（`ClaudeCodeIcon` / `KiroIcon` / `CodexIcon`，
  已在 `Sidebar.tsx:15` 导入）
- Produces: 默认导出组件，props：
  ```ts
  {
    kind: 'dir' | 'note'
    onPick: (path: string, agent: SessionType | null) => void
    onChangeAgent?: (path: string) => void     // 行级操作单「换 agent 类型」
    onPickWithPrompt?: (path: string, agent: SessionType | null) => void
    onEmpty?: () => void                        // 列表为空时通知父级（父级可改渲染 pick-type）
  }
  ```

- [ ] **Step 1: 写失败的测试**

创建 `frontend/src/components/__tests__/QuickTargets.test.tsx`：

```tsx
import { render, screen, waitFor, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import QuickTargets from '../QuickTargets'
import * as api from '../../lib/api'
import { notifyQuickTargetsChanged } from '../../lib/quickTargetsBus'
import type { QuickTarget } from '../../lib/api'

const t = (over: Partial<QuickTarget> = {}): QuickTarget => ({
  kind: 'dir', path: '/w/a', agent: 'claude', display: 'a', hint: '~', ...over,
})
const list = (top: QuickTarget[]) => ({ top })

describe('QuickTargets 事件驱动刷新', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('notifyQuickTargetsChanged() 让挂载中的组件重新取数并重排', async () => {
    // 这是新约束 1 的核心：列表不能是「挂载时取一次」的静态快照。
    let call = 0
    vi.spyOn(api, 'listQuickTargets').mockImplementation(() => {
      call += 1
      return Promise.resolve(call === 1
        ? list([t({ path: '/w/old', display: 'old' })])
        : list([t({ path: '/w/new', display: 'new' })]))
    })

    render(<QuickTargets kind="dir" onPick={() => {}} />)
    await screen.findByText('old')

    notifyQuickTargetsChanged()
    await screen.findByText('new')
    expect(screen.queryByText('old')).not.toBeInTheDocument()
  })
})

describe('QuickTargets stale-response 防护', () => {
  beforeEach(() => vi.restoreAllMocks())

  // 本 repo 已因 stale-response clobber 修过 12 次。本组件同时具备「慢 GET」
  // （JuiceFS 上的 per-row 守卫）与「乐观 mutation」（forget 先改本地再 refetch）。
  //
  // 这个测试的时序是**实测确定**的，三点都关键，改动任一点都会让它退化成空转：
  // 1. forget 的网络调用**永不 resolve** —— 锁住时间窗，使唯一能改变 UI 的写入
  //    只有那个陈旧 GET。否则 forget 完成后的「纠正性 load」会把 ghost 修好，
  //    测试即便在无守卫时也绿（实测确认过这个陷阱）。
  // 2. 后续 GET 全部复用同一个慢 promise —— 同上，杜绝纠正性 load 掩盖问题。
  // 3. 断言用 `act` 精确围栏而非 `waitFor` 轮询 —— waitFor 会一直轮询到 ghost
  //    被修好为止，从而看不见中间那个错误状态。
  it('forget 在途期间到达的陈旧 GET 不得让已移除的行重新出现', async () => {
    let resolvePre: (v: { top: QuickTarget[] }) => void = () => {}
    const pre = new Promise<{ top: QuickTarget[] }>(r => { resolvePre = r })
    let call = 0
    vi.spyOn(api, 'listQuickTargets').mockImplementation(() => {
      call += 1
      if (call === 1) return Promise.resolve(list([
        t({ path: '/w/gone', display: 'gone' }),
        t({ path: '/w/keep', display: 'keep' }),
      ]))
      return pre   // 后续 GET 全用这个慢 promise
    })
    vi.spyOn(api, 'forgetQuickTarget').mockImplementation(() => new Promise<void>(() => {}))

    render(<QuickTargets kind="dir" onPick={() => {}} />)
    await screen.findByText('gone')

    act(() => { notifyQuickTargetsChanged() })   // GET#2 起飞（慢，携带移除前的快照）

    const row = screen.getByText('gone').closest('li')!
    await act(async () => {
      ;(row.querySelector('[data-testid="qt-menu"]') as HTMLElement).click()
    })
    await act(async () => { screen.getByTestId('qt-forget').click() })
    expect(screen.queryByText('gone')).not.toBeInTheDocument()   // 乐观移除已生效

    // 陈旧快照（仍含 gone）现在到达。有 reqRef bump → 丢弃；无 bump → gone 复活。
    await act(async () => {
      resolvePre(list([
        t({ path: '/w/gone', display: 'gone' }),
        t({ path: '/w/keep', display: 'keep' }),
      ]))
      await Promise.resolve(); await Promise.resolve()
    })
    expect(screen.queryByText('gone')).not.toBeInTheDocument()
  })
})

describe('QuickTargets agent 收敛与取用', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('agent 合法时点行直接 onPick 带类型', async () => {
    vi.spyOn(api, 'listQuickTargets').mockResolvedValue(
      list([t({ path: '/w/y', display: 'y', agent: 'codex' })]))
    const onPick = vi.fn()
    render(<QuickTargets kind="dir" onPick={onPick} onChangeAgent={() => {}} />)
    ;(await screen.findByText('y')).click()
    expect(onPick).toHaveBeenCalledWith('/w/y', 'codex')
  })

  it('agent 为未知字符串时点行走 onChangeAgent，不把脏值传给 onPick', async () => {
    vi.spyOn(api, 'listQuickTargets').mockResolvedValue(
      list([t({ path: '/w/x', display: 'x', agent: 'gemini' })]))
    const onPick = vi.fn()
    const onChangeAgent = vi.fn()
    render(<QuickTargets kind="dir" onPick={onPick} onChangeAgent={onChangeAgent} />)
    ;(await screen.findByText('x')).click()
    expect(onPick).not.toHaveBeenCalled()
    expect(onChangeAgent).toHaveBeenCalledWith('/w/x')
  })

  it('note 行（agent 空串）点行走 onPick 且 agent 为 null', async () => {
    vi.spyOn(api, 'listQuickTargets').mockResolvedValue(
      list([t({ kind: 'note', path: 'p/a.md', display: 'a', hint: 'p', agent: '' })]))
    const onPick = vi.fn()
    render(<QuickTargets kind="note" onPick={onPick} />)
    ;(await screen.findByText('a')).click()
    expect(onPick).toHaveBeenCalledWith('p/a.md', null)
  })
})

describe('QuickTargets 手机可用性', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('行级操作单入口不依赖 hover：无 hover 也可见可点', async () => {
    // Tailwind v4 把 group-hover:* 编译进 @media (hover:hover)，手机上整条规则不生效
    // → 元素永久 opacity:0 但仍可点击 = 隐形按钮。用户主设备是手机，故禁止 hover-only。
    vi.spyOn(api, 'listQuickTargets').mockResolvedValue(
      list([t({ path: '/w/a', display: 'a' })]))
    render(<QuickTargets kind="dir" onPick={() => {}} onChangeAgent={() => {}} />)
    const menu = await screen.findByTestId('qt-menu')
    expect(menu.className).not.toMatch(/opacity-0/)
    expect(menu.className).not.toMatch(/group-hover/)
  })

  it('列表为空时通知父级（父级据此渲染 pick-type，而不是给出空壳首屏）', async () => {
    vi.spyOn(api, 'listQuickTargets').mockResolvedValue(list([]))
    const onEmpty = vi.fn()
    render(<QuickTargets kind="dir" onPick={() => {}} onEmpty={onEmpty} />)
    await waitFor(() => expect(onEmpty).toHaveBeenCalled())
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd frontend && npx vitest run src/components/__tests__/QuickTargets.test.tsx`
Expected: FAIL — `Failed to resolve import "../QuickTargets"`。

- [ ] **Step 3: 写实现**

创建 `frontend/src/components/QuickTargets.tsx`：

```tsx
import { useState, useEffect, useCallback, useRef } from 'react'
import { MoreVertical, X, FileText, Terminal, Repeat, MessageSquarePlus } from 'lucide-react'
import type { SessionType, QuickTarget } from '../lib/api'
import { listQuickTargets, forgetQuickTarget } from '../lib/api'
import { coerceAgent } from '../lib/quickTargets'
import { subscribeQuickTargets } from '../lib/quickTargetsBus'
import { ClaudeCodeIcon, KiroIcon, CodexIcon } from './BrandIcons'

/** 行首图标 = 这一行会开出什么。比行尾一个小写标签的信息量更高，且省下约 44px 宽度
 *  给目录名和 hint（224px 弹层里这是决定性的）。 */
function RowIcon({ kind, agent, size = 15 }: { kind: 'dir' | 'note'; agent: string; size?: number }) {
  if (kind === 'note') return <FileText size={size} className="text-[var(--accent-blue)] shrink-0" />
  switch (coerceAgent(agent)) {
    case 'claude': return <ClaudeCodeIcon size={size} className="shrink-0" />
    case 'kiro':   return <KiroIcon size={size} className="shrink-0" />
    case 'codex':  return <CodexIcon size={size} className="shrink-0" />
    case 'tmux':   return <Terminal size={size} className="text-[var(--accent-green-text)] shrink-0" />
    default:       return <Terminal size={size} className="text-[var(--text-muted)] shrink-0" />
  }
}

/** 常用目录/笔记快速入口。一份实现服务三处：New Session 首屏、DirectoryPicker 顶部、
 *  VaultReader 的「最近打开」。kind 决定数据源与图标，其余行为一致。 */
export default function QuickTargets({ kind, onPick, onChangeAgent, onPickWithPrompt, onEmpty }: {
  kind: 'dir' | 'note'
  onPick: (path: string, agent: SessionType | null) => void
  onChangeAgent?: (path: string) => void
  onPickWithPrompt?: (path: string, agent: SessionType | null) => void
  onEmpty?: () => void
}) {
  const [items, setItems] = useState<QuickTarget[]>([])
  const [loaded, setLoaded] = useState(false)
  const [openMenu, setOpenMenu] = useState<string | null>(null)   // path|agent 的 key

  // 单调请求令牌。本组件同时具备「慢 GET」（JueceFS/S3 上的 per-row 守卫）与
  // 「乐观 mutation」（forget 先改本地 state 再 refetch）两个条件，正是本 repo 修过
  // 12 次的 stale-response clobber 场景：一个乐观写之前发出的旧 GET 迟到，会把刚
  // 移除的条目复活成 ghost。fetch 顶部 bump，每个乐观写前也 bump，await 后守卫。
  const reqRef = useRef(0)

  const load = useCallback(async () => {
    const req = ++reqRef.current
    try {
      const data = await listQuickTargets(kind)
      if (reqRef.current !== req) return
      setItems(data?.top ?? [])
    } catch {
      if (reqRef.current !== req) return
      // 快速入口是加速器，不是主路径：加载失败就安静地什么都不显示，让用户回落到
      // 目录浏览，而不是弹错误挡住新建会话。
      setItems([])
    }
    if (reqRef.current === req) setLoaded(true)
  }, [kind])

  useEffect(() => { load() }, [load])
  // 事件驱动刷新：没有它，列表就是挂载时的静态快照（VaultReader 常驻挂载，会一直
  // 显示几小时前的顺序）。发射点精确镜像后端两处 bump。
  useEffect(() => subscribeQuickTargets(load), [load])

  // 空列表时通知父级，让它改渲染原来的类型选择器 —— 否则全新库点 ＋ 只看到一个标题
  // 加一行「其他目录…」，比改动前更差。
  useEffect(() => { if (loaded && items.length === 0) onEmpty?.() }, [loaded, items.length, onEmpty])

  const forget = useCallback(async (it: QuickTarget) => {
    reqRef.current++      // 使任何在途 GET 失效，否则旧快照会让这条复活成 ghost
    setItems(prev => prev.filter(x => !(x.path === it.path && x.agent === it.agent)))
    setOpenMenu(null)
    try { await forgetQuickTarget(kind, it.path, it.agent) } catch { /* 下次 load 会纠正 */ }
    load()
  }, [kind, load])

  const pick = (it: QuickTarget) => {
    if (it.kind === 'note') { onPick(it.path, null); return }
    const agent = coerceAgent(it.agent)
    // agent 不合法（库里的旧类型已被移除）→ 交给调用方选类型，绝不把脏字符串当
    // SessionType 发出去。
    if (!agent) { onChangeAgent?.(it.path); return }
    onPick(it.path, agent)
  }

  if (!loaded || items.length === 0) return null

  return (
    <ul className="border-b border-[var(--border)] max-h-72 overflow-y-auto">
      {items.map(it => {
        const key = `${it.path}|${it.agent}`
        return (
          <li key={key} className="relative border-b border-[var(--border)] last:border-b-0">
            <div className="flex items-stretch">
              {/* 整行 = 唯一主目标。min-h-[48px] 满足触控最小尺寸（v1 的 py-1.5 只有约 28px）。 */}
              <button
                type="button"
                onClick={() => pick(it)}
                className="flex items-start gap-2 flex-1 min-w-0 px-3 py-2 min-h-[48px] text-left hover:bg-[var(--bg-hover)] transition-colors"
                title={it.path}
              >
                <span className="mt-0.5"><RowIcon kind={it.kind} agent={it.agent} /></span>
                <span className="flex flex-col min-w-0 flex-1">
                  <span className="truncate text-xs text-[var(--text-primary)]">{it.display}</span>
                  {/* hint 独占第 2 行：内联时在 224px 下必被截成 "…"，而它唯一的作用
                      就是区分同名（vault 里多个 _index.md）。 */}
                  {it.hint && (
                    <span className="truncate text-[10px] text-[var(--text-muted)]">{it.hint}</span>
                  )}
                </span>
              </button>
              {/* 行级操作单入口。刻意不用 opacity-0 group-hover:opacity-100 —— Tailwind v4
                  把它编译进 @media (hover:hover)，手机上整条规则不生效，元素会永久
                  opacity:0 但仍可点击（隐形按钮）。用户主设备是手机。 */}
              <button
                type="button"
                data-testid="qt-menu"
                onClick={() => setOpenMenu(cur => (cur === key ? null : key))}
                className="shrink-0 w-8 flex items-center justify-center text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                title="更多操作"
              >
                <MoreVertical size={14} />
              </button>
            </div>

            {/* 展开的操作单：每项 ≥44px 整行 + 文字标签。破坏性操作下沉一层，
                这一层本身即确认（故不再加 confirm 弹窗）。 */}
            {openMenu === key && (
              <div className="border-t border-[var(--border)] bg-[var(--bg-secondary)]">
                {it.kind === 'dir' && onChangeAgent && (
                  <button
                    type="button"
                    data-testid="qt-changeagent"
                    onClick={() => { setOpenMenu(null); onChangeAgent(it.path) }}
                    className="flex items-center gap-2 w-full px-3 py-2.5 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                  >
                    <Repeat size={13} className="shrink-0" />换 agent 类型
                  </button>
                )}
                {it.kind === 'dir' && onPickWithPrompt && (
                  <button
                    type="button"
                    data-testid="qt-withprompt"
                    onClick={() => { setOpenMenu(null); onPickWithPrompt(it.path, coerceAgent(it.agent)) }}
                    className="flex items-center gap-2 w-full px-3 py-2.5 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                  >
                    <MessageSquarePlus size={13} className="shrink-0" />带 prompt 打开
                  </button>
                )}
                <button
                  type="button"
                  data-testid="qt-forget"
                  onClick={() => forget(it)}
                  className="flex items-center gap-2 w-full px-3 py-2.5 text-[11px] text-[var(--text-secondary)] hover:text-[var(--accent-red)] hover:bg-[var(--bg-hover)]"
                >
                  <X size={13} className="shrink-0" />从列表移除
                </button>
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd frontend && npx vitest run src/components/__tests__/QuickTargets.test.tsx`
Expected: PASS，8 个绿。

- [ ] **Step 5: 验证 stale 测试不是空转（可证伪性检查）**

临时把 `forget` 里的 `reqRef.current++` 那一行注释掉，重跑：

Run: `cd frontend && npx vitest run src/components/__tests__/QuickTargets.test.tsx 2>&1 | tail -12`
Expected: **「forget 在途期间到达的陈旧 GET 不得让已移除的行重新出现」这条变红**，
报 `expected document not to contain element, found <span ...>gone</span>`。

**这一步不是形式主义 —— 写本计划时的前两版测试都在无守卫时仍然绿**（即空转），
原因见该测试上方注释的三点时序要求。若它仍然绿，说明测试没有真正覆盖守卫，
必须修测试而不是接受它。确认变红后恢复那一行，再跑一次确认全绿。

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/QuickTargets.tsx frontend/src/components/__tests__/QuickTargets.test.tsx
git commit -m "feat(quick-targets): QuickTargets 组件(两行版式 + 行级操作单 + 事件驱动)

版式:整行是唯一主目标(min-h-[48px],v1 的 py-1.5 只有约 28px 不达触控标准),
右侧一个 32px 的操作单入口,hint 独占第 2 行(内联时在 224px 弹层里必被截成
省略号,而它唯一作用就是区分同名 _index.md)。行首图标 = 这行会开出什么,替掉
行尾约 44px 的大写 agent 标签。

禁止 hover-only:Tailwind v4 把 group-hover:* 编译进 @media (hover:hover),
手机上整条规则不生效 → 元素永久 opacity:0 但仍可点击(隐形按钮),而用户主设备
是手机。破坏性操作下沉进操作单,这一层本身即确认。

reqRef 在 fetch 顶部与每个乐观写前双侧 bump;stale 测试构造的是「乐观写之前发出、
写之后到达」的 GET(由 mutation 自己触发的 refetch 是权威响应必须接受),并附
可证伪性检查步骤——注释掉守卫必须变红。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---
### Task 6: 接入三个入口 + 修 5 个导航/可用性缺陷

**Files:**
- Modify: `frontend/src/components/Sidebar.tsx`（新增 step `quick`；弹层宽度；`pick-type` 返回键；
  `pick-prompt` 返回分流；`pick-dir` 的 disabled 守卫；`selectNewShell` 尊重已定目录）
- Modify: `frontend/src/components/DirectoryPicker.tsx`（顶部嵌入）
- Modify: `frontend/src/components/VaultReader.tsx`（「最近打开」换后端源 + 发射刷新事件）
- Modify: `frontend/src/App.tsx`（`handleCreate` 成功后发射刷新事件）
- Modify: `frontend/src/lib/vault.ts`（删除 localStorage recent 三函数 + KEY）
- Modify: `frontend/src/lib/__tests__/vault.test.ts`（删除对应测试）

**Interfaces:**
- Consumes: Task 5 的 `QuickTargets`；Task 4 的 `notifyQuickTargetsChanged`；
  既有 `onCreate(type, workDir, tmuxTarget, initialPrompt)`（`Sidebar.tsx:22`）
- Produces: 无新导出（纯接线）

- [ ] **Step 1: 弹层宽度随 mobile（根因先修）**

`Sidebar.tsx` 有**三处**硬编码 `w-56` 的弹层（`L472` 新建会话、`L798`、`L837`），
而侧栏面板本身是 `mobile ? 'w-64' : 'w-56'`（`L320`）。手机上侧栏已是全屏遮罩，
却把内容塞进 224px 浮层。

三处的 `w-56` 都改为：

```tsx
${mobile ? 'w-[calc(100vw-1rem)]' : 'w-56'}
```

（把这些 `className` 字符串改成模板字符串。`mobile` 已是组件 prop，`Sidebar.tsx:78`。）

这一行改动让整个宽度危机消失，并顺带缓解既有的 `pick-dir`/`pick-prompt` 拥挤。

- [ ] **Step 2: 新增 step `quick` 作首屏**

`Sidebar.tsx:63` 的 step 联合类型加 `'quick'`：

```ts
type NewSessionStep = 'closed' | 'quick' | 'pick-type' | 'pick-terminal-mode' | 'pick-dir' | 'pick-tmux' | 'pick-prompt' | 'manage-prompts'
```

顶部 import 加：

```ts
import QuickTargets from './QuickTargets'
```

`openTypePicker`（`Sidebar.tsx:172`）改为开在 `quick`：

```ts
  const openTypePicker = () => {
    setStep('quick')
    setPendingType(null)
    setPendingDir(null)   // 每次重新打开都从干净状态开始，避免上次残留的目录泄漏
  }
```

在 `step === 'pick-type'` 的 JSX 块**之前**插入 `quick` 块：

```tsx
              {step === 'quick' && (
                <>
                  <div className="px-3 py-1.5 text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">
                    新建会话
                  </div>
                  {/* 一击直达：点一行 = 用该行的 agent 直接创建，0 次列目录请求。
                      刻意跳过 prompt 页——中间插一页就退化成「少点两下的老流程」，
                      而且信息零丢失：会话建好后 AcpChatView 的 composer 里有一模一样的
                      preset 选择器。要带 prompt 的场景走行级操作单。 */}
                  <QuickTargets
                    kind="dir"
                    onPick={(path, agent) => {
                      if (!agent) { setPendingDir(path); setStep('pick-type'); return }
                      onCreate(agent, path)
                      closeAfterCreate()
                    }}
                    onChangeAgent={(path) => { setPendingDir(path); setStep('pick-type') }}
                    onPickWithPrompt={(path, agent) => {
                      setPendingDir(path)
                      setPendingType(agent ?? null)
                      setPromptDraft('')
                      presetStore.reload()
                      setStep(agent ? 'pick-prompt' : 'pick-type')
                    }}
                    // 列表为空（全新库）时直接跳到类型选择器，而不是给出一个只有标题
                    // 加一行「其他目录…」的空壳首屏——那比改动前更差。
                    onEmpty={() => setStep('pick-type')}
                  />
                  <button
                    type="button"
                    onClick={() => { setPendingDir(null); setStep('pick-type') }}
                    className="flex items-center gap-2 w-full px-3 py-2.5 min-h-[44px] text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors"
                  >
                    <Folder size={13} className="shrink-0" />
                    <span>其他目录…</span>
                  </button>
                  {/* Obsidian 显式保底入口：'vault' 在 App.tsx:240-244 于前端短路，
                      不经过 create_session，所以它永远不会出现在 dir 榜上。若只靠
                      「其他目录…」里的那份，入口会从今天的 2 tap 退化到 3 tap。 */}
                  {vaultEnabled && (
                    <button
                      type="button"
                      onClick={() => { onCreate('vault'); closeAfterCreate() }}
                      className="flex items-center gap-2 w-full px-3 py-2.5 min-h-[44px] text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors"
                    >
                      <BookOpen size={13} className="shrink-0" />
                      <span>Obsidian 笔记库</span>
                    </button>
                  )}
                </>
              )}
```

- [ ] **Step 3: 加 `closeAfterCreate`（手机上同时关侧栏）**

在 `close`（`Sidebar.tsx:215`）附近加：

```ts
  // 创建后收尾：关弹层，手机上还要关掉全屏侧栏 —— 否则用户建完会话正对着一块
  // 遮住新会话的遮罩（手机侧栏是 fixed 全屏），「1 次点击」这句话就不成立。
  // 既有的 handleSelect 只在「选择已有会话」时 onToggle，不覆盖创建路径。
  const closeAfterCreate = () => {
    close()
    if (mobile) onToggle()
  }
```

并把 `attachTmuxSession`、`submitWithPrompt`、`submitSkip`、`selectDir`（tmux 分支）
里的 `setStep('closed')` 都换成 `closeAfterCreate()`（这几处都是「创建完成」语义）。

- [ ] **Step 4: `selectType` 支持「目录已定」**

`selectType`（`Sidebar.tsx:176`）改为：

```ts
  const selectType = (type: SessionType) => {
    setPendingType(type)
    if (type === 'tmux') {
      setStep('pick-terminal-mode')
    } else if (pendingDir) {
      // 从快速卡片的「换 agent 类型」进来：目录已定，只是改类型 → 直接进 prompt 页
      setPromptDraft('')
      presetStore.reload()
      setStep('pick-prompt')
    } else {
      setStep('pick-dir')
      loadDirs()
    }
  }
```

`selectNewShell`（`Sidebar.tsx:187`）改为尊重已定目录 —— 否则用户从快速卡片说
「用终端打开目录 A」，会被扔回 5 层目录浏览：

```ts
  const selectNewShell = () => {
    if (pendingDir) { onCreate('tmux', pendingDir); closeAfterCreate(); return }
    setStep('pick-dir')
    loadDirs()
  }
```

- [ ] **Step 5: `pick-type` 加返回键**

`quick` 现在是首屏，`pick-type` 成了第二屏却没有返回路径（已核实
`Sidebar.tsx:473-528` 只有一个 "Select type" 标签，没有返回按钮）。
把那个标签行改为与 `pick-terminal-mode`（`L534`）/`pick-dir`（`L609`）一致的形态：

```tsx
                  <div className="flex items-center gap-1 px-2 py-1.5 border-b border-[var(--border)]">
                    <button
                      onClick={() => { setPendingDir(null); setStep('quick') }}
                      className="p-0.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] rounded transition-colors"
                      title="返回"
                    >
                      <ChevronLeft size={14} />
                    </button>
                    <span className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider truncate flex-1">
                      Select type
                    </span>
                  </div>
```

- [ ] **Step 6: `pick-prompt` 的返回按来源分流 + `pick-dir` 补 disabled 守卫**

`pick-prompt` 的返回按钮硬编码 `setStep('pick-dir')`（`Sidebar.tsx:693`）。走
「换 agent 类型」→ `pick-type` → `pick-prompt` 这条新路径时 `pick-dir` 从未
`loadDirs()`，返回后会落在 `currentPath === ''`、`dirs === []` 的空浏览器上。改为：

```tsx
                      onClick={() => setStep(currentPath ? 'pick-dir' : 'pick-type')}
```

并给 `pick-dir` 的「Use this directory」补 disabled 守卫（`Sidebar.tsx:634-639`）——
`DirectoryPicker.tsx:86` 早就有 `disabled={!currentPath}`，Sidebar 这一份漏了，
会把 `''` 当 work_dir 提交：

```tsx
                    <button
                      onClick={() => selectDir(currentPath)}
                      disabled={!currentPath}
                      className="w-full py-1 text-[10px] font-semibold bg-[var(--accent-blue)] hover:bg-[var(--accent-blue-hover)] text-white rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Use this directory
                    </button>
```

- [ ] **Step 7: `DirectoryPicker` 顶部嵌入**

`DirectoryPicker.tsx` 的「Current path + use-this button」`</div>` 之后插入：

```tsx
      <QuickTargets kind="dir" onPick={(path) => onSelect(path)} />
```

并加 import：

```ts
import QuickTargets from './QuickTargets'
```

（**注意**：Sidebar 内联 `pick-dir` 顶部**不加** —— 能走到那一屏的用户，路径必然是
`quick` →「其他目录…」→ 选类型 → `pick-dir`，即他刚刚才明确选择了「不用快速目标」。
在下一屏把同样 5 行再摆一遍是噪音。`DirectoryPicker` 这一份保留：定时任务表单是低频、
易填错的表单，真受益。）

- [ ] **Step 8: `App.tsx` 发射刷新事件**

`handleCreate`（`App.tsx:239`）的 `await createSession(...)` 之后加：

```ts
    notifyQuickTargetsChanged()   // 后端刚 bump 过，让挂载中的快速列表重排
```

import 加：

```ts
import { notifyQuickTargetsChanged } from './lib/quickTargetsBus'
```

（**只在 `createSession` 成功之后**发。`type === 'vault'` 的早退分支**不发** ——
它在前端短路，后端没有 bump。）

- [ ] **Step 9: `VaultReader` 换后端源 + 发射事件**

(a) import 改为：
```ts
import { filterVaultEntries, resolveVaultImageSrc } from '../lib/vault'
import QuickTargets from './QuickTargets'
import { notifyQuickTargetsChanged } from '../lib/quickTargetsBus'
```

(b) 删除 `const [recent, setRecent] = useState<string[]>(() => getRecentNotes())`。

(c) `openNote` 的 `.then()` 里，把 `pushRecentNote(path); setRecent(getRecentNotes())`
换成 `notifyQuickTargetsChanged()`（后端 `vault_file` 已在成功分支 bump）；
catch 里删掉 `removeRecentNote(path); setRecent(getRecentNotes())`（读出时守卫已自愈删行），
保留 alert：

```ts
    }).catch(() => {
      if (openReqRef.current !== req) return
      // 一条失效的历史条目（笔记已在 Obsidian 中删除/移动）会 404。后端的读出守卫
      // 会在下次列表时剔除并删行，这里只需告知用户。
      alert('无法打开笔记(可能已被删除或移动):' + path)
    })
```

(d) 把「最近打开」那段（`L119-125` 区域）替换为 —— **用 `hidden` 而非条件渲染**，
因为 `VaultReader` 在 `App.tsx:396` 是常驻挂载（用 `hidden` 切可见性、刻意不 unmount
以保留滚动状态），条件渲染会让切目录时 unmount/remount，每次重付一遍全量 note 校验的 IO：

```tsx
            <div className={cwd === '' ? '' : 'hidden'}>
              <QuickTargets kind="note" onPick={(path) => openNote(path)} />
            </div>
```

- [ ] **Step 10: 删除 vault.ts 的 localStorage recent**

`frontend/src/lib/vault.ts` 删除 `RECENT_KEY`、`getRecentNotes`、`pushRecentNote`、
`removeRecentNote` 四项（本次改动使其成为死代码，属清理自己造成的 mess）。

同步删除 `frontend/src/lib/__tests__/vault.test.ts` 中针对这三个函数的 describe 块
（先 `grep -n "RecentNote" frontend/src/lib/__tests__/vault.test.ts` 定位）。

**不做 localStorage → 后端的迁移**：那需要一个能批量写入任意 path + last_ms 的端点，
与被否决的公开 bump 端点是同一个洞。现存 ≤10 条 recent 打开一次笔记就自然重建。

- [ ] **Step 11: 跑全量前端测试 + lint + build**

Run: `cd frontend && npm test 2>&1 | tail -25`
Expected: 全绿。若 `VaultReader.test.tsx` 因「最近打开」断言失败，更新该断言 ——
`QuickTargets` 在无数据时返回 `null`，故需 mock `listQuickTargets` 返回 `{ top: [] }`。

Run: `cd frontend && npm run lint 2>&1 | tail -10`
Expected: 无 error。

Run: `cd frontend && npm run build 2>&1 | tail -5`
Expected: 成功产出 `frontend/dist/`。

Run: `cargo check 2>&1 | tail -5`
Expected: 无错误。

- [ ] **Step 12: Commit**

```bash
git add frontend/src/components/Sidebar.tsx frontend/src/components/DirectoryPicker.tsx frontend/src/components/VaultReader.tsx frontend/src/App.tsx frontend/src/lib/vault.ts frontend/src/lib/__tests__/vault.test.ts
git commit -m "feat(quick-targets): 接入三个入口 + 修 5 个导航/可用性缺陷

入口:New Session 首屏(快速卡片 + 其他目录… + Obsidian 保底入口)、DirectoryPicker
顶部、VaultReader 的最近打开。Sidebar 内联 pick-dir 顶部刻意不加——走到那屏的用户
刚刚才明确选择了「不用快速目标」。

Obsidian 保底入口是必需的:'vault' 在 App.tsx:240-244 前端短路不经 create_session,
永远不会出现在 dir 榜上;只靠「其他目录…」里那份会让入口从 2 tap 退化到 3 tap。

同时修 5 个缺陷:①三处弹层硬编码 w-56 不随 mobile(侧栏面板本身是 mobile?w-64)
②pick-type 缺返回键(quick 成首屏后它是第二屏却无路可回)③pick-prompt 返回硬编码
到未 loadDirs 的 pick-dir + 那屏的 Use this directory 缺 disabled 守卫(会把 ''
当 work_dir 提交,DirectoryPicker:86 早有这个守卫)④selectNewShell 丢弃已定目录
⑤手机创建后不关全屏侧栏(用户对着遮罩看不到新会话)。

VaultReader 用 hidden 而非条件渲染:它在 App.tsx:396 常驻挂载,条件渲染会让切目录
时 remount 重付全量 note 校验 IO。

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

浏览器打开 `http://localhost:8099`，逐条验证：

1. **全新库**：点 ＋ → 因列表为空，**直接看到类型选择器**（不是只有标题的空壳）
2. 走类型选择器创建 3 个不同目录的 claude 会话
3. 重开 ＋ → 首屏出现 3 条，最近创建的在最前，每条行首是 Claude 图标、第 2 行是父路径
4. 点第 1 条 → **直接创建**（不经 prompt 页），work_dir 正确
5. **同一目录先用 claude 再用 codex** → 重开 ＋ 应看到**该目录的 2 行**，
   一行 Claude 图标一行 Codex 图标，**标签不漂移**
6. 点某行的 `⋮` → 展开操作单，三项（换 agent 类型 / 带 prompt 打开 / 从列表移除）
   **都可见**（不需 hover）
7. 点「从列表移除」→ 该行消失；重开面板确认未复活
8. 点「换 agent 类型」→ 进类型选择，选 codex → 进 prompt 页（目录已定，不再选目录）
9. 点「换 agent 类型」→ 选 Terminal → **直接用该目录开终端**（不被扔回目录浏览）
10. 在 `pick-type` 点返回 → 回到快速列表
11. 首屏点「Obsidian 笔记库」→ 直接打开阅读器（**2 tap，未退化**）
12. **Obsidian 里连开 3 篇笔记 → 不离开该页面，列表顺序实时重排**（事件驱动生效）
13. 打开 2 篇同名 `_index.md` → 列表能通过第 2 行父目录区分

- [ ] **Step 3: 手机视口验证（Chrome DevTools 触屏模拟）**

DevTools → Toggle device toolbar → 选 iPhone → 勾选 touch 模拟。

1. 弹层宽度应接近全屏宽（不是 224px）
2. 行高 ≥48px，`⋮` 可见
3. 点一行创建 → **侧栏自动关闭**，能立刻看到新会话
4. 操作单三项都可见可点（这一条是 hover-only 回归的守门测试）

- [ ] **Step 4: 验证定时任务与 attach tmux 不污染**

在 Settings → 定时任务里建一个 5 分钟后触发的任务，work_dir 指向一个**从未手动开过
会话**的目录。等它触发一次后重开 ＋ 面板。

Expected: 该目录**不**出现在快速卡片中（bump 只在 `web.rs` 的交互式 handler，
定时任务走 `create_acp_session_tagged` 独立路径）。

再验证 attach：`tmux new -s probe -d`，然后 ＋ → Terminal → Attach existing → `probe`。

Expected: `~`（即 `--work-dir` 的兜底值）**不**出现在榜上。

- [ ] **Step 5: 验证三态守卫自愈**

```bash
NOW=$(date +%s000)
# ① 指向 ~/.ssh（确定性拒绝 → 应删行）
sqlite3 ~/.zeromux/zeromux.db \
  "INSERT INTO quick_targets (user_id,kind,path,agent,hits,last_ms,score_raw)
   VALUES ('legacy','dir','$HOME/.ssh','claude',9,$NOW,9.0);"
# ② 不存在的目录（NotFound → 应删行）
sqlite3 ~/.zeromux/zeromux.db \
  "INSERT INTO quick_targets (user_id,kind,path,agent,hits,last_ms,score_raw)
   VALUES ('legacy','dir','$HOME/definitely-not-here-$RANDOM','claude',9,$NOW,9.0);"
```

重开 ＋ 面板 → 两条都**不**显示。确认已删行：

```bash
sqlite3 ~/.zeromux/zeromux.db \
  "SELECT path FROM quick_targets WHERE path LIKE '%.ssh%' OR path LIKE '%definitely-not-here%';"
```
Expected: 空输出。

**再验证 Unknown 态不删行**（这是 v2 新增的保护，防止一次 JuiceFS 抖动清掉累积分）：
构造一个存在但不可 canonicalize 的路径 —— 建一个自指的 symlink 环：

```bash
ln -s ~/qt-loop ~/qt-loop 2>/dev/null || true
sqlite3 ~/.zeromux/zeromux.db \
  "INSERT INTO quick_targets (user_id,kind,path,agent,hits,last_ms,score_raw)
   VALUES ('legacy','dir','$HOME/qt-loop','claude',9,$(date +%s000),9.0);"
```

重开面板 → 该条不显示；然后确认**行仍在**：

```bash
sqlite3 ~/.zeromux/zeromux.db "SELECT path FROM quick_targets WHERE path LIKE '%qt-loop%';"
```
Expected: **非空**（symlink 环使 `canonicalize` 返回 `ELOOP` 而非 `NotFound`
→ `Unknown` → 只剔除不删行）。清理：`rm -f ~/qt-loop` 并删掉该行。

- [ ] **Step 6: 部署**

Run: `./deploy.sh --build`

**必须用 `./deploy.sh`。** 绝不手跑 `systemctl stop` + `cp` + `start` —— 尤其不要从
zeromux 终端里跑（cgroup 自杀陷阱，见项目 CLAUDE.md）。`deploy.sh` 会自动逃出 cgroup
并自带健康检查 + 自动回滚。

Expected: 健康检查通过；`https://zeromux.keithyu.cloud` 可访问且快速卡片可见。

- [ ] **Step 7: Commit（若手测有修补）**

```bash
git add -A
git commit -m "fix(quick-targets): 手测修补

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```
