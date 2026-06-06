use chrono::{DateTime, Utc};
use chrono_tz::Asia::Shanghai;
use std::str::FromStr;

/// Return scheduled fire points in the half-open interval (last_seen, now],
/// evaluated in Asia/Shanghai, oldest -> newest. The scheduler caller uses
/// `.last()` to fire only the most recent due point (no backfill of older ones).
///
/// Pure: time is injected via `last_seen`/`now`; this never reads the clock.
/// cron fields are evaluated in Shanghai local time (verified: the `cron` crate
/// evaluates in the passed datetime's timezone), so "0 0 9 * * *" means
/// 09:00 Shanghai == 01:00 UTC — no manual offset.
pub fn due_fire_points(
    cron_spec: &str,
    last_seen: DateTime<Utc>,
    now: DateTime<Utc>,
) -> Result<Vec<DateTime<Utc>>, String> {
    let schedule = cron::Schedule::from_str(cron_spec)
        .map_err(|e| format!("bad cron '{}': {}", cron_spec, e))?;
    let after = last_seen.with_timezone(&Shanghai);
    let mut out = Vec::new();
    for t in schedule.after(&after) {
        let t_utc = t.with_timezone(&Utc);
        if t_utc > now {
            break;
        }
        out.push(t_utc);
        if out.len() > 1000 {
            break; // safety bound against pathological specs
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    // 6-field cron: sec min hour dom mon dow. "0 0 9 * * *" = 09:00 daily,
    // evaluated in the after-datetime's tz (Shanghai) -> 01:00 UTC.
    const DAILY_0900: &str = "0 0 9 * * *";

    #[test]
    fn fires_once_for_daily_at_0900_shanghai() {
        // window: 00:59 UTC (08:59 CST) .. 01:01 UTC (09:01 CST)
        let last = Utc.with_ymd_and_hms(2026, 6, 6, 0, 59, 0).unwrap();
        let now = Utc.with_ymd_and_hms(2026, 6, 6, 1, 1, 0).unwrap();
        let fires = due_fire_points(DAILY_0900, last, now).unwrap();
        assert_eq!(fires.len(), 1, "exactly one 09:00 fire in window");
        // Proves no 8h skew: fire is 01:00 UTC == 09:00 Shanghai.
        assert_eq!(fires[0], Utc.with_ymd_and_hms(2026, 6, 6, 1, 0, 0).unwrap());
    }

    #[test]
    fn empty_when_no_fire_in_window() {
        let last = Utc.with_ymd_and_hms(2026, 6, 6, 2, 0, 0).unwrap();
        let now = Utc.with_ymd_and_hms(2026, 6, 6, 3, 0, 0).unwrap();
        assert!(due_fire_points(DAILY_0900, last, now).unwrap().is_empty());
    }

    #[test]
    fn multiple_due_points_when_loop_stalled() {
        // hourly at :00; 3-hour window -> 3 due points; caller takes last.
        let hourly = "0 0 * * * *";
        let last = Utc.with_ymd_and_hms(2026, 6, 6, 0, 30, 0).unwrap();
        let now = Utc.with_ymd_and_hms(2026, 6, 6, 3, 30, 0).unwrap();
        let fires = due_fire_points(hourly, last, now).unwrap();
        assert_eq!(fires.len(), 3);
    }

    #[test]
    fn weekday_cron_skips_weekend() {
        // "0 0 9 * * 1-5" = 09:00 Mon-Fri. 2026-06-06 is a Saturday;
        // a window over Sat 09:00 Shanghai must yield no fire.
        let weekday = "0 0 9 * * 1-5";
        let last = Utc.with_ymd_and_hms(2026, 6, 6, 0, 59, 0).unwrap(); // Sat 08:59 CST
        let now = Utc.with_ymd_and_hms(2026, 6, 6, 1, 1, 0).unwrap();   // Sat 09:01 CST
        assert!(due_fire_points(weekday, last, now).unwrap().is_empty(),
            "no fire on Saturday for a Mon-Fri schedule");
    }

    #[test]
    fn bad_cron_is_error_not_panic() {
        let now = Utc.with_ymd_and_hms(2026, 6, 6, 1, 1, 0).unwrap();
        assert!(due_fire_points("not a cron", now, now).is_err());
        // 5-field standard cron also errors in this crate (needs 6/7 fields).
        assert!(due_fire_points("* * * * *", now, now).is_err());
    }
}
