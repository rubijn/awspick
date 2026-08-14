# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`awsx` is an interactive picker for `AWS_PROFILE` / `AWS_REGION`, published to npm as
**`awspick`** with `awsx` as the `bin` name (bare `awsx` was taken on npm). Design
rationale — including the options that were rejected and why — lives in
`docs/adr/ADR-0001-aws-profile-region-switcher.md`. Read it before changing anything
structural; it is the reason the code looks the way it does.

## Commands

```bash
npm test                              # node:test over test/*.test.ts
node --test test/store.test.ts        # one file
node --test --test-name-pattern="toggle" test/*.test.ts   # one test by name
npm run typecheck                     # tsc --noEmit
npm run build                         # tsup -> single-file dist/index.js
npm run check                         # typecheck + test + build + publint (also runs prepublish)
node src/index.ts list                # run the CLI from source (Node strips the types)
```

Tests need Node ≥ 23.6 (TypeScript runs directly via type stripping); the published
bundle only needs Node ≥ 20. `npm test` requires no network. One test compares the
parser against `aws configure list-profiles` and self-skips if the AWS CLI is absent.

**Colour is TTY-dependent, so run the suite both ways before claiming it passes:**

```bash
npm test                  # colour off (pipe, CI, agent tool call)
FORCE_COLOR=1 npm test    # colour on (what a real terminal does)
```

`colorEnabled` in `src/render.ts` is computed at module load from
`NO_COLOR`/`TERM`/`stderr.isTTY`, so a suite run through a pipe exercises a
different code path than the same suite run in a terminal. Any assertion on
rendered output must go through the `visible()` ANSI-stripping helper in
`test/render.test.ts` — asserting on raw output makes a test that passes in CI and
fails on a developer's terminal (or the reverse).

### Running against fixtures instead of your real account

Every path is env-overridable, so nothing needs to touch `~/.aws` or
`~/.config/awsx`:

```bash
AWS_CONFIG_FILE=test/fixtures/config \
AWS_SHARED_CREDENTIALS_FILE=test/fixtures/credentials \
AWSX_CONFIG_FILE=/tmp/awsx-scratch.json \
  node src/index.ts list
```

`AWSX_AWS_BIN` overrides the `aws` binary. `test/cli.test.ts` uses exactly this
pattern — copy its `awsx()` helper rather than inventing another harness.

### Verifying the shell integration end to end

The wrapper cannot be exercised by unit tests. Symlink the built binary onto PATH
and drive a real shell:

```bash
npm run build && mkdir -p /tmp/awsx-bin && ln -sf "$PWD/dist/index.js" /tmp/awsx-bin/awsx
PATH=/tmp/awsx-bin:$PATH AWSX_CONFIG_FILE=/tmp/awsx-scratch.json zsh -c '
  eval "$(awsx init zsh)"; awsx --profile <any-profile-from-awsx-list>; echo "$AWS_PROFILE $AWS_REGION"'
```

For the picker itself, `script -q /dev/null` gives a pty. Feed keystrokes with a
bounded timeout — an expired SSO token makes the tool prompt, and an unanswered
prompt hangs forever.

## Architecture

### The shell contract is the load-bearing constraint

A child process cannot export into its parent. So `awsx` **prints shell code on
stdout**, and a function installed by `awsx init <shell>` evals it. Everything else
follows from that:

- **stdout is reserved for evalable shell code.** All human-facing text goes to stderr via `say()`; only `out()` writes stdout (`src/index.ts`). The interactive prompts render on stderr too (`promptContext` in `src/picker.ts`). Printing a friendly message to stdout means the user's shell tries to execute it.
- The wrapper sets `AWSX_SHELL_WRAPPER=1`; `wrapperActive()` gates whether output is applied or merely printed with an install hint. Without the wrapper the tool must still print the exports — never silently no-op.
- `PASSTHROUGH_COMMANDS` in `src/shell.ts` is the list of verbs the wrapper must *not* eval (they print for humans or need a real TTY, e.g. `exec`, `login`, `status`). It is interpolated into all four generated wrappers, so adding a non-mutating command means adding it there or the user's shell will try to eval its output. Conversely `export` **must** stay out of that list — its whole job is to be eval'd.
- Values reaching a shell go through `renderEnv()`'s quoting. Profile names come from a config file; never interpolate one into shell text by hand.

### The AWS CLI is a hard dependency, with a latency boundary

