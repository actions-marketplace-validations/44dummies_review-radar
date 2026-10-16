// Starts a bundled CLI as an MCP server over real stdio and checks one review end to end.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const cli = resolve(import.meta.dirname, '..', process.argv[2] ?? 'dist/cli.mjs');
const repo = mkdtempSync(join(tmpdir(), 'rr-smoke-'));
const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
git('init', '-q', '-b', 'main');
git('config', 'user.email', 'smoke@example.com');
git('config', 'user.name', 'Smoke');
git('config', 'core.autocrlf', 'false');
git('config', 'commit.gpgsign', 'false');
mkdirSync(join(repo, 'src'));
writeFileSync(join(repo, 'src/a.test.ts'), "it('a', () => {});\n");
git('add', '-A');
git('commit', '-qm', 'init');
writeFileSync(join(repo, 'src/a.test.ts'), "it.skip('a', () => {});\n");

const client = new Client({ name: 'smoke', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp'], cwd: repo, stderr: 'inherit' }));
const names = (await client.listTools()).tools.map((t) => t.name).sort().join(',');
if (names !== 'pr_review_guide,review_branches,review_changes') throw new Error(`unexpected tools: ${names}`);
const res = await client.callTool({ name: 'review_changes', arguments: {} });
const top = res.structuredContent?.hunks?.[0];
if (res.isError || top?.tier !== 'P0' || top?.file !== 'src/a.test.ts') throw new Error(`unexpected result: ${JSON.stringify(res)}`);
const branches = await client.callTool({ name: 'review_branches', arguments: {} });
const row = branches.structuredContent?.branches?.[0];
if (branches.isError || row?.name !== 'main' || !row.dirty || row.p0 < 1) throw new Error(`unexpected branches: ${JSON.stringify(branches)}`);
await client.close();
console.log(`mcp smoke ok: ${cli}`);
