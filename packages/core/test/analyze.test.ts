import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyze } from '../src/analyze';
import type { Signal } from '../src/types';
import { makeRepo } from './helpers/repo';

describe('analyze', () => {
  it('produces a ranked risk map end-to-end', async () => {
    const r = makeRepo();
    r.write({
      'src/auth/session.ts': 'export function check() { return true; }\n',
      'src/a.ts': "import { check } from './auth/session';\n",
      'src/b.ts': "import { check } from './auth/session';\n",
      'src/session.test.ts': "import { check } from './auth/session';\nit('works', () => { expect(check()).toBe(true); });\n",
      'README.md': '# x\n',
    });
    const base = r.commit('init');
    r.write({
      'src/auth/session.ts': 'export function check() { return false; }\n',
      'src/session.test.ts': "import { check } from './auth/session';\nit.skip('works', () => { expect(check()).toBe(true); });\n",
      'README.md': '# y\n',
    });
    const head = r.commit('change', { author: 'devin-ai-integration[bot]', email: 'bot@x' });
    const map = await analyze({ repoRoot: r.root, range: `${base}..${head}` });
    expect(map.hunks[0]!.tier).toBe('P0');
    expect(map.hunks.map((h) => h.hunk.file)).toContain('src/auth/session.ts');
    expect(map.hunks.find((h) => h.hunk.file === 'README.md')!.tier).toBe('P2');
    expect(map.meta.aiAuthored.likely).toBe(true);
    expect(map.meta.version).toBe('1.2.0');
    expect(map.summary.hunks).toBe(map.hunks.length);
  });

  it('returns an empty map for an empty diff', async () => {
    const r = makeRepo();
    r.write({ 'a.ts': '1\n' });
    const head = r.commit('init');
    const map = await analyze({ repoRoot: r.root, range: `${head}..${head}` });
    expect(map.hunks).toEqual([]);
    expect(map.summary).toMatchObject({ hunks: 0, p0: 0, p1: 0, p2: 0, estMinutes: 0 });
  });

  it('drops ignored files and lists binaries as skipped', async () => {
    const r = makeRepo();
    r.write({ 'a.ts': '1\n' });
    const base = r.commit('init');
    r.write({ 'dist/out.js': 'x\n' });
    writeFileSync(join(r.root, 'logo.png'), Buffer.from([0, 1, 2, 0, 255]));
    const head = r.commit('add');
    const map = await analyze({ repoRoot: r.root, range: `${base}..${head}` });
    expect(map.hunks).toEqual([]);
    expect(map.summary.skippedFiles).toEqual(['logo.png']);
  });

  it('isolates a failing signal and records a warning', async () => {
    const r = makeRepo();
    r.write({ 'a.ts': '1\n' });
    const base = r.commit('init');
    r.write({ 'a.ts': '2\n' });
    const head = r.commit('c');
    const boom: Signal = { name: 'boom', run: () => { throw new Error('kaput'); } };
    const ok: Signal = { name: 'ok', run: (ctx) => [{ signal: 'ok', hunkId: ctx.changeSet.files[0]!.hunks[0]!.id, weight: 5, message: 'fine' }] };
    const map = await analyze({ repoRoot: r.root, range: `${base}..${head}`, signals: [boom, ok] });
    expect(map.meta.warnings).toContain('signal boom skipped: kaput');
    expect(map.hunks[0]!.score).toBe(5);
  });

  it('reads SARIF and LCOV inputs', async () => {
    const r = makeRepo();
    r.write({ 'src/db.ts': 'a\n' });
    const base = r.commit('init');
    r.write({ 'src/db.ts': 'a\nb\n' });
    const head = r.commit('c');
    r.write({
      'semgrep.sarif': JSON.stringify({ version: '2.1.0', runs: [{ tool: { driver: { name: 'Semgrep' } }, results: [
        { ruleId: 'x', level: 'error', message: { text: 'bad' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'src/db.ts' }, region: { startLine: 2 } } }] }] }] }),
      'lcov.info': 'SF:src/db.ts\nDA:2,0\nend_of_record\n',
    });
    const map = await analyze({ repoRoot: r.root, range: `${base}..${head}`, sarifPaths: ['semgrep.sarif'], lcovPath: 'lcov.info' });
    const signals = map.hunks[0]!.evidence.map((e) => e.signal);
    expect(signals).toContain('external-sarif');
    expect(signals).toContain('untested-change');
  });
});

describe('analyze workingTree', () => {
  it('scores uncommitted test gaming and counts new untracked tests as tests', async () => {
    const r = makeRepo();
    r.write({ 'src/a.ts': 'export const total = 1;\n', 'src/a.test.ts': "it('a', () => {});\n" });
    r.commit('init');
    r.write({
      'src/a.ts': 'export const total = 2;\n',
      'src/a.test.ts': "it.skip('a', () => {});\n",
      'src/b.test.ts': "import { total } from './a';\nit('b', () => expect(total).toBe(2));\n",
    });
    const map = await analyze({ repoRoot: r.root, workingTree: true, useCache: false });
    expect(map.hunks[0]!.hunk.file).toBe('src/a.test.ts');
    expect(map.hunks[0]!.tier).toBe('P0');
    const aHunk = map.hunks.find((h) => h.hunk.file === 'src/a.ts')!;
    expect(aHunk.evidence.map((e) => e.signal)).not.toContain('untested-change');
  });
  it('staged: index scores only staged changes', async () => {
    const r = makeRepo();
    r.write({ 'src/a.test.ts': "it('a', () => {});\n", 'src/b.test.ts': "it('b', () => {});\n" });
    r.commit('init');
    r.write({ 'src/a.test.ts': "it.skip('a', () => {});\n", 'src/b.test.ts': "it.skip('b', () => {});\n" });
    r.git('add', 'src/a.test.ts');
    const map = await analyze({ repoRoot: r.root, staged: 'index' });
    expect(map.hunks.map((h) => h.hunk.file)).toEqual(['src/a.test.ts']);
    expect(map.hunks[0]!.tier).toBe('P0');
  });
});
