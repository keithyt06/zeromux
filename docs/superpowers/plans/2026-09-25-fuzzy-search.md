# 模糊搜索（New Session 目录 + Obsidian 文件夹/笔记 + ⚡ 问 agent）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 New Session 与 VaultReader 中提供 fzf 式模糊搜索（`$HOME` 目录 + vault 文件夹/笔记），搜到笔记即可一键在正确的文件夹里带上下文开 agent；vault 索引改为异步、可刷新，并在 1b 批次升级为 inotify 实时增量。

**Architecture:** 新模块 `src/fuzzy_index.rs` 持有两个 `IndexSlot`（目录 slot / vault slot），每个 slot 是 `RwLock<Option<Arc<Snapshot>>>` + `AtomicBool rebuilding` 的 stale-while-revalidate 槽；vault 快照同时产出搜索用 `PathIndex` 与 wikilink 用的既有 `VaultIndex`，取代启动时同步的 `build_vault_index`。匹配用 `nucleo-matcher`（basename 加权 + frecency 加分 + 同分规则），经 `GET /api/search`（`sections` 形状）与 `GET /api/search/warm` 暴露。1a 的 vault 新鲜度靠「打开即预热 + agent turn 结束单目录对账」；1b 新增 `src/vault_watch.rs`（inotify 标脏 → `reconcile_dir` 对账）取代触发源，不推翻 1a 代码。前端抽出共享结果行组件，Sidebar 首屏加底部搜索框、⚡ 问 agent 流程，VaultReader 换接口并支持 target 定位。

**Tech Stack:** Rust / Axum 0.8 / tokio / `nucleo-matcher 0.3` / `inotify 0.11`（1b）/ rusqlite 0.31 / React 19 / Vite / Tailwind v4 / vitest + @testing-library/react

**Spec:** `docs/superpowers/specs/2026-09-25-fuzzy-search-design.md`（v4）

## Global Constraints

- **语言**：用户可见字符串中文；代码与注释英文（本 repo 双语惯例）。
- **构建顺序**：前端先 build 才能 `cargo build`（`rust-embed` 编译期读 `frontend/dist/`）。迭代用 `cargo test` / `cargo check`，不用 `--release`。
- **测试命令**：后端 `cargo test <filter>`（repo 根）；前端 `cd frontend && npx vitest run <file>`。基线：`cargo test` 395 passed；`npx vitest run` 290 passed / 48 files。
- **目录索引**：根 `$HOME`，`DIR_MAX_DEPTH = 6`，`DIR_MAX_ENTRIES = 5000`，**BFS**；跳过 `.` 开头、`node_modules | target | __pycache__`；`file_type()` 不跟 symlink；**不排除 vault 子树**；守卫只做词法（`path_hits_sensitive_dir` + `read_hits_home_dotdir` 的词法等价，**不 canonicalize**）。
- **vault 收录**：`VaultNote` = `.md`（大小写不敏感）；`VaultDir` = 「子树含 `.md`」或「空文件夹（无任何非 dot 子项）」；跳过 dot 名与 `node_modules | target | __pycache__`；不跟 symlink。
- **目录 slot 刷新**：快照 > **120s** 或（零结果且 > **30s**）或 warm 且 > **30s**；CAS `false→true` 成功者发起。
- **vault slot 刷新（1a）**：warm 且 > 30s；notes 零结果且 > 30s；agent turn 结束钩子 → `reconcile_dir(work_dir, depth ≤ 3)`。
- **匹配**：`Config::DEFAULT.match_paths()`；`Pattern::parse(q, CaseMatching::Smart, Normalization::Smart)`；**正向 atom 数为 0 → 空结果**（`!docs`/`'`/`^`/空白都会 `Some(0)`）；`text = max(full, base + 20)`；丢弃 `score == 0`。
- **frecency 加分**：`s = Σ decayed_score`（按 path 聚合），`bonus = floor(12·s/(s+1))`，上限 12 < `SCORE_MATCH` 16。仅 Dir / VaultNote。
- **同分排序**：非空优先（空 `VaultDir` 最后）→ `mtime` 降序 → haystack 长度升序 → path 字典序。
- **接口**：`GET /api/search?q=&scope=dirs,notes&limit=`；`limit` 每段默认 6、上限 50；`q` 按 **`chars().count()` ≤ 128**，超出 400；未知 scope 400；notes 仅 admin + vault 配置（否则该段恒空、不报错）；notes 项带 `abs_dir`。`GET /api/search/warm?scope=` → 204。
- **删除**：`/api/vault/search`、`vault_search`、`vault_search_filter`、`VaultSearchQuery`、前端 `getVaultSearch`（及其测试）。不留兼容壳。
- **stale-response 防护**：所有新前端 fetch 用单调 `reqRef`（发请求前 bump、await 后比对）。
- **禁止 hover-only 控件**（Tailwind v4 把 `group-hover` 编译进 `@media (hover:hover)`，手机上是隐形可点按钮）。触控目标 ≥ 44px。
- **Drop-based teardown / fan-out 唯一 owner** 不变；turn 结束钩子只**读** `work_dir` 并异步投递，不触碰进程。
- **学习预设**：`seed_v2_if_needed` 置 `user_version = 2`；同标题已存在跳过；删除后不复活。

## Review Focus

1. **vault 在 `$HOME` 下、且 JuiceFS 冷缓存**：启动后前 ~52s notes 段必须返回 `indexing:true` 而非空结果被误读为「无匹配」，`vault_resolve` 返回 503 而非 404 → 前端提示「索引建立中」。Task 3 / Task 5 / Task 9 测试钉住。
2. **查询只有否定或 fzf 元字符**（`!docs`、`'`、`^`、`$`、全空格）：nucleo 对全部条目返回 `Some(0)`（已实测），必须返回空结果，而不是任意前 6 条。Task 2 测试钉住。
3. **中文与 128 上限**：128 个汉字（384 字节）必须通过，129 个 400。Task 5 测试钉住。
4. **目录名含 Unicode / 空格 / 与 vault 重叠**：`~/…/obsidian/projects/x` 同时出现在 dirs（开会话）与 notes（读）两段，这是有意的；dirs 段 `display/hint` 对 `/home/ubuntu-backup` 不能缩写成 `~-backup`（复用既有 `dir_display_hint`）。Task 1 / Task 5 测试钉住。
5. **⚡ 从 tmux 以外的路径才可达**：带上下文开 agent 时 pick-type 必须隐藏 Terminal（tmux 会忽略 initial_prompt，静默丢上下文）。Task 12 测试钉住。

---

## 批次 1a

### Task 1: `fuzzy_index` —— 目录遍历 + vault 遍历 + 快照类型 + `IndexSlot`

**Files:**
- Create: `src/fuzzy_index.rs`
- Modify: `src/main.rs:1-21`（mod 声明，在 `mod events;` 后加 `mod fuzzy_index;`）
- Modify: `src/web.rs`（把 `VaultIndex` 与 `resolve_wikilink` 的可见性保持 `pub(crate)`；新增 `pub(crate) fn vault_index_from_paths`，见 Step 3）
- Test: `src/fuzzy_index.rs` 内 `#[cfg(test)] mod tests`

**Interfaces:**
- Consumes: `crate::web::VaultIndex { by_basename, all_paths, by_basename_lc }`（`web.rs:3408`）
- Produces:
  ```rust
  pub enum EntryKind { Dir, VaultDir, VaultNote }
  pub struct IndexEntry { pub path: String, pub kind: EntryKind, pub haystack: String, pub basename_off: usize, pub mtime_ms: i64, pub is_empty_dir: bool }
  pub struct PathIndex { pub entries: Vec<IndexEntry>, pub truncated: bool }
  pub struct DirSnapshot { pub index: PathIndex, pub built_at_ms: i64 }
  pub struct VaultSnapshot { pub index: PathIndex, pub wiki: crate::web::VaultIndex, pub built_at_ms: i64 }
  pub fn scan_dirs(home: &Path, max_depth: usize, max_entries: usize) -> PathIndex
  pub struct VaultModel { /* dirs: BTreeMap<String, DirNode> */ }
  impl VaultModel {
      pub fn full_scan(root: &Path) -> std::io::Result<VaultModel>      // Err iff root read_dir fails
      /// `on_dir(rel)` is called BEFORE each directory is read (1b attaches an inotify watch there).
      pub fn full_scan_with(root: &Path, on_dir: &mut dyn FnMut(&str)) -> std::io::Result<VaultModel>
      /// Re-read `rel_dir`; NEW child dirs are scanned fully, KNOWN child dirs are re-reconciled
      /// only `known_depth` levels deep (1a turn-end hook: 3; 1b watcher: 0).
      pub fn reconcile_dir(&mut self, root: &Path, rel_dir: &str, known_depth: usize)
      pub fn reconcile_dir_with(&mut self, root: &Path, rel_dir: &str, known_depth: usize, on_dir: &mut dyn FnMut(&str))
      pub fn snapshot(&self, now_ms: i64) -> VaultSnapshot
  }
  pub struct IndexSlot<T> { .. }
  impl<T> IndexSlot<T> {
      pub fn new() -> Self
      pub fn current(&self) -> Option<Arc<T>>
      pub fn publish(&self, snap: T)
      pub fn try_begin_rebuild(&self) -> Option<RebuildGuard<'_, T>> // CAS false→true; guard resets on Drop
      pub fn is_rebuilding(&self) -> bool
  }
  pub const DIR_MAX_DEPTH: usize = 6;
  pub const DIR_MAX_ENTRIES: usize = 5000;
  pub fn now_ms() -> i64
  ```

- [ ] **Step 1: Write the failing tests**

在新文件 `src/fuzzy_index.rs` 末尾写测试模块（先写整个文件骨架：只有 `#[cfg(test)] mod tests`，其余 Step 3 补）：

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::symlink;

    fn tmp(tag: &str) -> tempfile::TempDir {
        tempfile::Builder::new().prefix(&format!("zmx_fz_{tag}_")).tempdir().unwrap()
    }
    fn paths(ix: &PathIndex) -> Vec<String> {
        let mut v: Vec<String> = ix.entries.iter().map(|e| e.path.clone()).collect();
        v.sort();
        v
    }

    #[test]
    fn scan_dirs_skips_dot_noise_symlink_and_respects_depth() {
        let d = tmp("dirs");
        let h = d.path();
        for p in ["a/b/c/d", ".hidden/x", "node_modules/x", "target/x", "__pycache__/x", "proj/src"] {
            fs::create_dir_all(h.join(p)).unwrap();
        }
        symlink(h.join("proj"), h.join("link")).unwrap();
        let ix = scan_dirs(h, 3, 5000);
        let got = paths(&ix);
        let hs = h.to_string_lossy().to_string();
        let want: Vec<String> = ["a", "a/b", "a/b/c", "proj", "proj/src"]
            .iter().map(|p| format!("{hs}/{p}")).collect();
        assert_eq!(got, want, "depth 3 stops before a/b/c/d; dot/noise/symlink skipped");
        assert!(!ix.truncated);
        assert!(ix.entries.iter().all(|e| matches!(e.kind, EntryKind::Dir)));
    }

    #[test]
    fn scan_dirs_bfs_truncation_drops_deepest_first() {
        let d = tmp("trunc");
        let h = d.path();
        for p in ["a/deep/deeper", "b", "c"] {
            fs::create_dir_all(h.join(p)).unwrap();
        }
        let ix = scan_dirs(h, 6, 4);
        let hs = h.to_string_lossy().to_string();
        assert!(ix.truncated);
        let got = paths(&ix);
        assert_eq!(got.len(), 4);
        assert!(!got.contains(&format!("{hs}/a/deep/deeper")), "BFS truncates deepest level: {got:?}");
    }

    #[test]
    fn scan_dirs_haystack_is_tilde_abbreviated_with_basename_offset() {
        let d = tmp("hay");
        let h = d.path();
        fs::create_dir_all(h.join("s3/zeromux")).unwrap();
        let ix = scan_dirs(h, 6, 5000);
        let e = ix.entries.iter().find(|e| e.path.ends_with("/zeromux")).unwrap();
        assert_eq!(e.haystack, "~/s3/zeromux");
        assert_eq!(&e.haystack[e.basename_off..], "zeromux");
    }

    #[test]
    fn vault_full_scan_collects_notes_note_dirs_and_empty_dirs_only() {
        let d = tmp("vault");
        let v = d.path();
        fs::create_dir_all(v.join("notes/sub")).unwrap();
        fs::write(v.join("notes/sub/A.md"), "x").unwrap();
        fs::write(v.join("notes/Weird.Md"), "x").unwrap();
        fs::create_dir_all(v.join("empty")).unwrap();
        fs::create_dir_all(v.join("code/pkg")).unwrap();
        fs::write(v.join("code/pkg/m.py"), "x").unwrap();
        fs::create_dir_all(v.join("assets")).unwrap();
        fs::write(v.join("assets/p.png"), "x").unwrap();
        fs::create_dir_all(v.join(".obsidian")).unwrap();
        fs::write(v.join(".obsidian/w.md"), "x").unwrap();
        fs::create_dir_all(v.join("__pycache__")).unwrap();
        symlink(v.join("notes"), v.join("loop")).unwrap();
        let m = VaultModel::full_scan(v).unwrap();
        let s = m.snapshot(1);
        let mut got: Vec<(String, &'static str)> = s.index.entries.iter().map(|e| (e.path.clone(), match e.kind {
            EntryKind::VaultNote => "note", EntryKind::VaultDir => "dir", EntryKind::Dir => "x" })).collect();
        got.sort();
        assert_eq!(got, vec![
            ("empty".into(), "dir"),
            ("notes".into(), "dir"),
            ("notes/Weird.Md".into(), "note"),
            ("notes/sub".into(), "dir"),
            ("notes/sub/A.md".into(), "note"),
        ]);
        let e = s.index.entries.iter().find(|e| e.path == "empty").unwrap();
        assert!(e.is_empty_dir);
        let n = s.index.entries.iter().find(|e| e.path == "notes/sub/A.md").unwrap();
        assert_eq!(n.haystack, "notes/sub/A", "note haystack drops .md");
        assert!(n.mtime_ms > 0);
    }

    #[test]
    fn vault_snapshot_wiki_index_matches_legacy_semantics() {
        let d = tmp("wiki");
        let v = d.path();
        fs::create_dir_all(v.join("a")).unwrap();
        fs::create_dir_all(v.join("b")).unwrap();
        fs::write(v.join("a/README.md"), "x").unwrap();
        fs::write(v.join("b/README.md"), "y").unwrap();
        fs::write(v.join("Weird.Md"), "z").unwrap();
        let s = VaultModel::full_scan(v).unwrap().snapshot(1);
        let mut all = s.wiki.all_paths.clone();
        all.sort();
        assert_eq!(all, vec!["Weird.Md", "a/README.md", "b/README.md"]);
        assert_eq!(crate::web::resolve_wikilink(&s.wiki, "weird").as_deref(), Some("Weird.Md"));
        assert_eq!(crate::web::resolve_wikilink(&s.wiki, "b/README").as_deref(), Some("b/README.md"));
    }

    #[test]
    fn vault_full_scan_errors_when_root_unreadable() {
        let d = tmp("gone");
        let gone = d.path().join("nope");
        assert!(VaultModel::full_scan(&gone).is_err(), "must not build an empty index for a missing root");
    }

    #[test]
    fn reconcile_dir_picks_up_new_note_folder_and_removals() {
        let d = tmp("rec");
        let v = d.path();
        fs::create_dir_all(v.join("单词")).unwrap();
        fs::write(v.join("单词/2026-09-24-上午.md"), "x").unwrap();
        let mut m = VaultModel::full_scan(v).unwrap();
        // agent writes a new note and a new nested folder with a note
        fs::write(v.join("单词/2026-09-25-上午.md"), "x").unwrap();
        fs::create_dir_all(v.join("单词/复习/第一轮")).unwrap();
        fs::write(v.join("单词/复习/第一轮/r.md"), "x").unwrap();
        fs::remove_file(v.join("单词/2026-09-24-上午.md")).unwrap();
        m.reconcile_dir(v, "单词", 3);
        let got = paths(&m.snapshot(2).index);
        assert!(got.contains(&"单词/2026-09-25-上午.md".to_string()));
        assert!(got.contains(&"单词/复习/第一轮/r.md".to_string()));
        assert!(got.contains(&"单词/复习/第一轮".to_string()));
        assert!(!got.contains(&"单词/2026-09-24-上午.md".to_string()));
    }

    #[test]
    fn reconcile_dir_known_depth_zero_does_not_rescan_known_children() {
        let d = tmp("recd0");
        let v = d.path();
        fs::create_dir_all(v.join("p/known")).unwrap();
        let mut m = VaultModel::full_scan(v).unwrap();
        fs::write(v.join("p/known/late.md"), "x").unwrap(); // change inside a KNOWN child
        fs::create_dir_all(v.join("p/brandnew")).unwrap();
        fs::write(v.join("p/brandnew/n.md"), "x").unwrap();
        let mut visited = Vec::new();
        m.reconcile_dir_with(v, "p", 0, &mut |r| visited.push(r.to_string()));
        let got = paths(&m.snapshot(2).index);
        assert!(got.contains(&"p/brandnew/n.md".to_string()), "new child dir is scanned fully");
        assert!(!got.contains(&"p/known/late.md".to_string()), "known child not rescanned at depth 0");
        assert_eq!(visited, vec!["p/brandnew".to_string()], "on_dir only for newly discovered dirs");
    }

    #[test]
    fn full_scan_with_calls_on_dir_before_every_dir() {
        let d = tmp("ondir");
        let v = d.path();
        fs::create_dir_all(v.join("a/b")).unwrap();
        let mut seen = Vec::new();
        VaultModel::full_scan_with(v, &mut |r| seen.push(r.to_string())).unwrap();
        seen.sort();
        assert_eq!(seen, vec!["".to_string(), "a".to_string(), "a/b".to_string()]);
    }

    #[test]
    fn reconcile_dir_of_deleted_dir_removes_subtree() {
        let d = tmp("recdel");
        let v = d.path();
        fs::create_dir_all(v.join("x/y")).unwrap();
        fs::write(v.join("x/y/n.md"), "x").unwrap();
        let mut m = VaultModel::full_scan(v).unwrap();
        fs::remove_dir_all(v.join("x")).unwrap();
        m.reconcile_dir(v, "x", 3);
        let got = paths(&m.snapshot(2).index);
        assert!(got.iter().all(|p| !p.starts_with("x")), "{got:?}");
    }

    #[test]
    fn folder_mtime_is_newest_descendant_note() {
        let d = tmp("mt");
        let v = d.path();
        fs::create_dir_all(v.join("f")).unwrap();
        fs::write(v.join("f/old.md"), "x").unwrap();
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(86_400);
        let f = fs::File::options().write(true).open(v.join("f/old.md")).unwrap();
        f.set_modified(old).unwrap();
        fs::write(v.join("f/new.md"), "x").unwrap();
        let s = VaultModel::full_scan(v).unwrap().snapshot(1);
        let folder = s.index.entries.iter().find(|e| e.path == "f").unwrap();
        let newn = s.index.entries.iter().find(|e| e.path == "f/new.md").unwrap();
        assert_eq!(folder.mtime_ms, newn.mtime_ms);
    }

    #[test]
    fn index_slot_cas_and_guard_reset_on_panic() {
        let slot: IndexSlot<u32> = IndexSlot::new();
        assert!(slot.current().is_none());
        {
            let g = slot.try_begin_rebuild().expect("first CAS wins");
            assert!(slot.try_begin_rebuild().is_none(), "second concurrent CAS loses");
            drop(g);
        }
        assert!(!slot.is_rebuilding());
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _g = slot.try_begin_rebuild().unwrap();
            panic!("builder blew up");
        }));
        assert!(r.is_err());
        assert!(!slot.is_rebuilding(), "Drop guard must reset rebuilding even on panic");
        slot.publish(7);
        assert_eq!(*slot.current().unwrap(), 7);
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

在 `src/main.rs` 的 mod 区加 `mod fuzzy_index;`（`mod events;` 之后），然后：

Run: `cargo test fuzzy_index 2>&1 | tail -20`
Expected: 编译失败（`cannot find function scan_dirs`、`VaultModel` 等未定义）。

- [ ] **Step 3: Implement**

在 `src/web.rs` 紧挨 `pub(crate) fn build_vault_index` 之前加一个由路径列表构建 `VaultIndex` 的函数（复用既有的 basename 规则，保证 wikilink 语义不变）：

```rust
/// Build the wikilink index from a list of vault-relative `.md` paths, in the given
/// order (first-seen wins on basename collision — same rule as the walk below).
/// Used by `fuzzy_index::VaultModel::snapshot`, which owns the vault walk now.
pub(crate) fn vault_index_from_paths(paths: Vec<String>) -> VaultIndex {
    let mut by_basename = std::collections::HashMap::new();
    let mut by_basename_lc = std::collections::HashMap::new();
    for rel in &paths {
        let name = rel.rsplit('/').next().unwrap_or(rel);
        // Caller guarantees a case-insensitive ".md" suffix (3 ASCII bytes).
        let base = name[..name.len() - 3].to_string();
        by_basename_lc.entry(base.to_ascii_lowercase()).or_insert_with(|| rel.clone());
        by_basename.entry(base).or_insert_with(|| rel.clone());
    }
    VaultIndex { by_basename, all_paths: paths, by_basename_lc }
}
```

然后写 `src/fuzzy_index.rs` 的实现部分（放在测试模块之前）：

