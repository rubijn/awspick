/**
 * awsx — pick an AWS profile and region, and get them into the calling shell.
 *
 * Command surface is small enough that node:util parseArgs beats a CLI framework
 * in a latency-sensitive binary (ADR-0001, "Node/TypeScript conventions").
 */

import { parseArgs } from 'node:util';
import {
  AwsCliMissingError,
  callerIdentity,
  ensureAwsCli,
  exportCredentials,
  listProfiles,
  runWithEnv,
  ssoLogin,
  type ExportFormat,
} from './aws.ts';
import {
  CancelledError,
  confirmProd,
  confirmPrompt,
  orderProfiles,
  pickProfile,
  pickRegion,
} from './picker.ts';
import { loadAwsFiles, resolveProfiles, type Profile } from './profiles.ts';
import { bold, cyan, describe, dim, green, red, yellow } from './render.ts';
import { detectShell, initScript, installHint, isShell, renderEnv, selectionEnv, SHELLS, wrapperActive } from './shell.ts';
import { humanizeRemaining, loadTokenIndex, tokenStatus, type TokenIndex } from './sso.ts';
import {
  loadConfig,
  pruneMissing,
  recordSelection,
  saveConfig,
  type AwsxConfig,
} from './store.ts';

const VERSION = '0.1.0';

const USAGE = `${bold('awsx')} — interactive AWS_PROFILE / AWS_REGION switcher

${bold('Usage')}
  awsx [query]              pick a profile (and region); a query pre-filters the list
  awsx -                    switch back to the previous profile
  awsx region [name]        change only the region
  awsx status [--json]      what the current shell is pointed at, verified with STS
  awsx list [--json]        list every profile
  awsx login                refresh the SSO session for the current profile
  awsx export [--print]     materialize real credentials into the shell
  awsx exec -- <cmd>        run a command with the selection applied, no shell change
  awsx init <shell>         print the shell integration (${SHELLS.join(', ')})
  awsx doctor               check the AWS CLI, the shell wrapper and the config

${bold('Options')}
  --profile <name>          non-interactive profile selection
  --region <name>           non-interactive region selection
  --keep-region             keep the current region instead of resolving a new one
  --no-region               unset AWS_REGION
  --yes                     skip the production confirmation
  --json                    machine-readable output where supported
  -h, --help                this text
  -V, --version             version

${bold('Setup')}
  eval "$(awsx init zsh)"   add to ~/.zshrc — without it awsx cannot change this shell
`;

/** stderr for everything a human reads; stdout is reserved for shell code. */
const say = (text: string): void => {
  process.stderr.write(`${text}\n`);
};
const out = (text: string): void => {
  process.stdout.write(`${text}\n`);
};

type Ctx = {
  config: AwsxConfig;
  configPath: string;
  configDirty: boolean;
  profiles: Profile[];
  byName: Map<string, Profile>;
  tokens: TokenIndex;
  emitShell: boolean;
};

async function main(argv: string[]): Promise<number> {
  const { values, positionals, execArgs } = splitArgs(argv);

  if (values.help) {
    say(USAGE);
    return 0;
  }
  if (values.version) {
    out(VERSION);
    return 0;
  }

  const command = positionals[0];

  // `init` must work before anything else is validated — it is what makes the
  // rest usable, so it never depends on the AWS CLI or on readable config.
  if (command === 'init') {
    const requested = positionals[1] ?? detectShell();
    if (!isShell(requested)) {
      say(red(`unknown shell "${requested}" — expected one of: ${SHELLS.join(', ')}`));
      return 1;
    }
    out(initScript(requested));
    return 0;
  }
  if (command === 'help') {
    say(USAGE);
    return 0;
  }
  if (command === 'version') {
    out(VERSION);
    return 0;
  }

  const loaded = loadConfig();
  if (loaded.warning) say(yellow(`warning: ${loaded.warning}`));
  const config = loaded.config;

  const files = loadAwsFiles();
  for (const problem of files.problems) say(yellow(`warning: ${problem}`));

  const profiles = resolveProfiles(files, config.settings);
  const ctx: Ctx = {
    config,
    configPath: loaded.path,
    configDirty: false,
    profiles,
    byName: new Map(profiles.map((p) => [p.name, p])),
    tokens: loadTokenIndex(),
    emitShell: Boolean(values['emit-shell']),
  };

  if (pruneMissing(config, new Set(ctx.byName.keys()))) ctx.configDirty = true;

  try {
    switch (command) {
      case 'doctor':
        return await doctor(ctx);
      case 'list':
        return list(ctx, Boolean(values.json));
      case 'status':
        return await status(ctx, Boolean(values.json));
      case 'login':
        return await login(ctx, values);
      case 'export':
        return await exportCmd(ctx, values);
      case 'exec':
        return await exec(ctx, values, execArgs);
      case 'region':
        return await selectRegionOnly(ctx, values, positionals[1]);
      default:
        return await select(ctx, values, positionals);
    }
  } finally {
    if (ctx.configDirty) {
      try {
        saveConfig(ctx.config, ctx.configPath);
      } catch (err) {
        say(yellow(`warning: could not write ${ctx.configPath}: ${String(err)}`));
      }
    }
  }
}

