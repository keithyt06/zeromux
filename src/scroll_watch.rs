//! "↓ N new lines" while the user reads tmux copy-mode: copy-mode freezes the
//! pane, so the browser can't see new output — the server diffs history_size.

pub fn new_lines(baseline: u64, now: u64) -> u64 {
    now.saturating_sub(baseline)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn counts_growth_and_never_underflows() {
        assert_eq!(new_lines(100, 112), 12);
        assert_eq!(new_lines(100, 100), 0);
        assert_eq!(new_lines(50_000, 49_990), 0, "history-limit trimming must not underflow");
    }
}
