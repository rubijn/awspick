/**
 * The profile catalog (ADR-0002): a JSON file, by default ~/.aws/profiles.json,
 * from which `awsx profiles apply` generates ~/.aws/config.
 *
 * Compatible with the file the retired `aws-profiles` script wrote: `version` is
 * optional on read, unknown keys are carried through on save.
 *
 * Validation collects every error instead of stopping at the first, so one run
 * shows everything to fix in the file.
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs';

/** A config value: a string, or an indented sub-map such as `s3 = ` / `  addressing_style = path`. */
export type IniValue = string | Record<string, string>;

export type CatalogProfile = {
  name: string;
  group?: string;
  account_name?: string;
  account_id?: string;
  role?: string;
  region?: string;
  /** SSO session; `defaults.sso_session` when absent. */
  session?: string;
  /** Every other key of the profile, written as is. */
  extra?: Record<string, IniValue>;
  /** Names this profile had before; informational, never written to config. */
  former_names?: string[];
  /** Added by `discover`; blocks `apply` until a human chose the name. */
  new?: boolean;
  [unknown: string]: unknown;
};

export type Catalog = {
  version: number;
  sso_sessions: Record<string, Record<string, string>>;
  /** `sso_session` is the default session; every other key is written into each profile. */
  defaults: Record<string, string>;
  profiles: CatalogProfile[];
  /** Non-profile blocks, by header (`services local-dev`, `plugins`), written verbatim. */
  sections?: Record<string, Record<string, IniValue>>;
  [unknown: string]: unknown;
};

export const CATALOG_VERSION = 1;

/** The CLI's own profile name charset, as the script enforced it. */
export const PROFILE_NAME = /^[A-Za-z0-9_.-]+$/;
const KEY = /^[A-Za-z0-9_.-]+$/;
const ACCOUNT_ID = /^\d{12}$/;

/** Keys that hold credential material. The catalog must never contain them. */
export const CREDENTIAL_KEYS: ReadonlySet<string> = new Set([
  'aws_access_key_id',
  'aws_secret_access_key',
  'aws_session_token',
]);

