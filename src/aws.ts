/**
 * Everything delegated to the AWS CLI (a hard prerequisite — ADR-0001).
 *
 * Always `execFile` with an argv array, never a shell string: profile names come
 * from a config file and must never be able to become shell syntax. And always
 * pass `--profile` explicitly rather than relying on an inherited AWS_PROFILE.
 */

import { execFile, spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { promisify } from 'node:util';
import type { AwsxConfig } from './store.ts';

const execFileAsync = promisify(execFile);

const AWS_BIN = process.env.AWSX_AWS_BIN || 'aws';

/** Env for `aws` calls that must read config rather than inherit our shell. */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  delete env.AWS_PROFILE;
  delete env.AWS_DEFAULT_PROFILE;
  delete env.AWS_REGION;
  delete env.AWS_DEFAULT_REGION;
  delete env.AWS_ACCESS_KEY_ID;
  delete env.AWS_SECRET_ACCESS_KEY;
  delete env.AWS_SESSION_TOKEN;
  return env;
}

export type AwsRun = { stdout: string; stderr: string; code: number };

async function run(args: string[], opts: { timeout?: number; env?: NodeJS.ProcessEnv } = {}): Promise<AwsRun> {
  try {
    const { stdout, stderr } = await execFileAsync(AWS_BIN, args, {
      timeout: opts.timeout ?? 20_000,
      env: opts.env ?? cleanEnv(),
      maxBuffer: 8 * 1024 * 1024,
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string };
    if (e.code === 'ENOENT') throw new AwsCliMissingError();
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? String(err),
      code: typeof e.code === 'number' ? e.code : 1,
    };
  }
}

export class AwsCliMissingError extends Error {
  constructor() {
    super('the AWS CLI (`aws`) was not found on PATH');
    this.name = 'AwsCliMissingError';
  }
}

export type CliInfo = { version: string; major: number };

export function parseVersion(output: string): CliInfo | undefined {
  const match = /aws-cli\/(\d+)\.(\d+)\.(\d+)/.exec(output);
  if (!match) return undefined;
  return { version: `${match[1]}.${match[2]}.${match[3]}`, major: Number(match[1]) };
}

/**
 * Verify the AWS CLI once, cached in ~/.config/awsx/config.json against the
 * binary's mtime, so the common path does not pay ~240 ms for a version probe.
 * Returns the info and whether the cache was refreshed (caller decides to save).
 */
export async function ensureAwsCli(
  config: AwsxConfig,
): Promise<{ info: CliInfo; refreshed: boolean }> {
  const resolved = await which(AWS_BIN);
  if (!resolved) throw new AwsCliMissingError();

  let mtimeMs = 0;
  try {
    mtimeMs = Math.round(statSync(resolved).mtimeMs);
  } catch {
    mtimeMs = 0;
  }

  const cached = config.awsCli;
  if (cached && cached.path === resolved && cached.mtimeMs === mtimeMs) {
    const info = parseVersion(`aws-cli/${cached.version}`);
    if (info) return { info, refreshed: false };
  }

  const { stdout, stderr, code } = await run(['--version'], { timeout: 10_000 });
  const info = parseVersion(stdout || stderr);
  if (code !== 0 || !info) throw new Error(`could not determine the AWS CLI version: ${stderr.trim() || 'no output'}`);
  if (info.major < 2) {
    throw new Error(`AWS CLI v2 is required, found v${info.version}. Upgrade with: brew install awscli`);
  }
  config.awsCli = { path: resolved, mtimeMs, version: info.version };
  return { info, refreshed: true };
}

/** Resolve a binary on PATH without shelling out. */
async function which(bin: string): Promise<string | undefined> {
  if (bin.includes('/')) return bin;
  const { access } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const paths = (process.env.PATH ?? '').split(':').filter(Boolean);
  for (const dir of paths) {
    const candidate = join(dir, bin);
    try {
      await access(candidate, (await import('node:fs')).constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

/** `aws configure list-profiles` — the oracle for `doctor` and the diff test. */
export async function listProfiles(): Promise<string[]> {
  const { stdout, code, stderr } = await run(['configure', 'list-profiles']);
  if (code !== 0) throw new Error(`aws configure list-profiles failed: ${stderr.trim()}`);
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function configGet(key: string, profile: string): Promise<string | undefined> {
  const { stdout, code } = await run(['configure', 'get', key, '--profile', profile]);
  if (code !== 0) return undefined;
  const value = stdout.trim();
  return value === '' ? undefined : value;
}

export type CallerIdentity = { Account: string; Arn: string; UserId: string };

export async function callerIdentity(
  profile: string,
  region: string | undefined,
): Promise<{ ok: true; identity: CallerIdentity } | { ok: false; error: string }> {
  const args = ['sts', 'get-caller-identity', '--output', 'json', '--profile', profile];
  if (region) args.push('--region', region);
  const { stdout, stderr, code } = await run(args, { timeout: 15_000 });
  if (code !== 0) return { ok: false, error: firstUsefulLine(stderr) };
  try {
    return { ok: true, identity: JSON.parse(stdout) as CallerIdentity };
  } catch {
    return { ok: false, error: 'unexpected sts output' };
  }
}

/**
 * Interactive: inherits the terminal so the device-code flow and browser work.
 * The CLI prints the verification URL on stdout, which the wrapper evals — the
 * `&` in its query string is a shell parse error — so its stdout goes to stderr.
 */
export function ssoLogin(session: string | undefined, profile: string | undefined): Promise<number> {
  const args = ['sso', 'login'];
  if (session) args.push('--sso-session', session);
  else if (profile) args.push('--profile', profile);
  return new Promise((resolve, reject) => {
    const child = spawn(AWS_BIN, args, { stdio: ['inherit', process.stderr, 'inherit'], env: cleanEnv() });
    child.on('error', (err) => {
      reject((err as NodeJS.ErrnoException).code === 'ENOENT' ? new AwsCliMissingError() : err);
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

export type ExportFormat = 'env' | 'env-no-export' | 'powershell' | 'windows-cmd' | 'fish' | 'process';

/**
 * Materialize credentials via the CLI's own resolution chain (SSO, role chains,
 * credential_process). We never read secrets out of ~/.aws/credentials, and the
 * output is only ever eval'd — never logged, never persisted.
 */
export async function exportCredentials(
  profile: string,
  format: ExportFormat,
): Promise<{ ok: true; output: string } | { ok: false; error: string }> {
  const { stdout, stderr, code } = await run([
    'configure',
    'export-credentials',
    '--profile',
    profile,
    '--format',
    format,
  ]);
  if (code !== 0) return { ok: false, error: firstUsefulLine(stderr) };
  return { ok: true, output: stdout.trimEnd() };
}

/** Run a command with the selection applied, without touching the shell. */
export function runWithEnv(
  command: string,
  args: string[],
  env: Record<string, string | undefined>,
): Promise<number> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete childEnv[key];
    else childEnv[key] = value;
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env: childEnv });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve(signal ? 1 : (code ?? 1)));
  });
}

function firstUsefulLine(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.at(-1) ?? 'unknown error';
}