`aws` v2 is assumed present. One invocation costs ~240 ms, which decides what is
delegated (`src/aws.ts`) versus parsed in-process:

- **In-process** (`src/ini.ts` → `src/profiles.ts`): enumerating and describing profiles, because the picker redraws on every keystroke and needs account/role/region/session that `aws configure list-profiles` does not return.
- **Delegated**: `sso login` (device flow), `sts get-caller-identity`, `configure export-credentials` (SSO + role chains + `credential_process`), `configure get`, and `configure list-profiles` as a correctness oracle for `awsx doctor` and the differential test.
- Never call `aws` inside a filter/render loop. `ensureAwsCli()` caches the version probe in the config file keyed by the binary's mtime for the same reason.
- Always `execFile` with an argv array, never a shell string, and always pass `--profile` explicitly — `cleanEnv()` strips inherited AWS vars so a call reads config rather than the current selection.

### Data flow

`src/ini.ts` parses the AWS shared-config dialect (not general INI): `[profile X]` in
config vs bare `[X]` in credentials, `[sso-session X]` blocks, indented sub-maps,
`#`/`;` comments. `src/profiles.ts` merges both files into the `Profile` model —
credentials wins for credential keys, config wins for `region`; `sso_session` is
resolved to its start URL; `role_arn` yields account + role; `region` walks the
`source_profile` chain with a cycle guard and sets `regionInherited`. `src/sso.ts`
indexes `~/.aws/sso/cache/*.json` **by the `startUrl` field inside each file** (the
filename hash scheme varies by CLI vintage) and ignores registration files that have
no `accessToken`.

### One file for settings and state

`~/.config/awsx/config.json` (`src/store.ts`) holds both the user-edited `settings`
half and `awsx`-owned state (`lastProfile`, `previousProfile`, `recents`,
`perProfile`). Because a human edits it: atomic write via tmp+rename, `0600`,
unknown keys preserved on rewrite, and a corrupt file degrades to defaults with a
warning instead of throwing. It must never contain credential values. `pruneMissing()`
drops profiles that vanished from `~/.aws` — profiles churn, and a stale
`lastProfile` must never error.

### Ordering rules the tests pin down

In `orderProfiles()` (`src/picker.ts`): with an empty query, last-selected first,
then recents newest-first, then alphabetical. With a query, **relevance wins and
recency only breaks ties** — otherwise a stale favourite outranks an exact match.
Search covers name, account ID and role name; every whitespace term must match
(`src/fuzzy.ts`).

### Other invariants

- `awsx` never writes to `~/.aws/config` or `~/.aws/credentials`.
- `awsx export` refuses to print credentials to a terminal unless the wrapper will eval them or `--print` is passed explicitly.
- Exit codes: `0` selected, `1` error, `130` user cancelled — the wrapper must not eval on non-zero, so keep `CancelledError` mapping to 130.
- **Esc quits.** The inquirer prompts have no cancel key, so `prompt()` in `src/picker.ts` watches stdin for a bare `0x1b` and aborts the prompt's `AbortSignal`; `AbortPromptError` and `ExitPromptError` both become `CancelledError`. The 40 ms `ESC_TIMEOUT_MS` debounce exists because arrow keys are *also* escape sequences — remove it and a `\x1b` arriving split from its `[A` suffix quits the picker mid-navigation. Any new prompt must go through `prompt()` to inherit this.
- Prod marking is settings-driven (`prodPatterns` / `prodProfiles`), never hardcoded names.
- `src/render.ts` `layout()` gives the name column priority and drops the role column on narrow terminals; the name is what identifies the account, so never squeeze it to keep a column that reads `AdministratorAccess` on every row.

## Conventions

- ESM only, `verbatimModuleSyntax` and `erasableSyntaxOnly` are on: no enums, namespaces, or parameter properties — the code must survive type stripping.
- **Relative imports use `.ts` extensions** (`allowImportingTsExtensions` + `rewriteRelativeImportExtensions`). A new file imported as `.js` will not resolve.
- `dist/index.js` is bundled with `noExternal: [/.*/]`. Some `@inquirer` dependencies are still CJS and call `require('stream')`, so `tsup.config.ts` injects a `createRequire` banner — do not remove it, and re-run `npm run build` after touching dependencies.
- No colour library: a few SGR helpers in `src/render.ts`, gated on `NO_COLOR` / `TERM=dumb` / TTY.
- Arg parsing is `node:util` `parseArgs`; keep it that way rather than adding a CLI framework to a latency-sensitive binary.
