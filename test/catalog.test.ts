/**
 * The profile catalog core (ADR-0002, step 2): validation, rendering, the round
 * trip through our own parser, drift detection, and the AWS CLI as the oracle.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { inspectGenerated, renderConfig } from '../src/catalog/render.ts';
import {
  CatalogError,
  loadCatalog,
  pendingNew,
  saveCatalog,
  validateCatalog,
  type Catalog,
} from '../src/catalog/schema.ts';
import { parseIni } from '../src/ini.ts';
import { resolveProfiles, type AwsFiles } from '../src/profiles.ts';
import { DEFAULT_SETTINGS } from '../src/store.ts';

const execFileAsync = promisify(execFile);
const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const external = new Set(['ci-keys']);

const rawFixture = (): Record<string, unknown> =>
  JSON.parse(readFileSync(join(fixtures, 'catalog.json'), 'utf8')) as Record<string, unknown>;

function fixtureCatalog(): Catalog {
  const result = validateCatalog(rawFixture(), { externalProfiles: external });
  assert.deepEqual(result.errors, []);
  return result.catalog as Catalog;
}

/** Errors for the fixture after `mutate` changed it. */
function errorsAfter(mutate: (doc: any) => void): string[] {
  const doc = rawFixture();
  mutate(doc);
  return validateCatalog(doc, { externalProfiles: external }).errors;
}

const tmp = () => mkdtempSync(join(tmpdir(), 'awsx-catalog-'));

test('renders the fixture exactly as the golden file', () => {
  assert.equal(renderConfig(fixtureCatalog()), readFileSync(join(fixtures, 'catalog.config'), 'utf8'));
});

test('round trip: our parser reads back exactly what the catalog says', () => {
  const catalog = fixtureCatalog();
  const files: AwsFiles = {
    config: parseIni(renderConfig(catalog)),
    credentials: new Map(),
    configPath: '',
    credentialsPath: '',
    problems: [],
  };
  const resolved = new Map(resolveProfiles(files, DEFAULT_SETTINGS).map((p) => [p.name, p]));

  assert.deepEqual([...resolved.keys()].sort(), catalog.profiles.map((p) => p.name).sort());
  for (const p of catalog.profiles) {
    const got = resolved.get(p.name);
    if (p.account_id) {
      assert.equal(got?.kind, 'sso', p.name);
      assert.equal(got?.accountId, p.account_id, p.name);
      assert.equal(got?.roleName, p.role, p.name);
      assert.equal(got?.ssoSession, p.session ?? catalog.defaults.sso_session, p.name);
    }
    if (p.region) assert.equal(got?.region, p.region, p.name);
  }
  assert.equal(resolved.get('ops-read')?.accountId, '444444444444');
  assert.deepEqual(files.config.get('profile acme-dev-admin')?.nested.s3, { addressing_style: 'path' });
  assert.deepEqual(files.config.get('services local-dev')?.nested.s3, { endpoint_url: 'http://localhost:4566' });
});

test('rendering is deterministic', () => {
  assert.equal(renderConfig(fixtureCatalog()), renderConfig(fixtureCatalog()));
});

test('ungrouped profiles come first, then each group once, in order of first appearance', () => {
  const headers = renderConfig(fixtureCatalog())
    .split('\n')
    .filter((l) => l.startsWith('[profile ') || l.startsWith('# ──'));
  assert.deepEqual(headers, [
    '[profile sandbox]',
    '[profile from-static]',
    '# ── ACME ──',
    '[profile acme-prod-admin]',
    '[profile acme-dev-admin]',
    '[profile ops-read]',
    '# ── PARTNER ──',
    '[profile partner-read]',
  ]);
});

test('drift: clean as generated, edited after a change, unmanaged without the header', () => {
  const text = renderConfig(fixtureCatalog());
  assert.deepEqual(inspectGenerated(text), { state: 'clean' });
  assert.deepEqual(inspectGenerated(`${text}\n[profile added-by-hand]\nregion = eu-west-1\n`), { state: 'edited' });
  assert.deepEqual(inspectGenerated(text.replace('region = eu-west-3', 'region = eu-west-2')), { state: 'edited' });
  assert.deepEqual(inspectGenerated(readFileSync(join(fixtures, 'config'), 'utf8')), { state: 'unmanaged' });
});

