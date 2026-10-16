import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseUnifiedDiff, getChangeSet } from '../src/diff';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RadarError } from '../src/errors';
import { makeRepo } from './helpers/repo';

const MODIFY = [
  'diff --git a/src/auth.ts b/src/auth.ts',
  'index 111..222 100644',
  '--- a/src/auth.ts',
  '+++ b/src/auth.ts',
  '@@ -3,2 +3,3 @@ export function login() {',
  '-  return check(a);',
  '-  // old',
  '+  if (!a) throw new Error();',
  '+  return check(a, b);',
  '+  // new',
  '@@ -20 +21,0 @@',
  '-const unused = 1;',
  '',
].join('\n');

describe('parseUnifiedDiff', () => {
  it('parses hunks, ranges, added/removed lines and added line numbers', () => {
    const [f] = parseUnifiedDiff(MODIFY);
    expect(f!.path).toBe('src/auth.ts');
    expect(f!.status).toBe('modified');
    expect(f!.language).toBe('ts');
    expect(f!.hunks).toHaveLength(2);
    const [h1, h2] = f!.hunks;
    expect(h1!.oldRange).toEqual({ start: 3, end: 4 });
    expect(h1!.newRange).toEqual({ start: 3, end: 5 });
    expect(h1!.added).toEqual(['  if (!a) throw new Error();', '  return check(a, b);', '  // new']);
    expect(h1!.removed).toHaveLength(2);
    expect(h1!.addedLines).toEqual([3, 4, 5]);
    expect(h1!.id).toBe('src/auth.ts:3-5');
    expect(h2!.oldRange).toEqual({ start: 20, end: 20 });
    expect(h2!.newRange).toEqual({ start: 21, end: 21 });
    expect(h2!.added).toEqual([]);
  });

  it('treats CRLF diffs identically to LF', () => {
    const crlf = parseUnifiedDiff(MODIFY.replace(/\n/g, '\r\n'));
    expect(crlf).toEqual(parseUnifiedDiff(MODIFY));
  });

  it('handles new, deleted, renamed and binary files', () => {
    const text = [
      'diff --git a/n.py b/n.py', 'new file mode 100644', '--- /dev/null', '+++ b/n.py',
      '@@ -0,0 +1,2 @@', '+import os', '+print(1)',
      'diff --git a/tests/old.test.ts b/tests/old.test.ts', 'deleted file mode 100644',
      '--- a/tests/old.test.ts', '+++ /dev/null', '@@ -1,2 +0,0 @@', "-it('x', () => {});", '-',
      'diff --git a/a/x.ts b/b/y.ts', 'similarity index 90%', 'rename from a/x.ts', 'rename to b/y.ts',
      'diff --git a/logo.png b/logo.png', 'Binary files a/logo.png and b/logo.png differ',
      'diff --git a/z.ts b/z.ts', '--- a/z.ts', '+++ b/z.ts', '@@ -1 +1 @@', '-a', '+b',
      '\\ No newline at end of file', '',
    ].join('\n');
    const files = parseUnifiedDiff(text);
    expect(files.map((f) => [f.path, f.status, f.binary])).toEqual([
      ['n.py', 'added', false],
      ['tests/old.test.ts', 'deleted', false],
      ['b/y.ts', 'renamed', false],
      ['logo.png', 'modified', true],
      ['z.ts', 'modified', false],
    ]);
    expect(files[0]!.hunks[0]!.addedLines).toEqual([1, 2]);
    expect(files[1]!.isTest).toBe(true);
    expect(files[1]!.hunks[0]!.newRange).toEqual({ start: 0, end: 0 });
    expect(files[1]!.hunks[0]!.id).toBe('tests/old.test.ts:0-0');
    expect(files[2]!.oldPath).toBe('a/x.ts');
    expect(files[4]!.hunks[0]!.added).toEqual(['b']);
  });

  it('returns [] for empty input', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
  });
});

