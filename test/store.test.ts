import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  defaultConfig,
  loadConfig,
  pruneMissing,
  recordSelection,
  saveConfig,
} from '../src/store.ts';

const tmpFile = (name = 'config.json') => join(mkdtempSync(join(tmpdir(), 'awsx-')), name);

test('a missing file yields defaults without a warning', () => {
  const { config, warning } = loadConfig(tmpFile());
  assert.equal(warning, undefined);
  assert.deepEqual(config.recents, []);
  assert.equal(config.settings.recentsLimit, 10);
});

test('a corrupt file warns and falls back instead of throwing', () => {
  const path = tmpFile();
  writeFileSync(path, '{ this is not json');
  const { config, warning } = loadConfig(path);
  assert.match(warning ?? '', /not valid JSON/);
  assert.equal(config.lastProfile, undefined);
});

test('unknown keys written by a human survive a round-trip', () => {
  const path = tmpFile();
  writeFileSync(path, JSON.stringify({ version: 1, myOwnNote: 'keep me', settings: { confirmProd: true } }));
  const { config } = loadConfig(path);
  saveConfig(config, path);
  const written = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  assert.equal(written.myOwnNote, 'keep me');
  assert.equal((written.settings as Record<string, unknown>).confirmProd, true);
});

test('the file is written 0600 and is valid JSON', () => {
  const path = tmpFile();
  saveConfig(recordSelection(defaultConfig(), 'prod-admin', 'eu-west-1'), path);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(loadConfig(path).config.lastProfile, 'prod-admin');
});

test('bad types in settings are replaced by defaults', () => {
  const path = tmpFile();
  writeFileSync(
    path,
    JSON.stringify({ recents: 'nope', perProfile: 5, settings: { prodPatterns: 3, recentsLimit: -1 } }),
  );
  const { config } = loadConfig(path);
  assert.deepEqual(config.recents, []);
  assert.deepEqual(config.perProfile, {});
  assert.deepEqual(config.settings.prodPatterns, ['prod', 'prd']);
  assert.equal(config.settings.recentsLimit, 10);
});

test('recordSelection tracks last, previous and recents', () => {
  let config = defaultConfig();
  config = recordSelection(config, 'a', 'eu-west-1');
  config = recordSelection(config, 'b', 'us-east-1');
  assert.equal(config.lastProfile, 'b');
  assert.equal(config.previousProfile, 'a');
  assert.deepEqual(config.recents, ['b', 'a']);
  assert.equal(config.perProfile.b?.lastRegion, 'us-east-1');
  assert.equal(config.perProfile.a?.uses, 1);
});

test('re-selecting the same profile does not destroy the toggle target', () => {
  let config = defaultConfig();
  config = recordSelection(config, 'a', undefined);
  config = recordSelection(config, 'b', undefined);
  config = recordSelection(config, 'b', undefined);
  assert.equal(config.previousProfile, 'a');
  assert.equal(config.perProfile.b?.uses, 2);
  assert.deepEqual(config.recents, ['b', 'a']);
});

test('recents respect recentsLimit', () => {
  let config = defaultConfig();
  config.settings.recentsLimit = 3;
  for (const name of ['a', 'b', 'c', 'd']) config = recordSelection(config, name, undefined);
  assert.deepEqual(config.recents, ['d', 'c', 'b']);
});

test('pruneMissing drops profiles that no longer exist', () => {
  let config = defaultConfig();
  config = recordSelection(config, 'gone', 'eu-west-1');
  config = recordSelection(config, 'stays', 'eu-west-1');
  const changed = pruneMissing(config, new Set(['stays']));
  assert.equal(changed, true);
  assert.equal(config.lastProfile, 'stays');
  assert.equal(config.previousProfile, undefined); // was 'gone'
  assert.deepEqual(config.recents, ['stays']);
  assert.deepEqual(Object.keys(config.perProfile), ['stays']);
});

test('pruneMissing reports no change when everything still exists', () => {
  const config = recordSelection(defaultConfig(), 'stays', undefined);
  assert.equal(pruneMissing(config, new Set(['stays'])), false);
});
