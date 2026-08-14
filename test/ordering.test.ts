import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scoreFields, scoreOne } from '../src/fuzzy.ts';
import { orderProfiles } from '../src/picker.ts';
import type { Profile } from '../src/profiles.ts';

const profile = (name: string, extra: Partial<Profile> = {}): Profile => ({
  name,
  sources: ['config'],
  kind: 'sso',
  regionInherited: false,
  isProd: false,
  ...extra,
});

const profiles = [
  profile('acme-dev-AdministratorAccess', { accountId: '222222222222', roleName: 'AdministratorAccess' }),
  profile('acme-preprod-AdministratorAccess', { accountId: '333333333333' }),
  profile('acme-prod-AdministratorAccess', { accountId: '444444444444', roleName: 'AdministratorAccess' }),
  profile('sbx'),
  profile('sbx-presign'),
  profile('noc-dev-ops', { roleName: 'ObservabilityEngineers' }),
];

const names = (list: Profile[]) => list.map((p) => p.name);

test('empty query puts the last selected profile first', () => {
  const ordered = orderProfiles('', {
    profiles,
    recents: ['sbx', 'noc-dev-ops'],
    lastProfile: 'noc-dev-ops',
  });
  assert.equal(ordered[0]?.name, 'noc-dev-ops');
  assert.equal(ordered[1]?.name, 'sbx'); // then the rest of recents, newest first
});

test('empty query with no history is alphabetical', () => {
  assert.deepEqual(names(orderProfiles('', { profiles, recents: [] })), names([...profiles]).sort());
});

test('every profile is still reachable with an empty query', () => {
  const ordered = orderProfiles('', { profiles, recents: ['sbx'], lastProfile: 'sbx' });
  assert.equal(ordered.length, profiles.length);
});

test('a query ranks by relevance, not by recency', () => {
  const ordered = orderProfiles('prod', {
    profiles,
    // dev is the most recent, but it does not match "prod" at all
    recents: ['acme-dev-AdministratorAccess', 'acme-preprod-AdministratorAccess'],
    lastProfile: 'acme-dev-AdministratorAccess',
  });
  assert.equal(ordered[0]?.name, 'acme-prod-AdministratorAccess');
  assert.ok(!names(ordered).includes('acme-dev-AdministratorAccess'));
});

test('recency only breaks ties between equally relevant matches', () => {
  // Same shape, so `admin` scores identically on both and recency decides.
  const tied = [profile('x-admin'), profile('y-admin')];
  const ordered = orderProfiles('admin', { profiles: tied, recents: ['y-admin'], lastProfile: 'y-admin' });
  assert.equal(ordered[0]?.name, 'y-admin');
});

test('exact name beats a longer prefix match', () => {
  const ordered = orderProfiles('sbx', { profiles, recents: [] });
  assert.equal(ordered[0]?.name, 'sbx');
});

test('search matches account id and role name, not just the profile name', () => {
  assert.equal(orderProfiles('444444', { profiles, recents: [] })[0]?.name, 'acme-prod-AdministratorAccess');
  assert.equal(orderProfiles('observ', { profiles, recents: [] })[0]?.name, 'noc-dev-ops');
});

test('multi-term queries require every term to match', () => {
  const ordered = orderProfiles('acme prod', { profiles, recents: [] });
  assert.deepEqual(names(ordered), ['acme-prod-AdministratorAccess', 'acme-preprod-AdministratorAccess']);
  assert.deepEqual(orderProfiles('acme nope', { profiles, recents: [] }), []);
});

test('scoring prefers word-boundary and prefix hits', () => {
  const boundary = scoreOne('prod', 'acme-prod-Administrator');
  const middle = scoreOne('prod', 'acme-preprod-Administrator');
  assert.ok(boundary !== null && middle !== null && boundary > middle);
  assert.equal(scoreOne('zzz', 'abc'), null);
  assert.equal(scoreFields('x', [undefined]), null);
  assert.equal(scoreFields('', ['anything']), 0);
});
