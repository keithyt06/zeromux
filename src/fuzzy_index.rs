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
// pub(crate): `VaultIndex` is pub(crate), so a `pub` wrapper would warn (private type in public API).
pub(crate) struct VaultSnapshot { pub index: PathIndex, pub wiki: crate::web::VaultIndex, pub built_at_ms: i64 }

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub(crate) fn skip_name(name: &str) -> bool {
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

/// True iff `q` parses to at least one non-negated atom (i.e. it can match anything).
pub fn has_positive_atom(q: &str) -> bool {
    Pattern::parse(q, CaseMatching::Smart, Normalization::Smart).atoms.iter().any(|a| !a.negative)
}

pub fn search<'a>(ix: &'a PathIndex, q: &str, limit: usize, bonus_for: &dyn Fn(&str) -> u32) -> Vec<Hit<'a>> {
    let pattern = Pattern::parse(q, CaseMatching::Smart, Normalization::Smart);
    // A pattern with no positive atom (empty, whitespace, bare `'`/`^`/`$`, or only
    // negations like `!docs`) scores EVERY haystack Some(0) — refuse it outright.
    if !has_positive_atom(q) {
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
            // Hold the model lock for the WHOLE scan (~52s on JuiceFS). Scanning
            // outside the lock and swapping afterwards would overwrite any turn-end
            // reconcile that landed mid-scan with the older scan result (review r1
            // P0-2). Readers never take this lock — they read the published Arc — and
            // a waiting reconcile runs right after, on top of the fresh model.
            let mut m = model.lock().unwrap();
            match VaultModel::full_scan(&root) {
                Ok(fresh) => {
                    *m = fresh;
                    guard.slot.publish(m.snapshot(now_ms()));
                }
                Err(e) => eprintln!("[search] vault rebuild failed, keeping old snapshot: {e}"),
            }
            drop(m);
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

    /// Rescan one vault directory (used by the agent turn-end hook). Waits on the
    /// model lock, so if a full build is running it applies on top of that build's
    /// result. If no snapshot exists yet (the very first build failed or hasn't
    /// published), the reconcile is skipped — publishing a one-dir model would look
    /// like an almost-empty vault.
    pub fn reconcile_vault_dir(self: &Arc<Self>, abs_dir: &Path) {
        let Some(rel) = self.vault_rel(abs_dir) else { return };
        let (Some(slot), Some(model), Some(root)) = (&self.vault, &self.vault_model, &self.vault_root) else { return };
        let (slot, model, root) = (slot.clone(), model.clone(), root.clone());
        tokio::task::spawn_blocking(move || {
            let mut m = model.lock().unwrap();
            if slot.current().is_none() { return; }
            m.reconcile_dir(&root, &rel, RECONCILE_DEPTH);
            slot.publish(m.snapshot(now_ms()));
        });
    }
}

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
    fn basename_bonus_beats_shorter_haystack() {
        // Pins BASENAME_BONUS itself: without it both score 184 and the length
        // tie-break would put the SHORTER `~/zeromux/a` first (verified by setting
        // the bonus to 0 → this test goes red).
        let ix = ix_of(&[
            ("~/zeromux/a", EntryKind::Dir, 0, false),
            ("~/s3/zeromux", EntryKind::Dir, 0, false),
        ]);
        assert_eq!(top(&ix, "zeromux")[0], "~/s3/zeromux");
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
        // Equal mtime on both folders so ONLY the is_empty_dir rule can order them
        // (with 500 vs 0 the mtime rule alone would pass — review r1 finding).
        let ix = ix_of(&[
            ("考研英语/2007/英语二/阅读理解", EntryKind::VaultDir, 0, true),
            ("考研英语/2019/英语二/阅读理解", EntryKind::VaultDir, 0, false),
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
    async fn reconcile_during_rebuild_is_not_lost() {
        // review r1 P0-2: a turn-end reconcile landing while a full rebuild is in
        // flight must survive the rebuild's publish.
        let h = tmp("si_race_h");
        let v = tmp("si_race_v");
        fs::create_dir_all(v.path().join("d")).unwrap();
        let si = SearchIndexes::start(h.path().into(), Some(v.path().into()));
        let slot = si.vault.clone().unwrap();
        wait_until(|| slot.current().is_some() && !slot.is_rebuilding()).await;
        // Occupy the model lock to simulate a long full scan in progress.
        let model = si.vault_model.clone().unwrap();
        let held = model.lock().unwrap();
        fs::write(v.path().join("d/new-card.md"), "x").unwrap();
        si.reconcile_vault_dir(&v.path().join("d")); // queues behind the "scan"
        drop(held);
        wait_until(|| slot.current().unwrap().index.entries.iter().any(|e| e.path == "d/new-card.md")).await;
        si.refresh_vault_if_older(0); // real full rebuild after the reconcile
        wait_until(|| !slot.is_rebuilding()).await;
        assert!(slot.current().unwrap().index.entries.iter().any(|e| e.path == "d/new-card.md"));
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
}
