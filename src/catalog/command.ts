/**
 * `awsx profiles <import|apply>` (ADR-0002). Everything goes to stderr: this
 * command never prints shell code, and it is in PASSTHROUGH_COMMANDS so the
 * wrapper does not eval it.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mapLimit, ssoListAccountRoles, ssoListAccounts } from '../aws.ts';
import { parseIni } from '../ini.ts';
import { awsConfigPath, awsCredentialsPath, catalogPath } from '../paths.ts';
import { confirmPrompt } from '../picker.ts';
import { bold, dim, green, red, yellow } from '../render.ts';
import { readAccessToken } from '../sso.ts';
import { loadConfig, saveConfig } from '../store.ts';
import {
  adoptOutside,
  aliasHints,
  backupConfig,
  driftReason,
  hasChanges,
  planApply,
  recordFormerNames,
  renameInState,
  writeConfigAtomic,
  type ApplyPlan,
} from './apply.ts';
import { addDiscovered } from './discover.ts';
import { importCatalog } from './import.ts';
import { CatalogError, CREDENTIAL_KEYS, loadCatalog, saveCatalog } from './schema.ts';

type Values = Record<string, string | boolean | undefined>;

const say = (text: string): void => {
  process.stderr.write(`${text}\n`);
};

export const PROFILES_USAGE = `${bold('awsx profiles')} — manage ~/.aws/config from a JSON catalog (ADR-0002)

  awsx profiles import [--force] [--offline] [--default-session S]
      build the catalog from ~/.aws/config and ~/.aws/credentials
      (account names come from SSO unless --offline)
  awsx profiles discover [--session S] [--region R] [--dry-run]
      add the account/role pairs your SSO session reaches, marked "new"
  awsx profiles apply [--dry-run] [--yes] [--adopt | --force]
      regenerate ~/.aws/config from the catalog; ~/.aws/credentials is never written

  catalog: $AWSX_PROFILES_FILE, else ~/.aws/profiles.json`;

const readText = (path: string): string => {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
};

/** Names of the credentials sections that hold static keys: valid `source_profile` targets. */
function staticProfiles(credentialsText: string): Set<string> {
  const names = new Set<string>();
  for (const [header, section] of parseIni(credentialsText)) {
    if (Object.keys(section.keys).some((k) => CREDENTIAL_KEYS.has(k))) names.add(header);
  }
  return names;
}

export async function profilesCommand(sub: string | undefined, values: Values): Promise<number> {
  try {
    switch (sub) {
      case 'import':
        return await importCmd(values);
      case 'discover':
        return await discoverCmd(values);
      case 'apply':
        return await applyCmd(values);
      case undefined:
      case 'help':
        say(PROFILES_USAGE);
        return sub === undefined ? 1 : 0;
      default:
        say(red(`unknown subcommand "${sub}"`));
        say(PROFILES_USAGE);
        return 1;
    }
  } catch (err) {
    if (err instanceof CatalogError) {
      say(red(err.message));
      return 1;
    }
    throw err;
  }
}

/** Account ID -> name from SSO, or an empty map with the reason when it cannot be had. */
async function accountNames(session: Record<string, string> | undefined, name: string | undefined): Promise<Map<string, string>> {
  const startUrl = session?.sso_start_url;
  const region = session?.sso_region;
  if (!startUrl || !region || !name) return new Map();
  const token = readAccessToken(startUrl);
  if (!token) {
    say(dim(`note: no valid SSO token for "${name}", so account names come from profile names (\`awsx login\` first, or --offline to silence this)`));
    return new Map();
  }
  try {
    return new Map((await ssoListAccounts(token, region)).map((a) => [a.accountId, a.accountName]));
  } catch (err) {
    say(dim(`note: account names not read from SSO (${(err as Error).message})`));
    return new Map();
  }
}

