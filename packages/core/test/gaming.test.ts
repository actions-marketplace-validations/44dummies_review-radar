import { describe, it, expect } from 'vitest';
import { findTestGaming } from '../src/gaming';
import { loadConfig } from '../src/config';
import { makeRepo } from './helpers/repo';

function repo() {
  const r = makeRepo();
  r.write({ 'test/a.test.ts': "it('a', () => {});\n", 'legacy/b.test.ts': "it('b', () => {});\n", 'src/u.ts': 'export const u = 1;\n' });
  r.commit('init');
  return r;
}

describe('findTestGaming', () => {
  it('finds a staged skip with its location and rule', () => {
    const r = repo();
    r.write({ 'test/a.test.ts': "it.skip('a', () => {});\n" });
    r.git('add', '-A');
    expect(findTestGaming(r.root, 'index')).toEqual([
      { file: 'test/a.test.ts', startLine: 1, endLine: 1, ruleId: 'skip-added', message: 'skips a test (`.skip`/`xit`/`pytest.mark.skip`/`xfail`)' },
    ]);
  });
  it("ignores an unstaged skip in 'index' mode and finds it in 'all'", () => {
    const r = repo();
    r.write({ 'test/a.test.ts': "it.skip('a', () => {});\n" });
    expect(findTestGaming(r.root, 'index')).toEqual([]);
    expect(findTestGaming(r.root, 'all').map((f) => f.file)).toEqual(['test/a.test.ts']);
  });
  it('reports a deleted test file at its old location', () => {
    const r = repo();
    r.git('rm', '-q', 'test/a.test.ts');
    expect(findTestGaming(r.root, 'index')).toMatchObject([{ file: 'test/a.test.ts', startLine: 1, ruleId: 'test-file-deleted' }]);
  });
  it('drops ignored paths', () => {
    const r = repo();
    r.write({ '.reviewradar.yml': 'ignore:\n  - "legacy/**"\n', 'legacy/b.test.ts': "it.skip('b', () => {});\n" });
    expect(findTestGaming(r.root, 'all', loadConfig(r.root))).toEqual([]);
  });
  it('returns nothing for a clean commit', () => {
    const r = repo();
    r.write({ 'src/u.ts': 'export const u = 2;\n' });
    r.git('add', '-A');
    expect(findTestGaming(r.root, 'index')).toEqual([]);
  });
});
