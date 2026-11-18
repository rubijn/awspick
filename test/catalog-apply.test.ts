/**
 * `awsx profiles apply` (ADR-0002, step 4): the plan, drift, renames, backups,
 * and end-to-end runs of the real binary on copies of the fixtures, in a
 * throwaway HOME. ~/.aws/credentials must come out byte-identical every time.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  aliasHints,
  backupConfig,
  BACKUPS_KEPT,
  driftReason,
  planApply,
  recordFormerNames,
  renameInState,
} from '../src/catalog/apply.ts';
import { importCatalog } from '../src/catalog/import.ts';
import { renderConfig } from '../src/catalog/render.ts';
import { type Catalog } from '../src/catalog/schema.ts';
import { defaultConfig } from '../src/store.ts';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, '..', 'src', 'index.ts');
const fixtures = join(here, 'fixtures');
const read = (path: string) => readFileSync(path, 'utf8');

const SESSION = '[sso-session corp]\nsso_start_url = https://x.awsapps.com/start\nsso_region = eu-west-1\n';
const sso = (account: string, role = 'AdministratorAccess') =>
  `sso_session = corp\nsso_account_id = ${account}\nsso_role_name = ${role}\n`;

function catalogOf(configText: string, credentialsText = ''): Catalog {
  return importCatalog({ configText, credentialsText }).catalog;
}

// ---------------------------------------------------------------- the plan

test('plan: a clean generated file and an unchanged catalog have nothing to do', () => {
  const catalog = catalogOf(`${SESSION}[profile a]\n${sso('111111111111')}`);
  const plan = planApply({ catalog, configText: renderConfig(catalog), credentialsText: '' });
  assert.equal(plan.generated.state, 'clean');
  assert.deepEqual([plan.added, plan.removed, plan.changed, plan.renames, plan.otherSections], [[], [], [], [], []]);
  assert.equal(driftReason(plan), undefined);
});

test('plan: added, removed and changed keys, never values', () => {
  const catalog = catalogOf(`${SESSION}[profile a]\n${sso('111111111111')}region = eu-west-1\n[profile b]\nregion = eu-west-1\n`);
  const configText = renderConfig(catalog);
  catalog.profiles = catalog.profiles.filter((p) => p.name !== 'b');
  (catalog.profiles[0] as { region: string }).region = 'eu-west-3';
  catalog.profiles.push({ name: 'c', region: 'us-east-1' });
  const plan = planApply({ catalog, configText, credentialsText: '' });
  assert.deepEqual(plan.added, ['c']);
  assert.deepEqual(plan.removed, ['b']);
  assert.deepEqual(plan.changed, [{ name: 'a', keys: ['region'] }]);
  assert.doesNotMatch(JSON.stringify(plan.changed), /eu-west-3/);
});

test('plan: same role under a new name is a rename, not a remove and an add', () => {
  const catalog = catalogOf(`${SESSION}[profile old-name]\n${sso('111111111111')}`);
  const configText = renderConfig(catalog);
  (catalog.profiles[0] as { name: string }).name = 'new-name';
  const plan = planApply({ catalog, configText, credentialsText: '' });
  assert.deepEqual(plan.renames, [{ from: 'old-name', to: 'new-name' }]);
  assert.deepEqual([plan.added, plan.removed, plan.outside], [[], [], []]);
});

test('plan: an edited file is drift; a hand-written one only when it has unknown profiles', () => {
  const catalog = catalogOf(`${SESSION}[profile a]\n${sso('111111111111')}`);
  const edited = `${renderConfig(catalog)}[profile by-hand]\nregion = eu-west-1\n`;
  const plan = planApply({ catalog, configText: edited, credentialsText: '' });
  assert.equal(plan.generated.state, 'edited');
  assert.match(driftReason(plan) ?? '', /edited since the last apply/);
  assert.deepEqual(plan.outside, ['by-hand']);

  const handWritten = `${SESSION}[profile a]\n${sso('111111111111')}cli_pager =\n`;
  const first = planApply({ catalog, configText: handWritten, credentialsText: '' });
  assert.equal(first.generated.state, 'unmanaged');
  assert.equal(driftReason(first), undefined);

  const withUnknown = planApply({ catalog, configText: `${handWritten}[profile stray]\nregion = x\n`, credentialsText: '' });
  assert.match(driftReason(withUnknown) ?? '', /not in the catalog: stray/);
});

test('plan: a removed profile named in former_names is not "outside"', () => {
  const catalog = catalogOf(`${SESSION}[profile a]\n${sso('111111111111')}[profile gone]\nregion = x\n`);
  const configText = renderConfig(catalog);
  catalog.profiles = catalog.profiles.filter((p) => p.name !== 'gone');
  (catalog.profiles[0] as { former_names: string[] }).former_names = ['gone'];
  assert.deepEqual(planApply({ catalog, configText: `# hand\n${configText}`, credentialsText: '' }).outside, []);
});

test('plan: non-static credentials sections that shadow the catalog, with their line', () => {
  const catalog = catalogOf(`${SESSION}[profile a]\n${sso('111111111111')}[profile b]\nregion = x\n`);
  const credentialsText = '# top\n[keys]\naws_access_key_id = A\naws_secret_access_key = B\n\n[a]\nregion = eu-west-3\n[b]\naws_access_key_id = A\n';
  const plan = planApply({ catalog, configText: renderConfig(catalog), credentialsText });
  assert.deepEqual(plan.shadowed, [{ name: 'a', line: 6 }]);
});

// ---------------------------------------------------------------- state and hints

test('renames carry lastProfile, previousProfile, recents and perProfile', () => {
  const config = defaultConfig();
  Object.assign(config, { lastProfile: 'old', previousProfile: 'other', recents: ['old', 'other'] });
  config.perProfile.old = { lastRegion: 'eu-west-3', uses: 7 };
  assert.equal(renameInState(config, [{ from: 'old', to: 'new' }]), true);
  assert.equal(config.lastProfile, 'new');
  assert.equal(config.previousProfile, 'other');
  assert.deepEqual(config.recents, ['new', 'other']);
  assert.deepEqual(config.perProfile, { new: { lastRegion: 'eu-west-3', uses: 7 } });
  assert.equal(renameInState(config, [{ from: 'absent', to: 'x' }]), false);
});

test('a rename is recorded in former_names, once', () => {
  const catalog = catalogOf(`${SESSION}[profile new]\n${sso('111111111111')}`);
  const once = recordFormerNames(catalog, [{ from: 'old', to: 'new' }]);
  assert.deepEqual(once.profiles[0]?.former_names, ['old']);
  assert.deepEqual(recordFormerNames(once, [{ from: 'old', to: 'new' }]).profiles[0]?.former_names, ['old']);
});

test('alias hints match the whole name only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'awsx-rc-'));
  const rc = join(dir, '.zshrc');
  writeFileSync(rc, ["alias a='aws --profile acme-prod s3 ls'", 'export AWS_PROFILE=acme-prod-2', 'x=acme-prod'].join('\n'));
  assert.deepEqual(aliasHints([{ from: 'acme-prod', to: 'p' }], [rc, join(dir, 'missing')]), [
    { file: rc, line: 1, name: 'acme-prod' },
    { file: rc, line: 3, name: 'acme-prod' },
  ]);
});

test('backups: 0700 dir, rotation keeps the newest, never touches foreign backups', () => {
  const dir = mkdtempSync(join(tmpdir(), 'awsx-bk-'));
  const config = join(dir, 'config');
  writeFileSync(config, 'x');
  mkdirSync(join(dir, 'backup', '20261118-085214'), { recursive: true }); // the retired script's
  for (let i = 0; i < BACKUPS_KEPT + 3; i++) {
    backupConfig(config, new Date(Date.UTC(2026, 0, 1, 0, 0, i)));
  }
  const left = readdirSync(join(dir, 'backup')).sort();
  assert.equal(left.length, BACKUPS_KEPT + 1);
  assert.ok(left.includes('20261118-085214'));
  assert.ok(!left.includes('20260101T000000Z'));
  assert.equal(statSync(join(dir, 'backup', '20260101T000022Z')).mode & 0o777, 0o700);
  assert.equal(backupConfig(join(dir, 'nope')), undefined);
});

// ---------------------------------------------------------------- end to end

type Run = { stdout: string; stderr: string; code: number };

/** A throwaway HOME with copies of the messy import fixtures as ~/.aws. */
function sandbox() {
  const home = mkdtempSync(join(tmpdir(), 'awsx-home-'));
  const aws = join(home, '.aws');
  mkdirSync(aws, { mode: 0o700 });
  copyFileSync(join(fixtures, 'import', 'config'), join(aws, 'config'));
  copyFileSync(join(fixtures, 'import', 'credentials'), join(aws, 'credentials'));
  const paths = {
    home,
    config: join(aws, 'config'),
    credentials: join(aws, 'credentials'),
    catalog: join(aws, 'profiles.json'),
    awsx: join(home, '.config', 'awsx', 'config.json'),
  };
  const run = async (...args: string[]): Promise<Run> => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of ['AWS_PROFILE', 'AWS_REGION', 'AWS_DEFAULT_PROFILE', 'AWS_DEFAULT_REGION', 'AWSX_PROFILES_FILE', 'XDG_CONFIG_HOME']) {
      delete env[key];
    }
    Object.assign(env, {
      HOME: home,
      AWS_CONFIG_FILE: paths.config,
      AWS_SHARED_CREDENTIALS_FILE: paths.credentials,
      AWSX_CONFIG_FILE: paths.awsx,
      NO_COLOR: '1',
    });
    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, [entry, 'profiles', ...args], { env });
      return { stdout, stderr, code: 0 };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; code?: number };
      return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: typeof e.code === 'number' ? e.code : 1 };
    }
  };
  return { ...paths, run };
}

