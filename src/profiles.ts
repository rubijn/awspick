/**
 * Reads ~/.aws/config and ~/.aws/credentials and resolves them into the model
 * the picker displays: name, account, role, region, credential kind, SSO session.
 *
 * Direct file reads rather than `aws configure` calls, because this runs on
 * every keystroke of the search prompt and one `aws` invocation costs ~240 ms
 * and returns names only (ADR-0001, "The AWS CLI is a dependency").
 */

import { readFileSync } from 'node:fs';
import { parseIni, splitHeader, type IniFile, type IniSection } from './ini.ts';
import { awsConfigPath, awsCredentialsPath } from './paths.ts';
import type { Settings } from './store.ts';

export type ProfileKind = 'sso' | 'chained' | 'static' | 'process' | 'unknown';

export type Profile = {
  name: string;
  /** Which file(s) defined it. */
  sources: Array<'config' | 'credentials'>;
  kind: ProfileKind;
  /** Region for this profile, inherited through `source_profile` if needed. */
  region?: string;
  /** True when the region came from a parent profile rather than this one. */
  regionInherited: boolean;
  accountId?: string;
  roleName?: string;
  ssoSession?: string;
  ssoStartUrl?: string;
  ssoRegion?: string;
  sourceProfile?: string;
  isProd: boolean;
};

export type AwsFiles = {
  config: IniFile;
  credentials: IniFile;
  configPath: string;
  credentialsPath: string;
  /** Files that could not be read (missing is fine, unreadable is worth saying). */
  problems: string[];
};

function readIni(path: string, problems: string[]): IniFile {
  try {
    return parseIni(readFileSync(path, 'utf8'));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') problems.push(`${path}: ${String(err)}`);
    return new Map();
  }
}

export function loadAwsFiles(): AwsFiles {
  const problems: string[] = [];
  const configPath = awsConfigPath();
  const credentialsPath = awsCredentialsPath();
  return {
    config: readIni(configPath, problems),
    credentials: readIni(credentialsPath, problems),
    configPath,
    credentialsPath,
    problems,
  };
}

/** `arn:aws:iam::123456789012:role/path/Name` -> account + role name. */
export function parseRoleArn(arn: string): { accountId?: string; roleName?: string } {
  const match = /^arn:[^:]*:iam::(\d{12}):role\/(.+)$/.exec(arn.trim());
  if (!match) return {};
  const path = match[2] as string;
  const roleName = path.slice(path.lastIndexOf('/') + 1);
  return { accountId: match[1] as string, roleName };
}

export function isProdName(name: string, settings: Settings): boolean {
  if (settings.prodProfiles.includes(name)) return true;
  const lower = name.toLowerCase();
  return settings.prodPatterns.some((pattern) => pattern !== '' && lower.includes(pattern.toLowerCase()));
}

type RawProfile = {
  name: string;
  keys: Record<string, string>;
  sources: Array<'config' | 'credentials'>;
};

/**
 * Collect raw profile sections from both files.
 *
 * Precedence: the credentials file wins for the keys it is allowed to define
 * (credential material), the config file wins for everything else — notably
 * `region`, which some people also put in credentials where the CLI ignores it.
 */
function collectRaw(files: AwsFiles): Map<string, RawProfile> {
  const out = new Map<string, RawProfile>();

  const upsert = (name: string, source: 'config' | 'credentials'): RawProfile => {
    let entry = out.get(name);
    if (!entry) {
      entry = { name, keys: {}, sources: [] };
      out.set(name, entry);
    }
    if (!entry.sources.includes(source)) entry.sources.push(source);
    return entry;
  };

  for (const [header, section] of files.credentials) {
    const { type, name } = splitHeader(header);
    // Tolerate a `[profile x]` header here even though the CLI would not.
    const profileName = type === 'profile' ? name : header;
    const entry = upsert(profileName, 'credentials');
    Object.assign(entry.keys, section.keys);
  }

  for (const [header, section] of files.config) {
    const { type, name } = splitHeader(header);
    if (type === 'sso-session') continue;
    const profileName = header === 'default' ? 'default' : type === 'profile' ? name : undefined;
    if (profileName === undefined) continue; // `[services x]`, `[plugins]`, ...
    const entry = upsert(profileName, 'config');
    Object.assign(entry.keys, section.keys);
  }

  return out;
}

function ssoSessionSection(files: AwsFiles, session: string): IniSection | undefined {
  return files.config.get(`sso-session ${session}`);
}

function classify(keys: Record<string, string>): ProfileKind {
  if (keys.sso_session || keys.sso_start_url) return 'sso';
  if (keys.role_arn) return 'chained';
  if (keys.aws_access_key_id) return 'static';
  if (keys.credential_process) return 'process';
  return 'unknown';
}

export function resolveProfiles(files: AwsFiles, settings: Settings): Profile[] {
  const raw = collectRaw(files);

  /** Region from this profile, else walked up the source_profile chain. */
  const regionOf = (name: string): { region?: string; inherited: boolean } => {
    const seen = new Set<string>();
    let current = raw.get(name);
    let inherited = false;
    while (current && !seen.has(current.name)) {
      seen.add(current.name);
      const own = current.keys.region || current.keys.aws_region;
      if (own) return { region: own, inherited };
      // sso_region is where the SSO portal lives, not where you work, so it is
      // a last resort rather than a real default — and it can sit either on the
      // profile (legacy inline SSO config) or on the [sso-session] block.
      const session = current.keys.sso_session;
      const ssoRegion =
        current.keys.sso_region ??
        (session ? ssoSessionSection(files, session)?.keys.sso_region : undefined);
      if (ssoRegion) return { region: ssoRegion, inherited: true };
      const parent = current.keys.source_profile;
      if (!parent) break;
      inherited = true;
      current = raw.get(parent);
    }
    return { region: undefined, inherited: false };
  };

  const profiles: Profile[] = [];
  for (const entry of raw.values()) {
    const { keys } = entry;
    const kind = classify(keys);

    let accountId = keys.sso_account_id;
    let roleName = keys.sso_role_name;
    if (keys.role_arn) {
      const parsed = parseRoleArn(keys.role_arn);
      accountId ??= parsed.accountId;
      roleName ??= parsed.roleName;
    }

    let ssoStartUrl = keys.sso_start_url;
    let ssoRegion = keys.sso_region;
    if (keys.sso_session) {
      const sessionKeys = ssoSessionSection(files, keys.sso_session)?.keys;
      ssoStartUrl ??= sessionKeys?.sso_start_url;
      ssoRegion ??= sessionKeys?.sso_region;
    }

    const { region, inherited } = regionOf(entry.name);

    const profile: Profile = {
      name: entry.name,
      sources: entry.sources,
      kind,
      regionInherited: inherited,
      isProd: isProdName(entry.name, settings),
    };
    if (region) profile.region = region;
    if (accountId) profile.accountId = accountId;
    if (roleName) profile.roleName = roleName;
    if (keys.sso_session) profile.ssoSession = keys.sso_session;
    if (ssoStartUrl) profile.ssoStartUrl = ssoStartUrl;
    if (ssoRegion) profile.ssoRegion = ssoRegion;
    if (keys.source_profile) profile.sourceProfile = keys.source_profile;
    profiles.push(profile);
  }

  profiles.sort((a, b) => a.name.localeCompare(b.name));
  return profiles;
}