export class CatalogError extends Error {
  readonly errors: string[];
  constructor(path: string, errors: string[]) {
    super(`${path}: ${errors.length} problem(s)\n${errors.map((e) => `  - ${e}`).join('\n')}`);
    this.name = 'CatalogError';
    this.errors = errors;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Why a string cannot be written as an INI value, or undefined if it can.
 *
 * Besides line breaks (which would let a value open a new section), this rejects
 * what does not survive a round trip: surrounding spaces (the parser trims) and a
 * whitespace-separated `#`/`;` (src/ini.ts strips it as a comment, the CLI keeps it).
 */
export function valueProblem(value: string): string | undefined {
  if (/[\r\n]/.test(value)) return 'contains a line break';
  if (value !== value.trim()) return 'has leading or trailing spaces';
  if (/\s[#;]/.test(value)) return 'contains " #" or " ;", read as a comment';
  return undefined;
}

function checkValue(where: string, key: string, value: unknown, errors: string[], allowMap: boolean): void {
  if (!KEY.test(key)) errors.push(`${where}: invalid key ${JSON.stringify(key)}`);
  if (CREDENTIAL_KEYS.has(key)) {
    errors.push(`${where}: "${key}" is credential material; static keys stay in ~/.aws/credentials`);
    return;
  }
  if (typeof value === 'string') {
    const problem = valueProblem(value);
    if (problem) errors.push(`${where}.${key}: value ${problem}`);
    return;
  }
  if (allowMap && isRecord(value)) {
    for (const [sub, subValue] of Object.entries(value)) {
      if (typeof subValue !== 'string') errors.push(`${where}.${key}.${sub}: must be a string`);
      else checkValue(`${where}.${key}`, sub, subValue, errors, false);
    }
    return;
  }
  errors.push(`${where}.${key}: must be a string${allowMap ? ' or an object of strings' : ''}`);
}

function checkMap(where: string, map: unknown, errors: string[], allowMap: boolean): void {
  if (!isRecord(map)) {
    errors.push(`${where}: must be an object`);
    return;
  }
  for (const [key, value] of Object.entries(map)) checkValue(where, key, value, errors, allowMap);
}

export type ValidateOptions = {
  /**
   * Profiles defined outside the catalog that a `source_profile` may name (the
   * static-key sections of ~/.aws/credentials). When omitted, `source_profile`
   * is only checked against the catalog itself.
   */
  externalProfiles?: ReadonlySet<string>;
};

/** Check a parsed JSON document. Returns the typed catalog, or every problem found. */
export function validateCatalog(
  raw: unknown,
  options: ValidateOptions = {},
): { catalog: Catalog; errors: [] } | { catalog?: undefined; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(raw)) return { errors: ['the catalog must be a JSON object'] };

  if (raw.version !== undefined && raw.version !== CATALOG_VERSION) {
    errors.push(`version ${JSON.stringify(raw.version)} is not supported (expected ${CATALOG_VERSION})`);
  }

  const sessions = raw.sso_sessions ?? {};
  if (!isRecord(sessions)) errors.push('sso_sessions: must be an object');
  else {
    for (const [name, keys] of Object.entries(sessions)) {
      if (!PROFILE_NAME.test(name)) errors.push(`sso_sessions: invalid session name ${JSON.stringify(name)}`);
      checkMap(`sso_sessions.${name}`, keys, errors, false);
    }
  }
  const sessionNames = new Set(isRecord(sessions) ? Object.keys(sessions) : []);

  const defaults = raw.defaults ?? {};
  checkMap('defaults', defaults, errors, false);
  const defaultSession = isRecord(defaults) && typeof defaults.sso_session === 'string' ? defaults.sso_session : undefined;
  if (defaultSession !== undefined && !sessionNames.has(defaultSession)) {
    errors.push(`defaults.sso_session: unknown session "${defaultSession}"`);
  }

  if (raw.sections !== undefined) {
    if (!isRecord(raw.sections)) errors.push('sections: must be an object');
    else {
      for (const [header, keys] of Object.entries(raw.sections)) {
        const kind = header.split(/\s+/)[0];
        if (!/^[A-Za-z0-9_.-]+( [A-Za-z0-9_.-]+)?$/.test(header)) {
          errors.push(`sections: invalid header ${JSON.stringify(header)}`);
        } else if (kind === 'profile' || kind === 'sso-session' || header === 'default') {
          errors.push(`sections: "${header}" belongs in profiles or sso_sessions`);
        }
        checkMap(`sections.${header}`, keys, errors, true);
      }
    }
  }

  if (!Array.isArray(raw.profiles)) {
    errors.push('profiles: must be an array');
    return { errors };
  }

  const names = new Map<string, number>();
  const formerOwners = new Map<string, string>();
  raw.profiles.forEach((p, index) => {
    if (isRecord(p) && typeof p.name === 'string') {
      names.set(p.name, (names.get(p.name) ?? 0) + 1);
      if (Array.isArray(p.former_names)) {
        for (const former of p.former_names) if (typeof former === 'string') formerOwners.set(former, p.name);
      }
    } else {
      errors.push(`profiles[${index}]: must be an object with a string "name"`);
    }
  });

  const reported = new Set<string>();
  for (const p of raw.profiles) {
    if (!isRecord(p) || typeof p.name !== 'string') continue;
    const where = `profile "${p.name}"`;
    if (!PROFILE_NAME.test(p.name)) errors.push(`${where}: name must match ${PROFILE_NAME}`);
    const count = names.get(p.name) ?? 0;
    if (count > 1 && !reported.has(p.name)) {
      errors.push(`${where}: defined ${count} times`);
      reported.add(p.name);
    }
    const owner = formerOwners.get(p.name);
    if (owner !== undefined && owner !== p.name) {
      errors.push(`${where}: also listed in the former_names of "${owner}"`);
    }

    for (const field of ['group', 'account_name', 'region', 'session', 'account_id', 'role'] as const) {
      const value = p[field];
      if (value === undefined) continue;
      if (typeof value !== 'string' || value === '') errors.push(`${where}: ${field} must be a non-empty string`);
      else {
        const problem = valueProblem(value);
        if (problem) errors.push(`${where}: ${field} ${problem}`);
      }
    }

    const hasAccount = p.account_id !== undefined;
    const hasRole = p.role !== undefined;
    if (hasAccount !== hasRole) errors.push(`${where}: account_id and role go together`);
    if (typeof p.account_id === 'string' && !ACCOUNT_ID.test(p.account_id)) {
      errors.push(`${where}: account_id must be 12 digits`);
    }
    if (hasAccount) {
      const session = typeof p.session === 'string' ? p.session : defaultSession;
      if (session === undefined) errors.push(`${where}: no session and no defaults.sso_session`);
      else if (!sessionNames.has(session)) errors.push(`${where}: unknown session "${session}"`);
    } else if (p.session !== undefined) {
      errors.push(`${where}: session without account_id and role`);
    }

    if (p.extra !== undefined) {
      checkMap(`${where} extra`, p.extra, errors, true);
      if (isRecord(p.extra)) {
        for (const reserved of ['sso_session', 'sso_account_id', 'sso_role_name', 'region']) {
          if (reserved in p.extra) errors.push(`${where}: "${reserved}" goes in its own field, not in extra`);
        }
        const source = p.extra.source_profile;
        if (
          typeof source === 'string' &&
          !names.has(source) &&
          !(options.externalProfiles?.has(source) ?? false)
        ) {
          errors.push(`${where}: source_profile "${source}" is not a known profile`);
        }
      }
    }

    if (p.former_names !== undefined && !(Array.isArray(p.former_names) && p.former_names.every((n) => typeof n === 'string'))) {
      errors.push(`${where}: former_names must be an array of strings`);
    }
    if (p.new !== undefined && typeof p.new !== 'boolean') errors.push(`${where}: new must be true or false`);
  }

  if (errors.length > 0) return { errors };
  return {
    catalog: {
      ...raw,
      version: CATALOG_VERSION,
      sso_sessions: sessions as Catalog['sso_sessions'],
      defaults: defaults as Catalog['defaults'],
      profiles: raw.profiles as CatalogProfile[],
    } as Catalog,
    errors: [],
  };
}

/** Profiles still marked `"new": true` by `discover`. `apply` refuses while any remain. */
export function pendingNew(catalog: Catalog): string[] {
  return catalog.profiles.filter((p) => p.new === true).map((p) => p.name);
}

export function loadCatalog(path: string, options: ValidateOptions = {}): Catalog {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new CatalogError(path, ['file not found (create it with `awsx profiles import`)']);
    throw new CatalogError(path, [err instanceof SyntaxError ? `not valid JSON: ${err.message}` : String(err)]);
  }
  const result = validateCatalog(raw, options);
  if (!result.catalog) throw new CatalogError(path, result.errors);
  return result.catalog;
}

/** Atomic write, mode 0600: the catalog holds account IDs and SSO portal URLs. */
export function saveCatalog(path: string, catalog: Catalog): void {
  const { version: _version, ...rest } = catalog;
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: CATALOG_VERSION, ...rest }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}
