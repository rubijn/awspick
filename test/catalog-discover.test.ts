/**
 * `awsx profiles discover` and online `import` (ADR-0002, step 5). The AWS CLI is
 * a fake that records its argv: the SSO token must never appear there, and the
 * temp file that carries it must be gone afterwards.
 */

import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { mapLimit } from '../src/aws.ts';
import { addDiscovered } from '../src/catalog/discover.ts';
import { importCatalog } from '../src/catalog/import.ts';
import { readAccessToken } from '../src/sso.ts';
import { sandbox } from './sandbox.ts';

const TOKEN = 'fake-token-must-not-leak-0123456789';
const START_URL = 'https://d-example1.awsapps.com/start';

// ---------------------------------------------------------------- pure parts

const base = () =>
  importCatalog({
    configText: [
      '[sso-session corp]', `sso_start_url = ${START_URL}`, 'sso_region = eu-west-1',
      '[sso-session other]', 'sso_start_url = https://o.awsapps.com/start', 'sso_region = us-east-1',
      '[profile acme-prod-admin]', 'sso_session = corp', 'sso_account_id = 111111111111', 'sso_role_name = AdministratorAccess',
      '[profile acme-dev-admin]', 'sso_session = corp', 'sso_account_id = 222222222222', 'sso_role_name = AdministratorAccess',
    ].join('\n'),
    credentialsText: '',
  }).catalog;

test('addDiscovered adds only missing pairs, marked new, with unique names', () => {
  const { catalog, added } = addDiscovered(base(), 'corp', [
    { accountId: '111111111111', accountName: 'acme-prod', roles: ['AdministratorAccess', 'ReadOnlyAccess'] },
    { accountId: '333333333333', accountName: 'Acme Dev', roles: ['AdministratorAccess'] }, // name taken by 2222…
    { accountId: '444444444444', accountName: '', roles: ['Ops'] },
  ], 'eu-west-3');
  assert.deepEqual(
    added.map((p) => [p.name, p.account_id, p.role, p.region, p.new, p.session]),
    [
      ['acme-prod-read', '111111111111', 'ReadOnlyAccess', 'eu-west-3', true, undefined],
      ['acme-dev-admin-2', '333333333333', 'AdministratorAccess', 'eu-west-3', true, undefined],
      ['4444-ops', '444444444444', 'Ops', 'eu-west-3', true, undefined],
    ],
  );
  assert.equal(catalog.profiles.length, 5);
});

test('addDiscovered on a non-default session records the session, and avoids former names', () => {
  const start = base();
  (start.profiles[0] as { former_names: string[] }).former_names = ['x-admin'];
  const { added } = addDiscovered(start, 'other', [{ accountId: '111111111111', accountName: 'x', roles: ['AdministratorAccess'] }]);
  assert.deepEqual(added.map((p) => [p.name, p.session]), [['x-admin-2', 'other']]);
});

test('readAccessToken: the latest valid token for this start URL only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'awsx-cache-'));
  const now = new Date('2026-11-18T12:00:00Z');
  const put = (file: string, data: object) => writeFileSync(join(dir, file), JSON.stringify(data));
  put('a.json', { startUrl: START_URL, accessToken: 'old', expiresAt: '2026-11-18T13:00:00Z' });
  put('b.json', { startUrl: START_URL, accessToken: 'new', expiresAt: '2026-11-18T20:00:00UTC' });
  put('c.json', { startUrl: START_URL, accessToken: 'expired', expiresAt: '2026-11-18T11:00:00Z' });
  put('d.json', { startUrl: 'https://other/start', accessToken: 'other', expiresAt: '2026-11-19T00:00:00Z' });
  put('e.json', { startUrl: START_URL, clientId: 'registration, no token' });
  assert.equal(readAccessToken(START_URL, dir, now), 'new');
  assert.equal(readAccessToken('https://nobody/start', dir, now), undefined);
  assert.equal(readAccessToken(START_URL, join(dir, 'missing'), now), undefined);
});

test('mapLimit keeps order and never runs more than the limit at once', async () => {
  let running = 0;
  let peak = 0;
  const out = await mapLimit([5, 1, 4, 2, 3, 0, 6], 3, async (n) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, n * 2));
    running--;
    return n * 10;
  });
  assert.deepEqual(out, [50, 10, 40, 20, 30, 0, 60]);
  assert.equal(peak, 3);
});

// ---------------------------------------------------------------- end to end, fake AWS CLI

/** A fake `aws` that answers the two SSO calls from a fixed estate and logs every call. */
function fakeAws(): { bin: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), 'awsx-fake-aws-'));
  const log = join(dir, 'calls.jsonl');
  const bin = join(dir, 'aws');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);