const invalid: Array<[string, (doc: any) => void, RegExp]> = [
  ['duplicate name', (d) => d.profiles.push({ name: 'sandbox' }), /"sandbox": defined 2 times/],
  ['name charset', (d) => (d.profiles[0].name = 'has space'), /name must match/],
  ['name reused as a former name', (d) => (d.profiles[0].name = 'acme-prod-AdministratorAccess'), /former_names of "acme-prod-admin"/],
  ['account id length', (d) => (d.profiles[0].account_id = '1234'), /account_id must be 12 digits/],
  ['account without role', (d) => delete d.profiles[0].role, /account_id and role go together/],
  ['unknown session', (d) => (d.profiles[0].session = 'nope'), /unknown session "nope"/],
  ['unknown default session', (d) => (d.defaults.sso_session = 'nope'), /defaults.sso_session: unknown session/],
  ['session on a non-SSO profile', (d) => (d.profiles[4].session = 'corp'), /session without account_id/],
  ['unknown source_profile', (d) => (d.profiles[5].extra.source_profile = 'ghost'), /source_profile "ghost"/],
  ['reserved key in extra', (d) => (d.profiles[0].extra = { region: 'eu-west-1' }), /"region" goes in its own field/],
  ['SSO key in extra next to account_id', (d) => (d.profiles[0].extra = { sso_role_name: 'X' }), /"sso_role_name" goes in its own field/],
  ['secret in extra', (d) => (d.profiles[0].extra = { aws_secret_access_key: 'x' }), /credential material/],
  ['secret in a sub-map', (d) => (d.profiles[0].extra = { s3: { aws_session_token: 'x' } }), /credential material/],
  ['secret in defaults', (d) => (d.defaults.aws_access_key_id = 'x'), /credential material/],
  ['secret in a section', (d) => (d.sections['services local-dev'].aws_access_key_id = 'x'), /credential material/],
  ['section that is a profile', (d) => (d.sections['profile x'] = {}), /belongs in profiles/],
  ['newline injection', (d) => (d.profiles[0].region = 'eu-west-1\n[profile evil]'), /region contains a line break/],
  ['newline in extra', (d) => (d.profiles[0].extra = { output: 'json\n[x]' }), /contains a line break/],
  ['inline comment in a value', (d) => (d.profiles[0].region = 'eu-west-1 # note'), /read as a comment/],
  ['nested map in defaults', (d) => (d.defaults.s3 = { a: 'b' }), /defaults.s3: must be a string$/],
  ['future version', (d) => (d.version = 2), /version 2 is not supported/],
];

for (const [label, mutate, expected] of invalid) {
  test(`rejects: ${label}`, () => {
    const errors = errorsAfter(mutate);
    assert.ok(errors.some((e) => expected.test(e)), `${expected} not in ${JSON.stringify(errors)}`);
  });
}

test('reports every problem in one pass, not just the first', () => {
  const errors = errorsAfter((d) => {
    d.profiles[0].account_id = '1';
    d.profiles[2].name = 'bad name'; // partner-read: nothing refers to it
    d.defaults.aws_access_key_id = 'x';
  });
  assert.equal(errors.length, 3, JSON.stringify(errors));
});

test('legacy inline SSO keys are allowed in extra when the profile has no account_id', () => {
  const errors = errorsAfter((d) =>
    d.profiles.push({
      name: 'legacy',
      extra: { sso_start_url: 'https://legacy.awsapps.com/start', sso_region: 'us-east-1', sso_account_id: '666666666666', sso_role_name: 'ReadOnly' },
    }),
  );
  assert.deepEqual(errors, []);
});

test('a source_profile outside the catalog needs to be declared external', () => {
  const errors = validateCatalog(rawFixture()).errors;
  assert.deepEqual(errors, ['profile "from-static": source_profile "ci-keys" is not a known profile']);
});

