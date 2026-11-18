import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseIni, sectionSpans, splitHeader } from '../src/ini.ts';

test('parses section headers and key/value pairs', () => {
  const ini = parseIni('[profile foo]\nregion = eu-west-1\n');
  assert.deepEqual(ini.get('profile foo')?.keys, { region: 'eu-west-1' });
});

test('strips full-line and whitespace-separated inline comments', () => {
  const ini = parseIni(['[default]', '# a comment', '; another', 'region = eu-west-1   # main'].join('\n'));
  assert.equal(ini.get('default')?.keys.region, 'eu-west-1');
});

test('keeps a # that is part of a value', () => {
  const ini = parseIni('[default]\nrole = team#lead\n');
  assert.equal(ini.get('default')?.keys.role, 'team#lead');
});

test('reads indented sub-keys as a nested map, not top-level keys', () => {
  const ini = parseIni(
    ['[profile n]', 'region = us-east-1', 's3 =', '  addressing_style = path', 'max_attempts = 5'].join('\n'),
  );
  const section = ini.get('profile n');
  assert.deepEqual(section?.nested.s3, { addressing_style: 'path' });
  assert.equal(section?.keys.max_attempts, '5');
  assert.equal(section?.keys.addressing_style, undefined);
});

test('merges duplicate headers instead of dropping the first', () => {
  const ini = parseIni('[default]\na = 1\n[default]\nb = 2\n');
  assert.deepEqual(ini.get('default')?.keys, { a: '1', b: '2' });
});

test('tolerates values containing =', () => {
  const ini = parseIni('[default]\nsso_start_url = https://x.invalid/start?a=b\n');
  assert.equal(ini.get('default')?.keys.sso_start_url, 'https://x.invalid/start?a=b');
});

test('ignores keys written before any section header', () => {
  const ini = parseIni('stray = 1\n[default]\nregion = eu-west-1\n');
  assert.equal(ini.size, 1);
});

test('splitHeader separates type from name', () => {
  assert.deepEqual(splitHeader('profile foo'), { type: 'profile', name: 'foo' });
  assert.deepEqual(splitHeader('sso-session My_SSO'), { type: 'sso-session', name: 'My_SSO' });
  assert.deepEqual(splitHeader('default'), { type: '', name: 'default' });
});

test('sectionSpans gives each header its line range and the comments just above it', () => {
  const text = [
    '########',
    '# ACME',
    '########',
    '[profile a]',
    'region = eu-west-1',
    '',
    '; note on b',
    '[profile b]   # trailing',
    'region = eu-west-3',
    '# trailing comment of the file',
  ].join('\n');
  assert.deepEqual(sectionSpans(text), [
    { header: 'profile a', line: 3, end: 7, comments: ['ACME'] },
    { header: 'profile b', line: 7, end: 10, comments: ['note on b'] },
  ]);
});

test('sectionSpans resets comments after a key, so a comment inside a section is not carried', () => {
  const spans = sectionSpans(['[a]', '# about x', 'x = 1', '[b]'].join('\n'));
  assert.deepEqual(spans.map((s) => s.comments), [[], []]);
});