```rust
//! In-memory path indexes for fuzzy search: `$HOME` directories (polled) and the
//! Obsidian vault (notes + note folders). Each index lives in an `IndexSlot` —
//! a stale-while-revalidate cell: readers take an `Arc` snapshot, a rebuild runs
//! off-thread and swaps the whole snapshot in atomically.
//!
//! Walk rules deliberately mirror `web::list_directories` / the old
//! `build_vault_index`: `file_type()` never follows symlinks (cycle / escape
//! guard), dot-prefixed names and a small noise list are skipped. Guards are
//! LEXICAL only — no canonicalize, which costs ~10ms per call on JuiceFS.

use std::collections::{BTreeMap, VecDeque};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};

pub const DIR_MAX_DEPTH: usize = 6;
pub const DIR_MAX_ENTRIES: usize = 5000;
const NOISE: &[&str] = &["node_modules", "target", "__pycache__"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EntryKind { Dir, VaultDir, VaultNote }

#[derive(Clone, Debug)]
pub struct IndexEntry {
    /// Dir: absolute path. Vault*: vault-relative path (notes keep their `.md`).
    pub path: String,
    pub kind: EntryKind,
    /// String fed to the matcher: `~`-abbreviated path for Dir; vault-relative path
    /// with `.md` dropped for notes.
    pub haystack: String,
    /// Byte offset of the basename inside `haystack` (for basename weighting).
    pub basename_off: usize,
    /// Notes: own mtime. VaultDir: newest descendant note mtime. Dir: 0.
    pub mtime_ms: i64,
    /// VaultDir with no non-dot children (sorts after non-empty on ties).
    pub is_empty_dir: bool,
}

#[derive(Default)]
pub struct PathIndex { pub entries: Vec<IndexEntry>, pub truncated: bool }

pub struct DirSnapshot { pub index: PathIndex, pub built_at_ms: i64 }
pub struct VaultSnapshot { pub index: PathIndex, pub wiki: crate::web::VaultIndex, pub built_at_ms: i64 }

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn skip_name(name: &str) -> bool {
    name.starts_with('.') || NOISE.contains(&name)
}

fn basename_off(s: &str) -> usize {
    s.rfind('/').map(|i| i + 1).unwrap_or(0)
}

/// BFS over `$HOME` subdirectories. Truncation keeps shallow levels (drops deepest).
pub fn scan_dirs(home: &Path, max_depth: usize, max_entries: usize) -> PathIndex {
    let home_s = home.to_string_lossy().to_string();
    let mut out = PathIndex::default();
    let mut q: VecDeque<(std::path::PathBuf, usize)> = VecDeque::new();
    q.push_back((home.to_path_buf(), 0));
    while let Some((dir, depth)) = q.pop_front() {
        if depth >= max_depth { continue; }
        let rd = match std::fs::read_dir(&dir) { Ok(r) => r, Err(_) => continue };
        let mut children: Vec<std::path::PathBuf> = Vec::new();
        for ent in rd.flatten() {
            let ft = match ent.file_type() { Ok(t) => t, Err(_) => continue };
            if !ft.is_dir() { continue; } // symlinks report is_symlink(), not is_dir()
            let name = ent.file_name().to_string_lossy().to_string();
            if skip_name(&name) { continue; }
            children.push(ent.path());
        }
        children.sort();
        for p in children {
            if out.entries.len() >= max_entries { out.truncated = true; return out; }
            let abs = p.to_string_lossy().to_string();
            let rel = abs.strip_prefix(&home_s).unwrap_or(&abs).trim_start_matches('/');
            let haystack = format!("~/{rel}");
            out.entries.push(IndexEntry {
                basename_off: basename_off(&haystack),
                path: abs, kind: EntryKind::Dir, haystack, mtime_ms: 0, is_empty_dir: false,
            });
            q.push_back((p, depth + 1));
        }
    }
    out
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Child { Dir, Md(i64), Other }

#[derive(Default, Clone)]
struct DirNode { children: BTreeMap<String, Child> }

/// Mutable model of the vault tree (dirs and their admissible children). The
/// single source for snapshots; 1b's watcher mutates it via `reconcile_dir`.
#[derive(Default)]
pub struct VaultModel { dirs: BTreeMap<String, DirNode> }

fn join_rel(parent: &str, name: &str) -> String {
    if parent.is_empty() { name.to_string() } else { format!("{parent}/{name}") }
}

fn mtime_ms_of(md: &std::fs::Metadata) -> i64 {
    md.modified().ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl VaultModel {
    /// Read one directory into a DirNode. Err = the directory itself is unreadable.
    fn read_node(root: &Path, rel: &str) -> std::io::Result<DirNode> {
        let abs = if rel.is_empty() { root.to_path_buf() } else { root.join(rel) };
        let mut node = DirNode::default();
        for ent in std::fs::read_dir(&abs)?.flatten() {
            let name = ent.file_name().to_string_lossy().to_string();
            if skip_name(&name) { continue; }
            let ft = match ent.file_type() { Ok(t) => t, Err(_) => continue };
            if ft.is_symlink() { continue; }
            if ft.is_dir() {
                node.children.insert(name, Child::Dir);
            } else if name.to_ascii_lowercase().ends_with(".md") {
                let m = ent.metadata().map(|m| mtime_ms_of(&m)).unwrap_or(0);
                node.children.insert(name, Child::Md(m));
            } else {
                node.children.insert(name, Child::Other);
            }
        }
        Ok(node)
    }

    /// Walk `rel` and every descendant dir (up to `max_depth` levels below `rel`),
    /// inserting nodes. `on_dir` runs before each read (watch-then-read ordering:
    /// anything created after the watch lands is reported as an event, anything
    /// before it is seen by the read — no gap). Unreadable dirs drop out.
    fn scan_subtree_with(&mut self, root: &Path, rel: &str, max_depth: usize, on_dir: &mut dyn FnMut(&str)) {
        let mut q: VecDeque<(String, usize)> = VecDeque::new();
        q.push_back((rel.to_string(), 0));
        while let Some((d, depth)) = q.pop_front() {
            on_dir(&d);
            let node = match Self::read_node(root, &d) { Ok(n) => n, Err(_) => { self.remove_subtree(&d); continue } };
            if depth < max_depth {
                for (name, c) in &node.children {
                    if *c == Child::Dir { q.push_back((join_rel(&d, name), depth + 1)); }
                }
            }
            self.dirs.insert(d, node);
        }
    }

    fn remove_subtree(&mut self, rel: &str) {
        let prefix = format!("{rel}/");
        self.dirs.retain(|k, _| k != rel && !k.starts_with(&prefix));
    }

    /// Full walk. Fails iff the ROOT can't be read — a missing/unmounted vault must
    /// never "succeed" as an empty index (the caller keeps the old snapshot).
    pub fn full_scan(root: &Path) -> std::io::Result<VaultModel> {
        Self::full_scan_with(root, &mut |_| {})
    }

    pub fn full_scan_with(root: &Path, on_dir: &mut dyn FnMut(&str)) -> std::io::Result<VaultModel> {
        Self::read_node(root, "")?;
        let mut m = VaultModel::default();
        m.scan_subtree_with(root, "", usize::MAX, on_dir);
        Ok(m)
    }

    pub fn reconcile_dir(&mut self, root: &Path, rel_dir: &str, known_depth: usize) {
        self.reconcile_dir_with(root, rel_dir, known_depth, &mut |_| {})
    }

    /// Re-read one directory and reconcile its children with the model. The end
    /// state is always whatever `read_dir` saw — no per-event bookkeeping to drift.
    /// - removed child dirs drop their whole subtree;
    /// - NEW child dirs (not in the model before) are scanned fully (`on_dir` first);
    /// - KNOWN child dirs are re-reconciled only `known_depth` more levels.
    pub fn reconcile_dir_with(&mut self, root: &Path, rel_dir: &str, known_depth: usize, on_dir: &mut dyn FnMut(&str)) {
        let fresh = match Self::read_node(root, rel_dir) {
            Ok(n) => n,
            Err(_) => { self.remove_subtree(rel_dir); return; }
        };
        let old = self.dirs.get(rel_dir).cloned().unwrap_or_default();
        for (name, c) in &old.children {
            if *c == Child::Dir && fresh.children.get(name) != Some(&Child::Dir) {
                self.remove_subtree(&join_rel(rel_dir, name));
            }
        }
        self.dirs.insert(rel_dir.to_string(), fresh.clone());
        for (name, c) in &fresh.children {
            if *c != Child::Dir { continue; }
            let child = join_rel(rel_dir, name);
            let known = old.children.get(name) == Some(&Child::Dir) && self.dirs.contains_key(&child);
            if !known {
                self.scan_subtree_with(root, &child, usize::MAX, on_dir);
            } else if known_depth > 0 {
                self.reconcile_dir_with(root, &child, known_depth - 1, on_dir);
            }
        }
        // Ensure ancestors list this dir (a folder reconciled directly must stay
        // reachable for snapshot()).
        let mut cur = rel_dir.to_string();
        while !cur.is_empty() {
            let (parent, name) = match cur.rfind('/') {
                Some(i) => (cur[..i].to_string(), cur[i + 1..].to_string()),
                None => (String::new(), cur.clone()),
            };
            self.dirs.entry(parent.clone()).or_default().children.entry(name).or_insert(Child::Dir);
            cur = parent;
        }
    }

    /// Build a snapshot: notes, admissible folders (subtree has a note, or empty),
    /// folder mtime = newest descendant note, plus the wikilink index.
    pub fn snapshot(&self, now_ms: i64) -> VaultSnapshot {
        // Bottom-up (deepest paths first): newest note mtime per dir, 0 = no note.
        let mut newest: BTreeMap<&str, i64> = BTreeMap::new();
        let mut keys: Vec<&String> = self.dirs.keys().collect();
        keys.sort_by_key(|k| std::cmp::Reverse(k.matches('/').count() + usize::from(!k.is_empty())));
        for k in &keys {
            let node = &self.dirs[*k];
            let mut best = 0i64;
            for (name, c) in &node.children {
                match c {
                    Child::Md(m) => best = best.max((*m).max(1)),
                    Child::Dir => {
                        let child = join_rel(k, name);
                        if let Some(v) = newest.get(child.as_str()) { best = best.max(*v); }
                    }
                    Child::Other => {}
                }
            }
            newest.insert(k.as_str(), best);
        }
        let mut entries = Vec::new();
        let mut note_paths = Vec::new();
        for (rel, node) in &self.dirs {
            if !rel.is_empty() {
                let has_note = newest.get(rel.as_str()).copied().unwrap_or(0) > 0;
                let empty = node.children.is_empty();
                if has_note || empty {
                    entries.push(IndexEntry {
                        path: rel.clone(), kind: EntryKind::VaultDir, haystack: rel.clone(),
                        basename_off: basename_off(rel),
                        mtime_ms: newest.get(rel.as_str()).copied().unwrap_or(0),
                        is_empty_dir: empty,
                    });
                }
            }
            for (name, c) in &node.children {
                if let Child::Md(m) = c {
                    let p = join_rel(rel, name);
                    let hay = p[..p.len() - 3].to_string();
                    entries.push(IndexEntry {
                        basename_off: basename_off(&hay), haystack: hay,
                        path: p.clone(), kind: EntryKind::VaultNote, mtime_ms: *m, is_empty_dir: false,
                    });
                    note_paths.push(p);
                }
            }
        }
        VaultSnapshot {
            index: PathIndex { entries, truncated: false },
            wiki: crate::web::vault_index_from_paths(note_paths),
            built_at_ms: now_ms,
        }
    }
}

/// Stale-while-revalidate cell. `rebuilding` is claimed by CAS and released by the
/// guard's Drop — so a panicking builder can't wedge the slot "rebuilding" forever.
pub struct IndexSlot<T> { cur: RwLock<Option<Arc<T>>>, rebuilding: AtomicBool }

pub struct RebuildGuard<'a, T> { slot: &'a IndexSlot<T> }
impl<T> Drop for RebuildGuard<'_, T> {
    fn drop(&mut self) { self.slot.rebuilding.store(false, Ordering::Release); }
}

impl<T> Default for IndexSlot<T> { fn default() -> Self { Self::new() } }

impl<T> IndexSlot<T> {
    pub fn new() -> Self { Self { cur: RwLock::new(None), rebuilding: AtomicBool::new(false) } }
    pub fn current(&self) -> Option<Arc<T>> { self.cur.read().unwrap().clone() }
    pub fn publish(&self, snap: T) { *self.cur.write().unwrap() = Some(Arc::new(snap)); }
    pub fn is_rebuilding(&self) -> bool { self.rebuilding.load(Ordering::Acquire) }
    pub fn try_begin_rebuild(&self) -> Option<RebuildGuard<'_, T>> {
        self.rebuilding
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| RebuildGuard { slot: self })
    }
}
```

> 注：`RebuildGuard` 借用 slot，而 1a 的重建在 `spawn_blocking` 里跑（需要 `'static`）。Task 3 用 `Arc<IndexSlot<T>>` + 一个拥有 `Arc` 的 `OwnedRebuildGuard` 解决，Task 1 只需上面这个借用版本通过单测。

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test fuzzy_index 2>&1 | tail -20`
Expected: `test result: ok. 12 passed`（本模块 12 个测试）。

- [ ] **Step 5: Commit**

```bash
git add src/fuzzy_index.rs src/main.rs src/web.rs
git commit -m "feat(search): fuzzy_index 目录/vault 遍历模型 + IndexSlot

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: 匹配器（nucleo + basename 加权 + frecency + 同分规则）

**Files:**
- Modify: `Cargo.toml`（`[dependencies]` 加 `nucleo-matcher = "0.3"`）
- Modify: `src/fuzzy_index.rs`（新增 `search` 与相关类型）
- Test: `src/fuzzy_index.rs` tests 模块追加

**Interfaces:**
- Consumes: Task 1 `PathIndex`, `IndexEntry`, `EntryKind`
- Produces:
  ```rust
  pub struct Hit<'a> { pub entry: &'a IndexEntry, pub score: u32 }
  /// `bonus_for(path) -> 0..=12` supplies the frecency bonus (Task 5 builds it).
  pub fn search<'a>(ix: &'a PathIndex, q: &str, limit: usize, bonus_for: &dyn Fn(&str) -> u32) -> Vec<Hit<'a>>
  pub fn frecency_bonus(sum_decayed: f64) -> u32   // floor(12·s/(s+1))
  pub const BASENAME_BONUS: u32 = 20;
  ```

- [ ] **Step 1: Write the failing tests**

追加到 `mod tests`：

```rust
    fn ix_of(items: &[(&str, EntryKind, i64, bool)]) -> PathIndex {
        PathIndex {
            truncated: false,
            entries: items.iter().map(|(h, k, m, empty)| IndexEntry {
                path: h.to_string(), kind: *k, haystack: h.to_string(),
                basename_off: basename_off(h), mtime_ms: *m, is_empty_dir: *empty,
            }).collect(),
        }
    }
    fn top(ix: &PathIndex, q: &str) -> Vec<String> {
        search(ix, q, 10, &|_| 0).into_iter().map(|h| h.entry.path.clone()).collect()
    }

    #[test]
    fn search_subsequence_and_basename_weighting() {
        let ix = ix_of(&[
            ("~/s3/ai/zeromux/docs", EntryKind::Dir, 0, false),
            ("~/s3/ai/zeromux", EntryKind::Dir, 0, false),
            ("~/s3/keith-space/github-search/ai", EntryKind::Dir, 0, false),
        ]);
        assert_eq!(top(&ix, "zmx")[0], "~/s3/ai/zeromux", "repo itself beats its subdir");
        assert_eq!(top(&ix, "gsai")[0], "~/s3/keith-space/github-search/ai");
    }

    #[test]
    fn search_chinese_substring() {
        let ix = ix_of(&[("projects/long-term/考研英语/_index", EntryKind::VaultNote, 1, false)]);
        assert_eq!(top(&ix, "考研").len(), 1);
    }

    #[test]
    fn search_negative_only_or_meta_only_query_returns_nothing() {
        let ix = ix_of(&[("~/a", EntryKind::Dir, 0, false), ("~/b", EntryKind::Dir, 0, false)]);
        for q in ["!docs", "'", "^", "$", "   ", ""] {
            assert!(top(&ix, q).is_empty(), "query {q:?} must not return arbitrary rows");
        }
        // a positive atom plus a negation still works
        assert_eq!(top(&ix, "a !b"), vec!["~/a"]);
    }

    #[test]
    fn search_ties_prefer_nonempty_then_newest_mtime() {
        let ix = ix_of(&[
            ("考研英语/2007/英语二/阅读理解", EntryKind::VaultDir, 0, true),
            ("考研英语/2019/英语二/阅读理解", EntryKind::VaultDir, 500, false),
            ("考研英语/单词/2026-09-24-上午", EntryKind::VaultNote, 100, false),
            ("考研英语/单词/2026-09-25-上午", EntryKind::VaultNote, 200, false),
        ]);
        let r = top(&ix, "阅读理解");
        assert_eq!(r[0], "考研英语/2019/英语二/阅读理解", "empty skeleton sorts after non-empty: {r:?}");
        let r2 = top(&ix, "单词");
        assert_eq!(r2[0], "考研英语/单词/2026-09-25-上午", "newest note first among ties: {r2:?}");
    }

    #[test]
    fn frecency_bonus_is_capped_below_one_char_gap() {
        assert_eq!(frecency_bonus(0.0), 0);
        assert!(frecency_bonus(1.0) <= 12);
        assert_eq!(frecency_bonus(1e9), 11, "floor(12·s/(s+1)) never reaches 12");
        // bonus breaks a tie …
        let ix = ix_of(&[("~/p/alpha", EntryKind::Dir, 0, false), ("~/q/alpha", EntryKind::Dir, 0, false)]);
        let r: Vec<String> = search(&ix, "alpha", 10, &|p| if p == "~/q/alpha" { 5 } else { 0 })
            .into_iter().map(|h| h.entry.path.clone()).collect();
        assert_eq!(r[0], "~/q/alpha");
        // … but never beats a strictly better text match (exact basename vs. scattered)
        let ix2 = ix_of(&[("~/x/zeromux", EntryKind::Dir, 0, false), ("~/y/zexromxux", EntryKind::Dir, 0, false)]);
        let r2: Vec<String> = search(&ix2, "zeromux", 10, &|p| if p == "~/y/zexromxux" { 11 } else { 0 })
            .into_iter().map(|h| h.entry.path.clone()).collect();
        assert_eq!(r2[0], "~/x/zeromux");
    }

    #[test]
    fn search_respects_limit() {
        let items: Vec<(String, EntryKind, i64, bool)> =
            (0..30).map(|i| (format!("~/d{i}/note"), EntryKind::Dir, 0, false)).collect();
        let refs: Vec<(&str, EntryKind, i64, bool)> = items.iter().map(|(a, b, c, d)| (a.as_str(), *b, *c, *d)).collect();
        assert_eq!(search(&ix_of(&refs), "note", 6, &|_| 0).len(), 6);
    }
```

> `ix_of` 里用 `path == haystack` 只为测试简便；`bonus_for` 以 `entry.path` 为键（Task 5 用绝对路径 / vault 相对路径查 frecency）。

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test fuzzy_index::tests::search 2>&1 | tail -15`
Expected: 编译失败（`search` / `frecency_bonus` 未定义）。

- [ ] **Step 3: Implement**

`Cargo.toml` `[dependencies]` 末尾（`p256` 行后）加：

```toml
# Fuzzy path matching for /api/search (fzf-style, Helix's matcher). Pure Rust.
nucleo-matcher = "0.3"
```

`src/fuzzy_index.rs` 在 `IndexSlot` 之前加：

```rust
use nucleo_matcher::pattern::{CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config, Matcher, Utf32Str};

/// Added to the basename-only score so `…/zeromux` outranks `…/zeromux/docs`
/// (nucleo scores both full paths identically for `zmx`/`zeromux` — measured).
pub const BASENAME_BONUS: u32 = 20;

pub struct Hit<'a> { pub entry: &'a IndexEntry, pub score: u32 }

/// Frecency bonus from the summed decayed score: floor(12·s/(s+1)) ∈ [0, 11].
/// Capped below nucleo's per-char SCORE_MATCH (16) so history breaks ties but
/// never beats a strictly better text match.
pub fn frecency_bonus(sum_decayed: f64) -> u32 {
    if !(sum_decayed > 0.0) { return 0; }
    (12.0 * sum_decayed / (sum_decayed + 1.0)).floor() as u32
}

pub fn search<'a>(ix: &'a PathIndex, q: &str, limit: usize, bonus_for: &dyn Fn(&str) -> u32) -> Vec<Hit<'a>> {
    let pattern = Pattern::parse(q, CaseMatching::Smart, Normalization::Smart);
    // A pattern with no positive atom (empty, whitespace, bare `'`/`^`/`$`, or only
    // negations like `!docs`) scores EVERY haystack Some(0) — refuse it outright.
    if !pattern.atoms.iter().any(|a| !a.negative) {
        return Vec::new();
    }
    let mut matcher = Matcher::new(Config::DEFAULT.match_paths());
    let mut buf = Vec::new();
    let mut hits: Vec<Hit<'a>> = Vec::new();
    for e in &ix.entries {
        let full = match pattern.score(Utf32Str::new(&e.haystack, &mut buf), &mut matcher) {
            Some(s) if s > 0 => s,
            _ => continue,
        };
        let base = pattern
            .score(Utf32Str::new(&e.haystack[e.basename_off..], &mut buf), &mut matcher)
            .map(|s| s + BASENAME_BONUS)
            .unwrap_or(0);
        let bonus = match e.kind { EntryKind::VaultDir => 0, _ => bonus_for(&e.path) };
        hits.push(Hit { entry: e, score: full.max(base) + bonus });
    }
    hits.sort_by(|a, b| {
        b.score.cmp(&a.score)
            .then(a.entry.is_empty_dir.cmp(&b.entry.is_empty_dir))
            .then(b.entry.mtime_ms.cmp(&a.entry.mtime_ms))
            .then(a.entry.haystack.len().cmp(&b.entry.haystack.len()))
            .then(a.entry.path.cmp(&b.entry.path))
    });
    hits.truncate(limit);
    hits
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test fuzzy_index 2>&1 | tail -5`
Expected: `test result: ok. 18 passed`

- [ ] **Step 5: Commit**

```bash
git add Cargo.toml Cargo.lock src/fuzzy_index.rs
git commit -m "feat(search): nucleo 匹配 + basename 加权 + frecency 上限 + 同分规则

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `SearchIndexes` 运行时（异步首建 / SWR 刷新 / reconcile 投递）+ 接入 `AppState`

