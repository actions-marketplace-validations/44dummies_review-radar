import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG, loadConfig, isIgnored } from '../src/config';
import { RadarError } from '../src/errors';
import { makeRepo } from './helpers/repo';

describe('config', () => {
  it('defaults agentHooks.preCommit to warn', () => {
    expect(loadConfig(makeRepo().root).agentHooks).toEqual({ preCommit: 'warn' });
  });
  it.each(['warn', 'block', 'off'])('accepts agentHooks.preCommit: %s', (mode) => {
    const r = makeRepo();
    r.write({ '.reviewradar.yml': `agentHooks:\n  preCommit: ${mode}\n` });
    expect(loadConfig(r.root).agentHooks.preCommit).toBe(mode);
  });
  it('rejects any other agentHooks.preCommit value', () => {
    const r = makeRepo();
    r.write({ '.reviewradar.yml': 'agentHooks:\n  preCommit: maybe\n' });
    expect(() => loadConfig(r.root)).toThrow(/agentHooks\.preCommit must be warn, block or off/);
  });
  it('returns defaults when no file exists', () => {
    const r = makeRepo();
    expect(loadConfig(r.root)).toEqual(DEFAULT_CONFIG);
  });

  it('merges partial weights, tiers and appends extra sensitive paths', () => {
    const r = makeRepo();
    r.write({ '.reviewradar.yml': 'weights:\n  testGaming: 90\ntiers:\n  p0: 80\nsensitivePaths:\n  - "ledger"\n' });
    const cfg = loadConfig(r.root);
    expect(cfg.weights.testGaming).toBe(90);
    expect(cfg.weights.sensitivePath).toBe(DEFAULT_CONFIG.weights.sensitivePath);
    expect(cfg.tiers).toEqual({ p0: 80, p1: 40 });
    expect(cfg.sensitivePaths).toContain('ledger');
    expect(cfg.sensitivePaths).toContain('auth');
  });

  it('rejects invalid YAML with BAD_INPUT', () => {
    const r = makeRepo();
    r.write({ '.reviewradar.yml': 'weights: [unclosed' });
    expect(() => loadConfig(r.root)).toThrow(RadarError);
  });

  it('throws BAD_INPUT when an explicit config path is missing', () => {
    const r = makeRepo();
    expect(() => loadConfig(r.root, 'nope.yml')).toThrow(/nope\.yml/);
  });

  it('ignores dist, build, vendor and minified files by default', () => {
    expect(isIgnored('dist/index.js', DEFAULT_CONFIG)).toBe(true);
    expect(isIgnored('packages/x/build/a.js', DEFAULT_CONFIG)).toBe(true);
    expect(isIgnored('static/app.min.js', DEFAULT_CONFIG)).toBe(true);
    expect(isIgnored('src/a.ts', DEFAULT_CONFIG)).toBe(false);
  });
});
