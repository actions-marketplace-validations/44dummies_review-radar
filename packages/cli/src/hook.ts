import { findTestGaming, loadConfig, tryGit, type GamingFinding, type StagedMode } from '@review-radar/core';

// Quoted text (commit messages, heredocs inside "$(…)") can't contain commands or flags we care about.
const QUOTED = /"(?:\\.|[^"\\])*"|'[^']*'/g;
const COMMIT = /\bgit\b[^;&|\n]*?\scommit\b/;
const STAGES_FIRST = /\bgit\b[^;&|\n]*?\s(?:add|rm|mv)\b/;

/**
 * What the commit will record. The hook runs before the command, so a chained `git add`
 * hasn't happened yet: take the superset (every tracked edit plus untracked files).
 */
export function stagedModeFor(command: string): StagedMode {
  const plain = command.replace(QUOTED, '""');
  if (STAGES_FIRST.test(plain)) return 'all';
  const m = COMMIT.exec(plain);
  if (!m) return 'index';
  const args = plain.slice(m.index + m[0].length).split(/&&|\|\||[;|\n]/)[0]!.split(/\s+/);
  return args.some((t) => t === '--all' || (/^-[A-Za-z]+$/.test(t) && t.includes('a'))) ? 'all' : 'index';
}

const where = (f: GamingFinding) => (f.startLine === f.endLine ? `${f.file}:${f.startLine}` : `${f.file}:${f.startLine}-${f.endLine}`);
const bullets = (fs: GamingFinding[]) => fs.map((f) => `- ${where(f)} — ${f.message}`).join('\n');

function warn(fs: GamingFinding[]) {
  const first = fs[0]!;
  return {
    systemMessage: `Review Radar: this commit adds test gaming (${fs.length} finding${fs.length === 1 ? '' : 's'}) — ${first.file}:${first.startLine} ${first.message}`,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext:
        `Review Radar found test gaming in the changes being committed:\n${bullets(fs)}\n` +
        'Undo it (restore the test or the strict assertion) and fix the code under test, unless the user explicitly asked for it.',
    },
  };
}

function block(fs: GamingFinding[]) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        `Review Radar blocked this commit: it adds test gaming.\n${bullets(fs)}\n` +
        'Undo it and fix the code under test. (Set agentHooks.preCommit: warn in .reviewradar.yml to allow.)',
    },
  };
}

/** Claude Code PreToolUse hook for `git commit`. Never fails the commit: every error means no output. */
export function preCommit(stdin: string, io: { stdout(s: string): void }): void {
  try {
    const input = JSON.parse(stdin) as { cwd?: unknown; tool_input?: { command?: unknown } };
    const command = input.tool_input?.command;
    if (typeof command !== 'string' || typeof input.cwd !== 'string') return;
    if (!COMMIT.test(command.replace(QUOTED, '""'))) return;
    const root = tryGit(input.cwd, ['rev-parse', '--show-toplevel'])?.trim();
    if (!root) return;
    const config = loadConfig(root);
    if (config.agentHooks.preCommit === 'off') return;
    const findings = findTestGaming(root, stagedModeFor(command), config);
    if (findings.length === 0) return;
    io.stdout(`${JSON.stringify(config.agentHooks.preCommit === 'block' ? block(findings) : warn(findings))}\n`);
  } catch {
    // not a repo, no commits, bad config, git failure: let the commit go ahead untouched
  }
}
