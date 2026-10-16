#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze, render, renderBranches, reviewBranches, FORMATS, RadarError, VERSION, type Format } from '@review-radar/core';
import { startStdio } from './mcp';
import { preCommit } from './hook';

const HELP = `Usage: review-radar [<base>...<head>] [options]
       review-radar branches [--limit n] [--format terminal|json]
                                 Rank open branches and worktrees by what needs review
       review-radar mcp          Start the MCP server (stdio) for coding agents
       review-radar hook pre-commit
                                 Claude Code PreToolUse hook: reads the hook JSON on stdin

Shows which hunks of a change need human review, and why.
With no range: current branch vs the merge-base with main. base...head diffs from
the merge-base (like a PR); base..head is a direct diff.

Options:
  --sarif <file>     Merge findings from another scanner (repeatable)
  --lcov <file>      Use an LCOV coverage report for untested-change
  --format <f>       terminal | md | json | sarif   (default: terminal)
  --out <file>       Write the report to a file instead of stdout
  --fail-on <tier>   Exit 1 if any hunk is at or above P0 | P1
  --config <file>    Config file (default: .reviewradar.yml)
  --working-tree     Also review uncommitted and untracked changes (no-range mode)
  --staged           Review only staged changes (what git commit would record)
  --no-cache         Rebuild the import graph
  --no-color         Disable colors
  -v, --version      Print version
  -h, --help         Print this help
`;

/** True when this file is the entry script, even when launched through npm's bin symlink (npx). */
export function isMainModule(metaUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(argv1);
  } catch {
    return false;
  }
}

interface IO { stdout: (s: string) => void; stderr: (s: string) => void; cwd: string; stdin?: () => Promise<string> }

function fail(e: unknown, io: IO): number {
  if (e instanceof RadarError && e.code === 'NO_COMMITS') { io.stdout(`${e.message}\n`); return 0; }
  const msg = e instanceof RadarError ? e.message : (e as Error).stack ?? String(e);
  io.stderr(`review-radar: ${msg}\n`);
  return 2;
}

async function branches(argv: string[], io: IO): Promise<number> {
  let v: { limit?: string; format?: string };
  try {
    v = parseArgs({ args: argv, strict: true, options: { limit: { type: 'string' }, format: { type: 'string', default: 'terminal' } } }).values;
  } catch (e) {
    io.stderr(`review-radar: ${(e as Error).message}\n`);
    return 2;
  }
  const limit = v.limit === undefined ? 20 : Number(v.limit);
  if (!Number.isInteger(limit) || limit < 1) { io.stderr('review-radar: --limit must be a positive integer\n'); return 2; }
  if (v.format !== 'terminal' && v.format !== 'json') { io.stderr('review-radar: branches --format must be terminal or json\n'); return 2; }
  try {
    const res = await reviewBranches(io.cwd, { limit });
    io.stdout(v.format === 'json' ? `${JSON.stringify(res, null, 2)}\n` : renderBranches(res));
    return 0;
  } catch (e) {
    return fail(e, io);
  }
}

export async function main(argv: string[], io: IO): Promise<number> {
  if (argv[0] === 'mcp') { startStdio(io.cwd); return 0; }
  if (argv[0] === 'branches') return branches(argv.slice(1), io);
  if (argv[0] === 'hook') {
    if (argv[1] !== 'pre-commit') { io.stderr(`review-radar: unknown hook "${argv[1] ?? ''}" (use pre-commit)\n`); return 2; }
    preCommit(io.stdin ? await io.stdin() : '', io);
    return 0;
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: argv, allowPositionals: true, strict: true,
      options: {
        sarif: { type: 'string', multiple: true }, lcov: { type: 'string' }, format: { type: 'string', default: 'terminal' },
        out: { type: 'string' }, 'fail-on': { type: 'string' }, config: { type: 'string' },
        'no-cache': { type: 'boolean' }, 'working-tree': { type: 'boolean' }, staged: { type: 'boolean' }, 'no-color': { type: 'boolean' },
        version: { type: 'boolean', short: 'v' }, help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (e) {
    io.stderr(`review-radar: ${(e as Error).message}\n\n${HELP}`);
    return 2;
  }
  const { values: v, positionals } = parsed;
  if (v.help) { io.stdout(HELP); return 0; }
  if (v.version) { io.stdout(`${VERSION}\n`); return 0; }
  const format = v.format as Format;
  if (!FORMATS.includes(format)) { io.stderr(`review-radar: unknown --format "${v.format}" (use ${FORMATS.join(', ')})\n`); return 2; }
  const failOn = v['fail-on'];
  if (failOn && failOn !== 'P0' && failOn !== 'P1') { io.stderr('review-radar: --fail-on must be P0 or P1\n'); return 2; }
  if (v.staged && (positionals[0] || v['working-tree'])) {
    io.stderr("review-radar: --staged can't be combined with a range or --working-tree\n");
    return 2;
  }

  try {
    const map = await analyze({
      repoRoot: io.cwd, range: positionals[0], sarifPaths: v.sarif, lcovPath: v.lcov,
      configPath: v.config, useCache: !v['no-cache'], workingTree: v['working-tree'],
      staged: v.staged ? 'index' : undefined,
    });
    const text = render(map, format, { color: !v['no-color'] && !v.out });
    if (v.out) writeFileSync(isAbsolute(v.out) ? v.out : join(io.cwd, v.out), text);
    else io.stdout(text);
    if (failOn === 'P0' && map.summary.p0 > 0) return 1;
    if (failOn === 'P1' && map.summary.p0 + map.summary.p1 > 0) return 1;
    return 0;
  } catch (e) {
    return fail(e, io);
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main(process.argv.slice(2), {
    stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s), cwd: process.cwd(),
    stdin: () => new Promise<string>((done) => {
      if (process.stdin.isTTY) return done('');
      let s = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (c) => (s += c));
      process.stdin.on('end', () => done(s));
      process.stdin.on('error', () => done(s));
    }),
  }).then((code) => { process.exitCode = code; });
}