describe('getChangeSet', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('diffs an explicit base..head range', () => {
    const r = makeRepo();
    r.write({ 'src/a.ts': 'export const a = 1;\n' });
    const base = r.commit('init');
    r.write({ 'src/a.ts': 'export const a = 2;\n' });
    const head = r.commit('change');
    const cs = getChangeSet(r.root, `${base}..${head}`);
    expect(cs.base).toBe(base);
    expect(cs.head).toBe(head);
    expect(cs.files.map((f) => f.path)).toEqual(['src/a.ts']);
  });

  it('three-dot base...head diffs from the merge-base (PR semantics), ignoring later base commits', () => {
    const r = makeRepo();
    r.write({ 'a.ts': '1\n' });
    r.commit('init');
    r.git('checkout', '-q', '-b', 'feature');
    r.write({ 'feat.ts': 'x\n' });
    const head = r.commit('feat');
    r.git('checkout', '-q', 'main');
    r.write({ 'main-only.ts': 'y\n' });
    const base = r.commit('main moves on');
    expect(getChangeSet(r.root, `${base}...${head}`).files.map((f) => f.path)).toEqual(['feat.ts']);
    // two-dot keeps git's direct-diff meaning
    expect(getChangeSet(r.root, `${base}..${head}`).files.map((f) => f.path).sort()).toEqual(['feat.ts', 'main-only.ts']);
  });

  it('defaults to merge-base with main', () => {
    const r = makeRepo();
    r.write({ 'a.ts': '1\n' });
    const base = r.commit('init');
    r.git('checkout', '-q', '-b', 'feature');
    r.write({ 'a.ts': '2\n' });
    r.commit('feat');
    const cs = getChangeSet(r.root);
    expect(cs.base).toBe(base);
    expect(cs.files).toHaveLength(1);
  });

  it('throws BASE_NOT_FOUND with a fetch-depth hint for an unknown base in GitHub Actions', () => {
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    const r = makeRepo();
    r.write({ 'a.ts': '1\n' });
    r.commit('init');
    try {
      getChangeSet(r.root, 'deadbeef..HEAD');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(RadarError);
      expect((e as RadarError).code).toBe('BASE_NOT_FOUND');
      expect((e as RadarError).message).toContain('fetch-depth: 0');
    }
  });

  it('leaves the GitHub Actions hint out elsewhere', () => {
    vi.stubEnv('GITHUB_ACTIONS', '');
    const r = makeRepo();
    r.write({ 'a.ts': '1\n' });
    r.commit('init');
    expect(() => getChangeSet(r.root, 'deadbeef..HEAD')).toThrow(/^Cannot find base commit "deadbeef"\.$/);
  });

  it('throws NOT_A_REPO outside git', () => {
    expect(() => getChangeSet(process.platform === 'win32' ? 'C:\\' : '/')).toThrow(RadarError);
  });
});

describe('getChangeSet workingTree', () => {
  function repo() {
    const r = makeRepo();
    r.write({ 'src/a.ts': 'export const a = 1;\n', '.gitignore': 'out/\n' });
    r.commit('init');
    return r;
  }
  const paths = (r: ReturnType<typeof repo>) => getChangeSet(r.root, undefined, { workingTree: true }).files.map((f) => f.path).sort();

  it('includes unstaged edits', () => {
    const r = repo();
    r.write({ 'src/a.ts': 'export const a = 2;\n' });
    const [f] = getChangeSet(r.root, undefined, { workingTree: true }).files;
    expect(f!.path).toBe('src/a.ts');
    expect(f!.hunks[0]!.added).toEqual(['export const a = 2;']);
  });
  it('includes staged edits', () => {
    const r = repo();
    r.write({ 'src/a.ts': 'export const a = 3;\n' });
    r.git('add', 'src/a.ts');
    expect(paths(r)).toEqual(['src/a.ts']);
  });
  it('adds untracked files as added files covering every line', () => {
    const r = repo();
    r.write({ 'src/new.ts': 'a\nb\n' });
    const f = getChangeSet(r.root, undefined, { workingTree: true }).files.find((x) => x.path === 'src/new.ts')!;
    expect(f.status).toBe('added');
    expect(f.language).toBe('ts');
    expect(f.hunks[0]).toMatchObject({ id: 'src/new.ts:1-2', newRange: { start: 1, end: 2 }, added: ['a', 'b'], addedLines: [1, 2] });
  });
  it('skips gitignored untracked files and the legacy cache dir', () => {
    const r = repo();
    r.write({ 'out/x.js': '1\n', '.reviewradar-cache/graph-abc.json': '{}\n' });
    expect(paths(r)).toEqual([]);
  });
  it('marks binary or oversized untracked files as binary', () => {
    const r = repo();
    writeFileSync(join(r.root, 'img.png'), Buffer.from([0x89, 0x50, 0, 1, 2]));
    r.write({ 'big.js': 'x\n'.repeat(600_000) });
    const files = getChangeSet(r.root, undefined, { workingTree: true }).files;
    expect(files.map((f) => [f.path, f.binary]).sort()).toEqual([['big.js', true], ['img.png', true]]);
  });
  it('handles CRLF content and spaces in untracked names', () => {
    const r = repo();
    r.write({ 'my file.ts': 'a\r\nb\r\n' });
    const [f] = getChangeSet(r.root, undefined, { workingTree: true }).files;
    expect(f!.path).toBe('my file.ts');
    expect(f!.hunks[0]!.added).toEqual(['a', 'b']);
  });
  it('ignores workingTree when an explicit range is given', () => {
    const r = repo();
    const base = r.git('rev-parse', 'HEAD');
    r.write({ 'src/b.ts': 'export const b = 1;\n' });
    r.commit('b');
    r.write({ 'src/a.ts': 'export const a = 9;\n' });
    const cs = getChangeSet(r.root, `${base}..HEAD`, { workingTree: true });
    expect(cs.files.map((f) => f.path)).toEqual(['src/b.ts']);
  });
  it('returns no files for a clean tree at the merge-base', () => {
    expect(paths(repo())).toEqual([]);
  });
});