type Values = Record<string, string | boolean | undefined>;

/** parseArgs, with everything after `--` kept aside for `awsx exec`. */
function splitArgs(argv: string[]): { values: Values; positionals: string[]; execArgs: string[] } {
  const separator = argv.indexOf('--');
  const own = separator === -1 ? argv : argv.slice(0, separator);
  const execArgs = separator === -1 ? [] : argv.slice(separator + 1);

  const { values, positionals } = parseArgs({
    args: own,
    allowPositionals: true,
    // A bare `-` is a positional to us, not a flag.
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'V' },
      json: { type: 'boolean' },
      print: { type: 'boolean' },
      yes: { type: 'boolean', short: 'y' },
      'emit-shell': { type: 'boolean' },
      'keep-region': { type: 'boolean' },
      'no-region': { type: 'boolean' },
      profile: { type: 'string' },
      region: { type: 'string' },
      shell: { type: 'string' },
      format: { type: 'string' },
    },
  });
  return { values: values as Values, positionals, execArgs };
}

/** Emit the selection as shell code, or explain why nothing happened. */
function applySelection(ctx: Ctx, profile: Profile, region: string | undefined): number {
  recordSelection(ctx.config, profile.name, region);
  ctx.configDirty = true;

  const shell = resolveShell();
  const code = renderEnv(shell, selectionEnv(profile.name, region));

  const summary = `${green('✓')} ${bold(profile.name)} ${dim('·')} ${cyan(region ?? 'no region')} ${dim(`(${describe(profile)})`)}`;

  if (ctx.emitShell && wrapperActive()) {
    out(code);
    say(summary);
    return 0;
  }

  // No wrapper: print the exports so the selection is never silently lost, and
  // say once how to make this automatic.
  say(summary);
  say('');
  out(code);
  say('');
  say(dim(`the shell integration is not active, so the above was printed instead of applied`));
  say(dim(`install it with: ${installHint(resolveShell())}`));
  return 0;
}

function resolveShell() {
  const requested = process.env.AWSX_SHELL;
  if (requested && isShell(requested)) return requested;
  return detectShell();
}

/** Region precedence: explicit flag, then per-profile memory, then config. */
function resolveRegion(ctx: Ctx, profile: Profile, values: Values): string | undefined {
  if (values['no-region']) return undefined;
  if (typeof values.region === 'string' && values.region !== '') return values.region;
  if (values['keep-region']) return process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  return (
    ctx.config.perProfile[profile.name]?.lastRegion ??
    profile.region ??
    ctx.config.settings.regions[0]
  );
}