test('e2e: import, dry run, refuse without --yes, apply, then up to date; credentials untouched', async () => {
  const s = sandbox();
  const credentialsBefore = read(s.credentials);
  const configBefore = read(s.config);

  const imported = await s.run('import');
  assert.equal(imported.code, 0, imported.stderr);
  assert.equal(imported.stdout, '');
  assert.equal(statSync(s.catalog).mode & 0o777, 0o600);
  assert.equal((await s.run('import')).code, 1, 'refuses to overwrite');

  const dry = await s.run('apply', '--dry-run');
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stderr, /acme-prod-AdministratorAccess → acme-prod-admin/);
  assert.match(dry.stderr, /dry run: nothing written/);
  assert.equal(read(s.config), configBefore);

  const noTty = await s.run('apply');
  assert.equal(noTty.code, 1);
  assert.match(noTty.stderr, /pass --yes/);
  assert.equal(read(s.config), configBefore);

  const applied = await s.run('apply', '--yes');
  assert.equal(applied.code, 0, applied.stderr);
  assert.equal(applied.stdout, '');
  assert.match(read(s.config), /^# Generated by `awsx profiles apply`/);
  assert.equal(statSync(s.config).mode & 0o777, 0o600);
  assert.match(applied.stderr, /credentials:\d+ {2}\[split\]/);
  const backups = readdirSync(join(s.home, '.aws', 'backup'));
  assert.equal(backups.length, 1);
  assert.equal(read(join(s.home, '.aws', 'backup', backups[0] as string, 'config')), configBefore);

  const again = await s.run('apply', '--yes');
  assert.equal(again.code, 0);
  assert.match(again.stderr, /up to date/);

  assert.equal(read(s.credentials), credentialsBefore, 'credentials must never be written');
});

