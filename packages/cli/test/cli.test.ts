import { describe, it, expect, vi } from 'vitest';
import { main } from '../src/cli';
import { makeRepo } from '../../core/test/helpers/repo';

function run(argv: string[], cwd: string) {
  let out = '', err = '';
  return main(argv, { stdout: (s) => (out += s), stderr: (s) => (err += s), cwd }).then((code) => ({ code, out, err }));
}

function fixture() {
  const r = makeRepo();
  r.write({ 'src/auth.ts': 'export const a = 1;\n', 'src/a.test.ts': "it('a', () => {});\n" });
  const base = r.commit('init');
  r.write({ 'src/auth.ts': 'export const a = 2;\n', 'src/a.test.ts': "it.skip('a', () => {});\n" });
  const head = r.commit('change');
  return { r, range: `${base}..${head}` };
}

describe('cli', () => {
  it('--working-tree reviews uncommitted changes; the default stays committed-only', async () => {
    const r = makeRepo();
    r.write({ 'src/a.test.ts': "it('a', () => {});\n" });
    r.commit('init');
    r.write({ 'src/a.test.ts': "it.skip('a', () => {});\n" });
    const wt = await run(['--working-tree', '--no-color'], r.root);
    expect(wt.code).toBe(0);
    expect(wt.out).toContain('src/a.test.ts');
    expect((await run(['--no-color'], r.root)).out).not.toContain('src/a.test.ts');
  });
  it('documents the mcp subcommand in --help', async () => {
    const { r } = fixture();
    expect((await run(['--help'], r.root)).out).toContain('review-radar mcp');
  });
  it('documents --working-tree in --help', async () => {
    const { r } = fixture();
    expect((await run(['--help'], r.root)).out).toContain('--working-tree');
  });
  it('prints the terminal report and exits 0 by default', async () => {
    const { r, range } = fixture();
    const res = await run([range, '--no-color'], r.root);
    expect(res.code).toBe(0);
    expect(res.out).toContain('src/a.test.ts');
    expect(res.out).toContain('est. review time');
  });
  it('exits 1 with --fail-on P0 when a P0 exists', async () => {
    const { r, range } = fixture();
    expect((await run([range, '--fail-on', 'P0', '--no-color'], r.root)).code).toBe(1);
  });
  it('writes json/sarif/md to --out', async () => {
    const { r, range } = fixture();
    const res = await run([range, '--format', 'sarif', '--out', 'rr.sarif'], r.root);
    expect(res.code).toBe(0);
    const { readFileSync } = await import('node:fs');
    expect(JSON.parse(readFileSync(`${r.root}/rr.sarif`, 'utf8')).version).toBe('2.1.0');
  });
  it('exits 2 with a helpful message on a bad base', async () => {
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    const { r } = fixture();
    const res = await run(['nope..HEAD'], r.root);
    expect(res.code).toBe(2);
    expect(res.err).toContain('fetch-depth: 0');
    vi.unstubAllEnvs();
  });
  it('exits 2 on unknown format or flag', async () => {
    const { r } = fixture();
    expect((await run(['--format', 'xml'], r.root)).code).toBe(2);
    expect((await run(['--bogus'], r.root)).code).toBe(2);
  });
  it('prints version and help', async () => {
    const { r } = fixture();
    expect((await run(['--version'], r.root)).out.trim()).toBe('1.2.0');
    expect((await run(['--help'], r.root)).out).toContain('Usage: review-radar');
  });
  it('--staged reviews only staged changes', async () => {
    const r = makeRepo();
    r.write({ 'src/a.test.ts': "it('a', () => {});\n", 'src/b.test.ts': "it('b', () => {});\n" });
    r.commit('init');
    r.write({ 'src/a.test.ts': "it.skip('a', () => {});\n", 'src/b.test.ts': "it.skip('b', () => {});\n" });
    r.git('add', 'src/a.test.ts');
    const res = await run(['--staged', '--no-color'], r.root);
    expect(res.code).toBe(0);
    expect(res.out).toContain('src/a.test.ts');
    expect(res.out).not.toContain('src/b.test.ts');
  });
  it('rejects --staged with a range or --working-tree', async () => {
    const { r, range } = fixture();
    expect((await run(['--staged', range], r.root)).code).toBe(2);
    const res = await run(['--staged', '--working-tree'], r.root);
    expect(res.code).toBe(2);
    expect(res.err).toContain("--staged can't be combined with a range or --working-tree");
  });
  it('prints "nothing to review" and exits 0 in a repo with no commits', async () => {
    const r = makeRepo();
    r.write({ 'a.ts': '1\n' });
    const res = await run(['--working-tree'], r.root);
    expect(res).toMatchObject({ code: 0, out: 'No commits yet: nothing to review.\n' });
  });
  it('branches prints a table and json', async () => {
    const { r } = fixture();
    r.git('checkout', '-q', '-b', 'feat/x', 'HEAD~1');
    r.write({ 'src/a.test.ts': "it.skip('a', () => {});\n" });
    r.commit('skip');
    r.git('checkout', '-q', 'main');
    const table = await run(['branches'], r.root);
    expect(table.code).toBe(0);
    expect(table.out).toMatch(/^Branch\s+P0/);
    expect(table.out).toContain('feat/x');
    const json = await run(['branches', '--format', 'json', '--limit', '5'], r.root);
    expect(JSON.parse(json.out)).toMatchObject({ base: 'main', branches: [{ name: 'feat/x' }], skipped: 0 });
  });
  it('branches rejects a bad limit or format', async () => {
    const { r } = fixture();
    expect((await run(['branches', '--limit', '0'], r.root)).code).toBe(2);
    expect((await run(['branches', '--format', 'sarif'], r.root)).code).toBe(2);
  });
  it('documents --staged, branches and the hook in --help', async () => {
    const { r } = fixture();
    const out = (await run(['--help'], r.root)).out;
    expect(out).toContain('--staged');
    expect(out).toContain('review-radar branches');
    expect(out).toContain('review-radar hook pre-commit');
  });
});
