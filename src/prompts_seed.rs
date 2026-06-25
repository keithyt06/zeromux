//! Version-controlled starter preset content, seeded into the library on first
//! run. The human-readable source is
//! `docs/superpowers/specs/2026-06-16-preset-content-library-design.md`; this is
//! the machine source of truth. Edit the wording in BOTH places.
//!
//! Each entry is `(title, body)`. Titles carry an emoji prefix so the chips stay
//! distinguishable when truncated on a phone. Bodies are verbatim from the design
//! doc: English task-contracts (Task / Approach / Done-when) with a trailing
//! Chinese-output directive, and a `{{input}}` slot that frames the target.
//!
//! Ordering follows the coding-agent spine: Explore → Plan → Implement → Fix →
//! Review → Refactor → Explain → Commit. `seed_if_unseeded` assigns sort_order
//! by this array's index, so this is the on-screen chip order.

pub const SEED_PRESETS: &[(&str, &str)] = &[
    (
        "🔍 探索代码库",
        r#"Task: Map how this codebase handles {{input}}, read-only — change nothing. If I named no area above, ask me what to focus on first.

Approach: Investigate without bloating this transcript — spawn a subagent for the digging if you can; otherwise read only what's relevant and don't dump source back to me.

Done when: you return a tight map the planning step can act on — the key files and their roles, the data flow, existing reusable patterns/utilities, and the constraints I should know before touching it.

用中文与我交流（代码、命令、标识符保持英文）。"#,
    ),
    (
        "📋 写实现计划",
        r#"Task: Write a detailed implementation plan for {{input}}.

Approach: First explore the relevant code (read-only) and the nearest existing patterns to follow. Do NOT write or edit any code yet.

Done when: the plan lists which files change and how, the data flow, edge cases, the tests to add, and the verification (test/build/lint) for each step. STOP and show me the plan for approval before implementing.

用中文与我交流（代码、命令、标识符、提交信息保持英文）。"#,
    ),
    (
        "✅ TDD 实现",
        r#"Task: Implement {{input}} using test-driven development.

Approach: Read the nearest existing tests + the code you'll touch to match conventions (don't read the whole repo). Write tests for the happy path and key edge/error cases BEFORE implementing; run them and confirm they fail for the right reason (red). Then write the minimum code to pass — no speculative abstractions or scope beyond {{input}}.

Done when: the new tests and the existing relevant suite all pass. Paste the final test command and its green output as evidence, and state briefly what behavior the tests pin down. If you can't reach green, stop and report what's blocking — never claim success without passing output.

用中文与我交流（代码、命令、标识符、提交信息保持英文）。"#,
    ),
    (
        "🐛 修 Bug（根因）",
        r#"Task: Fix this bug — symptom: {{input}}. If no symptom is given above, ask me for one before touching code.

Approach: First write a failing test that reproduces the symptom. Find the root cause — spawn a subagent for deep tracing if you can, otherwise trace it directly. Do not patch over the symptom.

Done when: the reproducing test passes, the relevant suite still passes (no regression), and you've explained the root cause in one or two sentences. Paste before/after test output as evidence.

用中文与我交流（代码、命令、标识符、提交信息保持英文）。"#,
    ),
    (
        "👀 对抗式评审",
        r#"Task: Review the current uncommitted/branch changes (git diff) for {{input}}, with fresh, skeptical eyes — assume it's wrong until proven otherwise. If there's no diff to review, tell me and stop.

Approach: Read the diff and only the surrounding code needed to judge it; for deeper tracing, spawn a subagent if you can so this review stays focused. Hunt only for real defects: logic errors, unhandled edge cases/inputs, race conditions, broken error paths, security holes, and requirement gaps (does it do what was asked?).

Done when: each finding is file:line → concrete problem → smallest fix, ordered by severity. Do NOT report style/naming/formatting. Do NOT demand defensive code or abstractions for cases that can't occur — flagging non-problems is itself a failure. If nothing is materially wrong, say so plainly rather than inventing issues.

用中文与我交流（代码、命令、标识符保持英文）。"#,
    ),
    (
        "♻️ 简化重构",
        r#"Task: Refactor {{input}} to be simpler, with behavior unchanged.

Approach: Confirm the relevant tests are green first — if none cover it, tell me and add a characterization test before refactoring. Touch only what serves this goal — don't "improve" unrelated code, comments, or formatting. If 200 lines can become 50, do it, but every changed line must trace to the refactor.

Done when: the same tests still pass after (behavior is identical). Paste the test output as evidence, and summarize what got simpler and why it's safe.

用中文与我交流（代码、命令、标识符、提交信息保持英文）。"#,
    ),
    (
        "📖 解释代码",
        r#"Task: Explain {{input}}. If nothing is named above, ask me what to explain before reading.

Approach: Read the actual code (and its git history if a decision looks deliberate). Point to concrete file:line.

Done when: I understand what it does, how to use it, what it depends on, and WHY it's written this way rather than an obvious alternative. Aim for fast onboarding — not a line-by-line recital.

用中文与我交流（代码、命令、标识符保持英文）。"#,
    ),
    (
        "📝 提交并开 PR",
        r#"Task: Commit {{input}} and open a PR.

Approach: If not on a feature branch, create one first. Run verification (tests/build/lint) before committing; if it fails, fix it — don't commit broken work. Push, then open a PR with `gh` if it's available and authenticated; if PR creation isn't possible here, push the branch and give me a ready-to-paste PR title + body instead. Follow the repo's existing branch/PR conventions.

Done when: a descriptive commit (message explains WHY, not just what) is pushed, and either the PR is open (report the link) or you've reported the branch + PR draft. Include verification evidence (test output).

用中文与我交流（代码保持英文；commit message 与 PR 描述用英文，正文说明可中文）。"#,
    ),
];
