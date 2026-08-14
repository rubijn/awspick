/**
 * Column layout and colour for the picker rows.
 *
 * No colour dependency: a handful of SGR codes, gated on NO_COLOR / TERM=dumb /
 * non-TTY, is all this needs.
 */

import type { Profile } from './profiles.ts';
import { humanizeRemaining, tokenStatus, type TokenIndex } from './sso.ts';

const stream = process.stderr; // the picker draws on stderr, so ask stderr

export const colorEnabled =
  !process.env.NO_COLOR &&
  process.env.TERM !== 'dumb' &&
  (process.env.FORCE_COLOR === '1' || stream.isTTY === true);

const sgr = (code: string) => (text: string) => (colorEnabled ? `\u001B[${code}m${text}\u001B[0m` : text);

export const dim = sgr('2');
export const bold = sgr('1');
export const red = sgr('31');
export const green = sgr('32');
export const yellow = sgr('33');
export const cyan = sgr('36');
export const magenta = sgr('35');

function pad(text: string, size: number): string {
  if (text.length >= size) return text;
  return text + ' '.repeat(size - text.length);
}

function truncate(text: string, size: number): string {
  if (text.length <= size) return text;
  return size <= 1 ? text.slice(0, size) : `${text.slice(0, size - 1)}…`;
}

const KIND_LABEL: Record<Profile['kind'], string> = {
  sso: 'sso',
  chained: 'role',
  static: 'keys',
  process: 'proc',
  unknown: '?',
};

export type RowContext = {
  tokens: TokenIndex;
  now: Date;
  /** Terminal columns available for the row. */
  columns: number;
  /** Profile the cursor should open on, flagged with a star. */
  lastProfile?: string;
};

/**
 * Column widths for a given terminal width.
 *
 * The name is the column that identifies the account, so it gets priority: the
 * role column (usually `AdministratorAccess` on every row, so low signal) is
 * dropped entirely on narrow terminals rather than squeezing the name.
 */
export function layout(columns: number): {
  name: number;
  account: number;
  role: number;
  region: number;
} {
  const budget = Math.max(48, Math.min(columns, 200)) - 2; // leave room for the cursor
  const account = 12;
  const region = 11;
  const status = 10;
  const gaps = 4;
  const fixed = account + region + status + gaps;

  // Role only earns space once the name is comfortable.
  const forName = budget - fixed;
  if (forName >= 34 + 21) {
    const role = Math.min(20, forName - 34);
    return { name: forName - role - 1, account, role, region };
  }
  return { name: Math.max(16, forName), account, role: 0, region };
}

/** One picker row: name, account, role, region, SSO freshness. */
export function renderRow(profile: Profile, ctx: RowContext): string {
  const cols = layout(ctx.columns);

  const star = profile.name === ctx.lastProfile ? yellow('★') : ' ';
  const name = pad(truncate(profile.name, cols.name), cols.name);
  const account = pad(profile.accountId ?? '—', cols.account);
  const role = cols.role > 0 ? ` ${dim(pad(truncate(profile.roleName ?? '—', cols.role), cols.role))}` : '';
  const regionText = profile.region ?? '—';
  // A trailing * marks a region inherited from a parent profile or SSO session.
  const region = pad(truncate(profile.regionInherited ? `${regionText}*` : regionText, cols.region), cols.region);

  const status = tokenStatus(profile, ctx.tokens, ctx.now);
  const freshness =
    status.state === 'valid'
      ? green(`✓ ${humanizeRemaining(status.expiresAt, ctx.now)}`)
      : status.state === 'expired'
        ? red('✗ expired')
        : status.state === 'missing'
          ? yellow('· login')
          : dim(KIND_LABEL[profile.kind]);

  const coloredName = profile.isProd ? red(bold(name)) : name;
  return `${star} ${coloredName} ${dim(account)}${role} ${cyan(region)} ${freshness}`;
}

/** Compact one-line description of a profile, for `status` and confirmations. */
export function describe(profile: Profile): string {
  const bits = [KIND_LABEL[profile.kind]];
  if (profile.accountId) bits.push(`account ${profile.accountId}`);
  if (profile.roleName) bits.push(`role ${profile.roleName}`);
  if (profile.ssoSession) bits.push(`session ${profile.ssoSession}`);
  if (profile.sourceProfile) bits.push(`via ${profile.sourceProfile}`);
  return bits.join(' · ');
}
