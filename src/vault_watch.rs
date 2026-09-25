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
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

const DEBOUNCE_MS: u64 = 300;
const DEBOUNCE_MAX_MS: u64 = 1000;
const FULL_EVERY_MS: i64 = 6 * 3600 * 1000;
const MIN_REBUILD_GAP_MS: i64 = 60_000;
const DRAIN_EVERY_DIRS: usize = 64;
/// A watcher lifetime longer than this resets the restart backoff to 1s.
const HEALTHY_LIFETIME: Duration = Duration::from_secs(600);
/// A lazy unmount + remount of the vault's filesystem (JuiceFS) may deliver no
/// IN_UNMOUNT/IGNORED, leaving every watch dead. Re-stat the root this often.
const ROOT_CHECK_EVERY: Duration = Duration::from_secs(60);

fn root_id(root: &Path) -> std::io::Result<(u64, u64)> {
    let m = std::fs::metadata(root)?;
    Ok((m.dev(), m.ino()))
}

/// The root is gone or is now a different inode/device → watches are stale.
fn root_changed(prev: (u64, u64), now: std::io::Result<(u64, u64)>) -> bool {
    !matches!(now, Ok(id) if id == prev)
}

fn mask() -> WatchMask {
    WatchMask::CREATE | WatchMask::DELETE | WatchMask::MOVED_FROM | WatchMask::MOVED_TO
        | WatchMask::ONLYDIR | WatchMask::DONT_FOLLOW
}

pub(crate) struct Watcher {
    ino: Inotify,
    wd_to_dir: HashMap<i32, String>,
    root_wd: i32,
    buf: Vec<u8>,
    /// add_watch failures since the last `log_add_failures` (ENOSPC on a big vault
    /// would otherwise print one line per dir).
    add_failed: usize,
    last_add_err: Option<String>,
}

enum Drained { Ok, Overflow, RootGone }

impl Watcher {
    fn new() -> std::io::Result<Self> {
        Ok(Self { ino: Inotify::init()?, wd_to_dir: HashMap::new(), root_wd: -1, buf: vec![0u8; 64 * 1024], add_failed: 0, last_add_err: None })
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
            // Gone already (renamed away / removed): the parent's reconcile drops it.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            // ENOSPC etc.: this dir falls back to the 6h full rebuild; no retry storm.
            Err(e) => {
                self.add_failed += 1;
                self.last_add_err = Some(format!("{rel:?}: {e}"));
            }
        }
    }

    /// One log line per full build / reconcile batch instead of one per dir.
    fn log_add_failures(&mut self, ctx: &str) {
        if self.add_failed > 0 {
            eprintln!("[vault_watch] {ctx}: {} add_watch failures (last {})", self.add_failed,
                self.last_add_err.take().unwrap_or_default());
            self.add_failed = 0;
        }
    }

    /// Reconcile the dirty dirs shallow-first. Each dir is (re-)watched first: a
    /// KNOWN path whose inode changed (rename over an existing dir, rmdir+mkdir of
    /// the same name) is not "new" to the model, so reconcile won't call `on_dir`
    /// for it — without this its later events would be lost until the 6h rebuild.
    /// Re-adding a still-watched inode returns the existing wd and just remaps it.
    /// No ancestor de-dup — a dirty child must still be re-read (rename-over-
    /// existing), and each read is ~27ms.
    fn reconcile(&mut self, m: &mut VaultModel, root: &Path, dirty: &mut BTreeSet<String>) {
        let mut ds: Vec<String> = std::mem::take(dirty).into_iter().collect();
        ds.sort_by_key(|d| (d.matches('/').count() + usize::from(!d.is_empty()), d.clone()));
        for d in &ds {
            if !d.split('/').any(crate::fuzzy_index::skip_name) { self.add(root, d); }
            m.reconcile_dir_with(root, d, 0, &mut |rel| self.add(root, rel));
        }
        self.log_add_failures("reconcile");
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
    /// so a burst during the ~52s walk can't overflow it. The bool is `restart`:
    /// the queue overflowed or the root went away mid-walk, so events in already-
    /// walked dirs may be lost and the caller must run another full build.
    fn full(root: &Path, dirty: &mut BTreeSet<String>) -> std::io::Result<(Watcher, VaultModel, bool)> {
        let mut w = Watcher::new()?;
        let mut n = 0usize;
        let mut restart = false;
        let model = {
            let wref = &mut w;
            VaultModel::full_scan_with(root, &mut |rel| {
                wref.add(root, rel);
                n += 1;
                if n % DRAIN_EVERY_DIRS == 0 && !restart {
                    if !matches!(wref.drain(dirty), Drained::Ok) { restart = true; }
                }
            })?
        };
        if !restart && !matches!(w.drain(dirty), Drained::Ok) { restart = true; }
        w.log_add_failures("full build");
        Ok((w, model, restart))
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
                let t0 = Instant::now();
                let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run(&si)));
                si.set_watcher_active(false);
                // A lifetime that ran for a while was healthy: start backing off afresh.
                if t0.elapsed() > HEALTHY_LIFETIME { backoff = Duration::from_secs(1); }
                match r {
                    Ok(Ok(never)) => match never {},
                    Ok(Err(e)) => eprintln!("[vault_watch] stopped: {e}; retrying in {backoff:?}"),
                    Err(_) => eprintln!("[vault_watch] panicked; retrying in {backoff:?}"),
                }
                std::thread::sleep(backoff);
                backoff = (backoff * 2).min(Duration::from_secs(600));
            }
        })
        .expect("spawn vault-watch thread");
}

