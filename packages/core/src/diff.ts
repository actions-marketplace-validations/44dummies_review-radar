import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChangedFile, ChangeSet, Hunk, Range } from './types';
import { languageOf, isTestFile } from './lang';
import { git, tryGit } from './git';
import { RadarError } from './errors';

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function range(start: number, count: number): Range {
  if (count === 0) return { start, end: start };
  return { start, end: start + count - 1 };
}

function stripPrefix(p: string): string {
  return p.replace(/^[ab]\//, '');
}

export function parseUnifiedDiff(text: string): ChangedFile[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const files: ChangedFile[] = [];
  let file: ChangedFile | undefined;
  let hunk: Hunk | undefined;
  let newLine = 0;

  const finishFile = () => {
    if (file) {
      file.language = languageOf(file.path);
      file.isTest = isTestFile(file.path);
      files.push(file);
    }
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      finishFile();
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      file = { path: m ? m[2]! : '', status: 'modified', binary: false, isTest: false, hunks: [] };
      hunk = undefined;
      continue;
    }
    if (!file) continue;
    if (hunk === undefined) {
      if (line.startsWith('new file mode')) { file.status = 'added'; continue; }
      if (line.startsWith('deleted file mode')) { file.status = 'deleted'; continue; }
      if (line.startsWith('rename from ')) { file.status = 'renamed'; file.oldPath = line.slice(12); continue; }
      if (line.startsWith('rename to ')) { file.path = line.slice(10); continue; }
      if (line.startsWith('Binary files ')) { file.binary = true; continue; }
      if (line.startsWith('--- ')) {
        const p = line.slice(4);
        if (p !== '/dev/null' && file.status === 'deleted') file.path = stripPrefix(p);
        continue;
      }
      if (line.startsWith('+++ ')) {
        const p = line.slice(4);
        if (p !== '/dev/null') file.path = stripPrefix(p);
        continue;
      }
    }
    const hm = HUNK_RE.exec(line);
    if (hm) {
      const oldStart = Number(hm[1]);
      const oldCount = hm[2] === undefined ? 1 : Number(hm[2]);
      const newStart = Number(hm[3]);
      const newCount = hm[4] === undefined ? 1 : Number(hm[4]);
      const newRange = range(newStart, newCount);
      hunk = {
        id: `${file.path}:${newRange.start}-${newRange.end}`,
        file: file.path,
        oldRange: range(oldStart, oldCount),
        newRange,
        added: [],
        removed: [],
        addedLines: [],
      };
      file.hunks.push(hunk);
      newLine = newStart;
      continue;
    }
    if (!hunk) continue;
    if (line.startsWith('+')) {
      hunk.added.push(line.slice(1));
      hunk.addedLines.push(newLine++);
    } else if (line.startsWith('-')) {
      hunk.removed.push(line.slice(1));
    } else if (line.startsWith(' ')) {
      newLine++;
    }
    // '\ No newline at end of file' and blank trailing lines are ignored
  }
  finishFile();
  return files;
}

export function defaultBranch(repoRoot: string): string | undefined {
  const originHead = tryGit(repoRoot, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])?.trim();
  if (originHead) return originHead;
  for (const b of ['main', 'master', 'origin/main', 'origin/master']) {
    if (tryGit(repoRoot, ['rev-parse', '--verify', '--quiet', `${b}^{commit}`])) return b;
  }
  return undefined;
}

/** Checkout advice that only makes sense inside GitHub Actions. */
export function ciHint(): string {
  return process.env.GITHUB_ACTIONS === 'true' ? ' In GitHub Actions use actions/checkout with fetch-depth: 0.' : '';
}

function headCommit(repoRoot: string): string {
  const sha = tryGit(repoRoot, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])?.trim();
  if (!sha) throw new RadarError('NO_COMMITS', 'No commits yet: nothing to review.');
  return sha;
}

function resolveCommit(repoRoot: string, ref: string, role: 'base' | 'head'): string {
  const sha = tryGit(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])?.trim();
  if (!sha) {
    throw new RadarError(
      role === 'base' ? 'BASE_NOT_FOUND' : 'BAD_INPUT',
      `Cannot find ${role} commit "${ref}".${ciHint()}`,
    );
  }
  return sha;
}

