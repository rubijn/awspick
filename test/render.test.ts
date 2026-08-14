import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describe, layout, renderRow } from '../src/render.ts';
import type { Profile } from '../src/profiles.ts';

const profile = (extra: Partial<Profile> = {}): Profile => ({
  name: 'acme-observability-prod-AdministratorAccess',
  sources: ['config'],
  kind: 'sso',
  regionInherited: false,
  isProd: true,
  accountId: '222222222222',
  roleName: 'AdministratorAccess',
  region: 'eu-west-1',
  ssoSession: 'Corp_SSO',
  ssoStartUrl: 'https://example.invalid/start',
  ...extra,
});

const ctx = (columns: number) => ({ tokens: new Map(), now: new Date('2026-08-14T12:00:00Z'), columns });

/**
 * Colour depends on whether stderr is a TTY, so it is on in a terminal and off
 * in CI or a pipe. Assert on visible text only, or these tests pass in one
 * environment and fail in the other.
 */
const visible = (text: string): string => text.replaceAll(/\u001B\[[0-9;]*m/g, '');

test('the name column gets priority over the role column', () => {
  const narrow = layout(80);
  assert.equal(narrow.role, 0, 'role is dropped before the name is squeezed');
  assert.ok(narrow.name >= 40, `name should stay readable at 80 cols, got ${narrow.name}`);

  const wide = layout(140);
  assert.ok(wide.role > 0, 'role reappears when there is room');
  assert.ok(wide.name >= 60, `name should be generous at 140 cols, got ${wide.name}`);
});

test('layout never goes negative or absurd on tiny or huge terminals', () => {
  for (const columns of [20, 40, 60, 80, 100, 200, 400]) {
    const cols = layout(columns);
    assert.ok(cols.name >= 16, `${columns}: name ${cols.name}`);
    assert.ok(cols.role >= 0 && cols.account === 12 && cols.region === 11);
  }
});

test('a row fits the terminal width it was given, coloured or not', () => {
  for (const columns of [80, 100, 140]) {
    const width = visible(renderRow(profile(), ctx(columns))).length;
    assert.ok(width <= columns, `${columns} cols: row was ${width} wide`);
  }
});

test('colour does not change the visible width of a row', () => {
  // A prod profile is bold+red, a non-prod one is plain: same width either way.
  const plain = visible(renderRow(profile({ isProd: false }), ctx(140))).length;
  const coloured = visible(renderRow(profile({ isProd: true }), ctx(140))).length;
  assert.equal(plain, coloured);
});

test('a row carries account, region and freshness', () => {
  const row = visible(renderRow(profile(), ctx(140)));
  assert.match(row, /222222222222/);
  assert.match(row, /eu-west-1/);
  assert.match(row, /AdministratorAccess/);
  assert.match(row, /login/); // no cached token in this index
});

test('an inherited region is marked with a star', () => {
  assert.match(visible(renderRow(profile({ regionInherited: true }), ctx(140))), /eu-west-1\*/);
  assert.ok(!visible(renderRow(profile(), ctx(140))).includes('eu-west-1*'));
});

test('the last selected profile is flagged', () => {
  const row = visible(renderRow(profile(), { ...ctx(140), lastProfile: profile().name }));
  assert.match(row, /★/);
  assert.ok(!visible(renderRow(profile(), ctx(140))).includes('★'));
});

test('a valid token shows time remaining, an expired one says so', () => {
  const tokens = new Map([['https://example.invalid/start', new Date('2026-08-14T19:00:00Z')]]);
  assert.match(visible(renderRow(profile(), { ...ctx(140), tokens })), /✓ 7h/);

  const stale = new Map([['https://example.invalid/start', new Date('2026-08-14T06:00:00Z')]]);
  assert.match(visible(renderRow(profile(), { ...ctx(140), tokens: stale })), /expired/);
});

test('non-SSO profiles show their credential kind instead of a token state', () => {
  assert.match(visible(renderRow(profile({ kind: 'chained', ssoStartUrl: undefined }), ctx(140))), /role\s*$/);
  assert.match(visible(renderRow(profile({ kind: 'static', ssoStartUrl: undefined }), ctx(140))), /keys\s*$/);
});

test('describe summarises a profile for status output', () => {
  assert.equal(
    describe(profile()),
    'sso · account 222222222222 · role AdministratorAccess · session Corp_SSO',
  );
  assert.equal(
    describe(profile({ kind: 'chained', ssoSession: undefined, sourceProfile: 'base' })),
    'role · account 222222222222 · role AdministratorAccess · via base',
  );
});
