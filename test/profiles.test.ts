import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { before, test } from 'node:test';
import { loadAwsFiles, parseRoleArn, resolveProfiles, type Profile } from '../src/profiles.ts';
import { DEFAULT_SETTINGS } from '../src/store.ts';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

let profiles: Profile[];
const byName = () => new Map(profiles.map((p) => [p.name, p]));

before(() => {
  process.env.AWS_CONFIG_FILE = join(fixtures, 'config');
  process.env.AWS_SHARED_CREDENTIALS_FILE = join(fixtures, 'credentials');
  profiles = resolveProfiles(loadAwsFiles(), DEFAULT_SETTINGS);
});

test('finds every profile from both files, and no sso-session or services blocks', () => {
  assert.deepEqual(
    profiles.map((p) => p.name).sort(),
    [
      'chained',
      'cyclic-a',
      'cyclic-b',
      'default',
      'dev-observability',
      'inherits-region',
      'legacy-sso',
      'nested-settings',
      'no-region-sso',
      'prod-admin',
      'static-keys',
    ],
  );
});

test('merges [profile default] from config with [default] from credentials', () => {
  const profile = byName().get('default');
  assert.equal(profile?.region, 'eu-west-1');
  assert.deepEqual(profile?.sources.sort(), ['config', 'credentials']);
});

test('resolves an sso-session into start url and region', () => {
  const profile = byName().get('prod-admin');
  assert.equal(profile?.kind, 'sso');
  assert.equal(profile?.ssoSession, 'Corp_SSO');
  assert.equal(profile?.ssoStartUrl, 'https://d-example1.awsapps.com/start');
  assert.equal(profile?.accountId, '111111111111');
  assert.equal(profile?.roleName, 'AdministratorAccess');
  assert.equal(profile?.region, 'eu-west-3');
  assert.equal(profile?.regionInherited, false);
});

test('supports the legacy inline sso_start_url form', () => {
  const profile = byName().get('legacy-sso');
  assert.equal(profile?.kind, 'sso');
  assert.equal(profile?.ssoStartUrl, 'https://legacy.awsapps.com/start');
  assert.equal(profile?.region, 'us-east-1');
});

test('falls back to the session sso_region when the profile has none', () => {
  const profile = byName().get('no-region-sso');
  assert.equal(profile?.region, 'us-east-1');
  assert.equal(profile?.regionInherited, true);
});

test('derives account and role from role_arn, including a role path', () => {
  assert.deepEqual(parseRoleArn('arn:aws:iam::444444444444:role/team/DeployRole'), {
    accountId: '444444444444',
    roleName: 'DeployRole',
  });
  assert.deepEqual(parseRoleArn('not-an-arn'), {});
  const profile = byName().get('inherits-region');
  assert.equal(profile?.kind, 'chained');
  assert.equal(profile?.accountId, '444444444444');
  assert.equal(profile?.roleName, 'DeployRole');
});

test('inherits the region through source_profile and marks it inherited', () => {
  const profile = byName().get('inherits-region');
  assert.equal(profile?.region, 'eu-west-3'); // from prod-admin
  assert.equal(profile?.regionInherited, true);
});

test('a source_profile cycle terminates instead of hanging', () => {
  const profile = byName().get('cyclic-a');
  assert.equal(profile?.region, undefined);
  assert.equal(profile?.kind, 'chained');
});

test('classifies static keys and credential chains', () => {
  assert.equal(byName().get('static-keys')?.kind, 'static');
  assert.equal(byName().get('static-keys')?.region, 'us-west-2');
  assert.equal(byName().get('chained')?.kind, 'chained');
  assert.equal(byName().get('chained')?.accountId, '666666666666');
});

test('nested sub-keys do not leak into the profile model', () => {
  const profile = byName().get('nested-settings');
  assert.equal(profile?.region, 'us-east-1');
  assert.equal(profile?.kind, 'unknown');
});

test('prod detection follows settings, not hardcoded names', () => {
  const strict = resolveProfiles(loadAwsFiles(), { ...DEFAULT_SETTINGS, prodPatterns: [] });
  assert.equal(strict.find((p) => p.name === 'prod-admin')?.isProd, false);

  const listed = resolveProfiles(loadAwsFiles(), {
    ...DEFAULT_SETTINGS,
    prodPatterns: [],
    prodProfiles: ['static-keys'],
  });
  assert.equal(listed.find((p) => p.name === 'static-keys')?.isProd, true);
  assert.equal(byName().get('prod-admin')?.isProd, true);
  assert.equal(byName().get('dev-observability')?.isProd, false);
});