test('e2e: a profile added by hand stops apply; --adopt brings it into the catalog', async () => {
  const s = sandbox();
  await s.run('import');
  await s.run('apply', '--yes');
  writeFileSync(s.config, `${read(s.config)}\n[profile by-hand]\nregion = eu-west-2\n`);

  const refused = await s.run('apply', '--yes');
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /edited since the last apply/);
  assert.match(refused.stderr, /- by-hand/);

  const adopted = await s.run('apply', '--yes', '--adopt');
  assert.equal(adopted.code, 0, adopted.stderr);
  assert.ok(JSON.parse(read(s.catalog)).profiles.some((p: { name: string }) => p.name === 'by-hand'));
  assert.match(read(s.config), /\[profile by-hand\]\nregion = eu-west-2/);
  assert.match((await s.run('apply', '--yes')).stderr, /up to date/);
});

test('e2e: --force drops a hand-added profile, which stays in the backup', async () => {
  const s = sandbox();
  await s.run('import');
  await s.run('apply', '--yes');
  writeFileSync(s.config, `${read(s.config)}\n[profile by-hand]\nregion = eu-west-2\n`);
  const forced = await s.run('apply', '--yes', '--force');
  assert.equal(forced.code, 0, forced.stderr);
  assert.doesNotMatch(read(s.config), /by-hand/);
  const backups = readdirSync(join(s.home, '.aws', 'backup')).sort();
  assert.match(read(join(s.home, '.aws', 'backup', backups.at(-1) as string, 'config')), /by-hand/);
});

