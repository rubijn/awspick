/**
 * A throwaway HOME for end-to-end runs of `awsx profiles`, with copies of the
 * messy import fixtures as ~/.aws. Nothing here touches the real ~/.aws.
 */

import { execFile } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, '..', 'src', 'index.ts');
const fixtures = join(here, 'fixtures');

export type Run = { stdout: string; stderr: string; code: number };

/** `extraEnv` is added to every run, e.g. AWSX_AWS_BIN for a fake AWS CLI. */
export function sandbox(extraEnv: Record<string, string> = {}) {
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
      ...extraEnv,
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
