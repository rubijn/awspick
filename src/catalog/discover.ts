/**
 * `awsx profiles discover` (ADR-0002): add the account/role pairs an SSO session
 * can reach and the catalog lacks, marked `"new": true` with a proposed name. A
 * human chooses the final names; `apply` refuses while any entry is still new.
 */

import { roleShort, slug } from './import.ts';
import type { Catalog, CatalogProfile } from './schema.ts';

export type Reachable = { accountId: string; accountName: string; roles: string[] };

export function addDiscovered(
  catalog: Catalog,
  session: string,
  reachable: readonly Reachable[],
  region?: string,
): { catalog: Catalog; added: CatalogProfile[] } {
  const defaultSession = catalog.defaults.sso_session;
  const have = new Set(
    catalog.profiles
      .filter((p) => p.account_id !== undefined)
      .map((p) => `${p.session ?? defaultSession}\u0000${p.account_id}\u0000${p.role}`),
  );
  const taken = new Set(catalog.profiles.flatMap((p) => [p.name, ...(p.former_names ?? [])]));

  const added: CatalogProfile[] = [];
  for (const account of reachable) {
    for (const role of account.roles) {
      if (have.has(`${session}\u0000${account.accountId}\u0000${role}`)) continue;
      const base = `${account.accountName ? slug(account.accountName) : account.accountId.slice(-4)}-${roleShort(role)}`;
      let name = base;
      for (let i = 2; taken.has(name); i++) name = `${base}-${i}`;
      taken.add(name);

      const entry: CatalogProfile = { name };
      if (account.accountName) entry.account_name = account.accountName;
      entry.account_id = account.accountId;
      entry.role = role;
      if (region) entry.region = region;
      if (session !== defaultSession) entry.session = session;
      entry.new = true;
      added.push(entry);
    }
  }
  return { catalog: { ...catalog, profiles: [...catalog.profiles, ...added] }, added };
}