test('e2e: a rename moves picker state, records the old name, and points at aliases', async () => {
  const s = sandbox();
  await s.run('import');
  await s.run('apply', '--yes');

  mkdirSync(dirname(s.awsx), { recursive: true });
  writeFileSync(
    s.awsx,
    JSON.stringify({
      version: 1,
      lastProfile: 'acme-prod-admin',
      recents: ['acme-prod-admin', 'split'],
      perProfile: { 'acme-prod-admin': { lastRegion: 'eu-west-3', uses: 3 } },
      settings: { prodProfiles: ['acme-prod-admin'] },
    }),
  );
  writeFileSync(join(s.home, '.zshrc'), "alias acme='awsx --profile acme-prod-admin'\n");
  const catalog = JSON.parse(read(s.catalog));
  catalog.profiles.find((p: { name: string }) => p.name === 'acme-prod-admin').name = 'acme-prod';
  writeFileSync(s.catalog, JSON.stringify(catalog));

  const applied = await s.run('apply', '--yes');
  assert.equal(applied.code, 0, applied.stderr);
  assert.match(applied.stderr, /acme-prod-admin → acme-prod/);
  assert.match(applied.stderr, /prodProfiles .* still names: acme-prod-admin/);
  assert.match(applied.stderr, /\.zshrc:1 {2}acme-prod-admin/);

  const state = JSON.parse(read(s.awsx));
  assert.equal(state.lastProfile, 'acme-prod');
  assert.deepEqual(state.recents, ['acme-prod', 'split']);
  assert.deepEqual(Object.keys(state.perProfile), ['acme-prod']);
  const saved = JSON.parse(read(s.catalog)).profiles.find((p: { name: string }) => p.name === 'acme-prod');
  assert.ok(saved.former_names.includes('acme-prod-admin'));
  assert.equal(read(join(s.home, '.zshrc')), "alias acme='awsx --profile acme-prod-admin'\n", 'rc files are never edited');
});

test('e2e: entries still marked new block apply', async () => {
  const s = sandbox();
  await s.run('import');
  const catalog = JSON.parse(read(s.catalog));
  catalog.profiles.push({ name: 'acme-new-admin', account_id: '777777777777', role: 'AdministratorAccess', new: true });
  writeFileSync(s.catalog, JSON.stringify(catalog));
  const run = await s.run('apply', '--dry-run');
  assert.equal(run.code, 1);
  assert.match(run.stderr, /still marked "new": acme-new-admin/);
});

test('e2e: an invalid catalog lists every problem and writes nothing', async () => {
  const s = sandbox();
  writeFileSync(s.catalog, JSON.stringify({ profiles: [{ name: 'a b' }, { name: 'c', account_id: '1', role: 'R' }] }));
  const before = read(s.config);
  const run = await s.run('apply', '--yes');
  assert.equal(run.code, 1);
  assert.match(run.stderr, /"a b": name must match/);
  assert.match(run.stderr, /"c": account_id must be 12 digits/);
  assert.equal(read(s.config), before);
});

test('e2e: usage without a subcommand, error on an unknown one', async () => {
  const s = sandbox();
  assert.equal((await s.run()).code, 1);
  const unknown = await s.run('frobnicate');
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /unknown subcommand "frobnicate"/);
  assert.ok(!existsSync(s.catalog));
});