/** Changes a commit would record: 'index' = staged only (`git commit`); 'all' = every tracked edit plus untracked files (`git commit -a`, or after a chained `git add`). */
export type StagedMode = 'index' | 'all';

export interface ChangeSetOptions {
  /** With no range: diff the merge-base against the files on disk, including untracked files. */
  workingTree?: boolean;
  /** Diff against HEAD instead of the merge-base. Wins over workingTree; can't be combined with a range. */
  staged?: StagedMode;
}

const MAX_UNTRACKED_BYTES = 1024 * 1024; // bigger untracked files are treated like binaries
const LEGACY_CACHE = '.reviewradar-cache/';

/** Untracked, non-ignored files as "added" files, built through the same diff parser. */
function untrackedFiles(repoRoot: string): ChangedFile[] {
  const paths = git(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  const out: string[] = [];
  for (const p of paths) {
    if (p.startsWith(LEGACY_CACHE)) continue;
    let buf: Buffer;
    try { buf = readFileSync(join(repoRoot, p)); } catch { continue; }
    out.push(`diff --git a/${p} b/${p}`, 'new file mode 100644');
    if (buf.length > MAX_UNTRACKED_BYTES || buf.subarray(0, 8000).includes(0)) {
      out.push(`Binary files /dev/null and b/${p} differ`);
      continue;
    }
    const lines = buf.toString('utf8').replace(/\r\n/g, '\n').split('\n');
    if (lines.at(-1) === '') lines.pop();
    out.push('--- /dev/null', `+++ b/${p}`);
    if (lines.length) out.push(`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`));
  }
  return parseUnifiedDiff(out.join('\n') + '\n');
}

export function getChangeSet(repoRoot: string, rangeArg?: string, opts: ChangeSetOptions = {}): ChangeSet {
  if (!tryGit(repoRoot, ['rev-parse', '--is-inside-work-tree'])) {
    throw new RadarError('NOT_A_REPO', `${repoRoot} is not inside a git repository.`);
  }
  if (opts.staged) {
    if (rangeArg) throw new RadarError('BAD_INPUT', "--staged can't be combined with a range.");
    const head = headCommit(repoRoot);
    const args = ['diff', '--no-color', '--no-ext-diff', '-U0', '-M'];
    const files = parseUnifiedDiff(git(repoRoot, opts.staged === 'index' ? [...args, '--cached', head] : [...args, head]));
    return { base: head, head, files: opts.staged === 'all' ? [...files, ...untrackedFiles(repoRoot)] : files };
  }
  let base: string;
  let head: string;
  if (rangeArg) {
    const parts = rangeArg.split(/\.\.\.?/);
    if (parts.length !== 2 || !parts[0]) throw new RadarError('BAD_INPUT', `Range must look like base..head, got "${rangeArg}".`);
    base = resolveCommit(repoRoot, parts[0], 'base');
    head = resolveCommit(repoRoot, parts[1] || 'HEAD', 'head');
    if (rangeArg.includes('...')) {
      // git's A...B: diff from the merge-base, so later commits on A don't show up as reversed changes
      const mb = tryGit(repoRoot, ['merge-base', base, head])?.trim();
      if (!mb) throw new RadarError('BASE_NOT_FOUND', `No merge-base for ${rangeArg}.${ciHint()}`);
      base = mb;
    }
  } else {
    head = headCommit(repoRoot);
    const branch = defaultBranch(repoRoot);
    if (!branch) throw new RadarError('BASE_NOT_FOUND', `No default branch found. Pass an explicit range like main..HEAD.${ciHint()}`);
    const mb = tryGit(repoRoot, ['merge-base', branch, head])?.trim();
    if (!mb) throw new RadarError('BASE_NOT_FOUND', `No merge-base between ${branch} and HEAD.${ciHint()}`);
    base = mb;
  }
  if (!rangeArg && opts.workingTree) {
    const text = git(repoRoot, ['diff', '--no-color', '--no-ext-diff', '-U0', '-M', base]);
    return { base, head, files: [...parseUnifiedDiff(text), ...untrackedFiles(repoRoot)] };
  }
  const text = git(repoRoot, ['diff', '--no-color', '--no-ext-diff', '-U0', '-M', base, head]);
  return { base, head, files: parseUnifiedDiff(text) };
}
