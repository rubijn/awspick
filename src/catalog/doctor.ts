/**
 * Catalog checks for `awsx doctor` (ADR-0002, "awsx doctor gains"). Read-only and
 * cheap: two file reads and an in-memory plan, no AWS call.
 */

import { existsSync } from 'node:fs';
import type { Profile } from '../profiles.ts';
import { driftReason, hasChanges, planApply } from './apply.ts';
import { roleShort } from './import.ts';
import { CatalogError, loadCatalog } from './schema.ts';

export type Check = { level: 'ok' | 'warn' | 'bad'; label: string; detail: string };

/** AWS managed roles with a known short name. Custom roles are never checked. */
const MANAGED = new Set(['AdministratorAccess', 'ReadOnlyAccess', 'ViewOnlyAccess', 'PowerUserAccess']);
const SHORTS = new Set([...MANAGED].map(roleShort));

/**
 * Profiles whose name says one managed role and whose config assumes another,
 * such as `acme-admin` on `ReadOnlyAccess`: the misnaming the migration found
 * twice. Both sides must be known: `ops-read` on a custom `ops-reader` role is fine.
 */
export function misnamed(profiles: readonly Profile[]): Array<{ name: string; role: string }> {
  return profiles
    .filter((p) => p.roleName !== undefined)
    .filter((p) => {
      const last = p.name.slice(p.name.lastIndexOf('-') + 1).toLowerCase();
      const role = p.roleName as string;
      return SHORTS.has(last) && MANAGED.has(role) && roleShort(role) !== last;
    })
    .map((p) => ({ name: p.name, role: p.roleName as string }));
}

export type DoctorInput = {
  catalogPath: string;
  configText: string;
  credentialsText: string;
  staticProfiles: ReadonlySet<string>;
  profiles: readonly Profile[];
};

export function catalogChecks(input: DoctorInput): Check[] {
  const checks: Check[] = [];

  for (const m of misnamed(input.profiles)) {
    checks.push({ level: 'warn', label: 'profile name', detail: `"${m.name}" assumes ${m.role}` });
  }

  if (!existsSync(input.catalogPath)) {
    checks.push({ level: 'ok', label: 'catalog', detail: `none at ${input.catalogPath} (optional: \`awsx profiles import\`)` });
    return checks;
  }

  let catalog;
  try {
    catalog = loadCatalog(input.catalogPath, { externalProfiles: input.staticProfiles });
  } catch (err) {
    const detail = err instanceof CatalogError ? `${err.errors.length} problem(s): ${err.errors.join('; ')}` : String(err);
    checks.push({ level: 'bad', label: 'catalog', detail: `${input.catalogPath} is invalid — ${detail}` });
    return checks;
  }
  checks.push({ level: 'ok', label: 'catalog', detail: `${input.catalogPath} (${catalog.profiles.length} profiles)` });

  const plan = planApply({ catalog, configText: input.configText, credentialsText: input.credentialsText });
  if (plan.pendingNew.length > 0) {
    checks.push({ level: 'warn', label: 'catalog', detail: `still marked "new": ${plan.pendingNew.join(', ')}` });
  }
  const drift = driftReason(plan);
  if (drift !== undefined) {
    checks.push({ level: 'warn', label: 'config drift', detail: `${drift} — \`awsx profiles apply --adopt\` or \`--force\`` });
  } else if (hasChanges(plan)) {
    checks.push({ level: 'warn', label: 'config drift', detail: 'the catalog has changes not applied yet — `awsx profiles apply --dry-run`' });
  } else if (plan.generated.state === 'unmanaged') {
    checks.push({
      level: 'ok',
      label: 'config drift',
      detail: '~/.aws/config matches the catalog, but was not written by awsx: the next apply only adds its header',
    });
  } else {
    checks.push({ level: 'ok', label: 'config drift', detail: '~/.aws/config matches the catalog' });
  }
  if (plan.shadowed.length > 0) {
    checks.push({
      level: 'warn',
      label: 'shadowing',
      detail: `~/.aws/credentials redefines ${plan.shadowed.map((s) => `${s.name} (line ${s.line})`).join(', ')}, and wins over ~/.aws/config`,
    });
  }
  return checks;
}