**Files:**
- Modify: `src/fuzzy_index.rs`（新增 `SearchIndexes`）
- Modify: `src/main.rs:204`（`AppState.vault_index` → `search: Arc<fuzzy_index::SearchIndexes>`）、`src/main.rs:434-436`（删同步 `build_vault_index`，改为 `SearchIndexes::start`）、`src/main.rs:496`
- Modify: `src/web.rs:3799-3811`（`vault_resolve` 改读 vault 快照，首建中 503）
- Modify: `src/web.rs:3471-3519`（删除 `build_vault_index`；其 4 个测试 `build_vault_index_*` 与 `wikilink_idx()` 改用 `VaultModel::full_scan(..).unwrap().snapshot(0).wiki`）
- Test: `src/fuzzy_index.rs` tests

**Interfaces:**
- Consumes: Task 1 `IndexSlot`, `VaultModel`, `scan_dirs`, `DirSnapshot`, `VaultSnapshot`
- Produces:
  ```rust
  pub struct SearchIndexes {
      pub dirs: Arc<IndexSlot<DirSnapshot>>,
      pub vault: Option<Arc<IndexSlot<VaultSnapshot>>>,
      home: PathBuf, vault_root: Option<PathBuf>,
      vault_model: Option<Arc<Mutex<VaultModel>>>,   // single writer: rebuilds & reconciles take this lock
  }
  impl SearchIndexes {
      pub fn start(home: PathBuf, vault_root: Option<PathBuf>) -> Arc<Self>   // kicks off both initial builds in spawn_blocking; never blocks
      pub fn refresh_dirs_if_older(self: &Arc<Self>, max_age_ms: i64)
      pub fn refresh_vault_if_older(self: &Arc<Self>, max_age_ms: i64)
      pub fn reconcile_vault_dir(self: &Arc<Self>, abs_dir: &Path)           // no-op if outside vault / no vault
      pub fn vault_rel(&self, abs: &Path) -> Option<String>                    // lexical strip_prefix
      pub fn vault_root(&self) -> Option<&Path>
  }
  pub const DIR_TTL_MS: i64 = 120_000;
  pub const ZERO_HIT_MIN_AGE_MS: i64 = 30_000;
  pub const WARM_MIN_AGE_MS: i64 = 30_000;
  pub const RECONCILE_DEPTH: usize = 3;
  ```

- [ ] **Step 1: Write the failing tests**

追加到 `mod tests`：

```rust
    async fn wait_until(mut f: impl FnMut() -> bool) {
        for _ in 0..200 {
            if f() { return; }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("condition not reached");
    }

    #[tokio::test]
    async fn search_indexes_start_is_async_and_publishes_both() {
        let h = tmp("si_home");
        let v = tmp("si_vault");
        fs::create_dir_all(h.path().join("proj")).unwrap();
        fs::write(v.path().join("n.md"), "x").unwrap();
        let si = SearchIndexes::start(h.path().into(), Some(v.path().into()));
        // initial state is "indexing": rebuilding claimed before the build runs
        wait_until(|| si.dirs.current().is_some() && si.vault.as_ref().unwrap().current().is_some()).await;
        assert!(!si.dirs.is_rebuilding());
        let vs = si.vault.as_ref().unwrap().current().unwrap();
        assert!(vs.index.entries.iter().any(|e| e.path == "n.md"));
    }

    #[tokio::test]
    async fn refresh_if_older_only_rebuilds_stale_snapshots() {
        let h = tmp("si_ref");
        let si = SearchIndexes::start(h.path().into(), None);
        wait_until(|| si.dirs.current().is_some() && !si.dirs.is_rebuilding()).await;
        let t0 = si.dirs.current().unwrap().built_at_ms;
        fs::create_dir_all(h.path().join("fresh-clone")).unwrap();
        si.refresh_dirs_if_older(60_000); // snapshot is ~0s old → no rebuild
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert_eq!(si.dirs.current().unwrap().built_at_ms, t0);
        si.refresh_dirs_if_older(0);      // any age qualifies → rebuild
        wait_until(|| si.dirs.current().unwrap().index.entries.iter().any(|e| e.path.ends_with("/fresh-clone"))).await;
    }

    #[tokio::test]
    async fn reconcile_vault_dir_updates_snapshot_and_ignores_outside_paths() {
        let h = tmp("si_rh");
        let v = tmp("si_rv");
        fs::create_dir_all(v.path().join("单词")).unwrap();
        let si = SearchIndexes::start(h.path().into(), Some(v.path().into()));
        let slot = si.vault.clone().unwrap();
        wait_until(|| slot.current().is_some() && !slot.is_rebuilding()).await;
        fs::write(v.path().join("单词/new.md"), "x").unwrap();
        si.reconcile_vault_dir(&v.path().join("单词"));
        wait_until(|| slot.current().unwrap().index.entries.iter().any(|e| e.path == "单词/new.md")).await;
        // outside the vault: no panic, no change
        si.reconcile_vault_dir(h.path());
        assert!(si.vault_rel(h.path()).is_none());
        assert_eq!(si.vault_rel(&v.path().join("单词")).as_deref(), Some("单词"));
        assert_eq!(si.vault_rel(v.path()).as_deref(), Some(""));
    }

    #[tokio::test]
    async fn vault_rebuild_failure_keeps_old_snapshot() {
        let h = tmp("si_fh");
        let v = tmp("si_fv");
        fs::write(v.path().join("keep.md"), "x").unwrap();
        let root = v.path().to_path_buf();
        let si = SearchIndexes::start(h.path().into(), Some(root.clone()));
        let slot = si.vault.clone().unwrap();
        wait_until(|| slot.current().is_some() && !slot.is_rebuilding()).await;
        drop(v); // vault root disappears (≈ JuiceFS unmounted)
        si.refresh_vault_if_older(0);
        wait_until(|| !slot.is_rebuilding()).await;
        assert!(slot.current().unwrap().index.entries.iter().any(|e| e.path == "keep.md"),
            "a failed rebuild must not publish an empty index");
    }
```

同时把 `web.rs` 里 4 个 `build_vault_index_*` 测试与 `wikilink_idx()` 的 `let idx = build_vault_index(&dir);` 全部替换为：

```rust
        let idx = crate::fuzzy_index::VaultModel::full_scan(&dir).unwrap().snapshot(0).wiki;
```

（行号：`web.rs:3881, 3894, 3910, 3929, 6154` —— 用 `grep -n "build_vault_index(&dir)" src/web.rs` 定位全部 5 处。）

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test fuzzy_index 2>&1 | tail -15`
Expected: 编译失败（`SearchIndexes` 未定义）。

- [ ] **Step 3: Implement**

`src/fuzzy_index.rs` 追加（在 `IndexSlot` 实现之后）：

```rust
use std::path::PathBuf;
use std::sync::Mutex;

pub const DIR_TTL_MS: i64 = 120_000;
pub const ZERO_HIT_MIN_AGE_MS: i64 = 30_000;
pub const WARM_MIN_AGE_MS: i64 = 30_000;
/// Depth below an agent's work_dir rescanned on turn end (study-note dirs are
/// leaves or shallow; deeper writes are caught by the next warm-up).
pub const RECONCILE_DEPTH: usize = 3;

/// Owned variant of RebuildGuard so a claimed rebuild can move into spawn_blocking.
struct OwnedGuard<T> { slot: Arc<IndexSlot<T>> }
impl<T> Drop for OwnedGuard<T> {
    fn drop(&mut self) { self.slot.rebuilding.store(false, Ordering::Release); }
}
fn claim<T>(slot: &Arc<IndexSlot<T>>) -> Option<OwnedGuard<T>> {
    slot.rebuilding
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .ok()
        .map(|_| OwnedGuard { slot: slot.clone() })
}

pub struct SearchIndexes {
    pub dirs: Arc<IndexSlot<DirSnapshot>>,
    pub vault: Option<Arc<IndexSlot<VaultSnapshot>>>,
    home: PathBuf,
    vault_root: Option<PathBuf>,
    /// The vault model is the single writable source for vault snapshots. Full
    /// rebuilds replace it and reconciles mutate it — both under this lock, inside
    /// spawn_blocking, so they serialize and never publish out of order.
    vault_model: Option<Arc<Mutex<VaultModel>>>,
}

impl SearchIndexes {
    /// Never blocks: both initial builds are claimed (rebuilding=true → searches
    /// report `indexing`) and then run in spawn_blocking. Must be called inside a
    /// tokio runtime.
    pub fn start(home: PathBuf, vault_root: Option<PathBuf>) -> Arc<Self> {
        let si = Arc::new(Self {
            dirs: Arc::new(IndexSlot::new()),
            vault: vault_root.as_ref().map(|_| Arc::new(IndexSlot::new())),
            vault_model: vault_root.as_ref().map(|_| Arc::new(Mutex::new(VaultModel::default()))),
            home,
            vault_root,
        });
        si.refresh_dirs_if_older(i64::MIN);
        si.refresh_vault_if_older(i64::MIN);
        si
    }

    fn age_ok<T>(slot: &IndexSlot<T>, built_at: impl Fn(&T) -> i64, max_age_ms: i64) -> bool {
        match slot.current() {
            None => true,
            Some(s) => now_ms() - built_at(&s) > max_age_ms,
        }
    }

    pub fn refresh_dirs_if_older(self: &Arc<Self>, max_age_ms: i64) {
        if !Self::age_ok(&self.dirs, |s| s.built_at_ms, max_age_ms) { return; }
        let Some(guard) = claim(&self.dirs) else { return };
        let home = self.home.clone();
        tokio::task::spawn_blocking(move || {
            let index = scan_dirs(&home, DIR_MAX_DEPTH, DIR_MAX_ENTRIES);
            guard.slot.publish(DirSnapshot { index, built_at_ms: now_ms() });
            drop(guard);
        });
    }

    pub fn refresh_vault_if_older(self: &Arc<Self>, max_age_ms: i64) {
        let (Some(slot), Some(model), Some(root)) = (&self.vault, &self.vault_model, &self.vault_root) else { return };
        if !Self::age_ok(slot, |s| s.built_at_ms, max_age_ms) { return; }
        let Some(guard) = claim(slot) else { return };
        let (model, root) = (model.clone(), root.clone());
        tokio::task::spawn_blocking(move || {
            match VaultModel::full_scan(&root) {
                Ok(fresh) => {
                    let mut m = model.lock().unwrap();
                    *m = fresh;
                    guard.slot.publish(m.snapshot(now_ms()));
                }
                Err(e) => eprintln!("[search] vault rebuild failed, keeping old snapshot: {e}"),
            }
            drop(guard);
        });
    }

    pub fn vault_root(&self) -> Option<&Path> { self.vault_root.as_deref() }

    /// Lexical vault-relative path of `abs` ("" = the root); None if outside the vault.
    pub fn vault_rel(&self, abs: &Path) -> Option<String> {
        let root = self.vault_root.as_ref()?;
        let rel = abs.strip_prefix(root).ok()?;
        let s = rel.to_string_lossy().to_string();
        if s.split('/').any(|seg| seg.starts_with('.') && !seg.is_empty()) { return None; }
        Some(s)
    }

    /// Rescan one vault directory (used by the agent turn-end hook). Skipped while
    /// no snapshot exists yet — the in-flight initial build will include the change.
    pub fn reconcile_vault_dir(self: &Arc<Self>, abs_dir: &Path) {
        let Some(rel) = self.vault_rel(abs_dir) else { return };
        let (Some(slot), Some(model), Some(root)) = (&self.vault, &self.vault_model, &self.vault_root) else { return };
        if slot.current().is_none() { return; }
        let (slot, model, root) = (slot.clone(), model.clone(), root.clone());
        tokio::task::spawn_blocking(move || {
            let mut m = model.lock().unwrap();
            m.reconcile_dir(&root, &rel, RECONCILE_DEPTH);
            slot.publish(m.snapshot(now_ms()));
        });
    }
}
```

> 注：`reconcile_vault_dir` 与全量重建共用 `vault_model` 锁 → 两者串行；全量重建在锁内整体替换模型后发布，reconcile 之后发布的快照基于最新模型，不会回退。

`src/main.rs`：
- `AppState` 中把 `pub vault_index: Option<std::sync::Arc<web::VaultIndex>>,` 替换为：
  ```rust
      /// Fuzzy-search indexes ($HOME dirs + vault). Also the source of the vault
      /// wikilink index (replaces the old synchronous startup walk).
      pub search: Arc<fuzzy_index::SearchIndexes>,
  ```
- 把 `main.rs:434-436` 的
  ```rust
      let vault_index = vault_dir.as_ref().map(|v| {
          std::sync::Arc::new(web::build_vault_index(std::path::Path::new(v)))
      });
  ```
  替换为：
  ```rust
      // Both indexes build in the background: the listener no longer waits ~46s for
      // the vault walk on JuiceFS. Until the first snapshot lands, vault search
      // reports `indexing` and wikilink resolution answers 503.
      let search = fuzzy_index::SearchIndexes::start(
          std::path::PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/home/ubuntu".into())),
          vault_dir.as_ref().map(std::path::PathBuf::from),
      );
  ```
- 构造 `AppState` 处把 `vault_index,` 改为 `search,`。

`src/web.rs`：
- 删除 `pub(crate) fn build_vault_index`（`web.rs:3461-3519` 的 doc 注释 + 函数体）。
- `vault_resolve` 改为：
  ```rust
  async fn vault_resolve(
      State(state): State<Arc<AppState>>,
      user: axum::Extension<CurrentUser>,
      Query(q): Query<VaultResolveQuery>,
  ) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
      let _base = vault_base(&state, &user)?;
      let snap = state
          .search
          .vault
          .as_ref()
          .and_then(|s| s.current())
          .ok_or((StatusCode::SERVICE_UNAVAILABLE, "vault indexing".into()))?;
      let path = resolve_wikilink(&snap.wiki, &q.name)
          .ok_or((StatusCode::NOT_FOUND, "Wikilink target not found".into()))?;
      Ok(Json(serde_json::json!({ "path": path })))
  }
  ```
- `vault_search` 暂时改读快照以保持编译（Task 5 删除）：把 `.vault_index.as_ref().map(|idx| idx.all_paths.clone())` 改为 `.search.vault.as_ref().and_then(|s| s.current()).map(|s| s.wiki.all_paths.clone())`。

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test 2>&1 | grep "test result"`
Expected: `test result: ok. 417 passed`（395 基线 + 本模块 22；`build_vault_index_*` 4 个与 `resolve_wikilink_*` 6 个改用新构建方式后仍绿）。

- [ ] **Step 5: Commit**

```bash
git add src/fuzzy_index.rs src/main.rs src/web.rs
git commit -m "feat(search): 索引异步首建+SWR 刷新;vault 启动不再同步遍历 46s

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: agent turn 结束钩子（三个 fanout parity）

**Files:**
- Modify: `src/session_manager.rs:310-346`（`SessionManager` 加 `search` 字段）、`:652-664`（`set_search`）、`:2353`（新增 `maybe_mark_vault_dirty`，紧挨 `maybe_push_turn_done`）、三个 fanout 的 `maybe_push_turn_done` 调用点（`:2494`、`:3302`、`:3597` 附近）
- Modify: `src/main.rs:511`（`set_scheduled_store` 下一行加 `state.sessions.set_search(state.search.clone())`）
- Test: `src/session_manager.rs` tests 模块

**Interfaces:**
- Consumes: Task 3 `SearchIndexes::reconcile_vault_dir(&Path)`
- Produces: `pub fn set_search(&self, s: Arc<crate::fuzzy_index::SearchIndexes>)`；`fn maybe_mark_vault_dirty(mgr: &Weak<SessionManager>, work_dir: &str)`

- [ ] **Step 1: Write the failing test**

追加到 `session_manager.rs` 的 `#[cfg(test)] mod tests`（靠近 `maybe_push_turn_done_is_safe_noop_without_push_service`）：

```rust
    #[tokio::test]
    async fn maybe_mark_vault_dirty_reconciles_vault_work_dir_only() {
        let (mgr, _dir) = make_manager();
        let weak = Arc::downgrade(&mgr);
        // No search wired → clean no-op.
        maybe_mark_vault_dirty(&weak, "/tmp/anything");
        maybe_mark_vault_dirty(&Weak::new(), "/tmp/anything");

        let home = tempfile::tempdir().unwrap();
        let vault = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(vault.path().join("单词")).unwrap();
        let si = crate::fuzzy_index::SearchIndexes::start(home.path().into(), Some(vault.path().into()));
        mgr.set_search(si.clone());
        let slot = si.vault.clone().unwrap();
        for _ in 0..200 {
            if slot.current().is_some() && !slot.is_rebuilding() { break; }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        std::fs::write(vault.path().join("单词/2026-09-25-下午.md"), "x").unwrap();
        maybe_mark_vault_dirty(&weak, &vault.path().join("单词").to_string_lossy());
        let mut found = false;
        for _ in 0..200 {
            if slot.current().unwrap().index.entries.iter().any(|e| e.path == "单词/2026-09-25-下午.md") { found = true; break; }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(found, "a note written by the agent must be searchable after its turn ends");
    }

    #[test]
    fn every_fanout_marks_vault_dirty_next_to_turn_done_push() {
        // Parity guard (fan-out invariant): all three agent fan-outs must call the
        // hook, exactly where they settle a turn. Missing one = that backend's
        // notes silently stay unsearchable until the next warm-up.
        let src = include_str!("session_manager.rs");
        // concat! so this test's own literal doesn't count itself.
        let calls = src.matches(concat!("maybe_mark_vault_dirty(&mgr, ", "&work_dir);")).count();
        assert_eq!(calls, 3, "acp + crew + codex fan-outs");
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test maybe_mark_vault_dirty every_fanout_marks 2>&1 | tail -10`
Expected: 编译失败（`maybe_mark_vault_dirty` / `set_search` 未定义）。

- [ ] **Step 3: Implement**

`SessionManager` 结构体（`push` 字段后）加：

```rust
    /// Fuzzy-search indexes, wired at startup. The turn-end hook asks it to rescan
    /// the session's work_dir when that lies inside the vault. None in tests.
    search: Mutex<Option<Arc<crate::fuzzy_index::SearchIndexes>>>,
```

`SessionManager::new` 的初始化（`push: Mutex::new(None),` 后）加 `search: Mutex::new(None),`。

`set_push` 之后加：

```rust
    /// Wire the search indexes (called once at startup).
    pub fn set_search(&self, s: Arc<crate::fuzzy_index::SearchIndexes>) {
        *self.search.lock().unwrap() = Some(s);
    }
```

在 `fn maybe_push_turn_done` 定义之前加：

```rust
/// Turn-end hook: if this session works inside the Obsidian vault, rescan its
/// work_dir so notes the agent just wrote become searchable now (1a has no
/// watcher). Deliberately NOT gated on active_run_id — scheduled runs write
/// notes too. Reads only `work_dir`; never touches the process (fan-out
/// invariant). Lock-in/lock-out: clone the Arc, release, then call.
fn maybe_mark_vault_dirty(mgr: &Weak<SessionManager>, work_dir: &str) {
    let Some(m) = mgr.upgrade() else { return };
    let si = m.search.lock().unwrap().clone();
    if let Some(si) = si {
        si.reconcile_vault_dir(std::path::Path::new(work_dir));
    }
}
```

三个 fanout 中，在各自 settling boundary 的 `maybe_push_turn_done(...)` 调用**所在 `if` 块之外、紧随其后**加同一行（acp：`if boundary_count >= turn_seq && active_run_id.is_none() { … }` 之后；crew / codex：`maybe_push_turn_done(...)` 那一行之后，仍在 `if boundary_count >= turn_seq {` 块内）：

acp（`session_manager.rs` ~2495，`if … active_run_id.is_none() { … }` 结束后）：

```rust
                                if boundary_count >= turn_seq {
                                    maybe_mark_vault_dirty(&mgr, &work_dir);
                                }
```

> 不能直接放进 `active_run_id.is_none()` 的块里——那会把定时任务写的笔记排除。

crew（~3302）与 codex（~3597），在 `maybe_push_turn_done(&mgr, &sid, &owner_id, dur, turn_starts.front_intent());` 下一行：

```rust
                                    maybe_mark_vault_dirty(&mgr, &work_dir);
```

> acp 的写法是 `if boundary_count >= turn_seq { maybe_mark_vault_dirty(&mgr, &work_dir); }`，其中调用文本与另两处一致，故 parity 测试按调用文本计数 = 3。

`src/main.rs`：照既有 `state.sessions.set_scheduled_store(...)`（`main.rs:511`）的写法，在它下一行加：