test('render refuses a value that slipped past validation', () => {
  const catalog = fixtureCatalog();
  (catalog.profiles[0] as { region?: string }).region = 'x\n[profile evil]';
  assert.throws(() => renderConfig(catalog), /line break/);
});

test('pendingNew lists the profiles discover added and nobody renamed yet', () => {
  const catalog = fixtureCatalog();
  assert.deepEqual(pendingNew(catalog), []);
  catalog.profiles.push({ name: 'acme-new-admin', account_id: '777777777777', role: 'AdministratorAccess', new: true });
  assert.deepEqual(pendingNew(catalog), ['acme-new-admin']);
});

test('save writes version 1 with mode 0600 and keeps unknown keys; load accepts a file without version', () => {
  const dir = tmp();
  const path = join(dir, 'profiles.json');
  const doc = rawFixture();
  (doc.profiles as any[])[0].note = 'kept';
  doc.owner = 'kept too';
  writeFileSync(path, JSON.stringify(doc));

  const catalog = loadCatalog(path, { externalProfiles: external });
  saveCatalog(path, catalog);

  assert.equal(statSync(path).mode & 0o777, 0o600);
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(saved.version, 1);
  assert.equal(Object.keys(saved)[0], 'version');
  assert.equal(saved.owner, 'kept too');
  assert.equal(saved.profiles[0].note, 'kept');
});

test('load fails with every problem listed, and with a hint when the file is missing', () => {
  const dir = tmp();
  assert.throws(() => loadCatalog(join(dir, 'missing.json')), /awsx profiles import/);

  const path = join(dir, 'bad.json');
  writeFileSync(path, JSON.stringify({ profiles: [{ name: 'a b' }, { name: 'c', account_id: '1', role: 'R' }] }));
  assert.throws(
    () => loadCatalog(path),
    (err: unknown) =>
      err instanceof CatalogError &&
      err.errors.some((e) => /"a b": name must match/.test(e)) &&
      err.errors.some((e) => /"c": account_id must be 12 digits/.test(e)) &&
      err.errors.some((e) => /"c": no session/.test(e)),
  );

  writeFileSync(path, '{ not json');
  assert.throws(() => loadCatalog(path), /not valid JSON/);
});

// The oracle: the AWS CLI must read the generated file the way the catalog means it.
test('the AWS CLI reads the generated config as the catalog describes', async (t) => {
  try {
    await execFileAsync('aws', ['--version']);
  } catch {
    return t.skip('AWS CLI not installed');
  }

  const dir = tmp();
  writeFileSync(join(dir, 'config'), renderConfig(fixtureCatalog()));
  writeFileSync(join(dir, 'credentials'), '[ci-keys]\naws_access_key_id = AKIAFAKE\naws_secret_access_key = fake\n');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AWS_CONFIG_FILE: join(dir, 'config'),
    AWS_SHARED_CREDENTIALS_FILE: join(dir, 'credentials'),
  };
  for (const key of ['AWS_PROFILE', 'AWS_REGION', 'AWS_DEFAULT_PROFILE', 'AWS_DEFAULT_REGION']) delete env[key];
  const get = async (key: string, profile: string) =>
    (await execFileAsync('aws', ['configure', 'get', key, '--profile', profile], { env })).stdout.trim();

  const { stdout } = await execFileAsync('aws', ['configure', 'list-profiles'], { env });
  const listed = stdout.split('\n').map((l) => l.trim()).filter(Boolean).sort();
  assert.deepEqual(listed, [...fixtureCatalog().profiles.map((p) => p.name), 'ci-keys'].sort());

  assert.equal(await get('sso_account_id', 'partner-read'), '222222222222');
  assert.equal(await get('sso_session', 'partner-read'), 'partner');
  assert.equal(await get('region', 'acme-prod-admin'), 'eu-west-3');
  assert.equal(await get('source_profile', 'ops-read'), 'acme-prod-admin');
  assert.equal(await get('s3.addressing_style', 'acme-dev-admin'), 'path');
});