/// Watcher lifetimes back to back: full build, then the event loop until a
/// rebuild is needed (overflow / root loss / 6h → loop). Returns only on error
/// (→ backoff in `spawn`).
fn run(si: &SearchIndexes) -> Result<std::convert::Infallible, String> {
    let (slot, model, root) = si.vault_parts().ok_or("no vault")?;
    let mut last_full = i64::MIN;
    loop {
        // Space rebuilds out so a burst still in progress can't loop us.
        let gap = now_ms().saturating_sub(last_full);
        if gap < MIN_REBUILD_GAP_MS { std::thread::sleep(Duration::from_millis((MIN_REBUILD_GAP_MS - gap) as u64)); }
        // May be None if a 1a-path rebuild raced us at startup; the model lock below
        // still serializes the publishes, so proceeding is safe (worst case: one
        // extra walk). The guard only suppresses concurrent 1a rebuilds.
        let guard = claim(&slot);
        let mut dirty = BTreeSet::new();
        // Taken before the walk: a remount mid-walk is then caught by the first check.
        let root0 = root_id(&root).map_err(|e| format!("stat root: {e}"))?;
        let (mut w, fresh, restart) = Watcher::full(&root, &mut dirty).map_err(|e| format!("full scan: {e}"))?;
        last_full = now_ms();
        {
            let mut m = model.lock().unwrap_or_else(|e| e.into_inner());
            *m = fresh;
            w.reconcile(&mut m, &root, &mut dirty);
            slot.publish(m.snapshot(now_ms()));
        }
        if restart {
            // Events were dropped during the walk: publish what we have, then walk
            // again (MIN_REBUILD_GAP_MS spaces it out). 1a triggers stay the
            // fallback meanwhile.
            eprintln!("[vault_watch] queue overflow / root lost during full build; rebuilding");
            continue;
        }
        // Active BEFORE releasing the claim, so no 1a rebuild can slip in between.
        si.set_watcher_active(true);
        drop(guard);

        // Event loop.
        let mut first_dirty: Option<Instant> = None;
        let mut last_event = Instant::now();
        let mut next_root_check = Instant::now() + ROOT_CHECK_EVERY;
        loop {
            let until_full = Duration::from_millis((last_full + FULL_EVERY_MS - now_ms()).max(0) as u64);
            let timeout = match first_dirty {
                Some(_) => Duration::from_millis(DEBOUNCE_MS).saturating_sub(last_event.elapsed()).min(until_full),
                None => until_full,
            }
            // Bounded even when idle, so the root check below still runs.
            .min(next_root_check.saturating_duration_since(Instant::now()));
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
                let mut m = model.lock().unwrap_or_else(|e| e.into_inner());
                // Shallow-first: a parent's reconcile drops removed children before any
                // child entry is processed.
                w.reconcile(&mut m, &root, &mut dirty);
                slot.publish(m.snapshot(now_ms()));
                first_dirty = None;
            }
            if Instant::now() >= next_root_check {
                if root_changed(root0, root_id(&root)) {
                    eprintln!("[vault_watch] vault root remounted or gone; rebuilding");
                    break; // → full rebuild
                }
                next_root_check = Instant::now() + ROOT_CHECK_EVERY;
            }
            if now_ms() - last_full >= FULL_EVERY_MS { break; }
        }
        si.set_watcher_active(false);
        // loop → full rebuild with a NEW Inotify instance (old one dropped at scope end
        // releases every stale watch).
    }
}

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
    async fn rename_over_existing_dir_keeps_watching_the_moved_inode() {
        let (_h, v, si) = started("overw").await;
        fs::create_dir_all(v.path().join("A")).unwrap();
        fs::write(v.path().join("A/k.md"), "x").unwrap();
        fs::create_dir_all(v.path().join("B")).unwrap();
        eventually(&si, |p| p.contains(&"A/k.md".into()) && p.contains(&"B".into())).await;
        fs::rename(v.path().join("A"), v.path().join("B")).unwrap();
        eventually(&si, |p| p.contains(&"B/k.md".into()) && !p.contains(&"A".into())).await;
        tokio::time::sleep(Duration::from_millis(1500)).await;
        fs::write(v.path().join("B/after.md"), "x").unwrap();
        eventually(&si, |p| p.contains(&"B/after.md".into()) && p.contains(&"B/k.md".into())).await;
    }

    #[tokio::test]
    async fn rmdir_then_mkdir_same_name_keeps_watching_the_new_inode() {
        let (_h, v, si) = started("remk").await;
        fs::create_dir_all(v.path().join("X")).unwrap();
        fs::write(v.path().join("X/a.md"), "x").unwrap();
        eventually(&si, |p| p.contains(&"X/a.md".into())).await;
        fs::remove_dir_all(v.path().join("X")).unwrap();
        fs::create_dir(v.path().join("X")).unwrap();
        eventually(&si, |p| p.contains(&"X".into()) && !p.contains(&"X/a.md".into())).await;
        tokio::time::sleep(Duration::from_millis(1500)).await;
        fs::write(v.path().join("X/in.md"), "x").unwrap();
        eventually(&si, |p| p.contains(&"X/in.md".into())).await;
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

    #[tokio::test]
    async fn moved_in_from_outside_and_last_note_removal() {
        let (h, v, si) = started("in").await;
        fs::create_dir_all(h.path().join("outside/deep")).unwrap();
        fs::write(h.path().join("outside/deep/o.md"), "x").unwrap();
        fs::rename(h.path().join("outside"), v.path().join("inside")).unwrap();
        eventually(&si, |p| p.contains(&"inside/deep/o.md".into())).await;
        // folder with only a picture drops out; writing a note brings it back
        fs::remove_file(v.path().join("inside/deep/o.md")).unwrap();
        fs::write(v.path().join("inside/deep/pic.png"), "x").unwrap();
        eventually(&si, |p| !p.contains(&"inside/deep".into())).await;
        fs::write(v.path().join("inside/deep/back.md"), "x").unwrap();
        eventually(&si, |p| p.contains(&"inside/deep".into()) && p.contains(&"inside/deep/back.md".into())).await;
    }

    #[test]
    fn root_changed_detects_remount_or_loss() {
        let err = || Err(std::io::Error::from(std::io::ErrorKind::NotFound));
        assert!(!root_changed((1, 2), Ok((1, 2))));
        assert!(root_changed((1, 2), Ok((1, 3))));
        assert!(root_changed((1, 2), Ok((9, 2))));
        assert!(root_changed((1, 2), err()));
    }

    #[test]
    fn full_scan_fails_when_root_missing() {
        let d = tempfile::tempdir().unwrap();
        let gone = d.path().join("nope");
        assert!(Watcher::full(&gone, &mut BTreeSet::new()).is_err());
    }
}
