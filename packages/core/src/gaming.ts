import type { Config, Context, Evidence } from './types';
import { getChangeSet, type StagedMode } from './diff';
import { isIgnored, loadConfig } from './config';
import { testGamingSignal } from './signals/test-gaming';

export type GamingFinding = { file: string; startLine: number; endLine: number; ruleId: string; message: string };

/**
 * Test-gaming evidence in the changes a commit would record. Runs one `git diff` and the
 * test-gaming signal only (no history, no import graph), so it stays fast enough for a hook.
 */
export function findTestGaming(repoRoot: string, staged: StagedMode, config: Config = loadConfig(repoRoot)): GamingFinding[] {
  const raw = getChangeSet(repoRoot, undefined, { staged });
  const changeSet = { ...raw, files: raw.files.filter((f) => !f.binary && !isIgnored(f.path, config)) };
  const ctx: Context = {
    repoRoot, changeSet, config, sarif: [], testFiles: [],
    importGraph: { importedBy: () => [], importsOf: () => [] },
    git: { churn: () => 0, shallow: false },
    readFile: () => undefined,
  };
  const hunks = new Map(changeSet.files.flatMap((f) => f.hunks).map((h) => [h.id, h]));
  return (testGamingSignal.run(ctx) as Evidence[]).flatMap((e) => {
    const h = hunks.get(e.hunkId);
    if (!h) return [];
    const r = h.newRange.start ? h.newRange : h.oldRange; // deleted files only have old lines
    return [{ file: h.file, startLine: r.start, endLine: r.end, ruleId: e.ruleId ?? e.signal, message: e.message }];
  });
}
