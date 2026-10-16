---
name: review
description: Rank the changes you just made by how much a human needs to read them (P0 must read, P1 should read, P2 skim), with the reason for each, and undo test gaming in your own changes. Modes are quick (P0 only), commit (staged changes) or a git range like main...HEAD.
when_to_use: After you finish a coding task, before you commit, or when the user asks what to review, what is risky, or what changed. For opening a pull request use review-before-pr instead.
argument-hint: "[quick|commit|<range>]"
---

# Review your changes

Review Radar scores every changed hunk from 0 to 100 with plain-sentence evidence. It is deterministic and runs locally.

Arguments: `$ARGUMENTS`

## 1. Run the review for the mode

| Argument | Call |
|---|---|
| (none) | `review_changes` with no arguments: this branch plus uncommitted and untracked work |
| `quick` | `review_changes` with `minTier: "P0"` |
| `commit` | `review_changes` with `staged: true`: only what `git commit` would record |
| contains `..`, like `main...HEAD` | `review_changes` with `range` set to the argument |
| anything else | reply `Usage: /review-radar:review [quick, commit or <base>...<head>]` and stop |

If the `review_changes` tool isn't available, run `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" --format json` with `--working-tree`, `--staged` or the range instead.

## 2. Nothing to review?

If `summary.hunks` is 0, say "Nothing to review." with the scope from the tool's text, and stop.

## 3. Quick mode

Print `P0: <summary.p0> · est <summary.estMinutes> min`, and add ` · <trend.line>` when `trend` is present. Then print one line per P0 hunk: `<file>:<startLine> — <first evidence message>`. Stop there. Don't edit anything.

## 4. Every other mode

1. **List** the P0 and P1 hunks with their reasons, P0 first.
2. **Undo your own test gaming.** For every hunk with `test-gaming` evidence on code you changed in this task (a skipped or focused test, a deleted test, a removed assertion, or a strict matcher weakened to something like `toBeDefined()`), restore the test or the strict assertion and fix the code under test so the real test passes. Keep a skip only if the user explicitly asked for it. Never lower a score by editing `.reviewradar.yml`, renaming or moving files, or splitting changes. Then re-run the same `review_changes` call and run the project's tests.
3. **Follow through on each P0 hunk** that isn't test gaming:
   - **Why it's risky:** one sentence built from its evidence. Don't invent risks the evidence doesn't name.
   - **Is it covered?** `untested-change` evidence means no test covers it. Otherwise search the test files for the changed function or symbol names and name the covering test (`file:line`), or say "no test found".
   - **Act:** if it isn't covered, ask the user "Add a test for `<symbol>` in `<file>`?" and wait. Never add a test without a yes. If you can't ask (running non-interactively), don't add one: list it as "needs a test".
4. **End with the trend** (`trend.line`) when it is present.
