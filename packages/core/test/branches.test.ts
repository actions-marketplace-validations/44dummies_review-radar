import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { rankBranches, reviewBranches, type BranchRow } from '../src/branches';
import { renderBranches } from '../src/reporters/branches';
import { recordRun } from '../src/trend';
import { makeRepo } from './helpers/repo';

const gitIn = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

/** main + merged (ff-merged) + feat/risky (skips a test: P0) + small (one-line tweak) + wip (linked worktree, uncommitted edit). */
function setup() {
  const r = makeRepo();
  r.write({ 'src/a.test.ts': "it('a', () => {});\n", 'src/util.ts': 'export const u = 1;\n', 'docs/notes.md': 'notes\n' });
  r.commit('init');
  r.git('checkout', '-q', '-b', 'merged'); r.write({ 'docs/notes.md': 'more notes\n' }); r.commit('docs');
  r.git('checkout', '-q', 'main'); r.git('merge', '-q', '--ff-only', 'merged');
  r.git('checkout', '-q', '-b', 'feat/risky'); r.write({ 'src/a.test.ts': "it.skip('a', () => {});\n" }); r.commit('skip');
  r.git('checkout', '-q', 'main');
  r.git('checkout', '-q', '-b', 'small'); r.write({ 'src/util.ts': 'export const u = 2;\n' }); r.commit('tweak');
  r.git('checkout', '-q', 'main');
  const wt = join(mkdtempSync(join(tmpdir(), 'rr-wt-')), 'wip');
  r.git('worktree', 'add', '-q', '-b', 'wip', wt);
  gitIn(wt, 'commit', '-q', '--allow-empty', '-m', 'start wip');
  writeFileSync(join(wt, 'docs', 'notes.md'), 'draft\n');
  return { r, wt };
}

const row = (o: Partial<BranchRow> & { name: string }): BranchRow => ({ dirty: false, p0: 0, p1: 0, p2: 0, estMinutes: 0, ...o });

describe('rankBranches', () => {
  it('orders by P0, P1, minutes, then name, with errors last', () => {
    const ranked = rankBranches([
      row({ name: 'err', error: 'boom', p0: 9 }), row({ name: 'b', p0: 1, p1: 1 }), row({ name: 'a', p0: 1, p1: 1 }),
      row({ name: 'slow', p1: 2, estMinutes: 30 }), row({ name: 'top', p0: 2 }), row({ name: 'fast', p1: 2, estMinutes: 3 }),
    ]);
    expect(ranked.map((b) => b.name)).toEqual(['top', 'a', 'b', 'slow', 'fast', 'err']);
  });
});

// Each case spawns ~25 git processes and up to three full analyses: slow on Windows runners under a parallel suite.
describe('reviewBranches', { timeout: 60_000 }, () => {
  it('ranks unmerged branches and worktrees with uncommitted work', async () => {
    const { r, wt } = setup();
    recordRun(wt, { p0: 2, p1: 0, p2: 0, estMinutes: 1 }, 'worktree');
    recordRun(wt, { p0: 0, p1: 0, p2: 1, estMinutes: 1 }, 'worktree');
    const res = await reviewBranches(r.root);
    expect(res.base).toBe('main');
    expect(res.skipped).toBe(0);
    expect(res.branches.map((b) => b.name).sort()).toEqual(['feat/risky', 'small', 'wip']);
    const [first] = res.branches;
    expect(first).toMatchObject({ name: 'feat/risky', dirty: false, top: { file: 'src/a.test.ts', line: 1 } });
    expect(first!.p0).toBeGreaterThanOrEqual(1);
    expect(first!.worktree).toBeUndefined();
    const wip = res.branches.find((b) => b.name === 'wip')!;
    expect(wip.dirty).toBe(true);
    expect(wip.worktree).toBeTruthy();
    expect(wip.trend).toMatch(/^P0 2 → 0 /);
  });
  it('builds the graph for branches that are not checked out from the current checkout', async () => {
    const { r } = setup();
    await reviewBranches(r.root);
    const p = r.git('rev-parse', '--git-path', 'review-radar');
    const cacheDir = isAbsolute(p) ? p : join(r.root, p);
    expect(existsSync(join(cacheDir, `graph-${r.git('rev-parse', 'feat/risky')}.json`))).toBe(false);
    expect(existsSync(join(cacheDir, `graph-${r.git('rev-parse', 'HEAD')}.json`))).toBe(true);
  });
  it('analyses at most limit candidates and counts the rest as skipped', async () => {
    const { r } = setup();
    const res = await reviewBranches(r.root, { limit: 1 });
    expect(res.branches).toHaveLength(1);
    expect(res.skipped).toBe(2);
  });
  it('keeps going when one candidate fails', async () => {
    const { r, wt } = setup();
    rmSync(wt, { recursive: true, force: true });
    const res = await reviewBranches(r.root);
    expect(res.branches.at(-1)).toMatchObject({ name: 'wip' });
    expect(res.branches.at(-1)!.error).toBeTruthy();
    expect(res.branches[0]!.name).toBe('feat/risky');
  });
  it('returns an empty list when nothing is open', async () => {
    const r = makeRepo();
    r.write({ 'a.ts': '1\n' });
    r.commit('init');
    expect(await reviewBranches(r.root)).toEqual({ base: 'main', branches: [], skipped: 0 });
  });
});

describe('renderBranches', () => {
  it('prints an aligned table, marks uncommitted work and notes skipped branches', () => {
    const text = renderBranches({
      base: 'main', skipped: 3,
      branches: [
        row({ name: 'feat/payments', p0: 2, p1: 1, estMinutes: 14, trend: 'P0 3 → 2 since 09:12 (2 runs today)', top: { file: 'src/pay.ts', line: 40, message: 'path matches sensitive pattern `payment`' } }),
        row({ name: 'wip', dirty: true, p1: 1, estMinutes: 4 }),
        row({ name: 'broken', error: 'git failed' }),
      ],
    });
    expect(text).toBe([
      'Branch         P0  P1  min  Trend                                Top',
      'feat/payments   2   1   14  P0 3 → 2 since 09:12 (2 runs today)  src/pay.ts:40 — path matches sensitive pattern `payment`',
      'wip *           0   1    4',
      'broken          -   -    -                                       error: git failed',
      '* has uncommitted changes',
      '3 more branches not analysed (raise the limit to include them).',
      '',
    ].join('\n'));
  });
  it('says so when there is nothing to review', () => {
    expect(renderBranches({ base: 'main', branches: [], skipped: 0 })).toBe('No open branches or uncommitted work: nothing to review.\n');
  });
});
