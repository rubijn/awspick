# ADR-0001: Interactive CLI for selecting AWS_PROFILE and AWS_REGION

**Status:** Accepted — implemented 2026-08-14, see [Implementation notes](#implementation-notes)
**Date:** 2026-08-14
**Deciders:** Julien Bennamias — sole approver for internal tooling
**Supersedes:** nothing

## Context

Ground infrastructure runs across many AWS accounts. On this machine alone:

| Source | Count |
|---|---|
| `~/.aws/config` profiles | 52 (51 of them SSO-backed via `sso_session`) |
| `~/.aws/config` `[sso-session]` blocks | 3 (`Corp_SSO`, `partner-sso`, `training-sso`) |
| `~/.aws/credentials` sections | 43 (37 are `role_arn` + `source_profile` chains, 3 static key pairs) |
| Unique profile names across both files | **92** |

Today switching context means `export AWS_PROFILE=acme-preprod-AdministratorAccess`
typed from memory, or grepping the config file. Names are long, similar
(`acme-observability-dev-…` vs `acme-observability-prod-…`), and the
prod/dev distinction is one token deep in a 45-character string. The failure mode
is not inconvenience, it is **running a command against the wrong account**.

Requirements, as stated:

1. Interactive terminal UI to pick profile and region.
2. Reads the real `~/.aws/config` and `~/.aws/credentials` — no separate registry to maintain.
3. Installation must be trivial (`npx`-class, one line, no build step for the user).
4. If Node: TypeScript, and follow current Node CLI conventions.
5. **The AWS CLI v2 is a hard prerequisite and the tool may depend on it and shell out to it.**
6. **Type-to-search over profile names** — a 92-item list is not navigable by arrow keys.
7. **The last selected profile is the default proposal** — reopening the picker highlights it, so re-confirming yesterday's context is one keypress.
8. **All persisted state and user settings live in `~/.config/awsx/config.json`** — one file, one path, no second state file to reason about.

Non-functional constraints worth naming upfront:

- **Startup latency matters.** This runs dozens of times a day, interactively. Anything over ~300 ms feels broken.
- **Read-only by default.** The tool must never rewrite `~/.aws/credentials`, and must not silently mutate `~/.aws/config`.
- **Shell is zsh** (`/bin/zsh`, `~/.zshrc` present) — but the design should not hard-depend on zsh.

### The AWS CLI is a dependency, not an optional accelerant

`aws` v2 is assumed present (`/usr/local/bin/aws`, **aws-cli/2.34.30**, Python 3.14.4,
arm64 on this machine). That is a deliberate constraint, not an observation: the
tool is allowed to shell out, so anything AWS already implements correctly should
not be reimplemented. Measured on this machine, one `aws` invocation costs
**~240 ms** wall clock — cheap enough for one-shot actions, far too expensive for
anything inside an interactive filter loop. That single number decides the whole
delegation boundary:

| Concern | Owner | Why |
|---|---|---|
| Enumerate + describe 92 profiles for the picker | **`awsx`** (direct file read) | needs region/account/role/session per profile, redrawn on every keystroke; `aws` gives names only, at 240 ms a call |
| Authoritative single-value read | `aws configure get <key> --profile X` | resolves inheritance exactly as the CLI does |
| Cross-check our parser's profile list | `aws configure list-profiles` | differential oracle in tests and in `awsx doctor` |
| Refresh an expired SSO token | `aws sso login --sso-session <name>` | full device-authz + browser flow; reimplementing it would be reckless |
| Prove who we actually are | `aws sts get-caller-identity` | the only real answer, and it validates the whole chain |
| Materialize credentials for tools that need keys | `aws configure export-credentials --format env` | handles SSO, role chains and `credential_process` for us (needs CLI ≥ 2.9) |

`awsx` therefore preflights `aws --version` and fails with an install hint if the
CLI is absent or v1 — the failure is explicit at startup, never a mysterious
error mid-flow.

`aws configure export-credentials` also emits **`env`, `env-no-export`,
`powershell`, `windows-cmd` and `fish`** formats, which maps almost one-to-one
onto the `awsx init <shell>` generators below. Where the shape of a shell's
`export` syntax is already encoded in the AWS CLI, match it rather than invent it.

### The constraint that drives the whole design

A child process cannot mutate its parent's environment. `AWS_PROFILE` and
`AWS_REGION` live in the shell that invoked the tool. No Node program — however
it is installed — can `export` into that shell. Every design below is really a
different answer to *"how does the selection escape the child process?"*, and
that is the decision this ADR exists to make. It is also why `npx` cannot be the
whole install story: `npx <tool>` runs a child process, so it can select but not
apply.

## Decision

Build **`awsx`**: an ESM TypeScript CLI published to npm under a scoped name,
whose primary interface is a fuzzy-searchable profile picker, and which
**communicates the selection by printing shell code to stdout, evaluated by a
tiny shell function installed once from the tool's own `init` output.**

Concretely, the user does this once:

```bash
# ~/.zshrc
eval "$(npx -y awspick init zsh)"     # or: eval "$(awsx init zsh)" after a global install
```

which defines:

```zsh
awsx() {
  local out
  out="$(command awsx --emit-shell "$@")" || return $?
  [[ -n $out ]] && eval "$out"
}
```

and from then on:

```
$ awsx                     # TUI: pick profile → pick region → env is set in this shell
$ awsx prod                # non-interactive: unambiguous prefix/fuzzy match, no TUI
$ awsx -                   # toggle back to the previous selection
$ awsx region eu-west-3    # region only
$ awsx status              # current profile/region + sts get-caller-identity + SSO expiry
$ awsx login               # aws sso login for the current profile's sso-session
$ awsx exec -- terraform plan   # one-shot, no shell mutation
$ awsx export              # materialize real keys via aws configure export-credentials
$ awsx doctor              # verify aws v2, shell wrapper, parser-vs-CLI agreement
```

The wrapper is ~6 lines, is generated by the tool (`init zsh|bash|fish|pwsh`), and
is the only thing the user installs into their shell. Everything else is a normal
npm package plus the AWS CLI the user already has.

When the chosen profile's SSO token is expired, the picker offers the refresh
inline and runs `aws sso login --sso-session <name>` rather than handing back a
selection that fails on first use.

## Options Considered

### How the selection escapes the process

#### Option A: print shell code, `eval` it from a shell function *(chosen)*

| Dimension | Assessment |
|---|---|
| Complexity | Low — one function per shell, generated by the tool |
| Install cost | One `eval` line in `~/.zshrc` |
| Correctness | Exact: affects the calling shell only |
| Precedent | `direnv`, `zoxide`, `fnm`, `nvm`, `pyenv`, `starship` all do this |
| Failure mode | Forgetting the `eval` line → tool prints exports instead of applying them (self-explaining) |

**Pros:** the only approach that actually sets the variable in the current shell;
scoped per-terminal, so two tabs can hold two accounts; no global state to
corrupt; trivially testable (assert on stdout, no PTY needed).
**Cons:** requires a shell-config edit, so "zero install" is technically false;
needs a small generator per shell family.

#### Option B: rewrite `[default]` in `~/.aws/config`

| Dimension | Assessment |
|---|---|
| Complexity | Medium — must preserve comments, ordering, indented sub-keys |
| Install cost | None |
| Blast radius | **Global**: every shell, every IDE, every running `terraform`, every MCP server |

**Pros:** genuinely zero shell integration; works for tools that ignore `AWS_PROFILE`.
**Cons:** rejected. Mutating a 92-profile config file that already contains a
`[profile default]` block, from a tool whose job is to reduce
wrong-account risk, is backwards — a background `terraform apply` in another tab
silently changes account mid-run. Also unavoidably lossy on round-trip formatting.

#### Option C: spawn a subshell with the environment pre-set

| Dimension | Assessment |
|---|---|
| Complexity | Low |
| Install cost | None — pure `npx` |
| UX | Nested shells; `exit` semantics; broken prompt/history integration |

**Pros:** no shell integration at all; strong isolation (`aws-vault exec` model).
**Cons:** shell nesting is confusing at depth, and the user asked for a switcher,
not a launcher. **Kept as a secondary mode** (`awsx exec -- <cmd>`), which is the
right primitive for scripts and CI, and is what the no-`eval` fallback advertises.

#### Option D: state file + shell prompt hook (`precmd`) reads it

| Dimension | Assessment |
|---|---|
| Complexity | Medium |
| Correctness | Racy: leaks selection into *all* shells at their next prompt |

**Cons:** rejected as primary — losing per-tab independence is the exact
property that makes multi-account work safe. `~/.config/awsx/config.json` is still
used, but only to *remember* (default selection, `awsx -`, prompt decoration) —
never to *apply*.

**Decision on this axis: A, with C as the scripting/CI mode and a hard fallback.**
Without the `eval` line the binary still works: it detects that it was not called
through the wrapper (an env marker set by the wrapper), prints the `export` lines
to **stdout** and a one-line hint to **stderr** explaining `awsx init zsh`. Never
silently no-op.

### What actually gets exported

Having the AWS CLI available opens a second axis that was previously closed:
`aws configure export-credentials --format env` will resolve SSO, role chains and
`credential_process` and hand back real keys. So the tool could export either a
pointer or the credentials themselves.

| | exported | Pros | Cons |
|---|---|---|---|
| **Pointer** *(default)* | `AWS_PROFILE`, `AWS_REGION` | nothing secret enters the environment; tokens refresh and rotate on their own; survives token expiry; every AWS SDK understands it | useless to tools that read only `AWS_ACCESS_KEY_ID` |
| **Materialized** (`awsx export`) | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` | works with anything that speaks raw keys — older SDKs, containers, some Terraform providers, third-party tooling | short-lived secrets sit in the shell environment and leak into child processes and `ps`-visible env; expire mid-session with confusing errors; must never be echoed or logged |

Default to the pointer; keep materialization as an explicit, separately-named
command so it is always a deliberate act. When `awsx export` runs, delegate
entirely to `aws configure export-credentials` — never read `aws_secret_access_key`
out of `~/.aws/credentials` ourselves, and never write credential values to
`~/.config/awsx/config.json` or to any log.

Note also that `AWS_PROFILE` set in the environment overrides
`aws configure get`'s notion of the current profile for child processes, so all
internal `aws` invocations pass `--profile` explicitly rather than relying on
inherited environment.

### How the tool is installed

| Option | Cold start | Warm start | Simplicity | Verdict |
|---|---|---|---|---|
| `npx -y awspick` every call | ~2–4 s (download) | ~400–900 ms (npx resolution overhead on every run) | best first-run story | **Try/`init` only** |
| `npm i -g awspick` | one command | ~60–120 ms | one extra step | **Recommended for daily use** |
| Single-file bundle, no deps at runtime | — | fastest | needs `tsup`/`esbuild` step | **Yes — bundle at publish time** |
| Standalone binary (Node SEA / Bun compile) | — | ~20 ms | per-platform artifacts, release CI, Gatekeeper signing on macOS | **Not now** — revisit if latency bites |

Publish an **npm package that bundles its dependencies into one JS file**, so a
global install is one `node_modules` entry and startup is a single module load.
`npx` remains the discovery path (`npx awspick init zsh`) and the printed
snippet recommends the global install. Because the `eval` line is needed anyway,
paying it once alongside `npm i -g` is not extra friction — it *is* the install.

> Naming note: bare `awsp` is already taken on npm (and by a well-known Python
> tool). An alternative name (`awspick`, or a scoped `@<org>/awsx`) avoids the
> name fight while keeping the short `bin` name — `bin` names need not be unique on npm.

### Config parsing

| Option | Pros | Cons |
|---|---|---|
| Hand-rolled INI reader *(chosen)* | zero deps, ~150 LOC, full control over AWS quirks, instant startup | must encode the quirks ourselves and test them |
| `@aws-sdk/shared-ini-file-loader` | exactly the SDK's own semantics, maintained by AWS | pulls SDK packages; still needs our own merge/resolve layer on top |
| `ini` / `js-ini` npm | generic and small | wrong on AWS's nested sub-sections; still needs the quirk layer |
| Shell out to `aws configure list-profiles` | authoritative, and the CLI is a guaranteed dependency | **~240 ms measured** per call, and it returns names only — no region, account, role or session, all of which the picker displays |

The quirks that must be handled, all present in this machine's files:

- `[profile NAME]` in `config` but bare `[NAME]` in `credentials`; `[default]` is unprefixed in both.
- `[sso-session NAME]` blocks holding `sso_start_url` / `sso_region` / `sso_registration_scopes`, referenced by profiles via `sso_session`.
- Indented continuation sub-keys (nested maps) must not be read as top-level keys.
- Role chains: `role_arn` + `source_profile` (37 profiles here) — the effective account is in the ARN, not in `sso_account_id`.
- Precedence: `credentials` wins over `config` for credential keys; `config` supplies `region` and non-credential settings.
- Both files are `0600`; never log their values, never write them back.

Vendoring the parser keeps runtime deps at ~2 packages (the prompt library), which
is what makes the bundle small and the startup fast. Correctness is bought with
fixture tests, not with a dependency — and now that the AWS CLI is guaranteed
present, it is also bought with a **differential test**: assert that
`resolveProfiles()` yields exactly the set `aws configure list-profiles` reports,
and that `awsx status --json` agrees with `aws configure get region` for a sample
of profiles. `awsx doctor` runs the same comparison against the user's real
config, so a parser gap shows up as a diagnosable warning rather than a silently
missing profile in the picker. The CLI is the oracle; it is just not in the hot
path.

### Terminal UI library

Registry figures checked 2026-08-14 (`npm view` + npm downloads API):

| Option | Version / weekly downloads | Pros | Cons |
|---|---|---|---|
| **`@inquirer/prompts`** — specifically **`@inquirer/search`** *(chosen)* | 8.5.2 / 35.2M · search 4.2.1 / 29.9M, published 2026-05 | de-facto standard; **`search` is a purpose-built async filter-as-you-type prompt for long lists** — exactly this interaction; modular so only the prompts used are bundled; sane non-TTY and `NO_COLOR` behaviour; supports an initial/default value | marginally heavier than clack; ESM-first |
| `@clack/prompts` | 1.7.0 / 17.7M, published 2026-07 | smallest and prettiest for linear "ask 3 questions" flows | long-list search is the weak spot, and that *is* the core interaction here |
| `ink` (React in the terminal) | 7.1.1 / 5.7M | real layout engine — the right answer for a multi-pane dashboard | React + reconciler startup cost to render one list; overkill and slower |
| `enquirer` | 2.4.1 / 33.5M, **last published 2023** | rich prompt set, good autocomplete | effectively frozen; CJS-era |
| `prompts` | 2.4.2 / 56.4M, **last published 2023** | tiny, huge install base | unmaintained; downloads are transitive legacy, not a health signal |
| `blessed` / `neo-blessed` | 0.1.81 / 1.4M, 2024 | full-screen TUI widgets | unmaintained; wrong weight class |
| shell out to `fzf` | — | best-in-class matching, instant | external binary; the AWS CLI is a justified prerequisite, a second one is not |

Rule of thumb behind the choice: **match the library to the interaction, not to the
download count.** One searchable list of 92 rows → `@inquirer/search`. A handful of
sequential questions → `@clack/prompts`. A live multi-pane dashboard → `ink`.
Anything last published in 2023 is out regardless of downloads.

92 items means the interaction *is* fuzzy search, so pick the library whose
long-list story is strongest — `@inquirer/search` exists precisely for this.
Filtering matches against profile name, account ID and role name, so
`prod skyw`, `9940`, or `observ` all converge quickly. Scoring is a bundled
matcher (subsequence match + prefix and word-boundary bonuses, `-` and `_`
treated as word separators, case-insensitive) rather than a dependency;
`fuzzysort` is the fallback if hand-rolled ranking disappoints.

The picker shows columns, because the profile name alone is not enough to be safe:

```
    profile                                account       role                 region      sso
❯ ★ acme-prod-AdministratorAccess          1111xxxxxxxx  AdministratorAccess  eu-west-1   ✓ 7h
    acme-preprod-AdministratorAccess       2222xxxxxxxx  AdministratorAccess  eu-west-1   ✓ 7h
    acme-dev-ObservabilityEngineers        3333xxxxxxxx  Observability…       eu-west-1   ✗ expired
    legacy_prod                  (chained) 4444xxxxxxxx  role: OrgAdmin       —           —
```

Production profiles are visually marked (name heuristic `prod|prd` plus an
overridable allow-list in `~/.config/awsx/config.json`). This is the single
highest-value feature for a 92-account estate and costs almost nothing.

### Default selection and ordering

The picker opens with the **last selected profile highlighted** (`★` above), so
the common case — "same account as yesterday" — is Enter. Concretely:

- **Cursor** starts on `lastProfile` from `~/.config/awsx/config.json`. `@inquirer/select`/`search` take a `default`/initial value, so this is configuration, not custom rendering.
- **Order** with an empty query: last selected first, then the rest of `recents` most-recent-first, then everything else alphabetically. Once the user types, relevance score wins and recency is only a tie-breaker — otherwise a stale favourite outranks an exact match, which is the wrong kind of surprise.
- **Region** likewise defaults to the last region used *with that profile* (`perProfile[name].lastRegion`), falling back to the profile's own `region` key.
- **If `lastProfile` no longer exists** in the config files (profiles here churn), fall back silently to plain alphabetical order and drop the stale entry on next write — never error, never highlight a profile that cannot be used.
- `awsx` with no argument in a shell that already has `AWS_PROFILE` set highlights *that* profile instead, since the current context beats the remembered one.
- `awsx -` swaps to `previousProfile`, the shell-`cd -` gesture, for ping-ponging between two accounts (the actual daily pattern in a prod/dev pair).

### `~/.config/awsx/config.json` — one file for settings and state

Per the requirement, there is exactly one file, at `~/.config/awsx/config.json`
(honouring `$XDG_CONFIG_HOME` when set):

```jsonc
{
  "version": 1,
  "lastProfile": "acme-prod-AdministratorAccess",
  "previousProfile": "acme-dev-AdministratorAccess",
  "lastRegion": "eu-west-1",
  "recents": ["acme-prod-AdministratorAccess", "sandbox", "legacy_prod"],
  "perProfile": {
    "acme-prod-AdministratorAccess": { "lastRegion": "eu-west-1", "uses": 34 }
  },
  "settings": {
    "prodPatterns": ["prod", "prd"],
    "prodProfiles": ["tfstate"],
    "regions": ["eu-west-1", "eu-west-3", "us-east-1", "me-south-1"],
    "recentsLimit": 10,
    "confirmProd": false
  }
}
```

Merging mutable state into a hand-editable file has one real cost — the tool
rewrites a file the user also edits — so: JSON (no comments to destroy),
**atomic writes** (write `config.json.tmp`, `rename()`), unknown keys preserved
verbatim on rewrite, `0600`, and a corrupt or unparseable file is a warning plus
in-memory defaults, never a crash. It contains no secrets: profile names, regions
and counters only. `settings` is the half a human edits; the rest the tool owns.
`awsx doctor` prints the resolved path and validates the shape.

### Where the region comes from

Precedence when a profile is chosen: `perProfile[name].lastRegion` (what you used
with this profile last time) → the profile's own `region` key in `~/.aws/config` →
`sso_region` of its session → `settings.regions[0]`. The region picker is seeded
from `settings.regions` (the shortlist a human maintains — here plausibly
`eu-west-1`, `eu-west-3`, `me-south-1`, `us-east-1`) with a bundled full region
list behind it and free-text entry always allowed, so a brand-new region is never
blocked by a stale list. No `ec2:DescribeRegions` call: it needs credentials and
network, which defeats a sub-300 ms interactive tool.

### Node/TypeScript conventions to follow

- `"type": "module"`, ESM only; target Node 20+ (`engines.node: ">=20"`); this machine is on 24.14.1.
- `bin` entry with a `#!/usr/bin/env node` shebang, bundled with `tsup` (esbuild) to one file; `files` allow-list so the tarball stays tiny.
- Preflight `aws --version` once per run (result cached in `~/.config/awsx/config.json` keyed by the `aws` binary's mtime, so it is not 240 ms every invocation); require v2, and fail with a `brew install awscli` / official-installer hint if missing.
- Shell out with `node:child_process` `execFile` (never `exec`, never a shell string) so profile names — user-controlled text from a config file — can never be interpreted as shell syntax. Pass `--profile` explicitly, and scrub `AWS_PROFILE`/`AWS_REGION` from the child env when the point of the call is to read config rather than inherit it.
- Arg parsing: built-in `node:util` `parseArgs` — the command surface is ~6 verbs, which does not justify `commander`/`yargs` in a latency-sensitive binary.
- Respect `NO_COLOR`, `TERM=dumb`, and non-TTY stdout (non-TTY ⇒ never draw a UI; either resolve non-interactively or exit with a clear error).
- Machine-readable escape hatch: `--json` on `status`/`list`.
- Exit codes: `0` selected, `1` runtime error, `130` user cancelled (Ctrl-C) — the wrapper must not `eval` on non-zero.
- Tests: `node:test` + fixture `config`/`credentials` files copied from real-world shapes (redacted), asserting the resolved model and the exact emitted shell text. No PTY tests needed, which is a direct benefit of Option A.
- Publish checks: `publint` + `@arethetypeswrong/cli` in CI; provenance via `npm publish --provenance` from GitHub Actions/GitLab CI.

## Trade-off Analysis

The real tension is **"as simple as possible to install"** versus **"actually sets
the variable"**. These are in direct conflict: the only zero-install options are
the ones that cannot touch the calling shell (C) or that mutate global state to
fake it (B). The resolution is to be honest about the one-line shell edit and make
the tool generate it, verify it, and degrade loudly without it — while keeping a
genuinely zero-install path (`npx awspick exec -- <cmd>`, and `npx awspick list`)
for machines where editing `~/.zshrc` is not wanted.

Second tension: **dependency weight versus correctness**. Parsing AWS config
"properly" argues for the AWS SDK loader; interactive latency argues for zero
deps. Resolved in favour of a vendored parser plus fixture tests, because the
quirk surface is small, static, and fully observable in the two files on disk —
with the guaranteed `aws` CLI acting as the correctness oracle in tests and in
`awsx doctor` instead of as a runtime dependency in the hot path.

Third, and reshaped by the AWS-CLI prerequisite: **what to build versus what to
delegate**. The 240 ms cost of an `aws` invocation is the whole boundary. Anything
per-keystroke or per-profile-row is ours; anything one-shot, security-sensitive,
or protocol-heavy (device-authz SSO login, credential resolution across role
chains, caller identity) is the CLI's. This is a strictly better position than the
original ADR draft, which deferred SSO login purely because implementing OIDC
device flow was not worth it — with `aws sso login` guaranteed available, the
feature costs one `execFile` call and moves into v1.

Fourth: **safety features versus scope creep**. Account/role/SSO-expiry columns
and prod marking are not in the stated ask, but they are the difference between a
convenience and a guardrail in a 92-account estate. They are cheap (all data is
already parsed) and are included.

## Consequences

**Easier**
- Switching account/region becomes two keystrokes and a filter, per terminal tab.
- The prod/dev confusion class of incident gets a visual check at the moment of switching.
- Expired SSO tokens stop being a separate chore: the picker sees the expiry and runs `aws sso login --sso-session` in place.
- `awsx status --json` gives every other script and skill one place to ask "what am I pointed at?" — backed by `sts get-caller-identity`, so it reports reality rather than intent.
- `awsx exec --` gives CI and Makefiles a profile-scoped runner without exporting anything.
- Tools that only speak raw keys are reachable via `awsx export`, without anyone hand-copying secrets.

**Harder**
- One-line `~/.zshrc` edit per machine, and per shell family the team uses (zsh here; bash/fish/pwsh generators needed for others).
- **A hard dependency on AWS CLI v2** (≥ 2.9 for `export-credentials`): the tool is now unusable on a machine without it, and inherits its behaviour changes across releases. Accepted deliberately — the alternative is reimplementing SSO device flow and credential chaining, which is strictly worse.
- The vendored INI parser is ours to maintain if AWS adds config syntax — mitigated by the differential check against `aws configure list-profiles`.
- Any tool that reads only `~/.aws/config`'s `[default]` (rather than `AWS_PROFILE`) is unaffected by a selection — an accepted consequence of rejecting Option B.

**To revisit**
- If startup latency is still felt after bundling, ship a Node SEA / Bun-compiled binary and a Homebrew tap. (A Homebrew formula could also declare `awscli` as a dependency, which npm cannot.)
- **Overlap with the existing existing internal `aws-login` helper** now that `awsx login` exists: decide whether that skill shells into `awsx`, whether `awsx` replaces it, or whether they stay parallel. Duplicated login logic is the likeliest source of confusion in this design.
- If the team adopts it, move name resolution off heuristics: publish a shared `~/.config/awsx/config.json` (or a repo-committed one) mapping accounts to environment/criticality labels.
- Whether to cache `sts get-caller-identity` results per profile (240 ms each) so `status` and the picker can show verified account IDs without a stall.

## Action Items

1. [x] Confirm the package name/scope and the `bin` name — **`awspick` on npm, `awsx` as the `bin`**; bare `awsx` is taken on npm (v1.4.2) but free on this machine's PATH.
2. [x] Scaffold: npm + TypeScript strict, ESM, `tsup` bundle, `node:test`, `publint`.
3. [x] Implement `parseIni()` + `resolveProfiles()` over redacted fixtures, including SSO sessions and `role_arn` chains.
4. [x] Implement the shell-emit contract (`--emit-shell`, wrapper-presence marker, exit codes) and `init zsh|bash|fish|pwsh` generators.
5. [x] Implement `~/.config/awsx/config.json`: schema + `version`, atomic write, unknown-key preservation, corrupt-file tolerance, `0600`, `$XDG_CONFIG_HOME` support.
6. [x] Implement the picker (`@inquirer/search`, columns, fuzzy scoring over name/account/role, prod marking) with the last-selected profile as the default highlight, recents ordering on empty query, and stale-`lastProfile` pruning; plus the region picker seeded from `settings.regions`.
7. [x] Implement `status` (with `sts get-caller-identity`), `list --json`, `exec --`, `-` (toggle), and direct-match `awsx <query>`.
8. [x] Read `~/.aws/sso/cache/*.json` (match on `startUrl`) to show token validity per profile, and wire the expired-token path to `aws sso login --sso-session <name>`.
9. [x] Implement `awsx export` as a thin pass-through to `aws configure export-credentials`, with no credential values logged or persisted.
10. [x] Implement `awsx doctor`: AWS CLI presence and version, shell-wrapper presence, config path, and parser-vs-`aws configure list-profiles` diff.
11. [x] Add the differential test (`resolveProfiles()` vs `aws configure list-profiles`) — self-skips when the AWS CLI is absent.
12. [ ] Wire `npm run check` into CI and add `npm publish --provenance`.
13. [ ] Dogfood for a week on this machine, then publish and share the one-line install internally.
14. [ ] Decide the internal `aws-login` helper overlap (see "To revisit").

## Implementation notes

Built and verified on 2026-08-14. 81 tests, `publint` clean, 33 kB tarball
(3 files), **~29 ms** startup on the real 92-profile config — an order of
magnitude under the 300 ms budget, and ~8× cheaper than a single `aws` call.

Verified against reality rather than fixtures alone:

- `awsx doctor` reports **the parser agrees with `aws configure list-profiles` on all 92 real profiles** — the differential check earns its place.
- The shell contract works in a real zsh: select → `AWS_PROFILE`/`AWS_REGION` change in the calling shell, `awsx -` toggles, `awsx region` changes only the region.
- The picker was driven through a pty: typing `acme prod` filtered 92 rows to 4 across name/account/role, and Enter applied the selection.
- SSO freshness matched the real token cache exactly, including a `Corp_SSO` token that had expired 67 seconds earlier — it read `✗ expired` while a sibling session read `✓`.

Added after first use: **`esc` quits the picker** (exit 130, nothing applied,
nothing remembered), with the key advertised in the prompt's own hint line. The
prompts ship no cancel key, so this rides on `@inquirer/core`'s context
`AbortSignal` — with a 40 ms debounce, because arrow keys are escape sequences too.

Three deviations from the ADR as written, all discovered by building it:

1. **Column layout is adaptive, not fixed.** A fixed 58-column overhead truncated names to 22 characters at 80 columns (`acme-observab…`), destroying the one column that identifies the account. The role column — usually `AdministratorAccess` on every row, so low signal — is now dropped entirely below ~100 columns so the name stays intact.
2. **`sso_region` is read from the profile as well as the `[sso-session]` block.** The ADR only described the session case; legacy inline-SSO profiles carry it directly and were left with no region at all. Caught by a fixture test.
3. **esbuild's ESM output needed a `createRequire` banner.** Some `@inquirer` dependencies are still CJS and call `require('stream')`, which the bundle stubbed with a throwing shim. Worth knowing before the next single-file bundle in this repo.

Not built, deliberately: cached `sts get-caller-identity` per profile, and a
Homebrew formula (which is where an `awscli` dependency could actually be
declared — npm cannot).
