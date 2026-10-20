/**
 * End-to-end runs of the real binary against fixture config files, plus the
 * differential check against `aws configure list-profiles` (ADR-0001: the AWS
 * CLI is the oracle, just not in the hot path).
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, '..', 'src', 'index.ts');
const fixtures = join(here, 'fixtures');

type Run = { stdout: string; stderr: string; code: number };

async function awsx(args: string[], env: Record<string, string> = {}): Promise<Run> {
  const configFile = env.AWSX_CONFIG_FILE ?? join(mkdtempSync(join(tmpdir(), 'awsx-cli-')), 'config.json');
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  // Drop any ambient AWS selection first, so the test's own env wins.
  for (const key of ['AWS_PROFILE', 'AWS_REGION', 'AWS_DEFAULT_PROFILE', 'AWS_DEFAULT_REGION']) {
    delete childEnv[key];
  }
  Object.assign(childEnv, {
    AWS_CONFIG_FILE: join(fixtures, 'config'),
    AWS_SHARED_CREDENTIALS_FILE: join(fixtures, 'credentials'),
    AWSX_CONFIG_FILE: configFile,
    NO_COLOR: '1',
    ...env,
  });

  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [entry, ...args], { env: childEnv });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: typeof e.code === 'number' ? e.code : 1 };
  }
}

test('--profile emits shell code on stdout and the summary on stderr', async () => {
  const run = await awsx(['--profile', 'prod-admin', '--emit-shell'], {
    AWSX_SHELL_WRAPPER: '1',
    AWSX_SHELL: 'zsh',
  });
  assert.equal(run.code, 0);
  assert.equal(
    run.stdout.trim(),
    [
      "export AWS_PROFILE='prod-admin'",
      "export AWS_DEFAULT_PROFILE='prod-admin'",
      "export AWS_REGION='eu-west-3'",
      "export AWS_DEFAULT_REGION='eu-west-3'",
    ].join('\n'),
  );
  assert.match(run.stderr, /prod-admin/);
  // stdout must stay eval-safe: no human text mixed in
  assert.ok(!run.stdout.includes('✓'));
});

test('without the wrapper it still prints exports, plus an install hint', async () => {
  const run = await awsx(['--profile', 'prod-admin']);
  assert.equal(run.code, 0);
  assert.match(run.stdout, /export AWS_PROFILE='prod-admin'/);
  assert.match(run.stderr, /init zsh/);
});

test('an unambiguous query selects without any UI', async () => {
  const run = await awsx(['observability', '--emit-shell'], { AWSX_SHELL_WRAPPER: '1' });
  assert.equal(run.code, 0);
  assert.match(run.stdout, /AWS_PROFILE='dev-observability'/);
});

test('an ambiguous query in a non-tty refuses instead of guessing', async () => {
  const run = await awsx(['admin']);
  assert.equal(run.code, 1);
  assert.match(run.stderr, /matches \d+ profiles/);
});

test('an unknown profile is an error, not a silent no-op', async () => {
  const run = await awsx(['--profile', 'nope']);
  assert.equal(run.code, 1);
  assert.match(run.stderr, /no such profile/);
});

test('a query matching nothing says so', async () => {
  const run = await awsx(['zzzznothing']);
  assert.equal(run.code, 1);
  assert.match(run.stderr, /nothing matches/);
});

test('--no-region unsets the region instead of exporting an empty one', async () => {
  const run = await awsx(['--profile', 'prod-admin', '--no-region', '--emit-shell'], { AWSX_SHELL_WRAPPER: '1' });
  assert.match(run.stdout, /unset AWS_REGION/);
  assert.ok(!run.stdout.includes("AWS_REGION=''"));
});

test('selection is remembered, and `-` toggles back to the previous profile', async () => {
  const store = join(mkdtempSync(join(tmpdir(), 'awsx-toggle-')), 'config.json');
  await awsx(['--profile', 'prod-admin'], { AWSX_CONFIG_FILE: store });
  await awsx(['--profile', 'dev-observability'], { AWSX_CONFIG_FILE: store });

  const saved = JSON.parse(readFileSync(store, 'utf8')) as Record<string, unknown>;
  assert.equal(saved.lastProfile, 'dev-observability');
  assert.equal(saved.previousProfile, 'prod-admin');
  assert.deepEqual(saved.recents, ['dev-observability', 'prod-admin']);

  const back = await awsx(['-', '--emit-shell'], { AWSX_CONFIG_FILE: store, AWSX_SHELL_WRAPPER: '1' });
  assert.equal(back.code, 0);
  assert.match(back.stdout, /AWS_PROFILE='prod-admin'/);
});

test('the remembered region for a profile beats the one in ~/.aws/config', async () => {
  const store = join(mkdtempSync(join(tmpdir(), 'awsx-region-')), 'config.json');
  await awsx(['--profile', 'prod-admin', '--region', 'me-south-1'], { AWSX_CONFIG_FILE: store });
  const again = await awsx(['--profile', 'prod-admin', '--emit-shell'], {
    AWSX_CONFIG_FILE: store,
    AWSX_SHELL_WRAPPER: '1',
  });
  assert.match(again.stdout, /AWS_REGION='me-south-1'/); // not eu-west-3
});

test('`-` with no history is an error rather than a wrong guess', async () => {
  const run = await awsx(['-']);
  assert.equal(run.code, 1);
  assert.match(run.stderr, /no previous profile/);
});

test('list --json exposes the resolved model', async () => {
  const run = await awsx(['list', '--json']);
  assert.equal(run.code, 0);
  const parsed = JSON.parse(run.stdout) as Array<{ name: string; accountId?: string; sso: { state: string } }>;
  const prod = parsed.find((p) => p.name === 'prod-admin');
  assert.equal(prod?.accountId, '111111111111');
  assert.equal(prod?.sso.state, 'missing'); // no token cache for the fixture
});

test('status without AWS_PROFILE reports that and exits non-zero', async () => {
  const run = await awsx(['status', '--json']);
  assert.equal(run.code, 1);
  const parsed = JSON.parse(run.stdout) as { profile: null; error: string };
  assert.equal(parsed.profile, null);
  assert.match(parsed.error, /AWS_PROFILE is not set/);
});

test('init prints an evalable wrapper for each shell', async () => {
  for (const shell of ['zsh', 'bash', 'fish', 'pwsh']) {
    const run = await awsx(['init', shell]);
    assert.equal(run.code, 0, `${shell}: ${run.stderr}`);
    assert.match(run.stdout, /--emit-shell/);
  }
  const bad = await awsx(['init', 'csh']);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /unknown shell/);
});

test('init works even with an unreadable awsx config', async () => {
  const run = await awsx(['init', 'zsh'], { AWSX_CONFIG_FILE: '/dev/null/nope/config.json' });
  assert.equal(run.code, 0);
  assert.match(run.stdout, /awsx\(\)/);
});

test('export refuses to print credentials to a terminal without the wrapper', async () => {
  const run = await awsx(['export'], { AWS_PROFILE: 'static-keys' });
  assert.equal(run.code, 1);
  assert.match(run.stderr, /refusing to print credentials/);
});

test('exec runs a command with the selection applied', async () => {
  const run = await awsx(['exec', '--profile', 'prod-admin', '--', 'node', '-e', 'console.log(process.env.AWS_PROFILE + " " + process.env.AWS_REGION)']);
  assert.equal(run.code, 0);
  assert.equal(run.stdout.trim(), 'prod-admin eu-west-3');
});

test('exec without a command explains itself', async () => {
  const run = await awsx(['exec', '--profile', 'prod-admin']);
  assert.equal(run.code, 1);
  assert.match(run.stderr, /nothing to run/);
});

test('exec propagates the child exit code', async () => {
  const run = await awsx(['exec', '--profile', 'prod-admin', '--', 'node', '-e', 'process.exit(7)']);
  assert.equal(run.code, 7);
});

test('a stale lastProfile is pruned instead of breaking the picker', async () => {
  const store = join(mkdtempSync(join(tmpdir(), 'awsx-stale-')), 'config.json');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(
    store,
    JSON.stringify({ version: 1, lastProfile: 'deleted-profile', recents: ['deleted-profile'], perProfile: {} }),
  );
  const run = await awsx(['list'], { AWSX_CONFIG_FILE: store });
  assert.equal(run.code, 0);
  const saved = JSON.parse(readFileSync(store, 'utf8')) as Record<string, unknown>;
  assert.equal(saved.lastProfile, undefined);
  assert.deepEqual(saved.recents, []);
});

test('--help and --version do not touch AWS config at all', async () => {
  const help = await awsx(['--help'], { AWS_CONFIG_FILE: '/nonexistent' });
  assert.equal(help.code, 0);
  assert.match(help.stderr, /interactive AWS_PROFILE/);
  const version = await awsx(['--version'], { AWS_CONFIG_FILE: '/nonexistent' });
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

// `aws sso login` prints the verification URL on stdout; the wrapper evals stdout,
// and the `&` in that URL is a shell parse error.
test('sso login output never reaches stdout', async () => {
  const bin = join(mkdtempSync(join(tmpdir(), 'awsx-fake-aws-')), 'aws');
  writeFileSync(bin, '#!/bin/sh\necho "open https://device.sso.example/?user_code=AB-CD&x=1"\n');
  chmodSync(bin, 0o755);
  const run = await awsx(['login', '--profile', 'prod-admin'], { AWSX_AWS_BIN: bin });
  assert.equal(run.code, 0);
  assert.equal(run.stdout, '');
  assert.match(run.stderr, /user_code=AB-CD&x=1/);
});

// The oracle: our parser must see exactly what the AWS CLI sees.
test('resolveProfiles agrees with `aws configure list-profiles`', async (t) => {
  let cliOk = false;
  try {
    await execFileAsync('aws', ['--version']);
    cliOk = true;
  } catch {
    cliOk = false;
  }
  if (!cliOk) return t.skip('AWS CLI not installed');

  const { stdout } = await execFileAsync('aws', ['configure', 'list-profiles'], {
    env: {
      ...process.env,
      AWS_CONFIG_FILE: join(fixtures, 'config'),
      AWS_SHARED_CREDENTIALS_FILE: join(fixtures, 'credentials'),
    },
  });
  const fromCli = stdout.split('\n').map((line) => line.trim()).filter(Boolean).sort();

  const ours = await awsx(['list', '--json']);
  const mine = (JSON.parse(ours.stdout) as Array<{ name: string }>).map((p) => p.name).sort();

  assert.deepEqual(mine, fromCli);
});
