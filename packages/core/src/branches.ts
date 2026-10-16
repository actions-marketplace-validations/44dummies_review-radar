import { basename } from 'node:path';
import type { RiskMap } from './types';
import { analyze } from './analyze';
import { defaultBranch } from './diff';
import { git, tryGit } from './git';
import { readTrend } from './trend';
import { RadarError } from './errors';

export type BranchRow = {
  name: string; worktree?: string; dirty: boolean;
  p0: number; p1: number; p2: number; estMinutes: number;
  top?: { file: string; line: number; message: string };
  trend?: string;
  error?: string;
};
export type BranchesResult = { base: string; branches: BranchRow[]; skipped: number };

type Worktree = { path: string; branch?: string };

function listWorktrees(repoRoot: string): Worktree[] {
  const out: Worktree[] = [];
  for (const line of git(repoRoot, ['worktree', 'list', '--porcelain']).split(/\r?\n/)) {
    if (line.startsWith('worktree ')) out.push({ path: line.slice('worktree '.length) });
    else if (line.startsWith('branch refs/heads/') && out.length) out.at(-1)!.branch = line.slice('branch refs/heads/'.length);
    else if (line === 'bare') out.pop();
  }
  return out;
}

const refs = (text: string) => text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
const isDirty = (path: string) => (tryGit(path, ['status', '--porcelain']) ?? '').trim() !== '';

export function rankBranches(rows: BranchRow[]): BranchRow[] {
  return [...rows].sort((a, b) =>
    Number(!!a.error) - Number(!!b.error) || b.p0 - a.p0 || b.p1 - a.p1 || b.estMinutes - a.estMinutes || a.name.localeCompare(b.name));
}

function countsOf(map: RiskMap): Omit<BranchRow, 'name' | 'dirty'> {
  const { p0, p1, p2, estMinutes } = map.summary;
  const h = map.hunks[0]; // hunks come sorted by score
  return { p0, p1, p2, estMinutes, ...(h ? { top: { file: h.hunk.file, line: h.hunk.newRange.start, message: h.evidence[0]?.message ?? '' } } : {}) };
}

/**
 * Local branches not merged into the default branch, plus worktrees with uncommitted work,
 * ranked by how much review they need. Checked-out branches include their uncommitted changes.
 */
export async function reviewBranches(repoRoot: string, opts: { limit?: number; now?: Date } = {}): Promise<BranchesResult> {
  const limit = opts.limit ?? 20;
  const base = defaultBranch(repoRoot);
  if (!base) throw new RadarError('BASE_NOT_FOUND', 'No default branch found, so there is nothing to compare branches against.');
  const merged = new Set(refs(git(repoRoot, ['branch', '--merged', base, '--format=%(refname:short)'])));
  const worktrees = listWorktrees(repoRoot);
  const checkedOut = new Map(worktrees.filter((w) => w.branch).map((w) => [w.branch!, w]));

  const candidates: { name: string; worktree?: Worktree; dirty: boolean }[] = [];
  for (const name of refs(git(repoRoot, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads']))) {
    const wt = checkedOut.get(name);
    const dirty = wt ? isDirty(wt.path) : false;
    if ((name === base || merged.has(name)) && !dirty) continue;
    candidates.push({ name, worktree: wt, dirty });
  }
  for (const wt of worktrees) {
    if (!wt.branch && isDirty(wt.path)) candidates.push({ name: basename(wt.path), worktree: wt, dirty: true });
  }

  // Non-checked-out branches reuse the current checkout's import graph (see AnalyzeOptions.importGraphFrom).
  const graphFrom = tryGit(repoRoot, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])?.trim();
  const rows: BranchRow[] = [];
  for (const c of candidates.slice(0, limit)) {
    const row: BranchRow = { name: c.name, ...(c.worktree ? { worktree: c.worktree.path } : {}), dirty: c.dirty, p0: 0, p1: 0, p2: 0, estMinutes: 0 };
    try {
      const map = c.worktree
        ? await analyze({ repoRoot: c.worktree.path, workingTree: true })
        : await analyze({ repoRoot, range: `${base}...${c.name}`, importGraphFrom: graphFrom });
      Object.assign(row, countsOf(map));
      const trend = c.worktree && readTrend(c.worktree.path, 'worktree', opts.now);
      if (trend) row.trend = trend.line;
    } catch (e) {
      row.error = (e as Error).message;
    }
    rows.push(row);
  }
  return { base, branches: rankBranches(rows), skipped: Math.max(0, candidates.length - limit) };
}
