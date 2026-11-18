/**
 * Catalog checks for `awsx doctor` (ADR-0002, step 6): read-only, no AWS call.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { catalogChecks, misnamed, type Check } from '../src/catalog/doctor.ts';
import { importCatalog } from '../src/catalog/import.ts';
import { renderConfig } from '../src/catalog/render.ts';
import { saveCatalog } from '../src/catalog/schema.ts';
import type { Profile } from '../src/profiles.ts';

const profile = (name: string, roleName?: string): Profile => ({
  name,
  sources: ['config'],
  kind: 'sso',
  regionInherited: false,
  isProd: false,
  ...(roleName ? { roleName } : {}),
});

test('misnamed: a role short name at the end of the name must match the role', () => {
  assert.deepEqual(
    misnamed([
      profile('acme-admin', 'ReadOnlyAccess'),
      profile('acme-read', 'ReadOnlyAccess'),
      profile('acme-ops', 'AdministratorAccess'), // not a known short name: not checked
      profile('acme-admin-2', 'ReadOnlyAccess'), // suffix after the short name: not checked
      profile('plain-admin'), // no role (static, chained without ARN)
      profile('ops-read', 'team-ops-reader'), // custom role: never checked
    ]),
    [{ name: 'acme-admin', role: 'ReadOnlyAccess' }],
  );
});

const CONFIG = [
  '[sso-session corp]', 'sso_start_url = https://x.awsapps.com/start', 'sso_region = eu-west-1',
  '[profile a]', 'sso_session = corp', 'sso_account_id = 111111111111', 'sso_role_name = AdministratorAccess',
].join('\n');

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'awsx-doctor-'));
  const catalogPath = join(dir, 'profiles.json');
  const catalog = importCatalog({ configText: CONFIG, credentialsText: '' }).catalog;
  saveCatalog(catalogPath, catalog);
  const checks = (configText: string, credentialsText = '') =>
    catalogChecks({ catalogPath, configText, credentialsText, staticProfiles: new Set(), profiles: [] });
  return { catalogPath, catalog, checks };
}

const find = (checks: Check[], label: string) => checks.filter((c) => c.label === label);

test('no catalog is fine: the feature is optional', () => {
  const checks = catalogChecks({ catalogPath: '/nonexistent/profiles.json', configText: '', credentialsText: '', staticProfiles: new Set(), profiles: [] });
  assert.deepEqual(checks.map((c) => [c.level, c.label]), [['ok', 'catalog']]);
});

test('an invalid catalog is a failure, with every problem', () => {
  const { catalogPath, checks } = setup();
  writeFileSync(catalogPath, JSON.stringify({ profiles: [{ name: 'a b' }, { name: 'a b' }] }));
  const [c] = find(checks(CONFIG), 'catalog');
  assert.equal(c?.level, 'bad');
  assert.match(c?.detail ?? '', /3 problem\(s\)/);
});

test('in sync, unapplied changes, edited by hand', () => {
  const { catalog, catalogPath, checks } = setup();
  const generated = renderConfig(catalog);
  assert.equal(find(checks(generated), 'config drift')[0]?.detail, '~/.aws/config matches the catalog');
  const byAnotherTool = generated.split('\n').slice(3).join('\n');
  assert.match(find(checks(byAnotherTool), 'config drift')[0]?.detail ?? '', /not written by awsx/);

  catalog.profiles.push({ name: 'b', region: 'eu-west-1' });
  saveCatalog(catalogPath, catalog);
  assert.match(find(checks(generated), 'config drift')[0]?.detail ?? '', /changes not applied yet/);

  assert.match(find(checks(`${generated}[profile x]\nregion = y\n`), 'config drift')[0]?.detail ?? '', /edited since the last apply/);
});

test('pending "new" entries and shadowing credentials are warnings', () => {
  const { catalog, catalogPath, checks } = setup();
  catalog.profiles.push({ name: 'n', account_id: '222222222222', role: 'R', new: true });
  saveCatalog(catalogPath, catalog);
  const all = checks(renderConfig(catalog), '[a]\nregion = eu-west-3\n');
  assert.ok(all.some((c) => c.level === 'warn' && /still marked "new": n/.test(c.detail)));
  assert.match(find(all, 'shadowing')[0]?.detail ?? '', /a \(line 1\)/);
  assert.ok(all.every((c) => c.level !== 'bad'));
});
