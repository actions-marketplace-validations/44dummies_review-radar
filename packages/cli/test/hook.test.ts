import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli';
import { stagedModeFor } from '../src/hook';
import { makeRepo } from '../../core/test/helpers/repo';

function hook(input: unknown) {
  let out = '';
  const stdin = async () => (typeof input === 'string' ? input : JSON.stringify(input));
  return main(['hook', 'pre-commit'], { stdout: (s) => (out += s), stderr: () => {}, cwd: process.cwd(), stdin }).then((code) => ({ code, out }));
}
const commit = (cwd: string, command = 'git commit -m "wip"') =>
  ({ session_id: 's', cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });

/** Committed test; the working tree skips it. Pass stage=true to stage the skip. */
function repo(stage: boolean) {
  const r = makeRepo();
  r.write({ 'src/a.test.ts': "it('a', () => {});\n", 'src/u.ts': 'export const u = 1;\n' });
  r.commit('init');
  r.write({ 'src/a.test.ts': "it.skip('a', () => {});\n" });
  if (stage) r.git('add', 'src/a.test.ts');
  return r;
}
const HEREDOC = `git commit -m "$(cat <<'EOF'\nfix: add retry and rm stale cache\n\nDetails.\nEOF\n)"`;

describe('hook pre-commit', () => {
  it('warns about staged test gaming without deciding the permission', async () => {
    const r = repo(true);
    const { code, out } = await hook(commit(r.root));
    expect(code).toBe(0);
    const res = JSON.parse(out);
    expect(res.systemMessage).toBe('Review Radar: this commit adds test gaming (1 finding) — src/a.test.ts:1 skips a test (`.skip`/`xit`/`pytest.mark.skip`/`xfail`)');
    expect(res.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(res.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(res.hookSpecificOutput.additionalContext).toContain('- src/a.test.ts:1 — skips a test');
    expect(res.hookSpecificOutput.additionalContext).toContain('Undo it (restore the test or the strict assertion)');
  });
  it('denies the commit when agentHooks.preCommit is block', async () => {
    const r = repo(true);
    r.write({ '.reviewradar.yml': 'agentHooks:\n  preCommit: block\n' });
    const res = JSON.parse((await hook(commit(r.root))).out);
    expect(res.systemMessage).toBeUndefined();
    expect(res.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(res.hookSpecificOutput.permissionDecisionReason).toMatch(/^Review Radar blocked this commit: it adds test gaming\.\n- src\/a\.test\.ts:1 — /);
  });
  it('stays silent when agentHooks.preCommit is off', async () => {
    const r = repo(true);
    r.write({ '.reviewradar.yml': 'agentHooks:\n  preCommit: off\n' });
    expect((await hook(commit(r.root))).out).toBe('');
  });
  it('stays silent for a clean commit', async () => {
    const r = repo(false);
    r.write({ 'src/u.ts': 'export const u = 2;\n' });
    r.git('add', 'src/u.ts');
    expect((await hook(commit(r.root))).out).toBe('');
  });
  it.each([
    ['garbage stdin', () => 'not json'],
    ['a command that is not a commit', () => commit(repo(true).root, 'git status')],
    ['a directory outside git', () => commit(mkdtempSync(join(tmpdir(), 'rr-norepo-')))],
    ['a repo with no commits', () => { const r = makeRepo(); r.write({ 'a.test.ts': "it.skip('a', () => {});\n" }); r.git('add', '-A'); return commit(r.root); }],
    ['an invalid config', () => { const r = repo(true); r.write({ '.reviewradar.yml': 'agentHooks:\n  preCommit: maybe\n' }); return commit(r.root); }],
  ])('stays silent and exits 0 for %s', async (_name, input) => {
    expect(await hook(input())).toEqual({ code: 0, out: '' });
  });
  it.each([
    ['git add . && git commit -m "x"', true],
    ['git commit -am "x"', true],
    ['git commit --all -m "x"', true],
    ['git -c core.hooksPath=/dev/null commit -a -m x', true],
    ['git commit -m "x"', false],
    ['git commit -m "add a test"', false],
    ['git commit --author="a <a@b.c>" -m x', false],
    ['git commit --amend --no-edit', false],
    [HEREDOC, false],
  ])('%s sees unstaged edits: %s', async (command, warns) => {
    const r = repo(false);
    expect((await hook(commit(r.root, command))).out !== '').toBe(warns);
  });
  it("detects Claude's heredoc commit style", async () => {
    const r = repo(true);
    expect((await hook(commit(r.root, HEREDOC))).out).toContain('test gaming');
  });
  it('works when the hook runs from a subdirectory', async () => {
    const r = repo(false);
    r.write({ 'src/new.test.ts': "it.only('n', () => {});\n" });
    const res = await hook(commit(join(r.root, 'src'), 'git add -A && git commit -m x'));
    expect(res.out).toContain('src/new.test.ts:1');
  });
  it('stagedModeFor picks the superset when the command stages files first', () => {
    expect(stagedModeFor('git add -A && git commit -m x')).toBe('all');
    expect(stagedModeFor('git commit -m x')).toBe('index');
  });
});