async function importCmd(values: Values): Promise<number> {
  const path = catalogPath();
  if (existsSync(path) && !values.force) {
    say(red(`${path} already exists; pass --force to replace it`));
    return 1;
  }
  const defaultSession = typeof values['default-session'] === 'string' ? values['default-session'] : undefined;
  const input = {
    configText: readText(awsConfigPath()),
    credentialsText: readText(awsCredentialsPath()),
    ...(defaultSession ? { defaultSession } : {}),
  };
  let { catalog, report } = importCatalog(input);
  if (!values.offline) {
    const session = catalog.defaults.sso_session;
    const names = await accountNames(session ? catalog.sso_sessions[session] : undefined, session);
    if (names.size > 0) ({ catalog, report } = importCatalog({ ...input, accountNames: names }));
  }

  if (report.errors.some((e) => /static keys in ~\/.aws\/config/.test(e))) {
    for (const e of report.errors) say(red(e));
    return 1;
  }
  saveCatalog(path, catalog);

  say(`${green('✓')} wrote ${bold(path)}: ${catalog.profiles.length} profiles, ${Object.keys(catalog.sso_sessions).length} SSO sessions`);
  for (const f of report.folded) say(`  ${bold(f.kept)} ${dim(`replaces ${f.replaced.join(', ')}`)}`);
  for (const p of report.proposed) say(`  ${bold(p.name)} ${dim(`proposed for ${p.replaced.join(', ')} — rename it in the catalog if you like`)}`);
  if (report.staticProfiles.length > 0) {
    say(dim(`  static keys stay in ~/.aws/credentials: ${report.staticProfiles.join(', ')}`));
  }
  for (const w of report.warnings) say(yellow(`  ! ${w}`));
  if (report.errors.length > 0) {
    say(red(`the catalog has ${report.errors.length} problem(s) to fix before apply:`));
    for (const e of report.errors) say(red(`  - ${e}`));
    return 1;
  }
  say(dim('next: review the catalog, then `awsx profiles apply --dry-run`'));
  return 0;
}

const DISCOVER_CONCURRENCY = 6;

async function discoverCmd(values: Values): Promise<number> {
  const path = catalogPath();
  const catalog = loadCatalog(path, { externalProfiles: staticProfiles(readText(awsCredentialsPath())) });
  const name = typeof values.session === 'string' ? values.session : catalog.defaults.sso_session;
  const session = name === undefined ? undefined : catalog.sso_sessions[name];
  if (name === undefined || session === undefined) {
    say(red(`unknown SSO session ${name === undefined ? '(no --session and no defaults.sso_session)' : `"${name}"`}`));
    return 1;
  }
  const { sso_start_url: startUrl, sso_region: ssoRegion } = session;
  if (!startUrl || !ssoRegion) {
    say(red(`session "${name}" has no sso_start_url or sso_region`));
    return 1;
  }
  const token = readAccessToken(startUrl);
  if (!token) {
    say(red(`no valid SSO token for "${name}": run \`aws sso login --sso-session ${name}\` (or \`awsx login\`) first`));
    return 1;
  }

  const accounts = await ssoListAccounts(token, ssoRegion);
  const reachable = await mapLimit(accounts, DISCOVER_CONCURRENCY, async (a) => ({
    ...a,
    roles: await ssoListAccountRoles(token, ssoRegion, a.accountId),
  }));
  const region = typeof values.region === 'string' && values.region !== '' ? values.region : undefined;
  const { catalog: next, added } = addDiscovered(catalog, name, reachable, region);

  const pairs = reachable.reduce((n, a) => n + a.roles.length, 0);
  say(`${bold(name)}: ${accounts.length} accounts, ${pairs} account/role pairs reachable, ${added.length} not in the catalog`);
  for (const p of added) say(`  ${green('+')} ${bold(p.name)} ${dim(`${p.account_name || '…' + (p.account_id ?? '').slice(-4)} / ${p.role}`)}`);
  if (added.length === 0) return 0;
  if (values['dry-run']) {
    say(dim('dry run: catalog unchanged'));
    return 0;
  }
  saveCatalog(path, next);
  say(`${green('✓')} added to ${bold(path)}, marked "new": rename them if you like, remove "new", then \`awsx profiles apply\``);
  return 0;
}

function printPlan(plan: ApplyPlan): void {
  const line = (mark: string, text: string) => say(`  ${mark} ${text}`);
  for (const n of plan.added) line(green('+'), n);
  for (const n of plan.removed) line(red('-'), n);
  for (const r of plan.renames) line(yellow('→'), `${r.from} → ${bold(r.to)}`);
  for (const c of plan.changed) line(yellow('~'), `${c.name} ${dim(c.keys.join(', '))}`);
  for (const h of plan.otherSections) line(yellow('~'), dim(`[${h}]`));
}

