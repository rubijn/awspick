/**
 * `awsx profiles apply` (ADR-0002, "What apply guarantees").
 *
 * planApply() is pure: catalog and current file texts in, a plan out. The
 * writers below it are the only code in awsx that writes under ~/.aws/, and they
 * write ~/.aws/config only. ~/.aws/credentials is read, never written.
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseIni, sectionSpans, splitHeader, type IniFile, type IniSection } from '../ini.ts';
import type { AwsxConfig } from '../store.ts';
import { importCatalog } from './import.ts';
import { inspectGenerated, renderConfig, type GeneratedState } from './render.ts';
import { CREDENTIAL_KEYS, pendingNew, type Catalog } from './schema.ts';

export type Rename = { from: string; to: string };

export type ApplyPlan = {
  next: string;
  generated: GeneratedState;
  added: string[];
  removed: string[];
  /** Profiles in both, with the names of the keys that differ (never the values). */
  changed: Array<{ name: string; keys: string[] }>;
  renames: Rename[];
  /** Non-profile blocks (`sso-session x`, `services y`) added, removed or changed. */
  otherSections: string[];
  /**
   * Profiles only in the current config, neither in the catalog nor renamed:
   * someone added them outside the catalog. `apply` would delete them.
   */
  outside: string[];
  /** Non-static credentials sections that shadow a catalog profile, with their 1-based line. */
  shadowed: Array<{ name: string; line: number }>;
  pendingNew: string[];
};

/** Why apply must stop without --adopt or --force, or undefined if it may go on. */
export function driftReason(plan: ApplyPlan): string | undefined {
  if (plan.generated.state === 'edited') {
    return '~/.aws/config was edited since the last apply';
  }
  if (plan.outside.length > 0) {
    return `~/.aws/config has profiles that are not in the catalog: ${plan.outside.join(', ')}`;
  }
  return undefined;
}

export const hasChanges = (plan: ApplyPlan): boolean =>
  plan.added.length + plan.removed.length + plan.changed.length + plan.renames.length + plan.otherSections.length > 0;

const profileOf = (header: string): string | undefined => {
  if (header === 'default') return 'default';
  const { type, name } = splitHeader(header);
  return type === 'profile' ? name : undefined;
};

/** Flatten a section to comparable `key` / `parent.key` entries. */
function flat(section: IniSection): Map<string, string> {
  const out = new Map(Object.entries(section.keys));
  for (const [parent, map] of Object.entries(section.nested)) {
    out.delete(parent);
    for (const [k, v] of Object.entries(map)) out.set(`${parent}.${k}`, v);
  }
  return out;
}

function differingKeys(a: IniSection, b: IniSection): string[] {
  const fa = flat(a);
  const fb = flat(b);
  const keys = new Set([...fa.keys(), ...fb.keys()]);
  return [...keys].filter((k) => fa.get(k) !== fb.get(k)).sort();
}

/** What makes two profiles "the same" across a rename: the role they assume. */
function identity(section: IniSection): string | undefined {
  const k = section.keys;
  if (k.sso_session && k.sso_account_id && k.sso_role_name) return `sso:${k.sso_session}:${k.sso_account_id}:${k.sso_role_name}`;
  if (k.sso_start_url && k.sso_account_id && k.sso_role_name) return `sso:${k.sso_start_url}:${k.sso_account_id}:${k.sso_role_name}`;
  if (k.role_arn) return `role:${k.role_arn}:${k.source_profile ?? k.credential_source ?? ''}`;
  return undefined;
}

const profiles = (file: IniFile) => {
  const out = new Map<string, IniSection>();
  for (const [header, section] of file) {
    const name = profileOf(header);
    if (name !== undefined) out.set(name, section);
  }
  return out;
};

export type PlanInput = { catalog: Catalog; configText: string; credentialsText: string };

export function planApply({ catalog, configText, credentialsText }: PlanInput): ApplyPlan {
  const next = renderConfig(catalog);
  const before = parseIni(configText);
  const after = parseIni(next);
  const oldProfiles = profiles(before);
  const newProfiles = profiles(after);

  let added = [...newProfiles.keys()].filter((n) => !oldProfiles.has(n));
  let removed = [...oldProfiles.keys()].filter((n) => !newProfiles.has(n));

  // A removed and an added profile that assume the same role are one rename.
  const renames: Rename[] = [];
  const addedById = new Map<string, string>();
  for (const name of added) {
    const id = identity(newProfiles.get(name) as IniSection);
    if (id !== undefined && !addedById.has(id)) addedById.set(id, name);
  }
  for (const from of removed) {
    const id = identity(oldProfiles.get(from) as IniSection);
    const to = id === undefined ? undefined : addedById.get(id);
    if (to !== undefined) {
      renames.push({ from, to });
      addedById.delete(id as string);
    }
  }
  added = added.filter((n) => !renames.some((r) => r.to === n));
  removed = removed.filter((n) => !renames.some((r) => r.from === n));

  const changed = [...newProfiles.keys()]
    .filter((n) => oldProfiles.has(n))
    .map((name) => ({ name, keys: differingKeys(oldProfiles.get(name) as IniSection, newProfiles.get(name) as IniSection) }))
    .filter((c) => c.keys.length > 0);

  const otherHeaders = new Set(
    [...before.keys(), ...after.keys()].filter((h) => profileOf(h) === undefined),
  );
  const otherSections = [...otherHeaders]
    .filter((h) => {
      const a = before.get(h);
      const b = after.get(h);
      return !a || !b || differingKeys(a, b).length > 0;
    })
    .sort();

  // Profiles the catalog does not know at all, not even as a former name.
  const known = new Set(catalog.profiles.flatMap((p) => [p.name, ...(p.former_names ?? [])]));
  const outside = removed.filter((n) => !known.has(n));

  const credentials = parseIni(credentialsText);
  const catalogNames = new Set(catalog.profiles.map((p) => p.name));
  const shadowed = sectionSpans(credentialsText)
    .filter((span) => {
      const name = span.header.startsWith('profile ') ? splitHeader(span.header).name : span.header;
      const section = credentials.get(span.header);
      return (
        catalogNames.has(name) &&
        section !== undefined &&
        !Object.keys(section.keys).some((k) => CREDENTIAL_KEYS.has(k))
      );
    })
    .map((span) => ({ name: span.header, line: span.line + 1 }));

  return {
    next,
    generated: configText === '' ? { state: 'unmanaged' } : inspectGenerated(configText),
    added: added.sort(),
    removed: removed.sort(),
    changed,
    renames,
    otherSections,
    outside: outside.sort(),
    shadowed,
    pendingNew: pendingNew(catalog),
  };
}

