import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { git, tryGit } from './git';

export type TrendMode = 'worktree' | 'staged';
export type TrendRecord = { t: string; branch: string; head: string; mode: TrendMode; p0: number; p1: number; p2: number; estMinutes: number };
export type TrendPoint = { t: string; p0: number; p1: number };
export type Trend = { line: string; previous?: TrendPoint; firstToday?: TrendPoint };
export type TrendCounts = { p0: number; p1: number; p2: number; estMinutes: number };

export const TREND_MAX_LINES = 1000;

/** Per-worktree file inside the git dir, so it never shows up as a change. */
export function trendFile(repoRoot: string): string {
  const p = git(repoRoot, ['rev-parse', '--git-path', 'review-radar/trend.jsonl']).trim();
  return isAbsolute(p) ? p : join(repoRoot, p);
}

const pad = (n: number) => String(n).padStart(2, '0');
const day = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const point = (r: TrendRecord): TrendPoint => ({ t: r.t, p0: r.p0, p1: r.p1 });

function readRecords(file: string): TrendRecord[] {
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch { return []; }
  const out: TrendRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as TrendRecord;
      if (typeof r.t === 'string' && typeof r.p0 === 'number' && typeof r.p1 === 'number') out.push(r);
    } catch { /* corrupt line */ }
  }
  return out;
}

/** Compares `current` with the first of today's earlier runs, else the last earlier run. */
export function computeTrend(earlier: TrendRecord[], current: { p0: number; p1: number }, now: Date): Trend | undefined {
  const last = earlier.at(-1);
  if (!last) return undefined;
  const todays = earlier.filter((r) => day(new Date(r.t)) === day(now));
  const from = todays[0] ?? last;
  const at = new Date(from.t);
  const since = todays.length ? `since ${hhmm(at)} (${todays.length + 1} runs today)` : `since ${day(at)} ${hhmm(at)}`;
  return {
    line: `P0 ${from.p0} → ${current.p0} · P1 ${from.p1} → ${current.p1} ${since}`,
    previous: point(last),
    ...(todays[0] ? { firstToday: point(todays[0]) } : {}),
  };
}

const branchOf = (root: string) => tryGit(root, ['rev-parse', '--abbrev-ref', 'HEAD'])?.trim() || 'HEAD';
const headOf = (root: string) => tryGit(root, ['rev-parse', '--short=7', 'HEAD'])?.trim() ?? '';

/** Appends this run and returns its trend. Best-effort: any failure means no trend, never an error. */
export function recordRun(repoRoot: string, counts: TrendCounts, mode: TrendMode, now: Date = new Date()): Trend | undefined {
  try {
    const file = trendFile(repoRoot);
    const all = readRecords(file);
    const branch = branchOf(repoRoot);
    const trend = computeTrend(all.filter((r) => r.branch === branch && r.mode === mode), counts, now);
    const { p0, p1, p2, estMinutes } = counts;
    const rec: TrendRecord = { t: now.toISOString(), branch, head: headOf(repoRoot), mode, p0, p1, p2, estMinutes };
    mkdirSync(dirname(file), { recursive: true });
    if (all.length + 1 > TREND_MAX_LINES) {
      writeFileSync(file, [...all, rec].slice(-TREND_MAX_LINES).map((r) => JSON.stringify(r)).join('\n') + '\n');
    } else {
      appendFileSync(file, JSON.stringify(rec) + '\n');
    }
    return trend;
  } catch {
    return undefined;
  }
}

/** The trend of the latest recorded run on this branch, without recording a new one. */
export function readTrend(repoRoot: string, mode: TrendMode, now: Date = new Date()): Trend | undefined {
  try {
    const branch = branchOf(repoRoot);
    const mine = readRecords(trendFile(repoRoot)).filter((r) => r.branch === branch && r.mode === mode);
    const latest = mine.pop();
    return latest && computeTrend(mine, latest, now);
  } catch {
    return undefined;
  }
}
