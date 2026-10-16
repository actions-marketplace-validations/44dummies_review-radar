import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..', '..');
const json = (p: string) => JSON.parse(readFileSync(join(root, p), 'utf8'));

describe('claude code plugin', () => {
  it('marketplace lists the plugin from the repo root', () => {
    const m = json('.claude-plugin/marketplace.json');
    expect(m.name).toBe('review-radar');
    expect(m.owner.name).toBeTruthy();
    expect(m.plugins).toEqual([expect.objectContaining({ name: 'review-radar', source: './' })]);
  });
  it('plugin version matches the npm package', () => {
    expect(json('.claude-plugin/plugin.json').version).toBe(json('packages/cli/package.json').version);
  });
  it('runs the committed bundle as its MCP server', () => {
    expect(json('.claude-plugin/plugin.json').mcpServers['review-radar']).toEqual({
      command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs', 'mcp'],
    });
    expect(existsSync(join(root, 'dist/cli.mjs'))).toBe(true);
  });
  const skill = (name: string) => {
    const md = readFileSync(join(root, `skills/${name}/SKILL.md`), 'utf8').replace(/\r\n/g, '\n');
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(md)?.[1] ?? '';
    const field = (k: string) => new RegExp(`^${k}: (.+)$`, 'm').exec(fm)?.[1] ?? '';
    return { md, fm, field };
  };
  it.each(['review-before-pr', 'review', 'today'])('ships the %s skill with valid frontmatter', (name) => {
    const s = skill(name);
    expect(s.field('name')).toBe(name);
    expect(s.field('description').length).toBeGreaterThan(50);
    expect(s.field('description').length).toBeLessThanOrEqual(1024);
    expect(s.field('description')).not.toMatch(/: /); // plain YAML scalar must not contain ": "
  });
  it('review-before-pr keeps its directive trigger and gains the empty-diff stop and P0 follow-through', () => {
    const s = skill('review-before-pr');
    // Directive wording auto-triggered 2/2 headless runs vs 1/2 for "Use before…" (e2e 2026-10-11)
    expect(s.field('description')).toMatch(/^Required before you open a pull request/);
    expect(s.md).toContain('review_changes');
    expect(s.md).toContain('pr_review_guide');
    expect(s.md).toContain('Nothing to review.');
    expect(s.md).toContain('needs a test');
  });
  it('review takes quick, commit or a range', () => {
    const s = skill('review');
    expect(s.field('argument-hint')).toBe('"[quick|commit|<range>]"');
    expect(s.field('when_to_use')).toMatch(/before you commit/);
    for (const word of ['$ARGUMENTS', 'minTier', 'staged', 'range', 'Nothing to review.', 'trend', 'needs a test']) expect(s.md).toContain(word);
  });
  it('today calls review_branches and never edits', () => {
    const s = skill('today');
    expect(s.md).toContain('review_branches');
    expect(s.md).toContain('Never edit files');
  });
  it('registers the commit hook on Bash git commit', () => {
    const h = json('hooks/hooks.json');
    expect(h.hooks.PreToolUse).toEqual([{
      matcher: 'Bash',
      hooks: [{
        type: 'command', if: 'Bash(git commit *)', command: 'node',
        args: ['${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs', 'hook', 'pre-commit'], timeout: 30,
      }],
    }]);
  });
  describe('codex plugin', () => {
    const codex = () => json('.codex-plugin/plugin.json');
    it('mirrors the Claude plugin identity and ships the same skills', () => {
      expect(codex()).toMatchObject({ name: 'review-radar', version: json('packages/cli/package.json').version, skills: './skills/' });
    });
    it('runs the published npm version as its MCP server, from the session folder', () => {
      const mcp = json(codex().mcpServers.slice(2));
      // Codex does not expand plugin-root variables in MCP args, and the server reviews its cwd
      expect(mcp.mcpServers['review-radar']).toEqual({
        command: 'npx', args: ['-y', `review-radar@${json('packages/cli/package.json').version}`, 'mcp'],
      });
    });
    it('registers the commit hook as one command string (Codex has no args or if fields)', () => {
      const h = json(codex().hooks.slice(2));
      expect(h.hooks.PreToolUse).toEqual([{
        matcher: 'Bash',
        hooks: [{ type: 'command', command: 'node "${PLUGIN_ROOT}/dist/cli.mjs" hook pre-commit', timeout: 30 }],
      }]);
    });
  });
});
