/**
 * ~/.config/awsx/config.json — one file for both user settings and remembered
 * state (ADR-0001, "one file for settings and state").
 *
 * Rules that make merging the two safe:
 *   - atomic write (tmp + rename), mode 0600
 *   - unknown keys preserved verbatim, so a hand-added field is never eaten
 *   - a corrupt file is a warning plus in-memory defaults, never a crash
 *   - no credential values, ever: profile names, regions and counters only
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { awsxConfigPath } from './paths.ts';

export type Settings = {
  /** Case-insensitive substrings that mark a profile as production. */
  prodPatterns: string[];
  /** Profiles always treated as production, whatever their name. */
  prodProfiles: string[];
  /** Region shortlist offered first in the region picker. */
  regions: string[];
  recentsLimit: number;
  /** Ask for confirmation before selecting a production profile. */
  confirmProd: boolean;
};

export type ProfileState = {
  lastRegion?: string;
  uses?: number;
};

export type AwsxConfig = {
  version: number;
  lastProfile?: string;
  previousProfile?: string;
  lastRegion?: string;
  recents: string[];
  perProfile: Record<string, ProfileState>;
  settings: Settings;
  /** Cached `aws --version` probe, keyed by the binary's mtime. */
  awsCli?: { path: string; mtimeMs: number; version: string };
  /** Anything a human added that we do not know about is carried through. */
  [extra: string]: unknown;
};

export const DEFAULT_SETTINGS: Settings = {
  prodPatterns: ['prod', 'prd'],
  prodProfiles: [],
  regions: [],
  recentsLimit: 10,
  confirmProd: false,
};

export function defaultConfig(): AwsxConfig {
  return { version: 1, recents: [], perProfile: {}, settings: { ...DEFAULT_SETTINGS } };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const stringArray = (v: unknown, fallback: string[]): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : fallback;

export type LoadResult = { config: AwsxConfig; path: string; warning?: string };

export function loadConfig(path = awsxConfigPath()): LoadResult {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { config: defaultConfig(), path };
    return { config: defaultConfig(), path, warning: `could not read ${path}: ${String(err)}` };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {
      config: defaultConfig(),
      path,
      warning: `${path} is not valid JSON — using defaults, and it will be rewritten on the next selection`,
    };
  }
  if (!isRecord(raw)) {
    return { config: defaultConfig(), path, warning: `${path} is not a JSON object — using defaults` };
  }

  const rawSettings = isRecord(raw.settings) ? raw.settings : {};
  const config: AwsxConfig = {
    // Spread first so unknown keys survive a round-trip.
    ...raw,
    version: typeof raw.version === 'number' ? raw.version : 1,
    recents: stringArray(raw.recents, []),
    perProfile: isRecord(raw.perProfile) ? (raw.perProfile as Record<string, ProfileState>) : {},
    settings: {
      prodPatterns: stringArray(rawSettings.prodPatterns, DEFAULT_SETTINGS.prodPatterns),
      prodProfiles: stringArray(rawSettings.prodProfiles, DEFAULT_SETTINGS.prodProfiles),
      regions: stringArray(rawSettings.regions, DEFAULT_SETTINGS.regions),
      recentsLimit:
        typeof rawSettings.recentsLimit === 'number' && rawSettings.recentsLimit > 0
          ? rawSettings.recentsLimit
          : DEFAULT_SETTINGS.recentsLimit,
      confirmProd:
        typeof rawSettings.confirmProd === 'boolean'
          ? rawSettings.confirmProd
          : DEFAULT_SETTINGS.confirmProd,
    },
  };
  if (typeof raw.lastProfile === 'string') config.lastProfile = raw.lastProfile;
  if (typeof raw.previousProfile === 'string') config.previousProfile = raw.previousProfile;
  if (typeof raw.lastRegion === 'string') config.lastRegion = raw.lastRegion;

  return { config, path };
}

export function saveConfig(config: AwsxConfig, path = awsxConfigPath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path); // atomic: a reader sees either the old file or the new one
}

/**
 * Record a selection. `previousProfile` only moves when the profile actually
 * changes, so `awsx -` stays a useful toggle instead of a no-op.
 */
export function recordSelection(
  config: AwsxConfig,
  profile: string,
  region: string | undefined,
): AwsxConfig {
  if (config.lastProfile && config.lastProfile !== profile) {
    config.previousProfile = config.lastProfile;
  }
  config.lastProfile = profile;
  if (region) config.lastRegion = region;

  const limit = config.settings.recentsLimit;
  config.recents = [profile, ...config.recents.filter((p) => p !== profile)].slice(0, limit);

  const state = (config.perProfile[profile] ??= {});
  state.uses = (state.uses ?? 0) + 1;
  if (region) state.lastRegion = region;

  return config;
}

/** Drop remembered profiles that no longer exist in the AWS config files. */
export function pruneMissing(config: AwsxConfig, existing: ReadonlySet<string>): boolean {
  let changed = false;
  const before = config.recents.length;
  config.recents = config.recents.filter((p) => existing.has(p));
  if (config.recents.length !== before) changed = true;

  for (const key of ['lastProfile', 'previousProfile'] as const) {
    const value = config[key];
    if (value && !existing.has(value)) {
      delete config[key];
      changed = true;
    }
  }
  for (const name of Object.keys(config.perProfile)) {
    if (!existing.has(name)) {
      delete config.perProfile[name];
      changed = true;
    }
  }
  return changed;
}