const at = argv.indexOf('--cli-input-json');
const file = at === -1 ? undefined : argv[at + 1].replace(/^file:\\/\\//, '');
const input = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
const mode = file ? (fs.statSync(file).mode & 0o777).toString(8) : undefined;
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, file, mode, input }) + '\\n');
if (input.accessToken !== ${JSON.stringify(TOKEN)}) { console.error('An error occurred (UnauthorizedException)'); process.exit(255); }
const accounts = [
  { accountId: '111111111111', accountName: 'acme-prod' },
  { accountId: '333333333333', accountName: 'Acme Dev' },
  { accountId: '888888888888', accountName: 'acme-new' },
];
const roles = { '111111111111': ['AdministratorAccess', 'ReadOnlyAccess'], '333333333333': ['AdministratorAccess'], '888888888888': ['AdministratorAccess'] };
if (argv[1] === 'list-accounts') {
  // Two pages, to prove nextToken is followed.
  const page = input.nextToken ? { accountList: accounts.slice(2) } : { accountList: accounts.slice(0, 2), nextToken: 'p2' };
  console.log(JSON.stringify(page));
} else if (argv[1] === 'list-account-roles') {
  console.log(JSON.stringify({ roleList: (roles[input.accountId] || []).map((roleName) => ({ roleName })) }));
} else { process.exit(2); }
`,
  );
  chmodSync(bin, 0o755);
  return { bin, log };
}

const calls = (log: string) =>
  existsSync(log)
    ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { argv: string[]; file: string; mode: string; input: Record<string, string> })
    : [];

function withToken(home: string, token = TOKEN, expiresAt = '2099-01-01T00:00:00Z') {
  const cache = join(home, '.aws', 'sso', 'cache');
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, 'token.json'), JSON.stringify({ startUrl: START_URL, accessToken: token, expiresAt }));
}

test('e2e: discover adds the missing pairs; the token never reaches argv and its file is removed', async () => {
  const aws = fakeAws();
  const s = sandbox({ AWSX_AWS_BIN: aws.bin });
  assert.equal((await s.run('import', '--offline')).code, 0);
  withToken(s.home);

  const dry = await s.run('discover', '--dry-run');
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stderr, /3 accounts, 4 account\/role pairs reachable/);
  assert.match(dry.stderr, /dry run: catalog unchanged/);
  assert.doesNotMatch(read(s.catalog), /"new": true/);

  const run = await s.run('discover', '--region', 'eu-west-3');
  assert.equal(run.code, 0, run.stderr);
  const added = JSON.parse(read(s.catalog)).profiles.filter((p: { new?: boolean }) => p.new);
  assert.deepEqual(
    added.map((p: { name: string; role: string; region: string }) => [p.name, p.role, p.region]).sort(),
    [
      // 3333… / AdministratorAccess is already in the catalog (as 3333-admin): skipped.
      ['acme-new-admin', 'AdministratorAccess', 'eu-west-3'],
      ['acme-prod-read', 'ReadOnlyAccess', 'eu-west-3'],
    ],
  );

  const all = calls(aws.log);
  assert.ok(all.length >= 2 + 3 * 2, 'paged list-accounts, then roles per account, twice');
  assert.ok(all.some((c) => c.input.nextToken === 'p2'), 'follows nextToken');
  for (const c of all) {
    assert.ok(!c.argv.join(' ').includes(TOKEN), 'token must not be in argv');
    assert.equal(c.mode, '600');
    assert.equal(existsSync(c.file), false, 'temp input file must be removed');
  }

  const apply = await s.run('apply', '--dry-run');
  assert.equal(apply.code, 1);
  assert.match(apply.stderr, /still marked "new"/);
});

test('e2e: discover without a valid token says how to log in, and calls nothing', async () => {
  const aws = fakeAws();
  const s = sandbox({ AWSX_AWS_BIN: aws.bin });
  await s.run('import', '--offline');
  withToken(s.home, TOKEN, '2020-01-01T00:00:00Z');
  const run = await s.run('discover');
  assert.equal(run.code, 1);
  assert.match(run.stderr, /no valid SSO token for "corp": run `aws sso login --sso-session corp`/);
  assert.deepEqual(calls(aws.log), []);
});

test('e2e: discover on an unknown session fails clearly', async () => {
  const s = sandbox();
  await s.run('import', '--offline');
  const run = await s.run('discover', '--session', 'nope');
  assert.equal(run.code, 1);
  assert.match(run.stderr, /unknown SSO session "nope"/);
});

test('e2e: online import names accounts from SSO; offline and without a token it falls back', async () => {
  const aws = fakeAws();
  const online = sandbox({ AWSX_AWS_BIN: aws.bin });
  withToken(online.home);
  assert.equal((await online.run('import')).code, 0);
  const names = JSON.parse(read(online.catalog)).profiles.map((p: { name: string }) => p.name);
  assert.ok(names.includes('acme-dev-admin'), `SSO name "Acme Dev" used: ${names}`);

  const offline = sandbox({ AWSX_AWS_BIN: aws.bin });
  withToken(offline.home);
  const before = calls(aws.log).length;
  assert.equal((await offline.run('import', '--offline')).code, 0);
  assert.equal(calls(aws.log).length, before, '--offline calls nothing');
  assert.ok(JSON.parse(read(offline.catalog)).profiles.some((p: { name: string }) => p.name === '3333-admin'));

  const noToken = sandbox({ AWSX_AWS_BIN: aws.bin });
  const run = await noToken.run('import');
  assert.equal(run.code, 0);
  assert.match(run.stderr, /no valid SSO token for "corp"/);
});

const read = (path: string) => readFileSync(path, 'utf8');