/**
 * `--adopt`: bring the profiles that exist only in config into the catalog, with
 * the same folding rules as `import`. Profiles in both keep the catalog's version.
 */
export function adoptOutside(catalog: Catalog, configText: string, credentialsText: string, names: string[]): Catalog {
  const imported = importCatalog({ configText, credentialsText, ...(catalog.defaults.sso_session ? { defaultSession: catalog.defaults.sso_session } : {}) }).catalog;
  const wanted = new Set(names);
  const taken = new Set(catalog.profiles.map((p) => p.name));
  const adopted = imported.profiles.filter(
    (p) => !taken.has(p.name) && (wanted.has(p.name) || (p.former_names ?? []).some((n) => wanted.has(n))),
  );
  // Sessions an adopted profile needs and the catalog lacks come along.
  const sso_sessions = { ...catalog.sso_sessions };
  for (const p of adopted) {
    const s = p.session ?? imported.defaults.sso_session;
    if (s && !sso_sessions[s] && imported.sso_sessions[s]) sso_sessions[s] = imported.sso_sessions[s];
    if (p.account_id && p.session === undefined && s !== catalog.defaults.sso_session && s !== undefined) p.session = s;
  }
  // Values the import moved into its own defaults go back onto each adopted profile
  // when the catalog does not share them.
  for (const p of adopted) {
    for (const [k, v] of Object.entries(imported.defaults)) {
      if (k === 'sso_session' || catalog.defaults[k] === v) continue;
      p.extra = { ...(p.extra ?? {}), [k]: v };
    }
  }
  return { ...catalog, sso_sessions, profiles: [...catalog.profiles, ...adopted] };
}

/** Carry remembered state across renames. Returns true when something moved. */
export function renameInState(config: AwsxConfig, renames: Rename[]): boolean {
  let changed = false;
  for (const { from, to } of renames) {
    for (const key of ['lastProfile', 'previousProfile'] as const) {
      if (config[key] === from) {
        config[key] = to;
        changed = true;
      }
    }
    if (config.recents.includes(from)) {
      config.recents = config.recents.map((n) => (n === from ? to : n));
      changed = true;
    }
    const state = config.perProfile[from];
    if (state !== undefined) {
      if (config.perProfile[to] === undefined) config.perProfile[to] = state;
      delete config.perProfile[from];
      changed = true;
    }
  }
  return changed;
}

/** Record each old name in the renamed profile's former_names. */
export function recordFormerNames(catalog: Catalog, renames: Rename[]): Catalog {
  const byTo = new Map(renames.map((r) => [r.to, r.from]));
  return {
    ...catalog,
    profiles: catalog.profiles.map((p) => {
      const from = byTo.get(p.name);
      if (from === undefined || (p.former_names ?? []).includes(from)) return p;
      return { ...p, former_names: [...(p.former_names ?? []), from] };
    }),
  };
}

export type AliasHit = { file: string; line: number; name: string };

/** Lines of shell rc files that still use an old profile name. Read-only. */
export function aliasHints(renames: Rename[], files: string[]): AliasHit[] {
  const hits: AliasHit[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (const { from } of renames) {
      const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const word = new RegExp(`(^|[^A-Za-z0-9_.-])${escaped}($|[^A-Za-z0-9_.-])`);
      lines.forEach((l, i) => {
        if (word.test(l)) hits.push({ file, line: i + 1, name: from });
      });
    }
  }
  return hits;
}

export const BACKUPS_KEPT = 20;

/** `20261118T085214Z`: sortable, and unambiguous across time zones. */
export const backupStamp = (now = new Date()) => now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

/**
 * Copy the config file into `<dir of config>/backup/<stamp>/`, then keep only the
 * most recent BACKUPS_KEPT backups. Returns the backup directory, or undefined when
 * there was no file to back up.
 */
export function backupConfig(configPath: string, now = new Date()): string | undefined {
  if (!existsSync(configPath)) return undefined;
  const root = join(dirname(configPath), 'backup');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  let dir = join(root, backupStamp(now));
  for (let i = 2; existsSync(dir); i++) dir = join(root, `${backupStamp(now)}-${i}`);
  mkdirSync(dir, { mode: 0o700 });
  copyFileSync(configPath, join(dir, 'config'));

  const stamps = readdirSync(root)
    // Only our own stamps: a backup made by another tool (the retired script wrote
    // `20261118-085214`) is never deleted.
    .filter((n) => /^\d{8}T\d{6}Z(-\d+)?$/.test(n))
    .sort();
  for (const old of stamps.slice(0, Math.max(0, stamps.length - BACKUPS_KEPT))) {
    rmSync(join(root, old), { recursive: true, force: true });
  }
  return dir;
}

/** tmp + rename in the same directory, mode 0600. */
export function writeConfigAtomic(configPath: string, text: string): void {
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  const tmp = `${configPath}.awsx-${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, configPath);
}
