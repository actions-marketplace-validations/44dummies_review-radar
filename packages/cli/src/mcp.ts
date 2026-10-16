import { resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { analyze, recordRun, renderBranches, renderPrGuide, reviewBranches, renderTerminal, tryGit, RadarError, VERSION, type RiskMap, type Tier } from '@review-radar/core';

const TIERS = ['P0', 'P1', 'P2'] as const;
const RANK: Record<Tier, number> = { P0: 0, P1: 1, P2: 2 };

const inputSchema = z.object({
  range: z.string().optional().describe('Git range such as main...HEAD. Omit to review this branch plus uncommitted and untracked changes against the default branch.'),
  minTier: z.enum(TIERS).optional().describe('Lowest tier to include: P0 (must read), P1 (should read, default) or P2 (skim).'),
  staged: z.boolean().optional().describe('Review only staged changes: what `git commit` would record. Cannot be combined with range.'),
  path: z.string().optional().describe('Path inside the repository. Defaults to the directory the server was started in.'),
});

const point = z.object({ t: z.string(), p0: z.number(), p1: z.number() });
const outputSchema = z.object({
  summary: z.object({ hunks: z.number(), p0: z.number(), p1: z.number(), p2: z.number(), estMinutes: z.number() }),
  aiAuthored: z.object({ likely: z.boolean(), reasons: z.array(z.string()) }),
  warnings: z.array(z.string()),
  hunks: z.array(z.object({
    tier: z.enum(TIERS), score: z.number(), file: z.string(), startLine: z.number(), endLine: z.number(),
    evidence: z.array(z.object({ signal: z.string(), message: z.string(), weight: z.number() })),
  })),
  trend: z.object({ line: z.string(), previous: point.optional(), firstToday: point.optional() }).optional(),
});
export type ReviewPayload = z.infer<typeof outputSchema>;

const branchesInput = z.object({
  limit: z.number().int().min(1).max(50).optional().describe('How many branches to analyse, most recently committed first (default 20).'),
  path: z.string().optional().describe('Path inside the repository. Defaults to the directory the server was started in.'),
});
const branchesOutput = z.object({
  base: z.string(),
  branches: z.array(z.object({
    name: z.string(), worktree: z.string().optional(), dirty: z.boolean(),
    p0: z.number(), p1: z.number(), p2: z.number(), estMinutes: z.number(),
    top: z.object({ file: z.string(), line: z.number(), message: z.string() }).optional(),
    trend: z.string().optional(), error: z.string().optional(),
  })),
  skipped: z.number(),
});

export function toPayload(map: RiskMap, minTier: Tier): ReviewPayload {
  const { hunks, p0, p1, p2, estMinutes } = map.summary;
  return {
    summary: { hunks, p0, p1, p2, estMinutes },
    aiAuthored: map.meta.aiAuthored,
    warnings: map.meta.warnings,
    hunks: map.hunks
      .filter((h) => RANK[h.tier] <= RANK[minTier])
      .map((h) => ({
        tier: h.tier, score: h.score, file: h.hunk.file, startLine: h.hunk.newRange.start, endLine: h.hunk.newRange.end,
        evidence: h.evidence.map((e) => ({ signal: e.signal, message: e.message, weight: e.weight })),
      })),
  };
}

/** Repo top level, so a server started in a subdirectory still gets repo-relative paths. */
function repoRoot(cwd: string, path?: string): string {
  const dir = path ? resolve(cwd, path) : cwd;
  const top = tryGit(dir, ['rev-parse', '--show-toplevel'])?.trim();
  if (!top) throw new RadarError('NOT_A_REPO', `${dir} is not inside a git repository.`);
  return top;
}

type Args = { range?: string; path?: string; staged?: boolean };

const NO_COMMITS_TEXT = 'No commits yet: nothing to review.';
const EMPTY: ReviewPayload = {
  summary: { hunks: 0, p0: 0, p1: 0, p2: 0, estMinutes: 0 }, aiAuthored: { likely: false, reasons: [] }, warnings: [], hunks: [],
};
const scope = (a: Args) => (a.staged ? 'staged changes' : a.range ?? 'the working tree and branch');

/** undefined means the repo has no commits yet, which is "nothing to review", not an error. */
async function review(root: string, args: Args): Promise<RiskMap | undefined> {
  try {
    return await analyze({ repoRoot: root, range: args.range, workingTree: !args.range, staged: args.staged ? 'index' : undefined });
  } catch (e) {
    if (e instanceof RadarError && e.code === 'NO_COMMITS') return undefined;
    throw e;
  }
}

export function createMcpServer(cwd: string): McpServer {
  const server = new McpServer({ name: 'review-radar', version: VERSION });
  server.registerTool(
    'review_changes',
    {
      title: 'Review Radar: where will a reviewer look?',
      description:
        'Ranks every changed hunk by how much a human reviewer needs to read it (P0 must read, P1 should read, P2 skim), ' +
        'with the evidence behind each score: test gaming (skipped or weakened tests), sensitive code, blast radius, ' +
        'untested changes, dependency bumps. Deterministic, no LLM. Use before opening a PR or after finishing a task. ' +
        'Pass staged: true to review only what the next commit would record. Repeated runs report a trend (P0 3 → 1 since 09:12).',
      inputSchema,
      outputSchema,
    },
    async (args) => {
      const root = repoRoot(cwd, args.path);
      const map = await review(root, args);
      if (!map) return { content: [{ type: 'text', text: NO_COMMITS_TEXT }], structuredContent: EMPTY };
      const payload = toPayload(map, args.minTier ?? 'P1');
      if (!args.range) {
        const { p0, p1, p2, estMinutes } = map.summary;
        const trend = recordRun(root, { p0, p1, p2, estMinutes }, args.staged ? 'staged' : 'worktree');
        if (trend) payload.trend = trend;
      }
      const body = map.summary.hunks === 0 ? `Nothing to review: no changes in ${scope(args)}.` : renderTerminal(map, { color: false });
      return {
        content: [{ type: 'text', text: payload.trend ? `${body.trimEnd()}\nTrend: ${payload.trend.line}\n` : body }],
        structuredContent: payload,
      };
    },
  );
  server.registerTool(
    'pr_review_guide',
    {
      title: 'Review Radar: PR "Where to look" section',
      description: 'Returns a markdown "Where to look" section listing the riskiest hunks and why, ready to paste into a pull request description.',
      inputSchema,
    },
    async (args) => {
      const map = await review(repoRoot(cwd, args.path), args);
      return { content: [{ type: 'text', text: map ? renderPrGuide(map, args.minTier ?? 'P1') : NO_COMMITS_TEXT }] };
    },
  );
  server.registerTool(
    'review_branches',
    {
      title: 'Review Radar: which branch needs review first?',
      description:
        'Lists local branches not merged into the default branch, plus worktrees with uncommitted work, ranked by P0 then P1 hunks, ' +
        "with each one's riskiest hunk and today's trend. Read-only. Use when the user asks what to review or work on today.",
      inputSchema: branchesInput,
      outputSchema: branchesOutput,
    },
    async (args) => {
      const res = await reviewBranches(repoRoot(cwd, args.path), { limit: args.limit });
      return { content: [{ type: 'text', text: renderBranches(res) }], structuredContent: res };
    },
  );
  return server;
}

/** Serves the tools over stdio. stdout carries JSON-RPC only. */
export function startStdio(cwd: string) {
  return serveStdio(() => createMcpServer(cwd));
}
