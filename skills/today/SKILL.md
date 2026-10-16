---
name: today
description: List local branches and worktrees with unreviewed changes, ranked by P0 hunks, with the riskiest hunk of each and today's trend. Read-only.
when_to_use: When the user asks what to review or work on today, wants a standup summary, or asks about open branches or worktrees.
---

# What needs review today

1. Call the `review_branches` tool (Review Radar MCP server) with no arguments. If it isn't available, run `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" branches --format json`.
2. If `branches` is empty, say "Nothing to review: no open branches or uncommitted work." and stop.
3. Show a table: branch (mark the ones with uncommitted changes), P0, P1, minutes, trend, and the top hunk as `file:line — message`. Rows with an `error` go last with the error. If `skipped` is above 0, say how many branches weren't analysed.
4. Suggest starting with the top row, and say why in one sentence from its top hunk.

Never edit files, switch branches or commit from this skill.