describe('repos with no commits', () => {
  it.each([undefined, { workingTree: true }])('throws NO_COMMITS with no range (%o)', (opts) => {
    const r = makeRepo();
    r.write({ 'a.ts': '1\n' });
    try {
      getChangeSet(r.root, undefined, opts);
      expect.unreachable();
    } catch (e) {
      expect((e as RadarError).code).toBe('NO_COMMITS');
      expect((e as RadarError).message).toBe('No commits yet: nothing to review.');
    }
  });
});

describe('getChangeSet staged', () => {
  function repo() {
    const r = makeRepo();
    r.write({ 'src/a.ts': 'export const a = 1;\n', 'src/b.ts': 'export const b = 1;\n', 'src/gone.ts': 'x\n' });
    r.commit('init');
    return r;
  }
  const paths = (r: ReturnType<typeof repo>, staged: 'index' | 'all') =>
    getChangeSet(r.root, undefined, { staged }).files.map((f) => f.path).sort();

  it("'index' sees only staged changes", () => {
    const r = repo();
    r.write({ 'src/a.ts': 'export const a = 2;\n' });
    r.git('add', 'src/a.ts');
    r.write({ 'src/b.ts': 'export const b = 2;\n', 'src/new.ts': 'n\n' });
    expect(paths(r, 'index')).toEqual(['src/a.ts']);
  });
  it("'all' sees staged, unstaged and untracked changes", () => {
    const r = repo();
    r.write({ 'src/a.ts': 'export const a = 2;\n' });
    r.git('add', 'src/a.ts');
    r.write({ 'src/b.ts': 'export const b = 2;\n', 'src/new.ts': 'n\n' });
    expect(paths(r, 'all')).toEqual(['src/a.ts', 'src/b.ts', 'src/new.ts']);
  });
  it('reports staged additions and deletions with their status', () => {
    const r = repo();
    r.write({ 'src/added.ts': 'a\n' });
    r.git('add', 'src/added.ts');
    r.git('rm', '-q', 'src/gone.ts');
    const files = getChangeSet(r.root, undefined, { staged: 'index' }).files;
    expect(Object.fromEntries(files.map((f) => [f.path, f.status]))).toEqual({ 'src/added.ts': 'added', 'src/gone.ts': 'deleted' });
  });
  it('diffs against HEAD, so base and head are both HEAD', () => {
    const r = repo();
    const head = r.git('rev-parse', 'HEAD');
    const cs = getChangeSet(r.root, undefined, { staged: 'index' });
    expect(cs).toMatchObject({ base: head, head, files: [] });
  });
  it('rejects a range combined with staged', () => {
    const r = repo();
    expect(() => getChangeSet(r.root, 'main..HEAD', { staged: 'index' })).toThrow("--staged can't be combined with a range.");
  });
  it('throws NO_COMMITS before the first commit', () => {
    const r = makeRepo();
    r.write({ 'a.ts': '1\n' });
    r.git('add', 'a.ts');
    expect(() => getChangeSet(r.root, undefined, { staged: 'index' })).toThrow('No commits yet: nothing to review.');
  });
});
