/**
 * SSO token freshness, read straight from ~/.aws/sso/cache/*.json.
 *
 * The cache filename is a sha1 of either the session name or the start URL
 * depending on CLI vintage, so match on the `startUrl` field inside the file
 * instead — it is present in every token file and works for both layouts.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ssoCacheDir } from './paths.ts';
import type { Profile } from './profiles.ts';

export type TokenStatus =
  | { state: 'valid'; expiresAt: Date }
  | { state: 'expired'; expiresAt: Date }
  | { state: 'missing' }
  | { state: 'not-sso' };

/** startUrl -> latest expiry seen for a token file that actually has a token. */
export type TokenIndex = Map<string, Date>;

/** The CLI has written both ISO-8601 and a `...UTC` variant over the years. */
export function parseExpiry(value: unknown): Date | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.endsWith('UTC') ? `${value.slice(0, -3)}Z` : value;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function loadTokenIndex(dir = ssoCacheDir()): TokenIndex {
  const index: TokenIndex = new Map();
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return index; // no cache dir yet: everything reads as "missing"
  }

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      const raw: unknown = JSON.parse(readFileSync(join(dir, entry), 'utf8'));
      if (typeof raw !== 'object' || raw === null) continue;
      const record = raw as Record<string, unknown>;
      // Client-registration files have no accessToken; skip them.
      if (typeof record.accessToken !== 'string' || typeof record.startUrl !== 'string') continue;
      const expiresAt = parseExpiry(record.expiresAt);
      if (!expiresAt) continue;
      const previous = index.get(record.startUrl);
      if (!previous || expiresAt > previous) index.set(record.startUrl, expiresAt);
    } catch {
      continue; // unreadable or malformed cache entry is not our problem
    }
  }
  return index;
}

export function tokenStatus(profile: Profile, index: TokenIndex, now = new Date()): TokenStatus {
  if (profile.kind !== 'sso' || !profile.ssoStartUrl) return { state: 'not-sso' };
  const expiresAt = index.get(profile.ssoStartUrl);
  if (!expiresAt) return { state: 'missing' };
  return expiresAt > now ? { state: 'valid', expiresAt } : { state: 'expired', expiresAt };
}

/** "7h", "42m", "3d" — coarse on purpose; nobody needs seconds here. */
export function humanizeRemaining(expiresAt: Date, now = new Date()): string {
  const minutes = Math.round((expiresAt.getTime() - now.getTime()) / 60_000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