function printShadowed(plan: ApplyPlan, credentialsPath: string): void {
  if (plan.shadowed.length === 0) return;
  say(yellow(`! ${credentialsPath} defines ${plan.shadowed.length} catalog profile(s) again, and wins over ~/.aws/config.`));
  say(yellow('  awsx never writes that file: remove these sections by hand.'));
  for (const s of plan.shadowed) say(yellow(`    ${credentialsPath}:${s.line}  [${s.name}]`));
}

async function applyCmd(values: Values): Promise<number> {
  const path = catalogPath();
  const configPath = awsConfigPath();
  const credentialsPath = awsCredentialsPath();
  const configText = readText(configPath);
  const credentialsText = readText(credentialsPath);

  let catalog = loadCatalog(path, { externalProfiles: staticProfiles(credentialsText) });
  let plan = planApply({ catalog, configText, credentialsText });

  if (plan.pendingNew.length > 0) {
    say(red(`profiles still marked "new": ${plan.pendingNew.join(', ')}`));
    say('choose their names in the catalog and remove "new", then apply again');
    return 1;
  }

  const drift = driftReason(plan);
  if (drift !== undefined) {
    if (values.adopt) {
      const before = catalog.profiles.length;
      catalog = adoptOutside(catalog, configText, credentialsText, plan.outside);
      plan = planApply({ catalog, configText, credentialsText });
      say(yellow(`! ${drift}; --adopt adds ${catalog.profiles.length - before} profile(s) to the catalog`));
    } else if (values.force) {
      say(yellow(`! ${drift}; --force overwrites it (the current file goes to the backup)`));
    } else {
      say(red(`! ${drift}.`));
      printPlan(plan);
      say('run with --adopt to bring those profiles into the catalog, or --force to drop them');
      return 1;
    }
  }

  if (!hasChanges(plan) && plan.generated.state === 'clean') {
    say(`${green('✓')} ~/.aws/config is up to date with the catalog`);
    printShadowed(plan, credentialsPath);
    return 0;
  }

  say(bold(`awsx profiles apply → ${configPath}`));
  if (hasChanges(plan)) printPlan(plan);
  else say(dim('  no profile changes; the file is rewritten with the generated header'));
  printShadowed(plan, credentialsPath);

  if (values['dry-run']) {
    say(dim('dry run: nothing written'));
    return 0;
  }

  if (!values.yes) {
    if (!process.stdin.isTTY || !process.stderr.isTTY) {
      say(red('not a terminal: pass --yes to apply without confirmation'));
      return 1;
    }
    if (!(await confirmPrompt(`Write ${configPath}?`, false))) {
      say('nothing written');
      return 130;
    }
  }

  const backup = backupConfig(configPath);
  writeConfigAtomic(configPath, plan.next);
  if (values.adopt || plan.renames.length > 0) {
    saveCatalog(path, recordFormerNames(catalog, plan.renames));
  }
  if (backup) say(dim(`backup: ${backup}`));
  say(`${green('✓')} wrote ${bold(configPath)}`);

  if (plan.renames.length > 0) {
    const loaded = loadConfig();
    if (renameInState(loaded.config, plan.renames)) saveConfig(loaded.config, loaded.path);
    const prod = loaded.config.settings.prodProfiles.filter((n) => plan.renames.some((r) => r.from === n));
    if (prod.length > 0) {
      say(yellow(`! settings.prodProfiles in ${loaded.path} still names: ${prod.join(', ')}`));
    }
    const home = process.env.HOME || homedir();
    const hits = aliasHints(plan.renames, [
      join(home, '.zshrc'),
      join(home, '.bashrc'),
      join(home, '.config', 'fish', 'config.fish'),
    ]);
    if (hits.length > 0) {
      say(yellow('! these lines still use an old profile name:'));
      for (const h of hits) say(yellow(`    ${h.file}:${h.line}  ${h.name}`));
    }
  }
  return 0;
}
