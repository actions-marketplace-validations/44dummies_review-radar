---
name: review-before-pr
description: Required before you open a pull request, write a PR description, or tell the user a branch is ready for review. Runs Review Radar on the branch plus uncommitted work to rank changed hunks (P0 must read, P1 should read, P2 skim), finds and undoes test gaming in your own changes (skipped tests, weakened or deleted assertions), and produces the "Where to look" section for the PR description.
---

# Review before opening a PR

Review Radar scores every changed hunk from 0 to 100 with plain-sentence evidence. It is deterministic and runs locally. By default it reviews this branch plus uncommitted and untracked changes against the default branch.

## Steps

1. **Run the review.** Call the `review_changes` tool (Review Radar MCP server) with no arguments.
   If the tool isn't available, run `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" --working-tree --format json` in the repository instead.
   If `summary.hunks` is 0, say "Nothing to review." and stop.

2. **Undo your own test gaming.** For every hunk whose evidence comes from the `test-gaming` signal and that touches code you changed in this task (a skipped or focused test, a deleted test, a removed assertion, or a strict matcher weakened to something like `toBeDefined()`):
   - restore the test or the strict assertion, and
   - fix the code under test so the real test passes.
   Only keep a skip if the user explicitly asked for it, and say so in the PR description.

3. **Never game the score.** Don't edit `.reviewradar.yml`, rename or move files, or split changes to lower a score. A high score on auth, payments or migrations is expected; it means a human should read it, not that you did something wrong.

4. **Follow through on each P0 hunk** that isn't test gaming:
   - **Why it's risky:** one sentence built from its evidence. Don't invent risks the evidence doesn't name.
   - **Is it covered?** `untested-change` evidence means no test covers it. Otherwise search the test files for the changed function or symbol names and name the covering test (`file:line`), or say "no test found".
   - **Act:** if it isn't covered, ask the user "Add a test for `<symbol>` in `<file>`?" and wait. Never add a test without a yes. If you can't ask (running non-interactively), don't add one: mark it "needs a test" in the PR description.

5. **Re-run** `review_changes` and confirm the test-gaming evidence is gone. Run the project's tests.

6. **Hand it to the human.** Call `pr_review_guide` and put its markdown in the pull request description, with any "needs a test" items under it. If you're not opening a PR, show the user the P0 and P1 hunks with their reasons instead.