async function select(ctx: Ctx, values: Values, positionals: string[]): Promise<number> {
  if (ctx.profiles.length === 0) {
    say(red('no profiles found in ~/.aws/config or ~/.aws/credentials'));
    return 1;
  }

  const query = positionals.join(' ').trim();

  // `awsx -` toggles back to the previously selected profile.
  if (query === '-') {
    const previous = ctx.config.previousProfile;
    if (!previous) {
      say(red('no previous profile to switch back to'));
      return 1;
    }
    const profile = ctx.byName.get(previous);
    if (!profile) {
      say(red(`previous profile "${previous}" no longer exists`));
      return 1;
    }
    return applySelection(ctx, profile, resolveRegion(ctx, profile, values));
  }

  let profile: Profile | undefined;

  const explicit = typeof values.profile === 'string' ? values.profile : undefined;
  if (explicit) {
    profile = ctx.byName.get(explicit);
    if (!profile) {
      say(red(`no such profile: ${explicit}`));
      return 1;
    }
  } else if (query !== '') {
    // A query that lands on exactly one profile (or an exact name) skips the UI.
    const exact = ctx.byName.get(query);
    const filtered = exact
      ? [exact]
      : orderProfiles(query, {
          profiles: ctx.profiles,
          recents: ctx.config.recents,
          ...pickerDefault(ctx),
        });
    const only = filtered[0];
    if (only === undefined) {
      say(red(`nothing matches "${query}"`));
      return 1;
    }
    if (filtered.length === 1) profile = only;
    else if (!process.stdin.isTTY) {
      say(red(`"${query}" matches ${filtered.length} profiles — be more specific or use --profile`));
      return 1;
    } else {
      profile = await pickProfile({
        profiles: filtered,
        tokens: ctx.tokens,
        recents: ctx.config.recents,
        ...(ctx.config.lastProfile ? { lastProfile: ctx.config.lastProfile } : {}),
        message: `AWS profile matching "${query}"`,
      });
    }
  } else {
    if (!process.stdin.isTTY) {
      say(red('not a terminal — pass a query, --profile <name>, or use `awsx list`'));
      return 1;
    }
    profile = await pickProfile({
      profiles: ctx.profiles,
      tokens: ctx.tokens,
      recents: ctx.config.recents,
      // The current shell's profile beats the remembered one.
      ...pickerDefault(ctx),
    });
  }

  if (profile.isProd && ctx.config.settings.confirmProd && !values.yes && process.stdin.isTTY) {
    if (!(await confirmProd(profile))) {
      say(dim('cancelled'));
      return 130;
    }
  }

  let region = resolveRegion(ctx, profile, values);
  const wantsRegionPrompt =
    !values['no-region'] &&
    !values['keep-region'] &&
    typeof values.region !== 'string' &&
    region === undefined &&
    process.stdin.isTTY;
  if (wantsRegionPrompt) {
    region = await pickRegion({ shortlist: ctx.config.settings.regions });
  }

  await maybeOfferLogin(ctx, profile);
  return applySelection(ctx, profile, region);
}

function pickerDefault(ctx: Ctx): { lastProfile?: string } {
  const current = process.env.AWS_PROFILE;
  if (current && ctx.byName.has(current)) return { lastProfile: current };
  if (ctx.config.lastProfile && ctx.byName.has(ctx.config.lastProfile)) {
    return { lastProfile: ctx.config.lastProfile };
  }
  return {};
}

/** An expired SSO token means the selection would fail on first use. */
async function maybeOfferLogin(ctx: Ctx, profile: Profile): Promise<void> {
  const status = tokenStatus(profile, ctx.tokens);
  if (status.state === 'not-sso') return;
  if (status.state === 'valid') return;
  if (!process.stdin.isTTY) return;

  const label = status.state === 'expired' ? 'expired' : 'not cached';
  say(yellow(`the SSO token for ${profile.name} is ${label}`));
  if (!(await confirmPrompt('run `aws sso login` now?'))) return;
  const code = await ssoLogin(profile.ssoSession, profile.name);
  if (code === 0) ctx.tokens = loadTokenIndex();
  else say(red(`aws sso login exited with ${code}`));
}

async function selectRegionOnly(ctx: Ctx, values: Values, positional: string | undefined): Promise<number> {
  const explicit = positional ?? (typeof values.region === 'string' ? values.region : undefined);
  const currentProfile = process.env.AWS_PROFILE ?? ctx.config.lastProfile;
  const shortlist = ctx.config.settings.regions;

  let region: string;
  if (explicit) region = explicit;
  else if (!process.stdin.isTTY) {
    say(red('not a terminal — pass a region name'));
    return 1;
  } else {
    const current =
      process.env.AWS_REGION ??
      (currentProfile ? ctx.config.perProfile[currentProfile]?.lastRegion : undefined) ??
      (currentProfile ? ctx.byName.get(currentProfile)?.region : undefined);
    region = await pickRegion({ shortlist, ...(current ? { current } : {}) });
  }

  if (currentProfile) {
    const state = (ctx.config.perProfile[currentProfile] ??= {});
    state.lastRegion = region;
  }
  ctx.config.lastRegion = region;
  ctx.configDirty = true;

  const shell = resolveShell();
  const code = renderEnv(shell, [
    { name: 'AWS_REGION', value: region },
    { name: 'AWS_DEFAULT_REGION', value: region },
  ]);
  if (ctx.emitShell && wrapperActive()) {
    out(code);
    say(`${green('✓')} region ${cyan(region)}`);
    return 0;
  }
  out(code);
  say(dim(`shell integration not active — install it with: ${installHint(shell)}`));
  return 0;
}

