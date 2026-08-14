/**
 * The shell contract (ADR-0001, Option A).
 *
 * A child process cannot export into its parent, so `awsx` prints shell code on
 * stdout and a shell function installed from `awsx init <shell>` evals it. The
 * function only evals for env-changing commands; everything else is passed
 * straight through so it keeps a real TTY.
 */

export const SHELLS = ['zsh', 'bash', 'fish', 'pwsh'] as const;
export type Shell = (typeof SHELLS)[number];

/** Set by the generated wrapper so we can tell whether eval will happen. */
export const WRAPPER_ENV = 'AWSX_SHELL_WRAPPER';

/** Commands the wrapper must NOT eval — they print for humans or need a TTY. */
export const PASSTHROUGH_COMMANDS = [
  'status',
  'list',
  'login',
  'exec',
  'init',
  'doctor',
  'help',
  'version',
] as const;

export function isShell(value: string): value is Shell {
  return (SHELLS as readonly string[]).includes(value);
}

/** Wrapper env var, then $AWSX_SHELL, then $SHELL, then zsh. */
export function detectShell(env: NodeJS.ProcessEnv = process.env): Shell {
  const explicit = env.AWSX_SHELL;
  if (explicit && isShell(explicit)) return explicit;
  const shellPath = env.SHELL ?? '';
  const base = shellPath.slice(shellPath.lastIndexOf('/') + 1);
  if (isShell(base)) return base;
  if (base === 'sh' || base === 'dash' || base === 'ksh') return 'bash';
  if (base === 'powershell') return 'pwsh';
  return 'zsh';
}

/** POSIX single-quote: the only safe way to pass a name from a config file. */
function posixQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function pwshQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export type EnvChange = { name: string; value: string | undefined };

/** Render env changes as code for the given shell. `undefined` means unset. */
export function renderEnv(shell: Shell, changes: readonly EnvChange[]): string {
  const lines: string[] = [];
  for (const { name, value } of changes) {
    if (value === undefined) {
      lines.push(
        shell === 'fish'
          ? `set -e ${name}`
          : shell === 'pwsh'
            ? `Remove-Item -ErrorAction SilentlyContinue Env:${name}`
            : `unset ${name}`,
      );
      continue;
    }
    lines.push(
      shell === 'fish'
        ? `set -gx ${name} ${posixQuote(value)}`
        : shell === 'pwsh'
          ? `$env:${name} = ${pwshQuote(value)}`
          : `export ${name}=${posixQuote(value)}`,
    );
  }
  return lines.join('\n');
}

/**
 * AWS reads both AWS_REGION and AWS_DEFAULT_REGION depending on the tool, so set
 * both. AWS_PROFILE covers every current SDK; AWS_DEFAULT_PROFILE is legacy but
 * free to keep aligned.
 */
export function selectionEnv(profile: string, region: string | undefined): EnvChange[] {
  return [
    { name: 'AWS_PROFILE', value: profile },
    { name: 'AWS_DEFAULT_PROFILE', value: profile },
    { name: 'AWS_REGION', value: region },
    { name: 'AWS_DEFAULT_REGION', value: region },
  ];
}

const passthroughList = PASSTHROUGH_COMMANDS.join('|');

/** The snippet `awsx init <shell>` prints, for `eval` in a shell rc file. */
export function initScript(shell: Shell, bin = 'awsx'): string {
  switch (shell) {
    case 'zsh':
    case 'bash':
      return `# ${bin} shell integration — eval "$(${bin} init ${shell})"
${bin}() {
  case "$1" in
    ${passthroughList}|-h|--help|-V|--version)
      command ${bin} "$@"
      return $?
      ;;
  esac
  local __awsx_out __awsx_ret
  __awsx_out="$(${WRAPPER_ENV}=1 AWSX_SHELL=${shell} command ${bin} --emit-shell "$@")"
  __awsx_ret=$?
  if [ $__awsx_ret -ne 0 ]; then
    return $__awsx_ret
  fi
  [ -n "$__awsx_out" ] && eval "$__awsx_out"
  return 0
}`;
    case 'fish':
      return `# ${bin} shell integration — ${bin} init fish | source
function ${bin}
  switch "$argv[1]"
    case ${PASSTHROUGH_COMMANDS.map((c) => `'${c}'`).join(' ')} '-h' '--help' '-V' '--version'
      command ${bin} $argv
      return $status
  end
  set -l out (${WRAPPER_ENV}=1 AWSX_SHELL=fish command ${bin} --emit-shell $argv)
  set -l ret $status
  if test $ret -ne 0
    return $ret
  end
  if test -n "$out"
    eval (string join \\n $out)
  end
end`;
    case 'pwsh':
      return `# ${bin} shell integration — Invoke-Expression (& ${bin} init pwsh | Out-String)
function ${bin} {
  $passthrough = @(${PASSTHROUGH_COMMANDS.map((c) => `'${c}'`).join(', ')}, '-h', '--help', '-V', '--version')
  if ($args.Count -gt 0 -and $passthrough -contains $args[0]) {
    & (Get-Command -CommandType Application ${bin} | Select-Object -First 1) @args
    return
  }
  $env:${WRAPPER_ENV} = '1'
  $env:AWSX_SHELL = 'pwsh'
  $out = & (Get-Command -CommandType Application ${bin} | Select-Object -First 1) --emit-shell @args
  $code = $LASTEXITCODE
  Remove-Item Env:${WRAPPER_ENV}, Env:AWSX_SHELL -ErrorAction SilentlyContinue
  if ($code -ne 0) { return }
  if ($out) { Invoke-Expression ($out -join "\`n") }
}`;
  }
}

/** The rc-file line to install the wrapper. */
export function installHint(shell: Shell, bin = 'awsx'): string {
  switch (shell) {
    case 'zsh':
      return `echo 'eval "$(${bin} init zsh)"' >> ~/.zshrc`;
    case 'bash':
      return `echo 'eval "$(${bin} init bash)"' >> ~/.bashrc`;
    case 'fish':
      return `echo '${bin} init fish | source' >> ~/.config/fish/config.fish`;
    case 'pwsh':
      return `Add-Content $PROFILE 'Invoke-Expression (& ${bin} init pwsh | Out-String)'`;
  }
}

export function wrapperActive(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[WRAPPER_ENV] === '1';
}
