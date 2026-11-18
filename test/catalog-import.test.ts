/**
 * `import` (ADR-0002, step 3): folding duplicates, choosing names, keeping static
 * keys out of the catalog, and a stable round trip through render.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { importCatalog, isGeneratedName, roleShort, slug } from '../src/catalog/import.ts';
import { renderConfig } from '../src/catalog/render.ts';
import { validateCatalog, type Catalog, type CatalogProfile } from '../src/catalog/schema.ts';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = (...p: string[]) => readFileSync(join(fixtures, ...p), 'utf8');

const messy = (accountNames?: Map<string, string>) =>
  importCatalog({
    configText: read('import', 'config'),
    credentialsText: read('import', 'credentials'),
    ...(accountNames ? { accountNames } : {}),
  });

const byName = (catalog: Catalog) => new Map(catalog.profiles.map((p) => [p.name, p]));

test('names: generated vs hand-chosen, role short names, slugs', () => {
  assert.equal(isGeneratedName('acme-prod-AdministratorAccess', 'AdministratorAccess', '111111111111'), true);
  assert.equal(isGeneratedName('AdministratorAccess-111111111111', 'AdministratorAccess', '111111111111'), true);
  assert.equal(isGeneratedName('acme-prod-admin', 'AdministratorAccess', '111111111111'), false);
  assert.equal(isGeneratedName('default', 'default', '111111111111'), false);
  assert.equal(roleShort('AdministratorAccess'), 'admin');
  assert.equal(roleShort('ObservabilityEngineers'), 'observabilityengineers');
  assert.equal(slug('  Acme Prod (EU) '), 'acme-prod-eu');
});

test('a hand-chosen name wins, and the generated one goes to former_names', () => {
  const { catalog, report } = messy();
  const p = byName(catalog).get('acme-prod-admin');
  assert.equal(p?.account_id, '111111111111');
  assert.equal(p?.account_name, 'acme-prod');
  assert.deepEqual(p?.former_names, ['acme-prod-AdministratorAccess']);
  assert.equal(byName(catalog).has('acme-prod-AdministratorAccess'), false);
  assert.deepEqual(report.folded, [{ kept: 'acme-prod-admin', replaced: ['acme-prod-AdministratorAccess'] }]);
});

test('with only generated names, proposes <account>-<role short>, from SSO names when given', () => {
  const offline = messy();
  assert.deepEqual(offline.report.proposed.map((p) => p.name).sort(), [
    '3333-admin', // no account name anywhere: last 4 digits
    'acme-sandbox-power',
    'partner-read',
  ]);

  const online = messy(new Map([['333333333333', 'Acme Dev']]));
  const dev = byName(online.catalog).get('acme-dev-admin');
  assert.equal(dev?.account_name, 'Acme Dev');
  assert.deepEqual(dev?.former_names, ['AdministratorAccess-333333333333']);
  assert.deepEqual(dev?.extra, { s3: { addressing_style: 'path' } });
});

test('credentials wins for a profile in both files, and the shadowing is reported', () => {
  const { catalog, report } = messy();
  assert.equal(byName(catalog).get('split')?.region, 'eu-central-1');
  assert.ok(report.warnings.some((w) => /"split" is in ~\/.aws\/credentials/.test(w)));
});

test('static keys stay out of the catalog; a config part of the same profile is kept', () => {
  const { catalog, report } = messy();
  assert.deepEqual(report.staticProfiles, ['ci-keys', 'default']);
  assert.equal(byName(catalog).has('ci-keys'), false);
  assert.equal(byName(catalog).get('default')?.region, 'eu-west-1');
  const text = JSON.stringify(catalog);
  assert.doesNotMatch(text, /AKIA|secret|aws_access_key_id/);
});

test('a role chain on a static profile validates against the credentials file', () => {
  const { catalog, report } = messy();
  assert.deepEqual(byName(catalog).get('ops-read')?.extra, {
    role_arn: 'arn:aws:iam::555555555555:role/Read',
    source_profile: 'ci-keys',
  });
  assert.deepEqual(report.errors, []);
});

test('legacy inline SSO keeps its keys in extra', () => {
  const p = byName(messy().catalog).get('legacy');
  assert.equal(p?.account_id, undefined);
  assert.equal(p?.extra?.sso_account_id, '666666666666');
});

test('groups come from the last title before a profile; notes, rules and the preamble are not titles', () => {
  const groups = Object.fromEntries(messy().catalog.profiles.map((p) => [p.name, p.group]));
  assert.equal(groups['partner-read'], undefined); // only the file preamble above it
  assert.equal(groups['acme-sandbox-power'], 'ACME');
  assert.equal(groups['acme-prod-admin'], 'ACME'); // from credentials, which wins
  assert.equal(groups['ops-read'], 'OPS');
  assert.equal(groups.legacy, 'ACME'); // a note is not a title: the banner above still applies
});

test('defaults: the most used session, and a value every profile shares', () => {
  const { catalog } = messy();
  assert.deepEqual(catalog.defaults, { sso_session: 'corp', cli_pager: '' });
  assert.equal(byName(catalog).get('partner-read')?.session, 'partner');
  assert.equal(byName(catalog).get('acme-prod-admin')?.session, undefined);
  assert.ok(catalog.profiles.every((p) => p.extra?.cli_pager === undefined));
});

test('--default-session overrides the most used one', () => {
  const { catalog } = importCatalog({
    configText: read('import', 'config'),
    credentialsText: read('import', 'credentials'),
    defaultSession: 'partner',
  });
  assert.equal(catalog.defaults.sso_session, 'partner');
  assert.equal(byName(catalog).get('acme-prod-admin')?.session, 'corp');
});

test('non-profile sections are carried, sso-sessions copied', () => {
  const { catalog } = messy();
  assert.deepEqual(catalog.sections, { 'services local-dev': { s3: { endpoint_url: 'http://localhost:4566' } } });
  assert.deepEqual(Object.keys(catalog.sso_sessions), ['corp', 'partner']);
});

test('static keys written in config stop the import with a clear error', () => {
  const { report } = importCatalog({
    configText: '[profile k]\naws_access_key_id = AKIAFAKE\naws_secret_access_key = x\n',
    credentialsText: '',
  });
  assert.ok(report.errors.some((e) => /"k": static keys in ~\/.aws\/config/.test(e)));
});

test('same account and role under two hand-chosen names: both kept, with a warning', () => {
  const sso = 'sso_session = corp\nsso_account_id = 111111111111\nsso_role_name = Admin\n';
  const { catalog, report } = importCatalog({
    configText: `[sso-session corp]\nsso_start_url = https://x.awsapps.com/start\nsso_region = eu-west-1\n[profile a]\n${sso}[profile b]\n${sso}`,
    credentialsText: '',
  });
  assert.deepEqual(catalog.profiles.map((p) => p.name), ['a', 'b']);
  assert.ok(report.warnings.some((w) => /"a", "b" are the same account and role under hand-chosen names/.test(w)));
});

test('a proposed name never collides with an existing one', () => {
  const { catalog } = importCatalog({
    configText: [
      '[sso-session corp]', 'sso_start_url = https://x.awsapps.com/start', 'sso_region = eu-west-1',
      '[profile acme-admin]', 'region = eu-west-1',
      '[profile acme-AdministratorAccess]', 'sso_session = corp', 'sso_account_id = 111111111111', 'sso_role_name = AdministratorAccess',
    ].join('\n'),
    credentialsText: '',
  });
  assert.deepEqual(catalog.profiles.map((p) => p.name).sort(), ['acme-admin', 'acme-admin-2']);
});

test('re-importing a generated config gives back the same catalog', () => {
  const original = JSON.parse(read('catalog.json'));
  const valid = validateCatalog(original, { externalProfiles: new Set(['ci-keys']) }).catalog as Catalog;
  const accountNames = new Map(
    valid.profiles.filter((p) => p.account_id && p.account_name).map((p) => [p.account_id as string, p.account_name as string]),
  );
  const { catalog, report } = importCatalog({
    configText: renderConfig(valid),
    credentialsText: '[ci-keys]\naws_access_key_id = AKIAFAKE\naws_secret_access_key = fake\n',
    accountNames,
  });
  assert.deepEqual(report.errors, []);

  const strip = (profiles: CatalogProfile[]) =>
    profiles.map(({ former_names: _f, ...rest }) => rest).sort((a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(strip(catalog.profiles), strip(valid.profiles));
  assert.deepEqual(catalog.defaults, valid.defaults);
  assert.deepEqual(catalog.sso_sessions, valid.sso_sessions);
  assert.deepEqual(catalog.sections, valid.sections);
  // And it is a fixed point: rendering it again is byte-identical.
  assert.equal(renderConfig(importCatalog({ configText: renderConfig(catalog), credentialsText: '[ci-keys]\naws_access_key_id = A\n', accountNames }).catalog), renderConfig(catalog));
});
