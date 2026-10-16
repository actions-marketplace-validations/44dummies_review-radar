export type Lang = 'ts' | 'tsx' | 'js' | 'py';
export type Tier = 'P0' | 'P1' | 'P2';

/** 1-based inclusive line range. start = 0 means "no lines on this side" (pure add/delete). */
export interface Range { start: number; end: number }

export interface Hunk {
  id: string;            // `${file}:${newRange.start}-${newRange.end}`
  file: string;          // repo-relative POSIX path (new path)
  oldRange: Range;
  newRange: Range;
  added: string[];       // added line texts, no leading '+'
  removed: string[];     // removed line texts, no leading '-'
  addedLines: number[];  // new-file line numbers of each added line
}

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface ChangedFile {
  path: string;
  oldPath?: string;
  status: FileStatus;
  binary: boolean;
  language?: Lang;
  isTest: boolean;
  hunks: Hunk[];
}

export interface ChangeSet { base: string; head: string; files: ChangedFile[] }

/** hunkId '*' means "applies to every hunk" (PR-level evidence). */
export interface Evidence {
  signal: string;
  hunkId: string;
  weight: number;
  message: string;
  lines?: Range;
  ruleId?: string;
}

export interface HunkRisk { hunk: Hunk; score: number; tier: Tier; evidence: Evidence[] }

export interface Summary {
  hunks: number;
  p0: number;
  p1: number;
  p2: number;
  estMinutes: number;
  skippedFiles: string[];
}

export interface AiAuthorship { likely: boolean; reasons: string[] }

export interface RiskMap {
  changeSet: ChangeSet;
  hunks: HunkRisk[];
  summary: Summary;
  meta: { version: string; warnings: string[]; aiAuthored: AiAuthorship };
}

export interface ImportGraph {
  importedBy(path: string): string[];
  importsOf(path: string): string[];
}

export interface GitHistory {
  churn(path: string): number;
  shallow: boolean;
}

export interface SarifResult {
  tool: string;
  ruleId: string;
  level: 'error' | 'warning' | 'note' | 'none';
  message: string;
  file: string;          // repo-relative POSIX
  startLine: number;
  endLine: number;
}

export interface LcovData { lines(path: string): Map<number, number> | undefined }

export interface Weights {
  sensitivePath: number;
  sensitiveCode: number;
  blastRadiusPerImporter: number;
  blastRadiusMax: number;
  untestedChange: number;
  testGaming: number;
  dependencyManifest: number;
  dependencyMajor: number;
  dependencyLockfile: number;
  churnPerChange: number;
  churnMax: number;
  churnMin: number;
  sizePer10Lines: number;
  sizeMax: number;
  sizeMin: number;
  diffusion: number;
  sarifError: number;
  sarifWarning: number;
  sarifNote: number;
}

export type PreCommitMode = 'warn' | 'block' | 'off';

export interface Config {
  weights: Weights;
  tiers: { p0: number; p1: number };
  sensitivePaths: string[];   // regex sources, case-insensitive
  sensitiveCode: string[];    // regex sources, case-insensitive
  ignore: string[];           // picomatch globs
  churnDays: number;
  diffusion: { files: number; dirs: number };
  agentHooks: { preCommit: PreCommitMode };  // Claude Code commit hook
}

export interface Context {
  repoRoot: string;
  changeSet: ChangeSet;
  importGraph: ImportGraph;
  git: GitHistory;
  sarif: SarifResult[];
  lcov?: LcovData;
  config: Config;
  readFile(path: string): string | undefined; // repo-relative; undefined if missing
  testFiles: string[];                         // all tracked test files
}

export interface Signal {
  name: string;
  run(ctx: Context): Promise<Evidence[]> | Evidence[];
}

export function tierFor(score: number, tiers = { p0: 70, p1: 40 }): Tier {
  if (score >= tiers.p0) return 'P0';
  if (score >= tiers.p1) return 'P1';
  return 'P2';
}
