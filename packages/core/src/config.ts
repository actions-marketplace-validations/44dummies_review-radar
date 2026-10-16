import { existsSync, readFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { parse } from 'yaml';
import picomatch from 'picomatch';
import type { Config } from './types';
import { RadarError } from './errors';

export const DEFAULT_CONFIG: Config = {
  weights: {
    sensitivePath: 45,
    sensitiveCode: 35,
    blastRadiusPerImporter: 3,
    blastRadiusMax: 30,
    untestedChange: 25,
    testGaming: 70,
    dependencyManifest: 30,
    dependencyMajor: 20,
    dependencyLockfile: 10,
    churnPerChange: 2,
    churnMax: 20,
    churnMin: 3,
    sizePer10Lines: 2,
    sizeMax: 20,
    sizeMin: 20,
    diffusion: 10,
    sarifError: 40,
    sarifWarning: 20,
    sarifNote: 5,
  },
  tiers: { p0: 70, p1: 40 },
  sensitivePaths: [
    'auth', 'login', 'session', 'token', 'jwt', 'oauth', 'passw', 'secret', 'credential',
    'crypto', 'encrypt', 'permission', 'rbac', 'acl', 'payment', 'billing', 'checkout',
    'stripe', 'mpesa', 'invoice', 'migrations?/', '(^|/)\\.env', '(^|/)Dockerfile$',
    '^\\.github/workflows/',
  ],
  sensitiveCode: [
    'child_process', '\\bexec(Sync)?\\(', '\\beval\\(', 'new Function\\(', 'dangerouslySetInnerHTML',
    '\\bsubprocess\\.', 'os\\.system\\(', 'pickle\\.loads', 'yaml\\.load\\(', 'bcrypt', 'jwt\\.(sign|verify|decode)',
    'createHash\\(|createCipher', 'innerHTML\\s*=', 'verify\\s*=\\s*False', 'rejectUnauthorized:\\s*false',
  ],
  ignore: ['**/dist/**', '**/build/**', '**/vendor/**', '**/*.min.js', 'dist/**', 'build/**', 'vendor/**'],
  churnDays: 90,
  diffusion: { files: 10, dirs: 5 },
  agentHooks: { preCommit: 'warn' },
};

const PRE_COMMIT_MODES: readonly string[] = ['warn', 'block', 'off'];

type Partial2<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : Partial<T[K]>) : T[K] };

export function loadConfig(repoRoot: string, configPath?: string): Config {
  const p = configPath ? (isAbsolute(configPath) ? configPath : join(repoRoot, configPath)) : join(repoRoot, '.reviewradar.yml');
  if (!existsSync(p)) {
    if (configPath) throw new RadarError('BAD_INPUT', `Config file not found: ${configPath}`);
    return structuredClone(DEFAULT_CONFIG);
  }
  let raw: Partial2<Config>;
  try {
    raw = (parse(readFileSync(p, 'utf8')) ?? {}) as Partial2<Config>;
  } catch (e) {
    throw new RadarError('BAD_INPUT', `Invalid YAML in ${p}: ${(e as Error).message}`);
  }
  const d = structuredClone(DEFAULT_CONFIG);
  const preCommit = raw.agentHooks?.preCommit ?? d.agentHooks.preCommit;
  if (!PRE_COMMIT_MODES.includes(preCommit)) {
    throw new RadarError('BAD_INPUT', `agentHooks.preCommit must be warn, block or off (got "${String(preCommit)}") in ${p}`);
  }
  return {
    weights: { ...d.weights, ...(raw.weights ?? {}) },
    tiers: { ...d.tiers, ...(raw.tiers ?? {}) },
    sensitivePaths: [...d.sensitivePaths, ...(raw.sensitivePaths ?? [])],
    sensitiveCode: [...d.sensitiveCode, ...(raw.sensitiveCode ?? [])],
    ignore: [...d.ignore, ...(raw.ignore ?? [])],
    churnDays: raw.churnDays ?? d.churnDays,
    diffusion: { ...d.diffusion, ...(raw.diffusion ?? {}) },
    agentHooks: { preCommit },
  };
}

const matcherCache = new WeakMap<Config, (p: string) => boolean>();
export function isIgnored(path: string, cfg: Config): boolean {
  let m = matcherCache.get(cfg);
  if (!m) {
    m = picomatch(cfg.ignore, { dot: true });
    matcherCache.set(cfg, m);
  }
  return m(path);
}
