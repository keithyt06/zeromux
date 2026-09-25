//! Version-controlled starter preset content, seeded into the library on first
//! run. The human-readable source is
//! `docs/superpowers/specs/2026-06-16-preset-content-library-design.md` (v1);
//! SEED_PRESETS_V2 holds the study presets from
//! `docs/superpowers/specs/2026-09-25-fuzzy-search-design.md §8.`
//! These are the machine sources of truth. Edit the wording in both places.
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

/// v2 study presets (2026-09-25 fuzzy-search spec §8), appended once to libraries
/// already seeded with v1. Designed for the "⚡ 问 agent" flow: `{{input}}` wraps
/// the prefilled "当前笔记：<path>" line, and the session's work_dir is the note's
/// folder, so relative paths resolve.
pub const SEED_PRESETS_V2: &[(&str, &str)] = &[
    (
        "❓ 基于笔记出题",
        r#"Task: Quiz me on this note. {{input}}

Approach: Read that note in full first (the path above is absolute). Write 5 questions that cover its key points — mix recall, application, and one question that connects ideas across sections. Match the note's subject style (exam-style multiple choice for 考研英语 reading notes, worked problems for 管综数学).

Done when: you show the 5 questions only, then STOP and wait for my answers. After I answer, grade each one, explain every mistake with a pointer to the exact part of the note, and give the correct answer.

用中文与我交流（英文原文、公式、术语保持原样）。"#,
    ),
    (
        "💯 批改我的答案",
        r#"Task: Grade my answers for this note. {{input}}

Approach: My answers may be in my message, or in answer-sheet*/IMG_* images in this folder — look there before asking me. Read the note for the passage and reasoning. If the note marks its own answers as unverified (e.g. "尚未核对官方答案"), tell me which ones you're grading against unverified answers. If a `kaoyan-reading-review` skill is available and this is a 考研英语 reading passage, follow that skill's workflow. For each question: my answer, the correct answer, right/wrong, and the technique that gets it right.

Done when: every question is graded and the error pattern is summarized in 2–3 bullets. Only if I confirm, append the diagnosis to the note under a dated heading. If you found no answers anywhere, ask me for them and stop.

用中文与我交流（英文原文保持原样）。"#,
    ),
    (
        "🃏 生成背诵卡",
        r#"Task: Turn this note into a memorization card. {{input}}

Approach: Read the note. If other `*-背诵卡.md` files exist in this vault (search this folder and its parents), copy their conventions exactly — file naming (short topic name + `-背诵卡.md`), frontmatter (tags include `背诵卡`), the backlink to the full note, and their table-first layout. Otherwise use `<topic>-背诵卡.md` with a `[[原笔记|完整笔记]]` backlink. Extract only what must be memorized: definitions, formulas, key vocabulary, typical traps. No prose paragraphs.

Done when: the card is written next to the note (never overwrite an existing file — if one exists, show me the diff and ask), and you report its path and how many items it contains.

用中文与我交流（英文单词、公式保持原样）。"#,
    ),
    (
        "🔁 抽背单词",
        r#"Task: Drill me on vocabulary. {{input}}

Approach: Find the nearest directory named `单词` — in this folder, its subfolders, or any parent folder up to the vault root (its notes are date-named, entries look like `## N. word /phonetic/`). If none exists, ask me where my word lists are. Collect words from the most recent 7 notes, pick 20 at random (no duplicates), and quiz me ONE word at a time: show the word, wait for my meaning, then judge it and show the note's definition and example.

Done when: all 20 are done; then list the ones I missed with their note filenames so I can review them.

用中文与我交流（英文单词与例句保持原样）。"#,
    ),
];
