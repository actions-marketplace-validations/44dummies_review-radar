import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { recordRun, readTrend, trendFile, TREND_MAX_LINES } from '../src/trend';
import { makeRepo } from './helpers/repo';

const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m);
const counts = (p0: number, p1: number) => ({ p0, p1, p2: 0, estMinutes: p0 + p1 });
const lines = (root: string) => readFileSync(trendFile(root), 'utf8').trim().split('\n');
function repo() {
  const r = makeRepo();
  r.write({ 'a.ts': '1\n' });
  r.commit('init');
  return r;
}

describe('trend store', () => {
  it('first run has no trend and writes one record', () => {
    const r = repo();
    expect(recordRun(r.root, counts(3, 1), 'worktree', at(12, 9, 12))).toBeUndefined();
    const [rec] = lines(r.root).map((l) => JSON.parse(l));
    expect(rec).toMatchObject({ branch: 'main', mode: 'worktree', p0: 3, p1: 1, p2: 0, estMinutes: 4 });
    expect(rec.head).toHaveLength(7);
    expect(rec.t).toBe(at(12, 9, 12).toISOString());
  });
  it('compares with the first run today', () => {
    const r = repo();
    recordRun(r.root, counts(3, 1), 'worktree', at(12, 9, 12));
    expect(recordRun(r.root, counts(1, 2), 'worktree', at(12, 11))?.line).toBe('P0 3 → 1 · P1 1 → 2 since 09:12 (2 runs today)');
    const third = recordRun(r.root, counts(0, 2), 'worktree', at(12, 15))!;
    expect(third.line).toBe('P0 3 → 0 · P1 1 → 2 since 09:12 (3 runs today)');
    expect(third.firstToday).toMatchObject({ p0: 3, p1: 1 });
    expect(third.previous).toMatchObject({ p0: 1, p1: 2 });
  });
  it('compares with the last earlier run on a new day', () => {
    const r = repo();
    recordRun(r.root, counts(3, 1), 'worktree', at(11, 14, 3));
    const t = recordRun(r.root, counts(2, 1), 'worktree', at(12, 8))!;
    expect(t.line).toBe('P0 3 → 2 · P1 1 → 1 since 2026-10-11 14:03');
    expect(t.firstToday).toBeUndefined();
  });
  it('keeps branches and modes apart', () => {
    const r = repo();
    recordRun(r.root, counts(3, 1), 'worktree', at(12, 9));
    expect(recordRun(r.root, counts(1, 1), 'staged', at(12, 10))).toBeUndefined();
    r.git('checkout', '-q', '-b', 'feat/x');
    expect(recordRun(r.root, counts(1, 1), 'worktree', at(12, 11))).toBeUndefined();
  });
  it(`keeps the last ${TREND_MAX_LINES} records`, () => {
    const r = repo();
    const old = JSON.stringify({ t: at(1, 9).toISOString(), branch: 'main', head: 'abcdef1', mode: 'worktree', ...counts(9, 9) });
    mkdirSync(dirname(trendFile(r.root)), { recursive: true });
    writeFileSync(trendFile(r.root), `${old}\n`.repeat(TREND_MAX_LINES));
    recordRun(r.root, counts(1, 1), 'worktree', at(12, 9));
    const all = lines(r.root);
    expect(all).toHaveLength(TREND_MAX_LINES);
    expect(JSON.parse(all.at(-1)!)).toMatchObject({ p0: 1 });
  });
  it('skips corrupt lines', () => {
    const r = repo();
    mkdirSync(dirname(trendFile(r.root)), { recursive: true });
    const ok = JSON.stringify({ t: at(12, 9).toISOString(), branch: 'main', head: 'abcdef1', mode: 'worktree', ...counts(2, 0) });
    writeFileSync(trendFile(r.root), `not json\n${ok}\n{"t":1}\n`);
    expect(recordRun(r.root, counts(1, 0), 'worktree', at(12, 10))?.line).toBe('P0 2 → 1 · P1 0 → 0 since 09:00 (2 runs today)');
  });
  it('never throws when the file cannot be written', () => {
    const r = repo();
    mkdirSync(trendFile(r.root), { recursive: true }); // a directory where the file should be
    expect(recordRun(r.root, counts(1, 0), 'worktree', at(12, 9))).toBeUndefined();
  });
  it('records branch HEAD on a repo with no commits', () => {
    const r = makeRepo();
    expect(recordRun(r.root, counts(0, 0), 'worktree', at(12, 9))).toBeUndefined();
    expect(JSON.parse(lines(r.root)[0]!)).toMatchObject({ branch: 'HEAD', head: '' });
  });
  it('gives each linked worktree its own file', () => {
    const r = repo();
    const wt = join(mkdtempSync(join(tmpdir(), 'rr-wt-')), 'wt');
    r.git('worktree', 'add', '-q', '-b', 'wt', wt);
    expect(trendFile(wt)).not.toBe(trendFile(r.root));
    recordRun(wt, counts(1, 0), 'worktree', at(12, 9));
    expect(lines(wt)).toHaveLength(1);
  });
  it('readTrend reports the latest run without recording', () => {
    const r = repo();
    recordRun(r.root, counts(3, 0), 'worktree', at(12, 9));
    recordRun(r.root, counts(1, 0), 'worktree', at(12, 10));
    expect(readTrend(r.root, 'worktree', at(12, 12))?.line).toBe('P0 3 → 1 · P1 0 → 0 since 09:00 (2 runs today)');
    expect(lines(r.root)).toHaveLength(2);
  });
});
