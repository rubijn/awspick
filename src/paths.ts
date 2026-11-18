import { homedir } from 'node:os';
import { join } from 'node:path';

const home = () => process.env.HOME || homedir();

/** ~/.aws/config, or $AWS_CONFIG_FILE. */
export function awsConfigPath(): string {
  return process.env.AWS_CONFIG_FILE || join(home(), '.aws', 'config');
}

/** ~/.aws/credentials, or $AWS_SHARED_CREDENTIALS_FILE. */
export function awsCredentialsPath(): string {
  return process.env.AWS_SHARED_CREDENTIALS_FILE || join(home(), '.aws', 'credentials');
}

/** ~/.aws/sso/cache — where the CLI keeps SSO access tokens. */
export function ssoCacheDir(): string {
  return join(home(), '.aws', 'sso', 'cache');
}

/**
 * ~/.config/awsx/config.json — the single file holding settings *and* state.
 * Honours $XDG_CONFIG_HOME, and $AWSX_CONFIG_FILE for tests.
 */
export function awsxConfigPath(): string {
  if (process.env.AWSX_CONFIG_FILE) return process.env.AWSX_CONFIG_FILE;
  const base = process.env.XDG_CONFIG_HOME || join(home(), '.config');
  return join(base, 'awsx', 'config.json');
}

/**
 * The profile catalog (ADR-0002): $AWSX_PROFILES_FILE, else ~/.aws/profiles.json.
 * Next to the files it generates, not in ~/.config/awsx: it holds account IDs
 * and SSO portal URLs, which config.json is documented never to contain.
 */
export function catalogPath(): string {
  return process.env.AWSX_PROFILES_FILE || join(home(), '.aws', 'profiles.json');
}