function list(ctx: Ctx, json: boolean): number {
  if (json) {
    out(
      JSON.stringify(
        ctx.profiles.map((profile) => ({
          ...profile,
          sso: tokenStatus(profile, ctx.tokens),
        })),
        null,
        2,
      ),
    );
    return 0;
  }
  for (const profile of ctx.profiles) {
    const status = tokenStatus(profile, ctx.tokens);
    const freshness =
      status.state === 'valid'
        ? green(`✓ ${humanizeRemaining(status.expiresAt)}`)
        : status.state === 'expired'
          ? red('✗ expired')
          : status.state === 'missing'
            ? yellow('· login')
            : dim(profile.kind);
    const marker = profile.name === ctx.config.lastProfile ? yellow('★') : ' ';
    out(
      `${marker} ${profile.isProd ? red(profile.name) : profile.name}  ${dim(
        `${profile.accountId ?? '—'}  ${profile.region ?? '—'}`,
      )}  ${freshness}`,
    );
  }
  return 0;
}

async function status(ctx: Ctx, json: boolean): Promise<number> {
  const name = process.env.AWS_PROFILE ?? process.env.AWS_DEFAULT_PROFILE;
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  const profile = name ? ctx.byName.get(name) : undefined;

  const identity = name
    ? await callerIdentity(name, region)
    : ({ ok: false, error: 'AWS_PROFILE is not set' } as const);

  if (json) {
    out(
      JSON.stringify(
        {
          profile: name ?? null,
          region: region ?? null,
          known: Boolean(profile),
          details: profile ?? null,
          sso: profile ? tokenStatus(profile, ctx.tokens) : null,
          identity: identity.ok ? identity.identity : null,
          error: identity.ok ? null : identity.error,
          lastProfile: ctx.config.lastProfile ?? null,
          previousProfile: ctx.config.previousProfile ?? null,
          shellIntegration: wrapperActive(),
        },
        null,
        2,
      ),
    );
    return identity.ok ? 0 : 1;
  }

  if (!name) {
    say(`${yellow('AWS_PROFILE is not set')} — run ${bold('awsx')} to pick one`);
    return 1;
  }
  out(`${bold('profile')}  ${name}${profile ? dim(`  (${describe(profile)})`) : dim('  (not in config)')}`);
  out(`${bold('region')}   ${region ?? dim('unset')}`);
  if (profile) {
    const token = tokenStatus(profile, ctx.tokens);
    if (token.state === 'valid') out(`${bold('sso')}      ${green(`valid for ${humanizeRemaining(token.expiresAt)}`)}`);
    else if (token.state === 'expired') out(`${bold('sso')}      ${red('expired')} — run ${bold('awsx login')}`);
    else if (token.state === 'missing') out(`${bold('sso')}      ${yellow('no cached token')} — run ${bold('awsx login')}`);
  }
  if (identity.ok) {
    out(`${bold('identity')} ${green(identity.identity.Arn)}`);
    out(`${bold('account')}  ${identity.identity.Account}`);
  } else {
    out(`${bold('identity')} ${red(identity.error)}`);
  }
  return identity.ok ? 0 : 1;
}

async function login(ctx: Ctx, values: Values): Promise<number> {
  const name =
    (typeof values.profile === 'string' ? values.profile : undefined) ??
    process.env.AWS_PROFILE ??
    ctx.config.lastProfile;
  if (!name) {
    say(red('no profile selected — run `awsx` first, or pass --profile <name>'));
    return 1;
  }
  const profile = ctx.byName.get(name);
  if (!profile) {
    say(red(`no such profile: ${name}`));
    return 1;
  }
  if (profile.kind !== 'sso') {
    say(yellow(`${name} is not an SSO profile (${describe(profile)}) — nothing to log in to`));
    return 1;
  }
  return ssoLogin(profile.ssoSession, profile.name);
}

