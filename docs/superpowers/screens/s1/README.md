# S1 screenshots index

Isolated smoke-instance captures taken during the `feat/frontend-s1` implementation
(plan: `docs/superpowers/plans/2026-09-27-frontend-s1-foundation.md`). Never against
the live `:8090` instance. Filename convention: `<m|d>-<dark|light>-<scene>.png`
(`m` = mobile 390×844 iOS UA, `d` = desktop 1440×900).

## Per-task folders

| Folder | Task | Scenes |
|---|---|---|
| `t2-baseline/` | T2 | home × {m,d} × {dark,light} — pre-token-system baseline |
| `t3/` | T3 | home × {m,d} × {dark,light} — after design tokens + contrast pass |
| `t4/` | T4 | cold-start + settings (system theme) × {dark,light} — theme boot script |
| `t11/` | T11 | prompts / push / scheduled panels × {m,d} × {dark,light} |
| `t12/` | T12 | new-session / sidebar-theme / settings-menu / quicktargets-menu × {m,d} × {dark,light} |
| `t13/` | T13 | login / terminal / history / vault × {m,d} × {dark,light} — leftover token/dialog/emoji cleanup |
| `final/` | T14 | home × {m,d} × {dark,light} — S1 acceptance, same scenes as `t2-baseline` |

## t2-baseline ↔ final comparison

Same scenario, viewport, and theme, captured ~3 months apart at opposite ends of S1.
Visual diff: sidebar now has the 跟随系统/浅色/深色 theme `SegmentedControl` (T4/T12) and
uses semantic design tokens throughout (T3) instead of hardcoded Tailwind palette
classes; no functional/layout regression in the empty-state scene itself.

| Scenario | Viewport | Theme | t2-baseline | final |
|---|---|---|---|---|
| home | desktop | dark | `t2-baseline/d-dark-home.png` | `final/d-dark-home.png` |
| home | desktop | light | `t2-baseline/d-light-home.png` | `final/d-light-home.png` |
| home | mobile | dark | `t2-baseline/m-dark-home.png` | `final/m-dark-home.png` |
| home | mobile | light | `t2-baseline/m-light-home.png` | `final/m-light-home.png` |
