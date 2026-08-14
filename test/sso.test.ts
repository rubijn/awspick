import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Profile } from '../src/profiles.ts';
import { humanizeRemaining, loadTokenIndex, parseExpiry, tokenStatus } from '../src/sso.ts';

const ssoProfile = (startUrl?: string): Profile => ({
  name: 'p',
  sources: ['config'],
  kind: 'sso',
  regionInherited: false,
  isProd: false,
  ...(startUrl ? { ssoStartUrl: startUrl } : {}),
});

test('parses both ISO and the older ...UTC expiry format', () => {
  assert.equal(parseExpiry('2026-08-14T18:42:00Z')?.toISOString(), '2026-08-14T18:42:00.000Z');
  assert.equal(parseExpiry('2026-08-14T18:42:00UTC')?.toISOString(), '2026-08-14T18:42:00.000Z');
  assert.equal(parseExpiry('not a date'), undefined);
  assert.equal(parseExpiry(42), undefined);
});

test('indexes token files by startUrl and ignores registration-only files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'awsx-sso-'));
  writeFileSync(
    join(dir, 'token.json'),
    JSON.stringify({ accessToken: 'x', startUrl: 'https://a.invalid/start', expiresAt: '2026-08-14T18:00:00Z' }),
  );
  // No accessToken: this is a client registration, not a session.
  writeFileSync(join(dir, 'registration.json'), JSON.stringify({ clientId: 'c', expiresAt: '2027-01-01T00:00:00Z' }));
  writeFileSync(join(dir, 'garbage.json'), 'not json');
  writeFileSync(join(dir, 'ignored.txt'), 'nope');

  const index = loadTokenIndex(dir);
  assert.deepEqual([...index.keys()], ['https://a.invalid/start']);
});

test('keeps the latest expiry when several files share a startUrl', () => {
  const dir = mkdtempSync(join(tmpdir(), 'awsx-sso-'));
  const url = 'https://a.invalid/start';
  writeFileSync(join(dir, '1.json'), JSON.stringify({ accessToken: 'x', startUrl: url, expiresAt: '2026-01-01T00:00:00Z' }));
  writeFileSync(join(dir, '2.json'), JSON.stringify({ accessToken: 'y', startUrl: url, expiresAt: '2026-06-01T00:00:00Z' }));
  assert.equal(loadTokenIndex(dir).get(url)?.toISOString(), '2026-06-01T00:00:00.000Z');
});

test('a missing cache directory is not an error', () => {
  assert.equal(loadTokenIndex(join(tmpdir(), 'awsx-does-not-exist-12345')).size, 0);
});

test('reports valid, expired, missing and not-sso', () => {
  const now = new Date('2026-08-14T12:00:00Z');
  const index = new Map([
    ['https://valid.invalid/start', new Date('2026-08-14T19:00:00Z')],
    ['https://stale.invalid/start', new Date('2026-08-13T19:00:00Z')],
  ]);

  assert.equal(tokenStatus(ssoProfile('https://valid.invalid/start'), index, now).state, 'valid');
  assert.equal(tokenStatus(ssoProfile('https://stale.invalid/start'), index, now).state, 'expired');
  assert.equal(tokenStatus(ssoProfile('https://unknown.invalid/start'), index, now).state, 'missing');
  assert.equal(tokenStatus({ ...ssoProfile(), kind: 'static' }, index, now).state, 'not-sso');
  assert.equal(tokenStatus(ssoProfile(), index, now).state, 'not-sso');
});

test('humanizes remaining time coarsely', () => {
  const now = new Date('2026-08-14T12:00:00Z');
  assert.equal(humanizeRemaining(new Date('2026-08-14T12:42:00Z'), now), '42m');
  assert.equal(humanizeRemaining(new Date('2026-08-14T19:00:00Z'), now), '7h');
  assert.equal(humanizeRemaining(new Date('2026-08-17T12:00:00Z'), now), '3d');
  assert.equal(humanizeRemaining(new Date('2026-08-14T12:00:10Z'), now), '<1m');
});