async function exportCmd(ctx: Ctx, values: Values): Promise<number> {
  const name = process.env.AWS_PROFILE ?? ctx.config.lastProfile;
  if (!name) {
    say(red('no profile selected — run `awsx` first'));
    return 1;
  }

  const shell = resolveShell();
  const format: ExportFormat =
    (typeof values.format === 'string' ? (values.format as ExportFormat) : undefined) ??
    (shell === 'fish' ? 'fish' : shell === 'pwsh' ? 'powershell' : 'env');

  const evalable = ctx.emitShell && wrapperActive();
  if (!evalable && !values.print) {
    // Refuse to spray short-lived secrets across a terminal by accident.
    say(red('refusing to print credentials to a terminal'));
    say(dim(`install the shell integration (${installHint(shell)}) so they can be eval'd,`));
    say(dim('or pass --print if you really want them on stdout'));
    return 1;
  }

  const result = await exportCredentials(name, format);
  if (!result.ok) {
    say(red(`could not export credentials for ${name}: ${result.error}`));
    return 1;
  }
  out(result.output);
  if (evalable) say(`${green('✓')} credentials for ${bold(name)} exported into this shell`);
  return 0;
}

async function exec(ctx: Ctx, values: Values, execArgs: string[]): Promise<number> {
  if (execArgs.length === 0) {
    say(red('nothing to run — usage: awsx exec -- <command> [args...]'));
    return 1;
  }
  const name =
    (typeof values.profile === 'string' ? values.profile : undefined) ??
    process.env.AWS_PROFILE ??
    ctx.config.lastProfile;
  if (!name) {
    say(red('no profile selected — run `awsx` first, or pass --profile <name>'));
    return 1;
  }
  const profile = ctx.byName.get(name);
  if (!profile) {
    say(red(`no such profile: ${name}`));
    return 1;
  }
  const region =
    (typeof values.region === 'string' ? values.region : undefined) ??
    process.env.AWS_REGION ??
    ctx.config.perProfile[name]?.lastRegion ??
    profile.region;

  const [command, ...rest] = execArgs as [string, ...string[]];
  return runWithEnv(command, rest, {
    AWS_PROFILE: name,
    AWS_DEFAULT_PROFILE: name,
    AWS_REGION: region,
    AWS_DEFAULT_REGION: region,
  });
}

async function doctor(ctx: Ctx): Promise<number> {
  let problems = 0;
  const ok = (label: string, detail: string) => out(`${green('✓')} ${bold(label)} ${dim(detail)}`);
  const bad = (label: string, detail: string) => {
    problems += 1;
    out(`${red('✗')} ${bold(label)} ${detail}`);
  };
  const warn = (label: string, detail: string) => out(`${yellow('!')} ${bold(label)} ${detail}`);

  try {
    const { info, refreshed } = await ensureAwsCli(ctx.config);
    if (refreshed) ctx.configDirty = true;
    ok('aws cli', `v${info.version}`);
  } catch (err) {
    bad('aws cli', err instanceof AwsCliMissingError ? 'not found on PATH — install with `brew install awscli`' : String(err));
  }

  const shell = resolveShell();
  if (wrapperActive()) ok('shell integration', `active (${shell})`);
  else warn('shell integration', `not active — install with: ${installHint(shell)}`);

  ok('aws config', `${ctx.profiles.length} profiles from ~/.aws`);
  ok('awsx config', ctx.configPath);
  if (ctx.config.lastProfile) ok('last profile', ctx.config.lastProfile);

  // The AWS CLI is the oracle: any disagreement is a parser gap worth seeing.
  try {
    const fromCli = new Set(await listProfiles());
    const mine = new Set(ctx.byName.keys());
    const missing = [...fromCli].filter((name) => !mine.has(name));
    const extra = [...mine].filter((name) => !fromCli.has(name));
    if (missing.length === 0 && extra.length === 0) {
      ok('parser', `agrees with \`aws configure list-profiles\` (${fromCli.size} profiles)`);
    } else {
      bad(
        'parser',
        `disagrees with the AWS CLI — missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'}`,
      );
    }
  } catch (err) {
    warn('parser', `could not compare with the AWS CLI: ${String(err)}`);
  }

  return problems === 0 ? 0 : 1;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  if (err instanceof CancelledError) {
    process.exitCode = 130;
  } else if (err instanceof AwsCliMissingError) {
    say(red('the AWS CLI (`aws`) is required but was not found on PATH'));
    say(dim('install it with `brew install awscli`, or see https://aws.amazon.com/cli/'));
    process.exitCode = 1;
  } else {
    say(red(err instanceof Error ? err.message : String(err)));
    process.exitCode = 1;
  }
}
