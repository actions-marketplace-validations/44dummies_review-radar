import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { Context, Evidence, RiskMap, Signal } from './types';
import { getChangeSet, type StagedMode } from './diff';
import { loadConfig, isIgnored } from './config';
import { buildGitHistory, detectAiAuthorship } from './history';
import { buildImportGraph } from './imports/graph';
import { parseSarif } from './sarif-input';
import { parseLcov } from './lcov';
import { isTestFile } from './lang';
import { git } from './git';
import { defaultSignals } from './signals/index';
import { scoreHunks, summarize } from './scorer';
import { RadarError } from './errors';

export const VERSION = '1.2.0';

export interface AnalyzeOptions {
  repoRoot: string;
  range?: string;
  sarifPaths?: string[];
  lcovPath?: string;
  configPath?: string;
  useCache?: boolean;
  signals?: Signal[];
  /** With no range: also review uncommitted and untracked changes. */
  workingTree?: boolean;
  /** Review what a commit would record (diff against HEAD). */
  staged?: StagedMode;
  /** Commit whose on-disk checkout the import graph is built from and cached under (default: the reviewed head). */
  importGraphFrom?: string;
}

const abs = (root: string, p: string) => (isAbsolute(p) ? p : join(root, p));

function readInput(root: string, p: string, kind: string): string {
  const full = abs(root, p);
  if (!existsSync(full)) throw new RadarError('BAD_INPUT', `${kind} file not found: ${p}`);
  return readFileSync(full, 'utf8');
}

export async function analyze(opts: AnalyzeOptions): Promise<RiskMap> {
  const { repoRoot } = opts;
  const config = loadConfig(repoRoot, opts.configPath);
  const raw = getChangeSet(repoRoot, opts.range, { workingTree: opts.workingTree, staged: opts.staged });
  const warnings: string[] = [];

  const skippedFiles = raw.files.filter((f) => f.binary && !isIgnored(f.path, config)).map((f) => f.path);
  const changeSet = { ...raw, files: raw.files.filter((f) => !f.binary && !isIgnored(f.path, config)) };
  const hunks = changeSet.files.flatMap((f) => f.hunks);
  const aiAuthored = detectAiAuthorship(repoRoot, raw.base, raw.head);

  if (hunks.length === 0) {
    return { changeSet, hunks: [], summary: summarize([], skippedFiles), meta: { version: VERSION, warnings, aiAuthored } };
  }

  const history = buildGitHistory(repoRoot, raw.head, config.churnDays);
  if (history.shallow) warnings.push('shallow clone: churn signal disabled (use fetch-depth: 0)');

  const sarif = (opts.sarifPaths ?? []).flatMap((p) => parseSarif(readInput(repoRoot, p, 'SARIF'), repoRoot));
  const lcov = opts.lcovPath ? parseLcov(readInput(repoRoot, opts.lcovPath, 'LCOV'), repoRoot) : undefined;

  let importGraph: Context['importGraph'];
  try {
    importGraph = await buildImportGraph(repoRoot, opts.importGraphFrom ?? raw.head, { useCache: opts.useCache ?? true });
  } catch (e) {
    warnings.push(`import graph unavailable: ${(e as Error).message}`);
    importGraph = { importedBy: () => [], importsOf: () => [] };
  }

  const tracked = git(repoRoot, ['ls-files', '-z']).split('\0').filter(Boolean);
  const ctx: Context = {
    repoRoot, changeSet, importGraph, git: history, sarif, lcov, config,
    // newly added files (untracked in working-tree mode) can be tests too
    testFiles: [...new Set([...tracked, ...changeSet.files.filter((f) => f.status === 'added').map((f) => f.path)])].filter(isTestFile),
    readFile: (p) => { try { return readFileSync(join(repoRoot, p), 'utf8'); } catch { return undefined; } },
  };

  const evidence: Evidence[] = [];
  for (const s of opts.signals ?? defaultSignals) {
    try {
      evidence.push(...(await s.run(ctx)));
    } catch (e) {
      warnings.push(`signal ${s.name} skipped: ${(e as Error).message}`);
    }
  }

  const risks = scoreHunks(hunks, evidence, config);
  return { changeSet, hunks: risks, summary: summarize(risks, skippedFiles), meta: { version: VERSION, warnings, aiAuthored } };
}