```rust
    state.sessions.set_search(state.search.clone());
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test 2>&1 | grep "test result"`
Expected: `test result: ok. 419 passed`

- [ ] **Step 5: Commit**

```bash
git add src/session_manager.rs src/main.rs
git commit -m "feat(search): agent turn 结束时对账 vault work_dir(三 fanout parity)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `GET /api/search` + `GET /api/search/warm`；删除 `/api/vault/search`

**Files:**
- Modify: `src/web.rs:46`（删 `/api/vault/search` 路由）、`:68-69` 附近（加两条路由）、`:3521-3535`（删 `vault_search_filter`）、`:3759-3792`（删 `VaultSearchQuery` + `vault_search`）、`:6121-6134`（删 `vault_search_matches_name_and_path` 测试）
- Modify: `src/web.rs`（新增 handler `search` / `search_warm` 及纯函数 `build_search_response`，放在 `list_quick_targets` 之前）
- Test: `src/web.rs` `mod path_safety_tests` 追加

**Interfaces:**
- Consumes: Task 2 `search`, `frecency_bonus`；Task 3 `state.search`；`quick_targets::decayed_score`、`QuickTargetStore::candidates(user_id, kind)`；`dir_display_hint`、`note_display_hint`；`vault_base`
- Produces（JSON，见 spec §3）：
  ```rust
  fn parse_scope(s: Option<&str>) -> Result<Vec<&'static str>, (StatusCode, String)> // ["dirs","notes"] default
  fn validate_query(q: &str) -> Result<(), (StatusCode, String)>                      // chars ≤ 128
  fn dir_section(snap: Option<&DirSnapshot>, rebuilding: bool, q: &str, limit: usize, bonus: &HashMap<String,f64>, agents: &HashMap<String,String>, home: &str) -> serde_json::Value
  fn notes_section(snap: Option<&VaultSnapshot>, rebuilding: bool, q: &str, limit: usize, bonus: &HashMap<String,f64>, vault_root: &str) -> serde_json::Value
  ```

- [ ] **Step 1: Write the failing tests**

追加到 `mod path_safety_tests`：

```rust
    fn dir_snap(paths: &[&str]) -> crate::fuzzy_index::DirSnapshot {
        let h = "/home/u";
        crate::fuzzy_index::DirSnapshot {
            built_at_ms: 1,
            index: crate::fuzzy_index::PathIndex {
                truncated: false,
                entries: paths.iter().map(|p| {
                    let hay = format!("~{}", &p[h.len()..]);
                    crate::fuzzy_index::IndexEntry {
                        basename_off: hay.rfind('/').map(|i| i + 1).unwrap_or(0),
                        haystack: hay, path: p.to_string(),
                        kind: crate::fuzzy_index::EntryKind::Dir, mtime_ms: 0, is_empty_dir: false,
                    }
                }).collect(),
            },
        }
    }

    #[test]
    fn parse_scope_defaults_and_rejects_unknown() {
        assert_eq!(parse_scope(None).unwrap(), vec!["dirs", "notes"]);
        assert_eq!(parse_scope(Some("notes")).unwrap(), vec!["notes"]);
        assert_eq!(parse_scope(Some("notes,dirs")).unwrap(), vec!["notes", "dirs"]);
        assert_eq!(parse_scope(Some("files")).unwrap_err().0, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn validate_query_counts_chars_not_bytes() {
        assert!(validate_query(&"汉".repeat(128)).is_ok(), "128 CJK chars = 384 bytes must pass");
        assert_eq!(validate_query(&"汉".repeat(129)).unwrap_err().0, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn dir_section_shape_agent_and_indexing() {
        let snap = dir_snap(&["/home/u/s3/zeromux", "/home/u/s3/zeromux/docs"]);
        let mut agents = std::collections::HashMap::new();
        agents.insert("/home/u/s3/zeromux".to_string(), "claude".to_string());
        let v = dir_section(Some(&snap), false, "zmx", 6, &Default::default(), &agents, "/home/u");
        assert_eq!(v["kind"], "dirs");
        assert_eq!(v["indexing"], false);
        let it = &v["items"][0];
        assert_eq!(it["path"], "/home/u/s3/zeromux");
        assert_eq!(it["display"], "zeromux");
        assert_eq!(it["hint"], "~/s3");
        assert_eq!(it["agent"], "claude");
        assert!(it["score"].as_u64().unwrap() > v["items"][1]["score"].as_u64().unwrap(),
            "score is exposed so the client can order sections by their best hit");
        assert!(v["items"][1]["agent"].is_null());
        let none = dir_section(None, true, "zmx", 6, &Default::default(), &Default::default(), "/home/u");
        assert_eq!(none["indexing"], true);
        assert_eq!(none["items"].as_array().unwrap().len(), 0);
        let refreshing = dir_section(Some(&snap), true, "zmx", 6, &Default::default(), &agents, "/home/u");
        assert_eq!(refreshing["indexing"], false);
        assert_eq!(refreshing["refreshing"], true);
    }

    #[test]
    fn notes_section_abs_dir_for_note_and_folder() {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(d.path().join("projects/x")).unwrap();
        std::fs::write(d.path().join("projects/x/_index.md"), "x").unwrap();
        let snap = crate::fuzzy_index::VaultModel::full_scan(d.path()).unwrap().snapshot(1);
        let root = d.path().to_string_lossy().to_string();
        let v = notes_section(Some(&snap), false, "projects x", 50, &Default::default(), &root);
        assert_eq!(v["kind"], "notes");
        let items = v["items"].as_array().unwrap();
        let note = items.iter().find(|i| i["kind"] == "note").unwrap();
        let folder = items.iter().find(|i| i["kind"] == "folder" && i["path"] == "projects/x").unwrap();
        assert_eq!(note["path"], "projects/x/_index.md");
        assert_eq!(note["display"], "_index");
        assert_eq!(note["hint"], "projects/x");
        assert_eq!(note["abs_dir"], format!("{root}/projects/x"));
        assert_eq!(folder["abs_dir"], format!("{root}/projects/x"));
    }

    #[test]
    fn meta_only_query_yields_empty_sections() {
        let snap = dir_snap(&["/home/u/a"]);
        for q in ["!a", "'", "   "] {
            let v = dir_section(Some(&snap), false, q, 6, &Default::default(), &Default::default(), "/home/u");
            assert_eq!(v["items"].as_array().unwrap().len(), 0, "{q:?}");
        }
    }

    #[test]
    fn vault_search_endpoint_is_gone() {
        let src = include_str!("web.rs");
        assert!(!src.contains(concat!("\"/api/vault/", "search\"")), "legacy endpoint must be removed, not shimmed");
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test path_safety_tests::parse_scope 2>&1 | tail -10`
Expected: 编译失败（`parse_scope` 等未定义）。

- [ ] **Step 3: Implement**

路由（`build_router` 的 authed 组）：删 `.route("/api/vault/search", get(vault_search))`；在 `.route("/api/quick-targets", …)` 之后加：

```rust
        .route("/api/search", get(search))
        .route("/api/search/warm", get(search_warm))
```

删除 `vault_search_filter`（含其 doc 注释）、`struct VaultSearchQuery`、`async fn vault_search`、测试 `vault_search_matches_name_and_path`。

在 `list_quick_targets` 之前新增：

```rust
// ── Fuzzy search (/api/search) ──
//
// Shape: { sections: [{ kind, indexing, refreshing, truncated, items }] } — a new
// searchable entity later is just a new section kind (old clients ignore it).

#[derive(serde::Deserialize)]
struct SearchQuery {
    q: String,
    scope: Option<String>,
    limit: Option<usize>,
}

#[derive(serde::Deserialize)]
struct WarmQuery {
    scope: Option<String>,
}

const SEARCH_Q_MAX_CHARS: usize = 128;
const SEARCH_LIMIT_DEFAULT: usize = 6;
const SEARCH_LIMIT_MAX: usize = 50;

fn parse_scope(s: Option<&str>) -> Result<Vec<&'static str>, (StatusCode, String)> {
    let Some(s) = s.filter(|s| !s.trim().is_empty()) else { return Ok(vec!["dirs", "notes"]) };
    s.split(',')
        .map(|p| match p.trim() {
            "dirs" => Ok("dirs"),
            "notes" => Ok("notes"),
            other => Err((StatusCode::BAD_REQUEST, format!("unknown scope: {other}"))),
        })
        .collect()
}

/// Length cap counted in chars: 128 CJK chars are 384 bytes and must pass.
fn validate_query(q: &str) -> Result<(), (StatusCode, String)> {
    if q.chars().count() > SEARCH_Q_MAX_CHARS {
        return Err((StatusCode::BAD_REQUEST, format!("query longer than {SEARCH_Q_MAX_CHARS} chars")));
    }
    Ok(())
}

fn section_json(kind: &str, indexing: bool, refreshing: bool, truncated: bool, items: Vec<serde_json::Value>) -> serde_json::Value {
    serde_json::json!({ "kind": kind, "indexing": indexing, "refreshing": refreshing, "truncated": truncated, "items": items })
}

fn dir_section(
    snap: Option<&crate::fuzzy_index::DirSnapshot>,
    rebuilding: bool,
    q: &str,
    limit: usize,
    bonus: &std::collections::HashMap<String, f64>,
    agents: &std::collections::HashMap<String, String>,
    home: &str,
) -> serde_json::Value {
    let Some(snap) = snap else { return section_json("dirs", true, false, false, vec![]) };
    let hits = crate::fuzzy_index::search(&snap.index, q, limit, &|p| {
        crate::fuzzy_index::frecency_bonus(bonus.get(p).copied().unwrap_or(0.0))
    });
    let items = hits.iter().map(|h| {
        let (display, hint) = dir_display_hint(&h.entry.path, home);
        serde_json::json!({
            "path": h.entry.path, "display": display, "hint": hint,
            "agent": agents.get(&h.entry.path), "score": h.score,
        })
    }).collect();
    section_json("dirs", false, rebuilding, snap.index.truncated, items)
}

fn notes_section(
    snap: Option<&crate::fuzzy_index::VaultSnapshot>,
    rebuilding: bool,
    q: &str,
    limit: usize,
    bonus: &std::collections::HashMap<String, f64>,
    vault_root: &str,
) -> serde_json::Value {
    use crate::fuzzy_index::EntryKind;
    let Some(snap) = snap else { return section_json("notes", true, false, false, vec![]) };
    let hits = crate::fuzzy_index::search(&snap.index, q, limit, &|p| {
        crate::fuzzy_index::frecency_bonus(bonus.get(p).copied().unwrap_or(0.0))
    });
    let items = hits.iter().map(|h| {
        let p = &h.entry.path;
        let is_note = h.entry.kind == EntryKind::VaultNote;
        let (display, hint) = if is_note {
            note_display_hint(p)
        } else {
            match p.rfind('/') { Some(i) => (p[i + 1..].to_string(), p[..i].to_string()), None => (p.clone(), String::new()) }
        };
        let dir_rel = if is_note { p.rfind('/').map(|i| &p[..i]).unwrap_or("") } else { p.as_str() };
        let abs_dir = if dir_rel.is_empty() { vault_root.to_string() } else { format!("{vault_root}/{dir_rel}") };
        serde_json::json!({
            "path": p, "kind": if is_note { "note" } else { "folder" },
            "display": display, "hint": hint, "abs_dir": abs_dir, "score": h.score,
        })
    }).collect();
    section_json("notes", false, rebuilding, snap.index.truncated, items)
}

/// Per-user frecency, aggregated by path: (sum of decayed scores, best agent).
fn frecency_maps(
    state: &AppState,
    user_id: &str,
    kind: &str,
) -> (std::collections::HashMap<String, f64>, std::collections::HashMap<String, String>) {
    let now = crate::fuzzy_index::now_ms();
    let mut sum = std::collections::HashMap::<String, f64>::new();
    let mut best = std::collections::HashMap::<String, (f64, String)>::new();
    for r in state.quick_targets.candidates(user_id, kind).unwrap_or_default() {
        let d = crate::quick_targets::decayed_score(r.score_raw, r.last_ms, now);
        *sum.entry(r.path.clone()).or_default() += d;
        if matches!(r.agent.as_str(), "claude" | "crew" | "codex" | "tmux") {
            let e = best.entry(r.path.clone()).or_insert((f64::MIN, String::new()));
            if d > e.0 { *e = (d, r.agent.clone()); }
        }
    }
    (sum, best.into_iter().map(|(k, (_, a))| (k, a)).collect())
}

async fn search(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
    Query(q): Query<SearchQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    validate_query(&q.q)?;
    let scope = parse_scope(q.scope.as_deref())?;
    let limit = q.limit.unwrap_or(SEARCH_LIMIT_DEFAULT).clamp(1, SEARCH_LIMIT_MAX);
    let home = std::env::var("HOME").unwrap_or_else(|_| "/home/ubuntu".to_string());
    let vault_ok = vault_base(&state, &user).is_ok();
    let si = state.search.clone();
    let mut sections = Vec::new();
    for s in scope {
        match s {
            "dirs" => {
                let (bonus, agents) = frecency_maps(&state, &user.id, "dir");
                let snap = si.dirs.current();
                let sec = dir_section(snap.as_deref(), si.dirs.is_rebuilding(), &q.q, limit, &bonus, &agents, &home);
                let zero = sec["items"].as_array().is_some_and(|a| a.is_empty());
                if zero { si.refresh_dirs_if_older(crate::fuzzy_index::ZERO_HIT_MIN_AGE_MS); }
                else { si.refresh_dirs_if_older(crate::fuzzy_index::DIR_TTL_MS); }
                sections.push(sec);
            }
            "notes" => {
                let (Some(slot), Some(root), true) = (si.vault.as_ref(), si.vault_root(), vault_ok) else {
                    sections.push(section_json("notes", false, false, false, vec![]));
                    continue;
                };
                let (bonus, _) = frecency_maps(&state, &user.id, "note");
                let snap = slot.current();
                let sec = notes_section(snap.as_deref(), slot.is_rebuilding(), &q.q, limit, &bonus, &root.to_string_lossy());
                if sec["items"].as_array().is_some_and(|a| a.is_empty()) {
                    si.refresh_vault_if_older(crate::fuzzy_index::ZERO_HIT_MIN_AGE_MS);
                }
                sections.push(sec);
            }
            _ => unreachable!("parse_scope only yields known kinds"),
        }
    }
    Ok(Json(serde_json::json!({ "sections": sections })))
}

/// Opening the New Session popover / VaultReader warms stale indexes so a
/// just-cloned repo or just-synced note is indexed while the user types.
async fn search_warm(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
    Query(q): Query<WarmQuery>,
) -> Result<StatusCode, (StatusCode, String)> {
    for s in parse_scope(q.scope.as_deref())? {
        match s {
            "dirs" => state.search.refresh_dirs_if_older(crate::fuzzy_index::WARM_MIN_AGE_MS),
            "notes" if vault_base(&state, &user).is_ok() => {
                state.search.refresh_vault_if_older(crate::fuzzy_index::WARM_MIN_AGE_MS)
            }
            _ => {}
        }
    }
    Ok(StatusCode::NO_CONTENT)
}
```

> `search` handler 本身不做 IO（只读内存快照 + 一次小 SQLite 查询），不需要 `spawn_blocking`；nucleo 实测最坏查询 13.8ms / 7000 条，常规亚毫秒。

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test 2>&1 | grep "test result"`
Expected: `test result: ok. 424 passed`（419 + 6 新 − 1 删除）

- [ ] **Step 5: Commit**

```bash
git add src/web.rs
git commit -m "feat(search): /api/search(sections)+/api/search/warm;删除 /api/vault/search

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: 学习场景预设 + `seed_v2_if_needed` 迁移

**Files:**
- Modify: `src/prompts_seed.rs`（追加 `SEED_PRESETS_V2`）
- Modify: `src/prompts.rs:197-229` 之后（新增 `seed_v2_if_needed`）；tests（`:332` 起）追加
- Modify: `src/main.rs:297-301`（seed 调用后追加 v2 调用）

**Interfaces:**
- Produces: `pub const SEED_PRESETS_V2: &[(&str, &str)]`；`pub fn seed_v2_if_needed(&self, presets: &[(&str, &str)]) -> Result<usize, String>`

- [ ] **Step 1: Write the failing tests**

`src/prompts.rs` tests 追加：

```rust
    // ── seed_v2_if_needed ──
    use crate::prompts_seed::SEED_PRESETS_V2;

    fn titles(s: &PromptPresetStore) -> Vec<String> {
        s.list().unwrap().into_iter().map(|p| p.title).collect()
    }

    #[test]
    fn seed_v2_appends_four_after_v1_with_continuing_sort_order() {
        let (s, _d) = tmp_store();
        s.seed_if_unseeded(SEED_PRESETS).unwrap();
        assert_eq!(s.seed_v2_if_needed(SEED_PRESETS_V2).unwrap(), 4);
        let list = s.list().unwrap();
        assert_eq!(list.len(), 12);
        let last4: Vec<&str> = list[8..].iter().map(|p| p.title.as_str()).collect();
        assert_eq!(last4, SEED_PRESETS_V2.iter().map(|(t, _)| *t).collect::<Vec<_>>());
    }

    #[test]
    fn seed_v2_is_idempotent_and_never_resurrects() {
        let (s, _d) = tmp_store();
        s.seed_if_unseeded(SEED_PRESETS).unwrap();
        s.seed_v2_if_needed(SEED_PRESETS_V2).unwrap();
        assert_eq!(s.seed_v2_if_needed(SEED_PRESETS_V2).unwrap(), 0);
        for p in s.list().unwrap() { s.delete(&p.id).unwrap(); }
        assert_eq!(s.seed_v2_if_needed(SEED_PRESETS_V2).unwrap(), 0);
        assert!(s.list().unwrap().is_empty());
    }

    #[test]
    fn seed_v2_skips_titles_the_user_already_has() {
        let (s, _d) = tmp_store();
        s.seed_if_unseeded(SEED_PRESETS).unwrap();
        s.create(SEED_PRESETS_V2[0].0, "my own").unwrap();
        assert_eq!(s.seed_v2_if_needed(SEED_PRESETS_V2).unwrap(), 3);
        assert_eq!(titles(&s).iter().filter(|t| *t == SEED_PRESETS_V2[0].0).count(), 1);
    }

    #[test]
    fn fresh_db_gets_twelve_via_both_seeds() {
        let (s, _d) = tmp_store();
        s.seed_if_unseeded(SEED_PRESETS).unwrap();
        s.seed_v2_if_needed(SEED_PRESETS_V2).unwrap();
        assert_eq!(s.list().unwrap().len(), 12);
    }

    #[test]
    fn seed_v2_content_within_caps() {
        for (title, body) in SEED_PRESETS_V2 {
            let (t, b) = (title.trim(), body.trim());
            assert!(!t.is_empty() && !b.is_empty());
            assert!(t.chars().count() <= TITLE_MAX);
            assert!(b.chars().count() <= BODY_MAX);
            assert!(b.contains("{{input}}"), "study presets wrap the prefilled note context: {t}");
        }
    }
```

> `tmp_store()` 是既有 helper（`prompts.rs` tests，返回 `(PromptPresetStore, TempDir)`）；`list() -> Result<Vec<PromptPreset>, String>`、`create(&str, &str) -> Result<PromptPreset, String>`、`delete(&str) -> Result<bool, String>`（`prompts.rs:47/76/170`）。

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test seed_v2 fresh_db_gets_twelve 2>&1 | tail -10`
Expected: 编译失败（`SEED_PRESETS_V2` / `seed_v2_if_needed` 未定义）。

- [ ] **Step 3: Implement**

`src/prompts_seed.rs` 末尾追加：

```rust
/// v2 study presets (2026-09-25 fuzzy-search spec §8), appended once to libraries
/// already seeded with v1. Designed for the "⚡ 问 agent" flow: `{{input}}` wraps
/// the prefilled "当前笔记：<path>" line, and the session's work_dir is the note's
/// folder, so relative paths resolve.
pub const SEED_PRESETS_V2: &[(&str, &str)] = &[
    (
        "📝 基于笔记出题",
        r#"Task: Quiz me on the note referenced here: {{input}}

Approach: Read that note in full first. Write 5 questions that cover its key points — mix recall, application, and one question that connects ideas across sections. Match the note's subject style (e.g. exam-style multiple choice for 考研英语 reading notes, worked problems for 管综数学).

Done when: you show the 5 questions only, then STOP and wait for my answers. After I answer, grade each one, explain every mistake with a pointer to the exact part of the note, and give the correct answer.

用中文与我交流（英文原文、公式、术语保持原样）。"#,
    ),
    (
        "✅ 批改我的答案",
        r#"Task: Grade my answers against this note: {{input}} — my answers are in my message below or in attached images. If I haven't given any answers yet, ask me for them and stop.

Approach: Read the note (answer key / explanations) first. If a `kaoyan-reading-review` skill is available and this is a 考研英语 reading passage, follow that skill's workflow. For each question: my answer, the correct answer, right/wrong, and the reasoning technique that gets it right.

Done when: every question is graded, the error pattern is summarized in 2–3 bullets, and — only if I confirm — the diagnosis is appended to the note under a dated heading.

用中文与我交流（英文原文保持原样）。"#,
    ),
    (
        "🃏 生成背诵卡",
        r#"Task: Turn this note into a memorization card: {{input}}

Approach: Read the note. Extract only what must be memorized — definitions, formulas, key vocabulary, typical traps — as short Q→A pairs or cloze lines, grouped by section. No prose paragraphs.

Done when: a new file `<original-name>-背诵卡.md` is written next to the original note (never overwrite an existing file — if one exists, show me the diff and ask), and you report its path and how many cards it contains.

用中文与我交流（英文单词、公式保持原样）。"#,
    ),
    (
        "🔁 抽背单词",
        r#"Task: Drill me on vocabulary. Context: {{input}}

Approach: Find the `单词/` notes in or under this directory (if none, ask me where they are). Collect the words from the most recent 7 notes, pick 20 at random (no duplicates), and quiz me ONE word at a time: show the word, wait for my meaning, then judge it and show the note's definition + example.

Done when: all 20 are done; then list the ones I missed with their note filenames so I can review them.

用中文与我交流（英文单词与例句保持原样）。"#,
    ),
];
```

`src/prompts.rs`，`seed_if_unseeded` 之后加：

```rust
    /// One-shot v2 migration: append the study presets to a library already seeded
    /// with v1 (`user_version == 1`), then mark `user_version = 2` — in one tx, same
    /// atomicity argument as `seed_if_unseeded`. Titles the user already has are
    /// skipped (no duplicates). `user_version >= 2` → never touched again, so a
    /// deleted study preset is never resurrected. `user_version == 0` is left alone:
    /// callers run `seed_if_unseeded` first, which moves a fresh DB to 1.
    pub fn seed_v2_if_needed(&self, presets: &[(&str, &str)]) -> Result<usize, String> {
        let mut conn = self.conn.lock().unwrap();
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(|e| format!("Pragma read error: {}", e))?;
        if version != 1 {
            return Ok(0);
        }
        let max_order: i64 = conn
            .query_row("SELECT COALESCE(MAX(sort_order), 0) FROM prompt_presets", [], |row| row.get(0))
            .map_err(|e| format!("Max order error: {}", e))?;
        let now = now_iso();
        let tx = conn.transaction().map_err(|e| format!("Tx error: {}", e))?;
        let mut inserted = 0usize;
        for (title, body) in presets {
            let exists: i64 = tx
                .query_row("SELECT COUNT(*) FROM prompt_presets WHERE title = ?1", params![title.trim()], |r| r.get(0))
                .map_err(|e| format!("Exists check error: {}", e))?;
            if exists > 0 { continue; }
            inserted += 1;
            tx.execute(
                "INSERT INTO prompt_presets (id, title, body, created_at, updated_at, sort_order)
                 VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
                params![short_uuid(), title.trim(), body.trim(), now, max_order + inserted as i64],
            )
            .map_err(|e| format!("Seed v2 insert error: {}", e))?;
        }
        tx.execute_batch("PRAGMA user_version = 2")
            .map_err(|e| format!("Pragma write error: {}", e))?;
        tx.commit().map_err(|e| format!("Seed v2 commit error: {}", e))?;
        Ok(inserted)
    }
```

`src/main.rs`，在 `match prompts_store.seed_if_unseeded(...) { … }` 之后加：

```rust
    match prompts_store.seed_v2_if_needed(prompts_seed::SEED_PRESETS_V2) {
        Ok(0) => {}
        Ok(n) => eprintln!("Added {} study prompt presets (v2)", n),
        Err(e) => eprintln!("Prompt preset v2 seeding skipped: {}", e),
    }
```

同时把 `src/prompts_seed.rs` 顶部模块注释补一行：`SEED_PRESETS_V2 holds the study presets from docs/superpowers/specs/2026-09-25-fuzzy-search-design.md §8.`

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test 2>&1 | grep "test result"`
Expected: `test result: ok. 429 passed`

- [ ] **Step 5: Commit**

```bash
git add src/prompts_seed.rs src/prompts.rs src/main.rs
git commit -m "feat(prompts): 4 条学习预设 + seed v2 一次性追加迁移

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 7: 前端 API 层（`searchPaths` / `warmSearchIndex` / `resolveWikiLink` 区分 503）

**Files:**
- Modify: `frontend/src/lib/api.ts:452-462`（删 `getVaultSearch`；改 `resolveWikiLink`；新增类型与两个函数）
- Create: `frontend/src/lib/__tests__/search.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface DirHit { path: string; display: string; hint: string; agent: SessionType | null; score: number }
  export interface NoteHit { path: string; kind: 'note' | 'folder'; display: string; hint: string; abs_dir: string; score: number }
  export interface SearchSection<T> { kind: 'dirs' | 'notes'; indexing: boolean; refreshing: boolean; truncated: boolean; items: T[] }
  export interface SearchResult { dirs: SearchSection<DirHit> | null; notes: SearchSection<NoteHit> | null }
  export async function searchPaths(q: string, scope: string, limit?: number): Promise<SearchResult>
  export async function warmSearchIndex(scope: string): Promise<void>        // never throws
  export type WikiResolve = { path: string } | { indexing: true } | null
  export async function resolveWikiLink(name: string): Promise<WikiResolve>
  ```

- [ ] **Step 1: Write the failing test**

`frontend/src/lib/__tests__/search.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { searchPaths, warmSearchIndex, resolveWikiLink } from '../api'

describe('search API', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock) })
  afterEach(() => vi.unstubAllGlobals())

  it('searchPaths maps sections by kind and coerces unknown agents to null', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ sections: [
      { kind: 'notes', indexing: false, refreshing: false, truncated: false, items: [] },
      { kind: 'dirs', indexing: false, refreshing: true, truncated: false,
        items: [{ path: '/h/a', display: 'a', hint: '~', agent: 'kiro', score: 50 },
                { path: '/h/b', display: 'b', hint: '~', agent: 'claude', score: 40 }] },
      { kind: 'future-thing', items: [] },
    ] }) })
    const r = await searchPaths('zmx', 'dirs,notes')
    expect(fetchMock.mock.calls[0][0]).toBe('/api/search?q=zmx&scope=dirs%2Cnotes&limit=6')
    expect(r.dirs!.refreshing).toBe(true)
    expect(r.dirs!.items[0].agent).toBeNull()
    expect(r.dirs!.items[1].agent).toBe('claude')
    expect(r.notes!.items).toEqual([])
  })

  it('searchPaths throws on non-ok', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400, text: async () => 'bad' })
    await expect(searchPaths('x', 'dirs')).rejects.toThrow()
  })

  it('warmSearchIndex swallows failures', async () => {
    fetchMock.mockRejectedValue(new Error('offline'))
    await expect(warmSearchIndex('dirs,notes')).resolves.toBeUndefined()
  })

  it('resolveWikiLink distinguishes indexing (503) from not found (404)', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 })
    expect(await resolveWikiLink('x')).toEqual({ indexing: true })
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 })
    expect(await resolveWikiLink('x')).toBeNull()
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ path: 'a/b.md' }) })
    expect(await resolveWikiLink('x')).toEqual({ path: 'a/b.md' })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run src/lib/__tests__/search.test.ts`
Expected: FAIL（`searchPaths is not a function` 等）。

- [ ] **Step 3: Implement**

`frontend/src/lib/api.ts`：删除 `getVaultSearch`（452-456 行），把 `resolveWikiLink` 替换，并在其后加：

```ts
export type WikiResolve = { path: string } | { indexing: true } | null
/** 503 = the vault index is still building after a restart (~50s) — distinct from
 *  a genuinely missing note so the UI can say "try again shortly". */
export async function resolveWikiLink(name: string): Promise<WikiResolve> {
  const res = await api(`/api/vault/resolve?name=${encodeURIComponent(name)}`)
  if (res.status === 503) return { indexing: true }
  if (!res.ok) return null
  const d = await res.json()
  return d.path ? { path: d.path } : null
}

export interface DirHit { path: string; display: string; hint: string; agent: SessionType | null; score: number }
export interface NoteHit { path: string; kind: 'note' | 'folder'; display: string; hint: string; abs_dir: string; score: number }
export interface SearchSection<T> { kind: 'dirs' | 'notes'; indexing: boolean; refreshing: boolean; truncated: boolean; items: T[] }
export interface SearchResult { dirs: SearchSection<DirHit> | null; notes: SearchSection<NoteHit> | null }

const SEARCH_AGENTS: readonly SessionType[] = ['tmux', 'claude', 'crew', 'codex']

export async function searchPaths(q: string, scope: string, limit = 6): Promise<SearchResult> {
  const params = new URLSearchParams({ q, scope, limit: String(limit) })
  const res = await api(`/api/search?${params}`)
  if (!res.ok) throw new ApiError(res.status, await res.text())
  const d = await res.json() as { sections: Array<SearchSection<unknown> & { kind: string }> }
  const out: SearchResult = { dirs: null, notes: null }
  for (const s of d.sections ?? []) {
    if (s.kind === 'dirs') {
      out.dirs = { ...s, kind: 'dirs', items: (s.items as DirHit[]).map(it => ({
        ...it, agent: SEARCH_AGENTS.includes(it.agent as SessionType) ? it.agent : null,
      })) }
    } else if (s.kind === 'notes') {
      out.notes = { ...s, kind: 'notes', items: s.items as NoteHit[] }
    } // unknown kinds: ignored (forward compatible)
  }
  return out
}

/** Fire-and-forget: ask the server to refresh stale indexes while the user types. */
export async function warmSearchIndex(scope: string): Promise<void> {
  try { await api(`/api/search/warm?scope=${encodeURIComponent(scope)}`) } catch { /* best effort */ }
}
```

（`ApiError` 定义在同文件 `api.ts:68`，`api()` 在 `:82`——上面代码放在 `resolveWikiLink` 原位置，两者均已在作用域内。）

`VaultReader.tsx` 的 `onWikiLink` 相应改为：

```ts
  const onWikiLink = useCallback((name: string) => {
    resolveWikiLink(name).then(r => {
      if (r && 'path' in r) openNote(r.path)
      else if (r && 'indexing' in r) alert('笔记索引建立中，请稍候再试')
      else alert('未找到对应笔记:' + name)
    })
  }, [openNote])
```

（`VaultReader` 的搜索调用在 Task 10 改；本步先把 `import` 里的 `getVaultSearch` 暂换为 `searchPaths` 并把搜索 effect 临时改为 `searchPaths(query, 'notes', 50).then(r => { … setResults((r.notes?.items ?? []).map(i => ({ path: i.path, name: i.display }))) … })`，保证 tsc 通过；`VaultReader.test.tsx:9` 的 mock 把 `getVaultSearch` 改为 `searchPaths: vi.fn(async () => ({ dirs: null, notes: { kind: 'notes', indexing: false, refreshing: false, truncated: false, items: [] } }))`，并加 `warmSearchIndex: vi.fn(async () => {})`。）

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && npx vitest run src/lib/__tests__/search.test.ts src/components/__tests__/VaultReader.test.tsx && npx tsc -b`
Expected: PASS；tsc 无输出。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/api.ts frontend/src/lib/__tests__/search.test.ts frontend/src/components/VaultReader.tsx frontend/src/components/__tests__/VaultReader.test.tsx
git commit -m "feat(frontend): searchPaths/warmSearchIndex API;resolveWikiLink 区分 503

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: 共享结果组件 `SearchResults`（纯展示）

**Files:**
- Create: `frontend/src/components/SearchResults.tsx`
- Modify: `frontend/src/components/QuickTargets.tsx`（`RowIcon` 导出；删 `onEmpty` prop 与 `failed` state）
- Modify: `frontend/src/components/__tests__/QuickTargets.test.tsx:133-138`（删 `onEmpty` 测试）
- Create: `frontend/src/components/__tests__/SearchResults.test.tsx`

**Interfaces:**
- Consumes: Task 7 `DirHit`, `NoteHit`, `SearchResult`
- Produces:
  ```ts
  export function RowIcon(props: { kind: 'dir' | 'note' | 'folder'; agent: string; size?: number })   // from QuickTargets.tsx
  export default function SearchResults(props: {
    result: SearchResult
    showNotes: boolean
    onPickDir: (hit: DirHit) => void            // row tap
    onDirMenu?: { changeAgent: (hit: DirHit) => void; withPrompt: (hit: DirHit) => void }
    onPickNote: (hit: NoteHit) => void          // row tap
    onAskAgent: (hit: NoteHit) => void          // ⚡
    onOpenHere?: (hit: NoteHit) => void          // folder ⋮ 「在此开 agent」
    onRetry?: () => void
    failed?: boolean
  }): JSX.Element
  export function orderSections(r: SearchResult, showNotes: boolean): Array<'dirs' | 'notes'>
  ```

- [ ] **Step 1: Write the failing tests**

`frontend/src/components/__tests__/SearchResults.test.tsx`：

```tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import SearchResults, { orderSections } from '../SearchResults'
import type { SearchResult, DirHit, NoteHit } from '../../lib/api'

const dir = (o: Partial<DirHit> = {}): DirHit => ({ path: '/h/zeromux', display: 'zeromux', hint: '~/s3', agent: 'claude', score: 80, ...o })
const note = (o: Partial<NoteHit> = {}): NoteHit => ({ path: 'p/_index.md', kind: 'note', display: '_index', hint: 'p', abs_dir: '/v/p', score: 60, ...o })
const res = (d: DirHit[], n: NoteHit[], extra: Partial<SearchResult['dirs']> = {}, extraN: Partial<SearchResult['notes']> = {}): SearchResult => ({
  dirs: { kind: 'dirs', indexing: false, refreshing: false, truncated: false, items: d, ...extra },
  notes: { kind: 'notes', indexing: false, refreshing: false, truncated: false, items: n, ...extraN },
})
const noop = () => {}
const base = { onPickDir: noop, onPickNote: noop, onAskAgent: noop }

describe('SearchResults', () => {
  it('orders sections by best score', () => {
    expect(orderSections(res([dir({ score: 50 })], [note({ score: 90 })]), true)).toEqual(['notes', 'dirs'])
    expect(orderSections(res([dir({ score: 90 })], [note({ score: 50 })]), true)).toEqual(['dirs', 'notes'])
    expect(orderSections(res([dir()], [note()]), false)).toEqual(['dirs'])
  })

  it('renders both sections with display + hint', () => {
    render(<SearchResults result={res([dir()], [note()])} showNotes {...base} />)
    expect(screen.getByText('目录')).toBeInTheDocument()
    expect(screen.getByText('笔记')).toBeInTheDocument()
    expect(screen.getByText('zeromux')).toBeInTheDocument()
    expect(screen.getByText('~/s3')).toBeInTheDocument()
    expect(screen.getByText('_index')).toBeInTheDocument()
  })

  it('hides the notes section entirely when showNotes is false', () => {
    render(<SearchResults result={res([dir()], [])} showNotes={false} {...base} />)
    expect(screen.queryByText('笔记')).toBeNull()
    expect(screen.queryByText('无匹配笔记')).toBeNull()
  })

  it('row tap vs ⚡ are distinct targets; ⚡ is not hover-only', () => {
    const onPickNote = vi.fn(), onAskAgent = vi.fn()
    render(<SearchResults result={res([], [note()])} showNotes {...base} onPickNote={onPickNote} onAskAgent={onAskAgent} />)
    const ask = screen.getByTestId('sr-ask')
    expect(ask.className).not.toMatch(/opacity-0|group-hover/)
    fireEvent.click(ask)
    expect(onAskAgent).toHaveBeenCalledWith(note())
    expect(onPickNote).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('_index'))
    expect(onPickNote).toHaveBeenCalledWith(note())
  })

  it('folder row ⋮ offers 在此开 agent', () => {
    const onOpenHere = vi.fn()
    const f = note({ kind: 'folder', path: 'p', display: 'p', hint: '', abs_dir: '/v/p' })
    render(<SearchResults result={res([], [f])} showNotes {...base} onOpenHere={onOpenHere} />)
    fireEvent.click(screen.getByTestId('sr-menu'))
    fireEvent.click(screen.getByText('在此开 agent'))
    expect(onOpenHere).toHaveBeenCalledWith(f)
  })

  it('edge states: indexing, refreshing+empty, empty', () => {
    const { rerender } = render(<SearchResults result={res([], [], { indexing: true }, { indexing: true })} showNotes {...base} />)
    expect(screen.getByText('正在建立目录索引…')).toBeInTheDocument()
    expect(screen.getByText('正在建立笔记索引…')).toBeInTheDocument()
    rerender(<SearchResults result={res([], [], { refreshing: true }, { refreshing: true })} showNotes {...base} />)
    expect(screen.getByText('索引刷新中…')).toBeInTheDocument()
    expect(screen.getByText('笔记索引刷新中…')).toBeInTheDocument()
    rerender(<SearchResults result={res([], [])} showNotes {...base} />)
    expect(screen.getByText(/未找到（仅索引 6 层内）/)).toBeInTheDocument()
    expect(screen.getByText('无匹配笔记')).toBeInTheDocument()
  })

  it('failed shows a retry and nothing else', () => {
    const onRetry = vi.fn()
    render(<SearchResults result={res([dir()], [])} showNotes failed onRetry={onRetry} {...base} />)
    expect(screen.queryByText('zeromux')).toBeNull()
    fireEvent.click(screen.getByText('重试'))
    expect(onRetry).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run src/components/__tests__/SearchResults.test.tsx`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: Implement**

`QuickTargets.tsx`：
- 把 `function RowIcon(...)` 改为 `export function RowIcon({ kind, agent, size = 15 }: { kind: 'dir' | 'note' | 'folder'; agent: string; size?: number })`，并在函数体首行加 `if (kind === 'folder') return <Folder size={size} className="text-[var(--accent-blue)] shrink-0" />`（`import` 加 `Folder`）。
- 删除 prop `onEmpty`、state `failed`/`setFailed`、以及 `useEffect(() => { if (loaded && !failed && items.length === 0) onEmpty?.() }, …)`；catch 分支只保留 `setItems([])`（注释改为「快速入口是加速器：失败就安静地不显示」）。
- `QuickTargets.test.tsx` 删除 `'列表为空时通知父级…'` 这一个 `it`。
- `Sidebar.tsx:519` 删除 `onEmpty={() => setStep('pick-type')}` 及其上方两行注释（Task 9 会整体改写这一段，此处先删以保证 tsc 通过）。

新建 `frontend/src/components/SearchResults.tsx`：

```tsx
import { useState } from 'react'
import { MoreVertical, Zap, Repeat, MessageSquarePlus, FolderInput } from 'lucide-react'
import type { SearchResult, DirHit, NoteHit } from '../lib/api'
import { RowIcon } from './QuickTargets'

type SectionKind = 'dirs' | 'notes'

/** Section order follows each section's best hit — a fixed "dirs first" would bury
 *  a clearly better note match below six directory rows. */
export function orderSections(r: SearchResult, showNotes: boolean): SectionKind[] {
  const best = (xs: { score: number }[] | undefined) => (xs && xs.length ? Math.max(...xs.map(x => x.score)) : -1)
  const kinds: SectionKind[] = ['dirs']
  if (showNotes) kinds.push('notes')
  return kinds.sort((a, b) => best(r[b]?.items) - best(r[a]?.items))
}

function Hint({ text }: { text: string }) {
  return text ? <span className="truncate text-[10px] text-[var(--text-muted)]">{text}</span> : null
}

function Status({ text }: { text: string }) {
  return <div className="px-3 py-2 text-[10px] text-[var(--text-muted)]">{text}</div>
}

export default function SearchResults({ result, showNotes, onPickDir, onDirMenu, onPickNote, onAskAgent, onOpenHere, onRetry, failed }: {
  result: SearchResult
  showNotes: boolean
  onPickDir: (hit: DirHit) => void
  onDirMenu?: { changeAgent: (hit: DirHit) => void; withPrompt: (hit: DirHit) => void }
  onPickNote: (hit: NoteHit) => void
  onAskAgent: (hit: NoteHit) => void
  onOpenHere?: (hit: NoteHit) => void
  onRetry?: () => void
  failed?: boolean
}) {
  const [openMenu, setOpenMenu] = useState<string | null>(null)

  if (failed) {
    return (
      <div className="px-3 py-2 flex items-center justify-between gap-2">
        <span className="text-[10px] text-[var(--text-muted)]">搜索暂时不可用</span>
        {onRetry && (
          <button type="button" onClick={onRetry}
            className="shrink-0 px-2 py-1 min-h-[32px] text-[10px] font-semibold bg-[var(--bg-hover)] rounded">重试</button>
        )}
      </div>
    )
  }

  const rowBtn = 'flex items-start gap-2 flex-1 min-w-0 px-3 py-2 min-h-[48px] text-left hover:bg-[var(--bg-hover)] transition-colors'
  const sideBtn = 'shrink-0 w-11 flex items-center justify-center text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors'
  const menuItem = 'flex items-center gap-2 w-full px-3 py-2.5 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'

  const dirSection = () => {
    const s = result.dirs
    if (!s) return null
    return (
      <div key="dirs">
        <div className="px-3 pt-2 pb-1 text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">目录</div>
        {s.indexing ? <Status text="正在建立目录索引…" />
          : s.items.length === 0 ? <Status text={s.refreshing ? '索引刷新中…' : '未找到（仅索引 6 层内）· 用「其他目录…」浏览'} />
          : (
            <ul>
              {s.items.map(h => {
                const key = `d|${h.path}`
                return (
                  <li key={key} className="border-b border-[var(--border)] last:border-b-0">
                    <div className="flex items-stretch">
                      <button type="button" className={rowBtn} title={h.path} onClick={() => onPickDir(h)}>
                        <span className="mt-0.5"><RowIcon kind="dir" agent={h.agent ?? ''} /></span>
                        <span className="flex flex-col min-w-0 flex-1">
                          <span className="truncate text-xs text-[var(--text-primary)]">{h.display}</span>
                          <Hint text={h.hint} />
                        </span>
                      </button>
                      {onDirMenu && h.agent && (
                        <button type="button" data-testid="sr-menu" className={sideBtn} title="更多操作"
                          onClick={() => setOpenMenu(c => (c === key ? null : key))}><MoreVertical size={14} /></button>
                      )}
                    </div>
                    {openMenu === key && onDirMenu && (
                      <div className="border-t border-[var(--border)] bg-[var(--bg-secondary)]">
                        <button type="button" className={menuItem} onClick={() => { setOpenMenu(null); onDirMenu.changeAgent(h) }}>
                          <Repeat size={13} className="shrink-0" />换 agent 类型
                        </button>
                        <button type="button" className={menuItem} onClick={() => { setOpenMenu(null); onDirMenu.withPrompt(h) }}>
                          <MessageSquarePlus size={13} className="shrink-0" />带 prompt 打开
                        </button>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
      </div>
    )
  }

  const noteSection = () => {
    const s = result.notes
    if (!s || !showNotes) return null
    return (
      <div key="notes">
        <div className="px-3 pt-2 pb-1 text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">笔记</div>
        {s.indexing ? <Status text="正在建立笔记索引…" />
          : s.items.length === 0 ? <Status text={s.refreshing ? '笔记索引刷新中…' : '无匹配笔记'} />
          : (
            <ul>
              {s.items.map(h => {
                const key = `n|${h.kind}|${h.path}`
                return (
                  <li key={key} className="border-b border-[var(--border)] last:border-b-0">
                    <div className="flex items-stretch">
                      <button type="button" className={rowBtn} title={h.path} onClick={() => onPickNote(h)}>
                        <span className="mt-0.5"><RowIcon kind={h.kind} agent="" /></span>
                        <span className="flex flex-col min-w-0 flex-1">
                          <span className="truncate text-xs text-[var(--text-primary)]">{h.display}</span>
                          <Hint text={h.hint} />
                        </span>
                      </button>
                      {/* ⚡ = ask an agent about this note, in the note's own folder. A separate
                          ≥44px target (never hover-only — invisible-but-tappable on phones). */}
                      <button type="button" data-testid="sr-ask" className={sideBtn} title="问 agent"
                        onClick={() => onAskAgent(h)}><Zap size={14} /></button>
                      {h.kind === 'folder' && onOpenHere && (
                        <button type="button" data-testid="sr-menu" className={sideBtn} title="更多操作"
                          onClick={() => setOpenMenu(c => (c === key ? null : key))}><MoreVertical size={14} /></button>
                      )}
                    </div>
                    {openMenu === key && onOpenHere && (
                      <div className="border-t border-[var(--border)] bg-[var(--bg-secondary)]">
                        <button type="button" className={menuItem} onClick={() => { setOpenMenu(null); onOpenHere(h) }}>
                          <FolderInput size={13} className="shrink-0" />在此开 agent
                        </button>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
      </div>
    )
  }

  return <div>{orderSections(result, showNotes).map(k => (k === 'dirs' ? dirSection() : noteSection()))}</div>
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && npx vitest run src/components/__tests__/SearchResults.test.tsx src/components/__tests__/QuickTargets.test.tsx src/components/__tests__/crewSessionType.test.tsx && npx tsc -b`
Expected: PASS；tsc 无输出。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/SearchResults.tsx frontend/src/components/QuickTargets.tsx frontend/src/components/Sidebar.tsx frontend/src/components/__tests__/SearchResults.test.tsx frontend/src/components/__tests__/QuickTargets.test.tsx
git commit -m "feat(frontend): 共享搜索结果组件(两段/⚡/⋮/边界态);QuickTargets 去 onEmpty

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Sidebar 首屏搜索框 + 目录/笔记点击流程 + ⚡ 问 agent

**Files:**
- Modify: `frontend/src/components/Sidebar.tsx`（Props 加 `onOpenVault`、`askAgentRequest`；新增 state `query`/`searchResult`/`searchFailed`/`pendingSkipPrompt`/`pendingAgentContext`；`step === 'quick'` 段重写；`selectType`/`openTypePicker`/`close`/pick-type 渲染微调）
- Create: `frontend/src/lib/askAgent.ts`（纯函数：预填 prompt）
- Create: `frontend/src/lib/__tests__/askAgent.test.ts`
- Create: `frontend/src/components/__tests__/Sidebar.search.test.tsx`

**Interfaces:**
- Consumes: Task 7 `searchPaths`, `warmSearchIndex`；Task 8 `SearchResults`
- Produces:
  ```ts
  // lib/askAgent.ts
  export interface AskAgentTarget { absDir: string; relPath: string; kind: 'note' | 'folder' }
  export function askAgentPrompt(t: AskAgentTarget): string   // "当前笔记：<rel>\n\n" | "当前目录：<rel>/\n\n"
  // Sidebar Props additions
  onOpenVault?: (target: { path: string; kind: 'note' | 'folder' }) => void
  askAgentRequest?: (AskAgentTarget & { nonce: number }) | null
  ```

- [ ] **Step 1: Write the failing tests**

`frontend/src/lib/__tests__/askAgent.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { askAgentPrompt } from '../askAgent'

describe('askAgentPrompt', () => {
  it('prefixes the note path', () => {
    expect(askAgentPrompt({ absDir: '/v/a', relPath: 'a/Text3.md', kind: 'note' })).toBe('当前笔记：a/Text3.md\n\n')
  })
  it('prefixes the folder path with a trailing slash', () => {
    expect(askAgentPrompt({ absDir: '/v/a', relPath: 'a', kind: 'folder' })).toBe('当前目录：a/\n\n')
  })
})
```

`frontend/src/components/__tests__/Sidebar.search.test.tsx`：

```tsx
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import Sidebar from '../Sidebar'
import * as api from '../../lib/api'
import type { SearchResult } from '../../lib/api'

const sec = <T,>(kind: 'dirs' | 'notes', items: T[]) => ({ kind, indexing: false, refreshing: false, truncated: false, items })
const R = (dirs: SearchResult['dirs'], notes: SearchResult['notes']): SearchResult => ({ dirs, notes })

function setup(over: Partial<React.ComponentProps<typeof Sidebar>> = {}) {
  const onCreate = vi.fn(), onOpenVault = vi.fn(), onToggle = vi.fn()
  const props = {
    sessions: [], docTabs: [], activeId: null, onSelect: vi.fn(), onCreate, onOpenVault,
    onDelete: vi.fn(), onRename: vi.fn(), hasUnread: () => false, onLogout: vi.fn(),
    theme: 'dark' as const, onToggleTheme: vi.fn(), user: { id: 'u', login: 'u', role: 'admin', status: 'active' } as api.UserInfo,
    open: true, onToggle, mobile: false, ...over,
  }
  render(<Sidebar {...props} />)
  return { onCreate, onOpenVault, onToggle }
}

async function openAndType(q: string) {
  fireEvent.click(screen.getByText('New session'))
  const input = await screen.findByPlaceholderText('搜索目录或笔记…')
  fireEvent.change(input, { target: { value: q } })
  return input
}

describe('Sidebar New Session search', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.spyOn(api, 'getSchedulerHealth').mockResolvedValue({ heartbeat_ms: 1, healthy: true })
    vi.spyOn(api, 'getVaultMeta').mockResolvedValue({ enabled: true, name: 'obsidian' })
    vi.spyOn(api, 'listQuickTargets').mockResolvedValue({ top: [] })
    vi.spyOn(api, 'listPrompts').mockResolvedValue([])
  })

  it('warms the index when the popover opens', async () => {
    const warm = vi.spyOn(api, 'warmSearchIndex').mockResolvedValue()
    setup()
    fireEvent.click(screen.getByText('New session'))
    await waitFor(() => expect(warm).toHaveBeenCalledWith('dirs,notes'))
  })

  it('dir hit with a known agent creates in one tap', async () => {
    vi.spyOn(api, 'warmSearchIndex').mockResolvedValue()
    vi.spyOn(api, 'searchPaths').mockResolvedValue(R(sec('dirs', [{ path: '/h/zeromux', display: 'zeromux', hint: '~', agent: 'claude', score: 80 }]), sec('notes', [])))
    const { onCreate } = setup()
    await openAndType('zmx')
    fireEvent.click(await screen.findByText('zeromux'))
    expect(onCreate).toHaveBeenCalledWith('claude', '/h/zeromux')
  })

  it('dir hit without agent → pick-type → creates directly (no prompt page)', async () => {
    vi.spyOn(api, 'warmSearchIndex').mockResolvedValue()
    vi.spyOn(api, 'searchPaths').mockResolvedValue(R(sec('dirs', [{ path: '/h/new-repo', display: 'new-repo', hint: '~', agent: null, score: 80 }]), sec('notes', [])))
    const { onCreate } = setup()
    await openAndType('new')
    fireEvent.click(await screen.findByText('new-repo'))
    fireEvent.click(await screen.findByText('Claude Code'))
    expect(onCreate).toHaveBeenCalledWith('claude', '/h/new-repo')
    expect(screen.queryByPlaceholderText('给 agent 的第一条指令，留空则只创建会话')).toBeNull()
  })

  it('note row opens the vault; ⚡ goes to pick-type without Terminal then a prefilled prompt', async () => {
    vi.spyOn(api, 'warmSearchIndex').mockResolvedValue()
    const hit = { path: '考研英语/2019/英语二/阅读理解/Text3.md', kind: 'note' as const, display: 'Text3', hint: '考研英语/2019/英语二/阅读理解', abs_dir: '/v/考研英语/2019/英语二/阅读理解', score: 90 }
    vi.spyOn(api, 'searchPaths').mockResolvedValue(R(sec('dirs', []), sec('notes', [hit])))
    const { onCreate, onOpenVault } = setup()
    await openAndType('19t3')
    fireEvent.click(await screen.findByText('Text3'))
    expect(onOpenVault).toHaveBeenCalledWith({ path: hit.path, kind: 'note' })

    await openAndType('19t3')
    fireEvent.click(await screen.findByTestId('sr-ask'))
    expect(await screen.findByText('Claude Code')).toBeInTheDocument()
    expect(screen.queryByText('Terminal')).toBeNull()   // tmux would drop the context
    fireEvent.click(screen.getByText('Claude Code'))
    const ta = await screen.findByPlaceholderText('给 agent 的第一条指令，留空则只创建会话') as HTMLTextAreaElement
    expect(ta.value.startsWith(`当前笔记：${hit.path}`)).toBe(true)
    fireEvent.click(screen.getByText('Create & send'))
    expect(onCreate).toHaveBeenCalledWith('claude', hit.abs_dir, undefined, ta.value)
  })

  it('stale search responses are dropped', async () => {
    vi.spyOn(api, 'warmSearchIndex').mockResolvedValue()
    let resolveSlow!: (r: SearchResult) => void
    vi.spyOn(api, 'searchPaths')
      .mockImplementationOnce(() => new Promise(r => { resolveSlow = r }))
      .mockResolvedValueOnce(R(sec('dirs', [{ path: '/h/fast', display: 'fast', hint: '~', agent: null, score: 1 }]), sec('notes', [])))
    setup()
    const input = await openAndType('s')
    await act(async () => { vi.advanceTimersByTime(200) })
    fireEvent.change(input, { target: { value: 'fa' } })
    await act(async () => { vi.advanceTimersByTime(200) })
    await screen.findByText('fast')
    await act(async () => { resolveSlow(R(sec('dirs', [{ path: '/h/slow', display: 'slow', hint: '~', agent: null, score: 1 }]), sec('notes', []))) })
    expect(screen.queryByText('slow')).toBeNull()
    expect(screen.getByText('fast')).toBeInTheDocument()
  })

  it('back from pick-type keeps the query', async () => {
    vi.spyOn(api, 'warmSearchIndex').mockResolvedValue()
    vi.spyOn(api, 'searchPaths').mockResolvedValue(R(sec('dirs', [{ path: '/h/x', display: 'x-repo', hint: '~', agent: null, score: 1 }]), sec('notes', [])))
    setup()
    await openAndType('xr')
    fireEvent.click(await screen.findByText('x-repo'))
    fireEvent.click(await screen.findByTitle('返回'))
    expect((screen.getByPlaceholderText('搜索目录或笔记…') as HTMLInputElement).value).toBe('xr')
  })

  it('askAgentRequest from VaultReader opens the flow once per nonce', async () => {
    vi.spyOn(api, 'warmSearchIndex').mockResolvedValue()
    setup({ askAgentRequest: { absDir: '/v/a', relPath: 'a/n.md', kind: 'note', nonce: 1 } })
    expect(await screen.findByText('Claude Code')).toBeInTheDocument()
    expect(screen.queryByText('Terminal')).toBeNull()
  })
})
```

> 上面 `user` 对象的字段以 `api.ts` 的 `UserInfo` 为准（`grep -n "export interface UserInfo" -A8 frontend/src/lib/api.ts`），缺字段按其定义补齐；`getSchedulerHealth` 返回类型同理。

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run src/lib/__tests__/askAgent.test.ts src/components/__tests__/Sidebar.search.test.tsx`
Expected: FAIL（`askAgent` 模块不存在；搜索框不存在）。

- [ ] **Step 3: Implement**

`frontend/src/lib/askAgent.ts`：

```ts
export interface AskAgentTarget { absDir: string; relPath: string; kind: 'note' | 'folder' }

/** The context line prefilled into the new agent's first prompt. Only the PATH is
 *  passed — notes can be ~300KB; the agent reads the file itself. Presets wrap it
 *  via `{{input}}`. */
export function askAgentPrompt(t: AskAgentTarget): string {
  return t.kind === 'note' ? `当前笔记：${t.relPath}\n\n` : `当前目录：${t.relPath}/\n\n`
}
```

`Sidebar.tsx` 改动：

1. imports：`import { listDirectories, listTmuxSessions, getSchedulerHealth, getVaultMeta, searchPaths, warmSearchIndex } from '../lib/api'`；`import type { …, SearchResult, DirHit, NoteHit } from '../lib/api'`；`import SearchResults from './SearchResults'`；`import { askAgentPrompt, type AskAgentTarget } from '../lib/askAgent'`；lucide 加 `Search`。

2. `interface Props` 加：
   ```ts
     /** Optional only so this task compiles before App wires it (Task 10); App always passes it. */
     onOpenVault?: (target: { path: string; kind: 'note' | 'folder' }) => void
     askAgentRequest?: (AskAgentTarget & { nonce: number }) | null
   ```
   并加进函数参数解构。

3. state（`pendingDir` 之后）：
   ```ts
     // Search on the New Session first screen. The query lives at Sidebar level so
     // going pick-type → back keeps it; openTypePicker clears it.
     const [query, setQuery] = useState('')
     const [searchResult, setSearchResult] = useState<SearchResult | null>(null)
     const [searchFailed, setSearchFailed] = useState(false)
     const searchReqRef = useRef(0)
     // Set when a search hit fixed the dir: after picking a type, create directly
     // instead of showing the prompt page (a middle page would undo "one tap").
     const [pendingSkipPrompt, setPendingSkipPrompt] = useState(false)
     // Set by ⚡: the session must carry context → hide Terminal (tmux ignores
     // initial_prompt) and prefill the prompt page.
     const [pendingAgentContext, setPendingAgentContext] = useState<AskAgentTarget | null>(null)
   ```

4. 搜索 effect（放在 `loadTmuxSessions` 之后）：
   ```ts
     const runSearch = useCallback((q: string) => {
       const req = ++searchReqRef.current
       if (!q.trim()) { setSearchResult(null); setSearchFailed(false); return }
       searchPaths(q, vaultEnabled ? 'dirs,notes' : 'dirs')
         .then(r => {
           if (searchReqRef.current !== req) return
           setSearchResult(r); setSearchFailed(false)
           const refreshing = (r.dirs?.refreshing && r.dirs.items.length === 0) || (r.notes?.refreshing && r.notes.items.length === 0)
           if (refreshing) setTimeout(() => { if (searchReqRef.current === req) runSearch(q) }, 4000)
         })
         .catch(() => { if (searchReqRef.current === req) { setSearchResult(null); setSearchFailed(true) } })
     }, [vaultEnabled])

     useEffect(() => {
       if (step !== 'quick') return
       const t = setTimeout(() => runSearch(query), 150)
       return () => clearTimeout(t)
     }, [query, step, runSearch])
   ```

5. `openTypePicker` 改为：
   ```ts
     const openTypePicker = () => {
       setStep('quick')
       setPendingType(null)
       setPendingDir(null)   // start clean on every open so a leftover dir can't leak in
       setPendingSkipPrompt(false)
       setPendingAgentContext(null)
       setQuery('')
       setSearchResult(null)
       warmSearchIndex('dirs,notes')
     }
   ```
   `close()` 追加 `setPendingSkipPrompt(false); setPendingAgentContext(null)`。

6. `selectType` 的 `else if (pendingDir)` 分支改为：
   ```ts
       } else if (pendingDir && pendingSkipPrompt) {
         onCreate(type, pendingDir)
         closeAfterCreate()
       } else if (pendingDir) {
         // Arrived from a quick card's "换 agent 类型" or from ⚡: the dir is fixed,
         // only the type changes → straight to the prompt page (prefilled for ⚡).
         setPromptDraft(pendingAgentContext ? askAgentPrompt(pendingAgentContext) : '')
         presetStore.reload()
         setStep('pick-prompt')
       } else {
   ```
   `selectNewShell` 同样尊重 `pendingSkipPrompt`（它已经直接建）——无需改。

7. 搜索命中的处理函数（`selectDir` 之后）：
   ```ts
     const pickDirHit = (h: DirHit) => {
       if (h.agent) { onCreate(h.agent, h.path); closeAfterCreate(); return }
       setPendingDir(h.path); setPendingSkipPrompt(true); setPendingAgentContext(null); setStep('pick-type')
     }
     const pickNoteHit = (h: NoteHit) => {
       onOpenVault?.({ path: h.path, kind: h.kind })
       closeAfterCreate()
     }
     const askAgent = (t: AskAgentTarget) => {
       setPendingDir(t.absDir); setPendingSkipPrompt(false); setPendingAgentContext(t); setStep('pick-type')
     }
     const openHere = (h: NoteHit) => {
       setPendingDir(h.abs_dir); setPendingSkipPrompt(true); setPendingAgentContext(null); setStep('pick-type')
     }
   ```

8. `askAgentRequest` 消费（按 nonce 一次）：
   ```ts
     const lastAskNonce = useRef(0)
     useEffect(() => {
       if (!askAgentRequest || askAgentRequest.nonce === lastAskNonce.current) return
       lastAskNonce.current = askAgentRequest.nonce
       if (mobile && !open) onToggle()
       setPendingType(null)
       askAgent(askAgentRequest)
     // eslint-disable-next-line react-hooks/exhaustive-deps
     }, [askAgentRequest])
   ```

9. `step === 'quick'` 段重写为（替换 `{step === 'quick' && ( … )}` 整段）：
   ```tsx
               {step === 'quick' && (
                 <>
                   <div className="px-3 py-1.5 text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">
                     新建会话
                   </div>
                   {/* Results area is the only part that grows; capped so the popover (which
                       grows UPWARD from the bottom anchor) never pushes the input off-screen. */}
                   <div className="max-h-[40vh] overflow-y-auto border-b border-[var(--border)]">
                     {query.trim() ? (
                       searchResult || searchFailed ? (
                         <SearchResults
                           result={searchResult ?? { dirs: null, notes: null }}
                           failed={searchFailed}
                           onRetry={() => runSearch(query)}
                           showNotes={vaultEnabled}
                           onPickDir={pickDirHit}
                           onDirMenu={{
                             changeAgent: (h) => { setPendingDir(h.path); setPendingSkipPrompt(false); setStep('pick-type') },
                             withPrompt: (h) => { setPendingDir(h.path); setPendingType(h.agent); setPromptDraft(''); presetStore.reload(); setStep(h.agent ? 'pick-prompt' : 'pick-type') },
                           }}
                           onPickNote={pickNoteHit}
                           onAskAgent={(h) => askAgent({ absDir: h.abs_dir, relPath: h.path, kind: h.kind })}
                           onOpenHere={openHere}
                         />
                       ) : <div className="px-3 py-2 text-[10px] text-[var(--text-muted)]">搜索中…</div>
                     ) : (
                       /* 一击直达：点一行 = 用该行的 agent 直接创建，0 次列目录请求。 */
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
                       />
                     )}
                   </div>
                   <button type="button" onClick={() => { setPendingDir(null); setPendingSkipPrompt(false); setStep('pick-type') }}
                     className="flex items-center gap-2 w-full px-3 py-2.5 min-h-[44px] text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors">
                     <Folder size={13} className="shrink-0" /><span>其他目录…</span>
                   </button>
                   {vaultEnabled && (
                     <button type="button" onClick={() => { onCreate('vault'); closeAfterCreate() }}
                       className="flex items-center gap-2 w-full px-3 py-2.5 min-h-[44px] text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors">
                       <BookOpen size={13} className="shrink-0" /><span>Obsidian 笔记库</span>
                     </button>
                   )}
                   {/* Input at the BOTTOM: next to the anchor and the thumb; results growing
                       upward never move it. No autoFocus on phones (the QuickTargets one-tap is
                       still the main path and a keyboard would cover it). */}
                   <div className="flex items-center gap-2 mx-2 my-1.5 px-2 py-1.5 rounded bg-[var(--bg-secondary)] border border-[var(--border)]">
                     <Search size={13} className="text-[var(--text-muted)] shrink-0" />
                     <input
                       value={query}
                       onChange={e => setQuery(e.target.value)}
                       onKeyDown={e => {
                         if (e.key !== 'Enter' || !searchResult) return
                         e.preventDefault()
                         const first = [...(searchResult.dirs?.items ?? []).map(h => ({ t: 'd' as const, h, s: h.score })),
                           ...(vaultEnabled ? searchResult.notes?.items ?? [] : []).map(h => ({ t: 'n' as const, h, s: h.score }))]
                           .sort((a, b) => b.s - a.s)[0]
                         if (!first) return
                         if (first.t === 'd') pickDirHit(first.h as DirHit); else pickNoteHit(first.h as NoteHit)
                       }}
                       maxLength={128}
                       autoFocus={!mobile}
                       placeholder="搜索目录或笔记…"
                       className="flex-1 min-w-0 bg-transparent text-xs outline-none text-[var(--text-primary)]"
                     />
                   </div>
                 </>
               )}
   ```

10. pick-type 的返回按钮：`onClick={() => { setPendingDir(null); setPendingSkipPrompt(false); setPendingAgentContext(null); setStep('quick') }}`（查询词保留）。Terminal 按钮外包一层 `{!pendingAgentContext && ( … )}`；Obsidian 文档按钮同样包 `{vaultEnabled && !pendingAgentContext && ( … )}`。

11. 手机键盘补偿：在弹层容器（`absolute bottom-full left-2 …` 那个 div）上加 `ref={popRef}`，并加 effect（参照 `TerminalView.tsx:391-410`）：
    ```ts
      const popRef = useRef<HTMLDivElement>(null)
      useEffect(() => {
        if (!mobile || step === 'closed') return
        const vv = window.visualViewport
        if (!vv) return
        const apply = () => {
          const overlap = Math.max(0, window.innerHeight - vv.height - vv.offsetTop)
          if (popRef.current) popRef.current.style.transform = overlap ? `translateY(-${overlap}px)` : ''
        }
        apply()
        vv.addEventListener('resize', apply)
        vv.addEventListener('scroll', apply)
        return () => {
          vv.removeEventListener('resize', apply)
          vv.removeEventListener('scroll', apply)
          if (popRef.current) popRef.current.style.transform = ''
        }
      }, [mobile, step])
    ```

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && npx vitest run src/lib/__tests__/askAgent.test.ts src/components/__tests__/Sidebar.search.test.tsx src/components/__tests__/crewSessionType.test.tsx && npx tsc -b`
Expected: PASS。然后**验红**：临时把 `runSearch` 里 `.then` 的 `if (searchReqRef.current !== req) return` 注释掉，重跑 `Sidebar.search.test.tsx`，`stale search responses are dropped` 必须 FAIL；恢复后再 PASS。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/Sidebar.tsx frontend/src/lib/askAgent.ts frontend/src/lib/__tests__/askAgent.test.ts frontend/src/components/__tests__/Sidebar.search.test.tsx
git commit -m "feat(frontend): New Session 首屏模糊搜索 + ⚡ 问 agent + vault 文件夹开会话

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: App 接线（`onOpenVault` 复用 doc tab / `onAskAgent`）+ VaultReader（target / 新搜索 / ⚡）

**Files:**
- Modify: `frontend/src/App.tsx:241-247`（`handleCreate` 旁新增 `handleOpenVault`、`handleAskAgent`；state `docTargets`、`askAgentRequest`）、`:320-337`（Sidebar props）、`:404-410`（VaultReader props）
- Modify: `frontend/src/components/VaultReader.tsx`（props `target`、`onAskAgent`；搜索改 `searchPaths(q,'notes',50)` 与结果行；挂载 warm）
- Modify: `frontend/src/components/__tests__/VaultReader.test.tsx`
- Create: `frontend/src/lib/docTarget.ts` + `frontend/src/lib/__tests__/docTarget.test.ts`（纯函数：选哪个 tab）

**Interfaces:**
- Consumes: Task 7 `searchPaths`, `warmSearchIndex`, `NoteHit`；Task 9 `AskAgentTarget`、Sidebar `onOpenVault`/`askAgentRequest`
- Produces:
  ```ts
  // lib/docTarget.ts
  export function pickDocTabForTarget(tabs: DocTab[]): string | null   // most recently created = last; null → create new
  // VaultReader props
  target?: { path: string; kind: 'note' | 'folder'; nonce: number } | null
  onAskAgent?: (t: AskAgentTarget) => void
  ```

- [ ] **Step 1: Write the failing tests**

`frontend/src/lib/__tests__/docTarget.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { pickDocTabForTarget } from '../docTarget'

describe('pickDocTabForTarget', () => {
  it('reuses the most recently created doc tab', () => {
    expect(pickDocTabForTarget([{ id: 'doc-a', title: 't', kind: 'vault' }, { id: 'doc-b', title: 't', kind: 'vault' }])).toBe('doc-b')
  })
  it('returns null when there is none (caller creates one)', () => {
    expect(pickDocTabForTarget([])).toBeNull()
  })
})
```

`VaultReader.test.tsx`：mock 改为（替换文件顶部 `vi.mock` 块中的 `getVaultSearch` 行，并加两项）：

```ts
  searchPaths: vi.fn(async () => ({ dirs: null, notes: { kind: 'notes', indexing: false, refreshing: false, truncated: false, items: [] } })),
  warmSearchIndex: vi.fn(async () => {}),
```

追加测试：

```tsx
  it('target (note) opens the note; a new nonce re-triggers', async () => {
    const { rerender } = render(<VaultReader target={{ path: 'note.md', kind: 'note', nonce: 1 }} />)
    await waitFor(() => expect(api.getVaultFile).toHaveBeenCalledWith('note.md'))
    vi.mocked(api.getVaultFile).mockClear()
    rerender(<VaultReader target={{ path: 'note.md', kind: 'note', nonce: 1 }} />)
    expect(api.getVaultFile).not.toHaveBeenCalled()
    rerender(<VaultReader target={{ path: 'note.md', kind: 'note', nonce: 2 }} />)
    await waitFor(() => expect(api.getVaultFile).toHaveBeenCalledWith('note.md'))
  })

  it('target (folder) lists that folder', async () => {
    render(<VaultReader target={{ path: 'projects/x', kind: 'folder', nonce: 1 }} />)
    await waitFor(() => expect(api.listVault).toHaveBeenCalledWith('projects/x'))
  })

  it('search results include folders; tapping a folder navigates AND clears the query', async () => {
    vi.mocked(api.searchPaths).mockResolvedValue({ dirs: null, notes: { kind: 'notes', indexing: false, refreshing: false, truncated: false, items: [
      { path: 'projects/x', kind: 'folder', display: 'x', hint: 'projects', abs_dir: '/v/projects/x', score: 9 },
    ] } })
    render(<VaultReader />)
    const input = screen.getByPlaceholderText('搜索笔记名…') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'x' } })
    fireEvent.click(await screen.findByText('x'))
    await waitFor(() => expect(api.listVault).toHaveBeenCalledWith('projects/x'))
    expect(input.value).toBe('')
  })

  it('⚡ on a search result calls onAskAgent with the note context', async () => {
    vi.mocked(api.searchPaths).mockResolvedValue({ dirs: null, notes: { kind: 'notes', indexing: false, refreshing: false, truncated: false, items: [
      { path: 'a/n.md', kind: 'note', display: 'n', hint: 'a', abs_dir: '/v/a', score: 9 },
    ] } })
    const onAskAgent = vi.fn()
    render(<VaultReader onAskAgent={onAskAgent} />)
    fireEvent.change(screen.getByPlaceholderText('搜索笔记名…'), { target: { value: 'n' } })
    fireEvent.click(await screen.findByTestId('sr-ask'))
    expect(onAskAgent).toHaveBeenCalledWith({ absDir: '/v/a', relPath: 'a/n.md', kind: 'note' })
  })

  it('warms the notes index on mount', async () => {
    render(<VaultReader />)
    await waitFor(() => expect(api.warmSearchIndex).toHaveBeenCalledWith('notes'))
  })
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run src/lib/__tests__/docTarget.test.ts src/components/__tests__/VaultReader.test.tsx`
Expected: FAIL。

- [ ] **Step 3: Implement**

`frontend/src/lib/docTarget.ts`：

```ts
import type { DocTab } from './docTabs'

/** Opening a note from search reuses the most recently created doc tab (tabs are
 *  appended, so the last one) instead of spawning a new tab per tap — on a phone
 *  tabs would pile up and each one keeps a VaultReader mounted. */
export function pickDocTabForTarget(tabs: DocTab[]): string | null {
  return tabs.length ? tabs[tabs.length - 1].id : null
}
```

`VaultReader.tsx`：
- 签名：
  ```ts
  export default function VaultReader({ onClose, onTitleChange, target, onAskAgent }: {
    onClose?: () => void
    onTitleChange?: (title: string | null) => void
    target?: { path: string; kind: 'note' | 'folder'; nonce: number } | null
    onAskAgent?: (t: AskAgentTarget) => void
  }) {
  ```
- import：`import { listVault, getVaultFile, searchPaths, warmSearchIndex, resolveWikiLink } from '../lib/api'`；`import type { DirListEntry, SearchResult, NoteHit } from '../lib/api'`；`import SearchResults from './SearchResults'`；`import type { AskAgentTarget } from '../lib/askAgent'`。
- state `results`/`searchTruncated` 替换为 `const [search, setSearch] = useState<SearchResult | null>(null)`。
- 搜索 effect 改为：
  ```ts
  useEffect(() => {
    const t = setTimeout(() => {
      const req = ++searchReqRef.current
      if (!query.trim()) { setSearch(null); return }
      searchPaths(query, 'notes', 50)
        .then(r => { if (searchReqRef.current === req) setSearch(r) })
        .catch(() => { if (searchReqRef.current === req) setSearch(null) })
    }, 200)
    return () => clearTimeout(t)
  }, [query])

  useEffect(() => { warmSearchIndex('notes') }, [])
  ```
- `openNote` 之后加 target 消费：
  ```ts
  const lastTargetNonce = useRef(0)
  useEffect(() => {
    if (!target || target.nonce === lastTargetNonce.current) return
    lastTargetNonce.current = target.nonce
    if (target.kind === 'note') { openNote(target.path); return }
    setMode('list'); setQuery(''); setCwd(target.path); onTitleChange?.(null)
  }, [target, openNote, onTitleChange])

  const pickHit = (h: NoteHit) => {
    if (h.kind === 'note') { openNote(h.path); return }
    // Clear the query too: while it's non-empty the result list keeps rendering,
    // so navigating alone would look like the tap did nothing.
    setQuery(''); setCwd(h.path)
  }
  ```
- LIST MODE 中 `{query.trim() ? ( <ul>…results…</ul> ) : …}` 的结果分支替换为：
  ```tsx
        {query.trim() ? (
          search?.notes ? (
            <>
              <SearchResults
                result={search}
                showNotes
                onPickDir={() => {}}
                onPickNote={pickHit}
                onAskAgent={(h) => onAskAgent?.({ absDir: h.abs_dir, relPath: h.path, kind: h.kind })}
              />
              {search.notes.truncated && <div className="px-3 py-2 text-xs text-[var(--accent-yellow)]">仅显示前 50 条，请细化搜索</div>}
            </>
          ) : <div className="px-3 py-2 text-xs text-[var(--text-secondary)]">搜索中…</div>
        ) : (
  ```
  （`search` 的 `dirs` 为 null → `SearchResults` 不渲染目录段。）

`App.tsx`：
- import：`import { pickDocTabForTarget } from './lib/docTarget'`；`import type { AskAgentTarget } from './lib/askAgent'`。
- state（`docTabs` 附近）：
  ```ts
  // In-memory only (never persisted): refresh reopens doc tabs in list mode.
  const [docTargets, setDocTargets] = useState<Record<string, { path: string; kind: 'note' | 'folder'; nonce: number }>>({})
  const [askAgentRequest, setAskAgentRequest] = useState<(AskAgentTarget & { nonce: number }) | null>(null)
  const nonceRef = useRef(0)
  ```
- `handleCreate` 之后：
  ```ts
  const handleOpenVault = useCallback((target: { path: string; kind: 'note' | 'folder' }) => {
    const nonce = ++nonceRef.current
    const existing = pickDocTabForTarget(docTabsRef.current)
    const id = existing ?? (() => {
      const tab = newDocTab(DEFAULT_DOC_TITLE)
      setDocTabs(prev => [...prev, tab])
      return tab.id
    })()
    setDocTargets(prev => ({ ...prev, [id]: { ...target, nonce } }))
    setActiveId(id)
  }, [])

  const handleAskAgent = useCallback((t: AskAgentTarget) => {
    setAskAgentRequest({ ...t, nonce: ++nonceRef.current })
  }, [])
  ```
- `<Sidebar … />` 加 `onOpenVault={handleOpenVault}` 与 `askAgentRequest={askAgentRequest}`。
- `<VaultReader onTitleChange=… />` 改为 `<VaultReader onTitleChange={(title) => updateDocTabTitle(t.id, title)} target={docTargets[t.id] ?? null} onAskAgent={handleAskAgent} />`。
- `handleDeleteDocTab` 里顺手 `setDocTargets(prev => { const { [id]: _, ...rest } = prev; return rest })`。

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && npx vitest run && npx tsc -b && npm run lint`
Expected: 全部 PASS（约 290 − 1 + 新增 ≈ 315+）；tsc/lint 无错误。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/App.tsx frontend/src/components/VaultReader.tsx frontend/src/components/__tests__/VaultReader.test.tsx frontend/src/lib/docTarget.ts frontend/src/lib/__tests__/docTarget.test.ts
git commit -m "feat(frontend): 搜索结果打开笔记复用 doc tab;VaultReader 新搜索+⚡+target 定位

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: 1a 集成验证 + 部署

**Files:** 无代码改动（除非验证发现缺陷）。

- [ ] **Step 1: 全量测试**

Run（repo 根）：`cd frontend && npm run build && cd .. && cargo test 2>&1 | grep "test result"`
Expected: frontend build 成功；`test result: ok. 429 passed`。

- [ ] **Step 2: 本地冒烟（非 live 端口）**

```bash
cargo build
./target/debug/zeromux --port 8099 --password smoke --work-dir $HOME --vault-dir $HOME/s3-workspace/keith-space/obsidian > /tmp/zmx-smoke.log 2>&1 &
sleep 3; grep -n "listening" /tmp/zmx-smoke.log      # 应在 ~3s 内出现（不再等 46s vault 遍历）
TOKEN=$(curl -s -X POST localhost:8099/auth/login -H 'content-type: application/json' -d '{"password":"smoke"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
curl -s "localhost:8099/api/search?q=zmx&scope=dirs" -H "Authorization: Bearer $TOKEN" | python3 -m json.tool | head -20
curl -s -o /dev/null -w '%{http_code}\n' "localhost:8099/api/vault/resolve?name=_index" -H "Authorization: Bearer $TOKEN"   # 启动 50s 内应为 503
sleep 60
curl -s "localhost:8099/api/search?q=单词&scope=notes" -H "Authorization: Bearer $TOKEN" | python3 -m json.tool | head -30   # 今天的单词笔记排第一
curl -s -o /dev/null -w '%{http_code}\n' "localhost:8099/api/vault/search?q=x" -H "Authorization: Bearer $TOKEN"   # 应非 200（SPA fallback 或 404）
kill %1
```

Expected：listening 秒级出现；dirs 段首条是 `zeromux`；resolve 先 503；notes 段 `单词` 首条为最新日期；旧接口不可用。

> 登录接口字段以 `web.rs:142 legacy_login` 实际返回为准（`grep -n "fn legacy_login" -A25 src/web.rs`）。

- [ ] **Step 3: 真机验收（iOS Safari，用户手机）**

部署后在手机上：打开 New Session → 点底部搜索框 → 键盘弹起时输入框与结果前 3 条可见；结果滚动不带动输入框；搜 `阅读理解` → 笔记段有内容文件夹排在空骨架之前；点 ⚡ → 类型中无 Terminal → 选 Claude → prompt 预填「当前笔记：…」→ 点「📝 基于笔记出题」chip → 发送 → 会话 work_dir 为该笔记文件夹。

- [ ] **Step 4: 部署**

先 push 再 deploy（本 repo 教训：在 zeromux 终端内 deploy 会在 stop 时掉线）：

```bash
git push
./deploy.sh --build
```

Expected：deploy.sh 最终行 `OK: HTTP 200`；`journalctl -u zeromux -n 50` 中 `listening` 在 `serving read-only vault` 后数秒内出现，`Added 4 study prompt presets (v2)` 出现一次。

---

## 批次 1b

### Task 12: `vault_watch` —— inotify 标脏 → 对账（取代 1a 的 vault 轮询触发）

**Files:**
- Modify: `Cargo.toml`（加 `inotify = { version = "0.11", default-features = false }`、`libc = "0.2"`）
- Create: `src/vault_watch.rs`
- Modify: `src/main.rs`（`mod vault_watch;`；`SearchIndexes::start` → `start_watched`，其后 `vault_watch::spawn(search.clone())`）
- Modify: `src/fuzzy_index.rs`（`SearchIndexes` 加 `watcher_active: AtomicBool`；`refresh_vault_if_older` / `reconcile_vault_dir` 在 watcher 活跃时变为 no-op；新增 `pub(crate) fn vault_parts(&self) -> Option<(Arc<IndexSlot<VaultSnapshot>>, Arc<Mutex<VaultModel>>, PathBuf)>`）
- Test: `src/vault_watch.rs` 内 `#[cfg(test)]`

**Interfaces:**
- Consumes: Task 1 `VaultModel::{full_scan_with, reconcile_dir_with, snapshot}`；Task 3 `SearchIndexes`, `IndexSlot::{try_begin_rebuild via claim, publish}`
- Produces:
  ```rust
  pub fn spawn(si: Arc<SearchIndexes>)                       // no-op when no vault; std::thread, catch_unwind loop
  fn run(si: &SearchIndexes) -> Result<(), String>            // one watcher lifetime; Ok = rebuild now, Err = backoff
  // fuzzy_index.rs additions:
  pub fn start_watched(home: PathBuf, vault_root: Option<PathBuf>) -> Arc<SearchIndexes>
  pub fn watcher_is_active(&self) -> bool
  pub(crate) struct Watcher { ino: Inotify, wd_to_dir: HashMap<i32, String>, root_wd: i32 }
  impl Watcher {
      fn full(root: &Path, dirty: &mut BTreeSet<String>) -> io::Result<(Watcher, VaultModel)>   // BFS add-watch-then-read, drains every 64 dirs
      fn add(&mut self, root: &Path, rel: &str)
      fn drain(&mut self, dirty: &mut BTreeSet<String>) -> Drained   // non-blocking read
  }
  enum Drained { Ok, Overflow, RootGone }
  const DEBOUNCE_MS: u64 = 300; const DEBOUNCE_MAX_MS: u64 = 1000;
  const FULL_EVERY_MS: i64 = 6 * 3600 * 1000; const MIN_REBUILD_GAP_MS: i64 = 60_000;
  const DRAIN_EVERY_DIRS: usize = 64;
  ```

- [ ] **Step 1: Write the failing tests**

`src/vault_watch.rs` 末尾：

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::Duration;

    async fn eventually(si: &SearchIndexes, pred: impl Fn(&[String]) -> bool) {
        for _ in 0..300 {
            if let Some(s) = si.vault.as_ref().unwrap().current() {
                let ps: Vec<String> = s.index.entries.iter().map(|e| e.path.clone()).collect();
                if pred(&ps) { return; }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let ps: Vec<String> = si.vault.as_ref().unwrap().current()
            .map(|s| s.index.entries.iter().map(|e| e.path.clone()).collect()).unwrap_or_default();
        panic!("condition not reached; index = {ps:?}");
    }

    async fn started(tag: &str) -> (tempfile::TempDir, tempfile::TempDir, Arc<SearchIndexes>) {
        let h = tempfile::Builder::new().prefix(&format!("zmx_vw_h_{tag}")).tempdir().unwrap();
        let v = tempfile::Builder::new().prefix(&format!("zmx_vw_v_{tag}")).tempdir().unwrap();
        fs::create_dir_all(v.path().join("单词")).unwrap();
        let si = SearchIndexes::start_watched(h.path().into(), Some(v.path().into()));
        spawn(si.clone());
        eventually(&si, |p| p.contains(&"单词".to_string())).await;
        for _ in 0..100 { if si.watcher_is_active() { break } tokio::time::sleep(Duration::from_millis(20)).await; }
        assert!(si.watcher_is_active());
        (h, v, si)
    }

    #[tokio::test]
    async fn new_note_and_empty_folder_become_searchable() {
        let (_h, v, si) = started("new").await;
        fs::write(v.path().join("单词/2026-09-25-下午.md"), "x").unwrap();
        fs::create_dir_all(v.path().join("新建文件夹")).unwrap();
        eventually(&si, |p| p.contains(&"单词/2026-09-25-下午.md".into()) && p.contains(&"新建文件夹".into())).await;
    }

    #[tokio::test]
    async fn mkdir_p_race_is_fully_indexed() {
        let (_h, v, si) = started("race").await;
        fs::create_dir_all(v.path().join("a/b/c")).unwrap();
        fs::write(v.path().join("a/b/c/x.md"), "x").unwrap();
        eventually(&si, |p| ["a", "a/b", "a/b/c", "a/b/c/x.md"].iter().all(|w| p.contains(&w.to_string()))).await;
    }

    #[tokio::test]
    async fn folder_rename_moves_subtree_and_keeps_watching() {
        let (_h, v, si) = started("mv").await;
        fs::create_dir_all(v.path().join("old/sub")).unwrap();
        fs::write(v.path().join("old/sub/n.md"), "x").unwrap();
        eventually(&si, |p| p.contains(&"old/sub/n.md".into())).await;
        fs::rename(v.path().join("old"), v.path().join("new")).unwrap();
        eventually(&si, |p| p.contains(&"new/sub/n.md".into()) && !p.iter().any(|x| x.starts_with("old"))).await;
        fs::write(v.path().join("new/sub/after.md"), "x").unwrap();
        eventually(&si, |p| p.contains(&"new/sub/after.md".into())).await;
    }

    #[tokio::test]
    async fn rename_over_existing_empty_dir_keeps_moved_tree() {
        let (_h, v, si) = started("over").await;
        fs::create_dir_all(v.path().join("A")).unwrap();
        fs::write(v.path().join("A/k.md"), "x").unwrap();
        fs::create_dir_all(v.path().join("B")).unwrap();
        eventually(&si, |p| p.contains(&"A/k.md".into()) && p.contains(&"B".into())).await;
        fs::rename(v.path().join("A"), v.path().join("B")).unwrap();
        eventually(&si, |p| p.contains(&"B/k.md".into()) && !p.contains(&"A".into())).await;
        tokio::time::sleep(Duration::from_millis(1500)).await; // let the old B's IGNORED arrive
        let ps: Vec<String> = si.vault.as_ref().unwrap().current().unwrap().index.entries.iter().map(|e| e.path.clone()).collect();
        assert!(ps.contains(&"B/k.md".into()), "old B's IGNORED must not wipe the moved tree: {ps:?}");
    }

    #[tokio::test]
    async fn sed_i_style_atomic_replace_leaves_single_note() {
        let (_h, v, si) = started("sed").await;
        fs::write(v.path().join("单词/n.md"), "a").unwrap();
        eventually(&si, |p| p.contains(&"单词/n.md".into())).await;
        fs::write(v.path().join("单词/sedXYZ"), "b").unwrap();
        fs::rename(v.path().join("单词/sedXYZ"), v.path().join("单词/n.md")).unwrap();
        tokio::time::sleep(Duration::from_millis(1500)).await;
        let ps: Vec<String> = si.vault.as_ref().unwrap().current().unwrap().index.entries.iter().map(|e| e.path.clone()).collect();
        assert_eq!(ps.iter().filter(|p| p.starts_with("单词/")).count(), 1, "{ps:?}");
    }

    #[tokio::test]
    async fn rename_to_dot_or_noise_name_counts_as_removal() {
        let (_h, v, si) = started("dot").await;
        fs::create_dir_all(v.path().join("k")).unwrap();
        fs::write(v.path().join("k/n.md"), "x").unwrap();
        fs::create_dir_all(v.path().join("m")).unwrap();
        fs::write(v.path().join("m/n.md"), "x").unwrap();
        eventually(&si, |p| p.contains(&"k/n.md".into()) && p.contains(&"m/n.md".into())).await;
        fs::rename(v.path().join("k"), v.path().join(".k")).unwrap();
        fs::rename(v.path().join("m"), v.path().join("node_modules")).unwrap();
        eventually(&si, |p| !p.iter().any(|x| x.starts_with("k") || x.starts_with("m") || x.contains("node_modules"))).await;
    }

    #[tokio::test]
    async fn delete_to_trash_removes() {
        let (_h, v, si) = started("trash").await;
        fs::write(v.path().join("单词/gone.md"), "x").unwrap();
        eventually(&si, |p| p.contains(&"单词/gone.md".into())).await;
        fs::create_dir_all(v.path().join(".trash")).unwrap();
        fs::rename(v.path().join("单词/gone.md"), v.path().join(".trash/gone.md")).unwrap();
        eventually(&si, |p| !p.contains(&"单词/gone.md".into())).await;
    }

    #[tokio::test]
    async fn obsidian_dir_is_not_watched() {
        let (_h, v, si) = started("obs").await;
        fs::create_dir_all(v.path().join(".obsidian")).unwrap();
        fs::write(v.path().join(".obsidian/workspace.json"), "{}").unwrap();
        fs::write(v.path().join(".obsidian/fake.md"), "x").unwrap();
        tokio::time::sleep(Duration::from_millis(1200)).await;
        let ps: Vec<String> = si.vault.as_ref().unwrap().current().unwrap().index.entries.iter().map(|e| e.path.clone()).collect();
        assert!(ps.iter().all(|p| !p.starts_with(".obsidian")), "{ps:?}");
    }

    #[tokio::test]
    async fn legacy_poll_triggers_are_noops_while_watcher_runs() {
        let (_h, _v, si) = started("noop").await;
        let t0 = si.vault.as_ref().unwrap().current().unwrap().built_at_ms;
        si.refresh_vault_if_older(0);
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(!si.vault.as_ref().unwrap().is_rebuilding());
        assert_eq!(si.vault.as_ref().unwrap().current().unwrap().built_at_ms, t0);
    }

    #[test]
    fn full_scan_fails_when_root_missing() {
        let d = tempfile::tempdir().unwrap();
        let gone = d.path().join("nope");
        assert!(Watcher::full(&gone, &mut BTreeSet::new()).is_err());
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test vault_watch 2>&1 | tail -10`
Expected: 编译失败（`vault_watch` 模块 / `spawn` / `Watcher` 未定义）。

- [ ] **Step 3: Implement**

`Cargo.toml`：

```toml
# Vault watcher (fuzzy-search 1b): inotify on the local JuiceFS FUSE mount. No
# `stream` feature — we poll the raw fd from a dedicated OS thread, no tokio glue.
inotify = { version = "0.11", default-features = false }
libc = "0.2"
```

`src/fuzzy_index.rs` 的 `SearchIndexes`：
- 字段加 `watcher_active: AtomicBool`（`start` 里初始化 `AtomicBool::new(false)`）。
- 新增：
  ```rust
      pub fn watcher_is_active(&self) -> bool { self.watcher_active.load(Ordering::Acquire) }
      pub(crate) fn set_watcher_active(&self, on: bool) { self.watcher_active.store(on, Ordering::Release) }
      pub(crate) fn vault_parts(&self) -> Option<(Arc<IndexSlot<VaultSnapshot>>, Arc<Mutex<VaultModel>>, PathBuf)> {
          Some((self.vault.clone()?, self.vault_model.clone()?, self.vault_root.clone()?))
      }
  ```
- `refresh_vault_if_older` 与 `reconcile_vault_dir` 函数体首行加 `if self.watcher_is_active() { return; }`（watcher 是 vault 的唯一刷新源；1a 的触发点保留为 watcher 不可用时的回退）。
- 让 `claim` 变为 `pub(crate) fn claim<T>(...)`，`OwnedGuard` 变 `pub(crate)`，`skip_name` 变 `pub(crate)`。
- `VaultModel::reconcile_dir_with` 开头加守卫：`if rel_dir.split('/').any(skip_name) && !rel_dir.is_empty() { self.remove_subtree(rel_dir); return; }`（dirty 集合里的路径可能来自已改名为 dot/噪音名的旧映射，绝不能把它们读进模型）。

`src/vault_watch.rs`：

```rust
//! Vault watcher (fuzzy-search spec §1d, batch 1b). Events only mark directories
//! dirty; after a debounce each dirty dir is reconciled against a real `read_dir`
//! (`VaultModel::reconcile_dir_with`). No cookie pairing, no counters: the review
//! measured four ways per-event bookkeeping goes wrong (rename over an existing
//! dir + its late IGNORED, sed -i temp files, scan/CREATE double counting, rename
//! to a noise name). Reconciliation makes the end state whatever the FS says.
//!
//! One dedicated OS thread owns the Inotify fd and is the sole writer of the vault
//! model while active. Full rebuilds: at start, on queue overflow / root loss, and
//! every 6h (other hosts writing the same JuiceFS don't generate local events).

use crate::fuzzy_index::{claim, now_ms, SearchIndexes, VaultModel};
use inotify::{EventMask, Inotify, WatchMask};
use std::collections::{BTreeSet, HashMap};
use std::os::fd::AsRawFd;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

const DEBOUNCE_MS: u64 = 300;
const DEBOUNCE_MAX_MS: u64 = 1000;
const FULL_EVERY_MS: i64 = 6 * 3600 * 1000;
const MIN_REBUILD_GAP_MS: i64 = 60_000;
const DRAIN_EVERY_DIRS: usize = 64;

fn mask() -> WatchMask {
    WatchMask::CREATE | WatchMask::DELETE | WatchMask::MOVED_FROM | WatchMask::MOVED_TO
        | WatchMask::ONLYDIR | WatchMask::DONT_FOLLOW
}

pub(crate) struct Watcher {
    ino: Inotify,
    wd_to_dir: HashMap<i32, String>,
    root_wd: i32,
    buf: Vec<u8>,
}

enum Drained { Ok, Overflow, RootGone }

impl Watcher {
    fn new() -> std::io::Result<Self> {
        Ok(Self { ino: Inotify::init()?, wd_to_dir: HashMap::new(), root_wd: -1, buf: vec![0u8; 64 * 1024] })
    }

    /// Watch `rel`. Re-adding an already-watched inode returns its existing wd
    /// (measured), so a renamed dir is simply re-mapped to its new path.
    fn add(&mut self, root: &Path, rel: &str) {
        let abs = if rel.is_empty() { root.to_path_buf() } else { root.join(rel) };
        match self.ino.watches().add(&abs, mask()) {
            Ok(wd) => {
                let id = wd.get_watch_descriptor_id();
                if rel.is_empty() { self.root_wd = id; }
                self.wd_to_dir.insert(id, rel.to_string());
            }
            // ENOSPC etc.: this dir falls back to the 6h full rebuild; no retry storm.
            Err(e) => eprintln!("[vault_watch] add_watch {rel:?} failed: {e}"),
        }
    }

    /// Non-blocking drain of all queued events into `dirty` (parent dirs).
    fn drain(&mut self, dirty: &mut BTreeSet<String>) -> Drained {
        loop {
            let events = match self.ino.read_events(&mut self.buf) {
                Ok(ev) => ev,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => return Drained::Ok,
                Err(e) => { eprintln!("[vault_watch] read failed: {e}"); return Drained::RootGone; }
            };
            let mut any = false;
            for ev in events {
                any = true;
                if ev.mask.contains(EventMask::Q_OVERFLOW) { return Drained::Overflow; }
                if ev.mask.contains(EventMask::UNMOUNT) { return Drained::RootGone; }
                let id = ev.wd.get_watch_descriptor_id();
                if ev.mask.contains(EventMask::IGNORED) {
                    if id == self.root_wd { return Drained::RootGone; }
                    // Non-root: only drop the stale mapping. Removal of the dir itself
                    // is discovered by reconciling its parent — never delete the model
                    // subtree here (rename-over-existing sends the OLD dir's IGNORED
                    // after the moved tree already took its path).
                    self.wd_to_dir.remove(&id);
                    continue;
                }
                let Some(dir) = self.wd_to_dir.get(&id).cloned() else {
                    continue; // unknown wd: leftover watch on a dir moved out (e.g. to .trash)
                };
                // A dir that appears by NAME (created, or renamed/moved in — possibly over an
                // existing empty dir of the same name) must itself be rescanned: reconciling
                // only the parent would treat an existing same-named child as "known" and
                // miss the moved-in contents.
                if ev.mask.contains(EventMask::ISDIR)
                    && ev.mask.intersects(EventMask::CREATE | EventMask::MOVED_TO)
                {
                    if let Some(n) = ev.name.and_then(|n| n.to_str()) {
                        if !crate::fuzzy_index::skip_name(n) {
                            dirty.insert(if dir.is_empty() { n.to_string() } else { format!("{dir}/{n}") });
                        }
                    }
                }
                dirty.insert(dir);
            }
            if !any { return Drained::Ok; }
        }
    }

    /// Full BFS: watch-then-read every dir, draining the new queue every 64 dirs
    /// so a burst during the ~52s walk can't overflow it.
    fn full(root: &Path, dirty: &mut BTreeSet<String>) -> std::io::Result<(Watcher, VaultModel)> {
        let mut w = Watcher::new()?;
        let mut n = 0usize;
        let mut overflow = false;
        let model = {
            let wref = &mut w;
            VaultModel::full_scan_with(root, &mut |rel| {
                wref.add(root, rel);
                n += 1;
                if n % DRAIN_EVERY_DIRS == 0 {
                    if let Drained::Overflow = wref.drain(dirty) { overflow = true; }
                }
            })?
        };
        if overflow { dirty.insert(String::new()); } // reconcile the whole tree once more
        Ok((w, model))
    }

    fn wait(&self, timeout: Duration) {
        let mut pfd = libc::pollfd { fd: self.ino.as_raw_fd(), events: libc::POLLIN, revents: 0 };
        let ms = timeout.as_millis().min(i32::MAX as u128) as i32;
        // SAFETY: one valid pollfd for the duration of the call.
        unsafe { libc::poll(&mut pfd, 1, ms) };
    }
}

pub fn spawn(si: Arc<SearchIndexes>) {
    if si.vault_parts().is_none() { return; }
    std::thread::Builder::new()
        .name("vault-watch".into())
        .spawn(move || {
            let mut backoff = Duration::from_secs(1);
            loop {
                let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run(&si)));
                si.set_watcher_active(false);
                match r {
                    Ok(Ok(())) => backoff = Duration::from_secs(1),
                    Ok(Err(e)) => eprintln!("[vault_watch] stopped: {e}; retrying in {backoff:?}"),
                    Err(_) => eprintln!("[vault_watch] panicked; retrying in {backoff:?}"),
                }
                std::thread::sleep(backoff);
                backoff = (backoff * 2).min(Duration::from_secs(600));
            }
        })
        .expect("spawn vault-watch thread");
}

/// One watcher lifetime: full build, then the event loop until a rebuild is
/// needed (returns Ok to rebuild immediately) or an error (Err → backoff).
fn run(si: &SearchIndexes) -> Result<(), String> {
    let (slot, model, root) = si.vault_parts().ok_or("no vault")?;
    let mut last_full = i64::MIN;
    loop {
        // Space rebuilds out so a burst still in progress can't loop us.
        let gap = now_ms().saturating_sub(last_full);
        if gap < MIN_REBUILD_GAP_MS { std::thread::sleep(Duration::from_millis((MIN_REBUILD_GAP_MS - gap) as u64)); }
        let guard = claim(&slot);
        let mut dirty = BTreeSet::new();
        let (mut w, fresh) = Watcher::full(&root, &mut dirty).map_err(|e| format!("full scan: {e}"))?;
        last_full = now_ms();
        {
            let mut m = model.lock().unwrap();
            *m = fresh;
            let mut ds: Vec<String> = std::mem::take(&mut dirty).into_iter().collect();
            ds.sort_by_key(|d| (d.matches('/').count() + usize::from(!d.is_empty()), d.clone()));
            for d in &ds {
                m.reconcile_dir_with(&root, d, 0, &mut |rel| w.add(&root, rel));
            }
            slot.publish(m.snapshot(now_ms()));
        }
        drop(guard);
        si.set_watcher_active(true);

        // Event loop.
        let mut first_dirty: Option<Instant> = None;
        let mut last_event = Instant::now();
        loop {
            let until_full = Duration::from_millis((last_full + FULL_EVERY_MS - now_ms()).max(0) as u64);
            let timeout = match first_dirty {
                Some(_) => Duration::from_millis(DEBOUNCE_MS).saturating_sub(last_event.elapsed()).min(until_full),
                None => until_full,
            };
            w.wait(timeout);
            let before = dirty.len();
            match w.drain(&mut dirty) {
                Drained::Ok => {}
                Drained::Overflow | Drained::RootGone => break, // → full rebuild
            }
            if dirty.len() != before || (first_dirty.is_none() && !dirty.is_empty()) {
                last_event = Instant::now();
                first_dirty.get_or_insert(last_event);
            }
            let due = first_dirty.is_some_and(|t0| {
                last_event.elapsed() >= Duration::from_millis(DEBOUNCE_MS)
                    || t0.elapsed() >= Duration::from_millis(DEBOUNCE_MAX_MS)
            });
            if due {
                let mut m = model.lock().unwrap();
                // Shallow-first: a parent's reconcile drops removed children before any
                // child entry is processed. No ancestor de-dup — a dirty child must still
                // be re-read (rename-over-existing), and each read is ~27ms.
                let mut ds: Vec<String> = std::mem::take(&mut dirty).into_iter().collect();
                ds.sort_by_key(|d| (d.matches('/').count() + usize::from(!d.is_empty()), d.clone()));
                for d in &ds {
                    m.reconcile_dir_with(&root, d, 0, &mut |rel| w.add(&root, rel));
                }
                slot.publish(m.snapshot(now_ms()));
                first_dirty = None;
            }
            if now_ms() - last_full >= FULL_EVERY_MS { break; }
        }
        si.set_watcher_active(false);
        // loop → full rebuild with a NEW Inotify instance (old one dropped at scope end
        // releases every stale watch).
    }
}
```

> `reconcile_dir_with(.., known_depth = 0, ..)`：watcher 下每个被改动的目录自己都会产生事件、都在 dirty 里，所以已知子目录不必下钻；新子目录由 `on_dir` 挂 watch 后完整扫描（先 watch 再 read，无漏窗）。

`src/main.rs`：mod 区加 `mod vault_watch;`；`let search = …SearchIndexes::start(…);` 之后加：

```rust
    // Batch 1b: the watcher becomes the vault's refresh source (1a triggers turn
    // into no-ops while it runs, and resume as the fallback if it stops).
    vault_watch::spawn(search.clone());
```

> 启动时 vault 只能遍历一次（~52s JuiceFS 元数据）：watcher 自己的全量必须挂 watch，所以 1a 的 vault 首建要让位。
> 为此 `fuzzy_index.rs` 新增构造函数（`start` 保持不变，1a 测试不受影响）：
> ```rust
>     /// Like `start`, but leaves the vault's initial build to the watcher (which must
>     /// attach watches during the walk). Until the watcher publishes, `current()` is
>     /// None → searches report `indexing`, resolve answers 503 — same as 1a startup.
>     pub fn start_watched(home: PathBuf, vault_root: Option<PathBuf>) -> Arc<Self> {
>         let si = Self::new_unstarted(home, vault_root);
>         si.refresh_dirs_if_older(i64::MIN);
>         si
>     }
> ```
> 并把 `start` 的结构体构造抽成 `fn new_unstarted(home, vault_root) -> Arc<Self>`（`start` = `new_unstarted` + 两个 `refresh_*_if_older(i64::MIN)`）。`main.rs` 中 `SearchIndexes::start(` 改为 `SearchIndexes::start_watched(`。
> 窗口：watcher 线程 `claim` 之前若恰有 warm 请求，1a 路径可能抢先起一次全量；`claim` 互斥保证不会并发发布，最坏多遍历一次，仅发生在启动后毫秒级窗口内，可接受。

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test 2>&1 | grep "test result"`
Expected: `test result: ok. 439 passed`（429 + 10）

- [ ] **Step 5: Commit**

```bash
git add Cargo.toml Cargo.lock src/vault_watch.rs src/fuzzy_index.rs src/main.rs
git commit -m "feat(search): vault inotify watcher(标脏→单目录对账,溢出/6h 全量兜底)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: 1b 前端文案 + 集成验证 + 部署

**Files:**
- Modify: `frontend/src/components/SearchResults.tsx`（notes 段 `refreshing && 零结果` 文案：1b 下全量重建期间仍用旧快照，零结果即真无匹配 → 改为「无匹配笔记」）
- Modify: `frontend/src/components/__tests__/SearchResults.test.tsx`（对应断言改为 `无匹配笔记`）

- [ ] **Step 1: 改测试**：`edge states` 用例中 `expect(screen.getByText('笔记索引刷新中…'))` 改为 `expect(screen.getAllByText('无匹配笔记').length).toBeGreaterThan(0)`。

- [ ] **Step 2: 验红**：`cd frontend && npx vitest run src/components/__tests__/SearchResults.test.tsx` → FAIL。

- [ ] **Step 3: 实现**：notes 段 `<Status text={s.refreshing ? '笔记索引刷新中…' : '无匹配笔记'} />` 改为 `<Status text="无匹配笔记" />`；Sidebar `runSearch` 中 4s 重查条件去掉 notes 部分：`const refreshing = r.dirs?.refreshing && r.dirs.items.length === 0`。

- [ ] **Step 4: 全量验证**

```bash
cd frontend && npx vitest run && npm run build && cd .. && cargo test 2>&1 | grep "test result"
```

然后本地冒烟（同 Task 11 Step 2 起一个 8099 实例），在另一个终端：

```bash
echo x > "$HOME/s3-workspace/keith-space/obsidian/projects/zzz-watch-probe.md"
sleep 2
curl -s "localhost:8099/api/search?q=zzz-watch&scope=notes" -H "Authorization: Bearer $TOKEN" | grep -c zzz-watch-probe   # 1
rm "$HOME/s3-workspace/keith-space/obsidian/projects/zzz-watch-probe.md"
sleep 2
curl -s "localhost:8099/api/search?q=zzz-watch&scope=notes" -H "Authorization: Bearer $TOKEN" | grep -c zzz-watch-probe   # 0
```

- [ ] **Step 5: Commit + 部署**

```bash
git add frontend/src/components/SearchResults.tsx frontend/src/components/__tests__/SearchResults.test.tsx frontend/src/components/Sidebar.tsx
git commit -m "feat(frontend): 1b 下笔记段不再显示刷新中态

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git push
./deploy.sh --build
```

Expected：`OK: HTTP 200`；手机上在 Obsidian 新建一篇笔记后约 1–2s 内可在 New Session 搜到。
