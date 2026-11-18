# ADR-0002: Manage `~/.aws/config` from a JSON profile catalog (`awsx profiles`)

**Status:** Proposed
**Date:** 2026-11-18
**Deciders:** Julien Bennamias — sole approver for internal tooling
**Amends:** [ADR-0001](ADR-0001-aws-profile-region-switcher.md) — requirement 2, the "read-only" constraint, and the config/credentials precedence rule
**Supersedes:** the standalone Python script `~/.local/bin/aws-profiles`

## Context

ADR-0001 made `awsx` a strictly read-only consumer of `~/.aws/config` and
`~/.aws/credentials`: "no separate registry to maintain". Three months of use
showed that the *reading* side was not the problem. The files themselves were:

| Observation (one real machine, before cleanup) | Count |
|---|---|
| SSO profiles in `config`, auto-named by `aws configure sso` (`<Account>-<Role>`, `<Role>-<id>`) | 40 |
| SSO profiles in `credentials`, hand-named (`acme-sva-admin`, `ops-dev-net`, …) | 32 |
| `(sso-session, account, role)` triples defined twice, under two different names | 33 |
| Profile names defined in **both** files, with different `region` values | 2 |
| Profiles whose name lied about the role they assume | 2 |

The picker faithfully displayed all of it, which is to say it faithfully displayed
a mess. No amount of fuzzy search fixes 33 duplicates.

On 2026-11-18 the machine was migrated with a throwaway Python script,
`aws-profiles` (stdlib, ~450 lines, shells out to `aws`), described in
`.ai/handoff/2026-11-18-profile-config.md`. It introduced one idea worth keeping:

> **A JSON file is the source of truth for profile names; `~/.aws/config` is a
> build artifact generated from it.**

| Command | Effect |
|---|---|
| `export [--force] [--offline]` | build `~/.aws/profiles.json` from the current `config` + `credentials`, folding duplicates by `(session, account, role)`, keeping hand-chosen names, proposing `<account-slug>-<role-short>` otherwise |
| `list [--show-ids]` | table of the JSON |
| `apply [--dry-run]` | validate, back up to `~/.aws/backup/<stamp>/`, regenerate `config`, strip migrated profiles from `credentials` |
| `discover [--session S]` | list account/role pairs the SSO token can reach, append missing ones with `"new": true` |

End state: `config` holds 3 `[sso-session]` + 48 `[profile]` blocks, grouped and
generated; `credentials` holds one static key; `aws configure list-profiles`
returns 49 names; `sts get-caller-identity` succeeds on SSO, custom-role and
`role_arn`-chained samples.

The handoff asks for the script to move into this repository. It works, but it
has the defects of a one-evening migration tool, all visible in its source:

1. **Default SSO session is hardcoded** (one session name written in the source, else the first one). Same class of bug CLAUDE.md forbids for prod marking.
2. **Its INI reader is not the CLI's dialect.** Indented sub-maps (`s3 =` / `  addressing_style = path`) become top-level keys; inline comments are kept as part of values. `src/ini.ts` already handles both and is differentially tested.
3. **`apply` regenerates `config` blindly.** A profile added since the last `apply` — by `aws configure sso`, by a colleague's runbook, by `aws configure set` — is silently deleted. There is no drift detection, only a backup.
4. **`apply` rewrites `credentials` by re-joining parsed sections**, which drops every comment in the file, including in the sections it keeps.
5. **The SSO access token is passed in argv** (`aws sso list-accounts --access-token <token>`), visible to `ps` for the life of each call, one call per account in `discover`.
6. **Renames orphan state.** Renaming a profile in the JSON makes `awsx`'s `lastProfile`/`recents`/`perProfile` point at a name that no longer exists; `pruneMissing()` then silently forgets it. Shell aliases break with no warning (the migration needed four alias fixes in `~/.zshrc`, found by hand).
7. **No tests.** It was verified once, on one machine.

The migration also falsified a rule in this repo. ADR-0001 and
`src/profiles.ts` say "credentials wins for credential keys, **config wins for
`region`**". With aws-cli 2.34.30, `aws configure get region` returned the
**credentials** value for both conflicting profiles. botocore merges the
credentials profile *over* the config profile for every key. The picker has
been showing the wrong default region for any profile defined in both files.

## Decision

1. **Fix the precedence bug first, independently.** `collectRaw()` applies config, then credentials on top, for every key. Pinned by a fixture with a conflicting `region` and by the existing differential test extended to `aws configure get region`. ADR-0001's "Config parsing" bullet is amended accordingly.

2. **Add a `awsx profiles` command group** that owns `~/.aws/config` *on explicit request only*, generated from a versioned JSON catalog:

   ```
   awsx profiles import   [--force] [--offline] [--default-session S]
   awsx profiles discover [--session S] [--region R] [--dry-run]
   awsx profiles apply    [--dry-run] [--yes] [--adopt | --force]
   ```

   `profiles` joins `PASSTHROUGH_COMMANDS` in `src/shell.ts`: it never emits shell code, and `apply` prompts on the TTY.

3. **The catalog lives at `~/.aws/profiles.json`** (override: `AWSX_PROFILES_FILE`, then `settings.profilesFile`), not in `~/.config/awsx/config.json`. It holds account IDs and SSO portal URLs; `config.json` is documented as holding no such data, and the catalog describes AWS, not `awsx`. The existing file from the migration is read as-is (schema v1, `version` key optional on read, written on save).

4. **The picker stays read-only and catalog-agnostic.** `awsx`, `awsx list`, `status`, `exec`, `export` keep reading `~/.aws/config` + `credentials` only. A user who never runs `awsx profiles` sees no change. The catalog is a writer-side concept.

### What `apply` guarantees

`apply` is the only code path in `awsx` that writes under `~/.aws/`, and it writes
`~/.aws/config` only — `~/.aws/credentials` is never written by `awsx`. It earns that
with these properties, each covered by a test:

| Property | How |
|---|---|
| **Shows before it writes** | Always computes the full plan: profiles added / removed / changed (keys), renames, credentials sections to remove. `--dry-run` prints it and exits `0`. On a TTY without `--yes`, it prints it and asks. Non-TTY without `--yes` refuses (exit `1`). |
| **Detects drift** | The generated header carries `# awsx-profiles: sha256=<hash of the body>`. If the current `config` body no longer matches its hash, `apply` lists the profiles that appeared or changed outside the catalog and refuses. `--adopt` imports them into the catalog first (same folding rules as `import`), then applies; `--force` discards them (they remain in the backup). A `config` with no header (first apply) is drift by definition: `import` first, or `--force`. |
| **Never loses the previous state** | Copies `config` to `~/.aws/backup/<UTC stamp>/` (dir `0700`, file `0600`) before writing; keeps the 20 most recent backups. |
| **Writes atomically** | `tmp` in the same directory + `rename()`, mode `0600`, as `store.ts` already does. |
| **Never writes `credentials`** | `credentials` is read, never written, with no flag to change that. A non-static section whose name is in the catalog *shadows* the generated profile (decision 1: credentials wins for every key), so `apply` lists those sections by name and file line, and says to remove them by hand. The write to `config` still happens: the shadowing is reported, not blocking. Sections with `aws_access_key_id`/`aws_secret_access_key`/`aws_session_token` are never read beyond the key names. |
| **Keeps `awsx` state consistent across renames** | A rename is detected as the same `(session, account, role)` — or the same `role_arn` + `source_profile` — under a new name between the old and the new `config`. `apply` rewrites `lastProfile`, `previousProfile`, `recents` and `perProfile` keys in `~/.config/awsx/config.json`, appends the old name to `former_names` in the catalog, and lists `settings.prodProfiles` entries that still name the old profile (settings are human-owned: reported, not rewritten). |
| **Points at broken aliases** | After a rename, greps `~/.zshrc`, `~/.bashrc`, `~/.config/fish/config.fish` (read-only) for whole-word occurrences of the old names and prints `file:line`. Never edits rc files. |

### Catalog schema (v1)

Compatible with the file the Python script already wrote. Example with redacted
values:

```jsonc
{
  "version": 1,
  "sso_sessions": {
    "corp": { "sso_start_url": "https://example.awsapps.com/start", "sso_region": "eu-west-1",
              "sso_registration_scopes": "sso:account:access" }
  },
  "defaults": { "sso_session": "corp", "cli_pager": "" },
  "profiles": [
    { "name": "acme-sva-admin", "group": "ACME",
      "account_name": "acme-sva", "account_id": "111122223333",
      "role": "AdministratorAccess", "region": "eu-west-3",
      "session": "corp",                       // optional, else defaults.sso_session
      "extra": { "output": "json", "s3": { "addressing_style": "path" } },
      "former_names": ["acme-sva-AdministratorAccess"] },
    { "name": "ops-read", "extra": { "role_arn": "arn:aws:iam::444455556666:role/Read",
                                     "source_profile": "acme-sva-admin" } }
  ],
  "sections": { "services local-dev": { "s3": { "endpoint_url": "http://localhost:4566" } } }
}
```

Changes from the script's format, all additive:

- `version` — written on save, defaulted to `1` on read.
- `extra` values may be an object, rendered as an indented sub-map (what `src/ini.ts` parses as `nested`). The script could not represent these and dropped them.
- `sections` — non-profile, non-session blocks (`[services …]`, `[plugins]`) carried verbatim, so a regenerate does not delete them.
- `defaults.sso_session` is chosen at `import` time as the session referenced by most profiles, or `--default-session`; never a hardcoded name.

Validation (`load()` fails with every error listed, not the first):

- Names unique, `^[A-Za-z0-9_.\-]+$`, and not equal to another profile's `former_names` (an alias would silently resolve to the wrong account).
- `account_id` is 12 digits; `role` non-empty; the resolved session exists in `sso_sessions`.
- Every `source_profile` names a profile in the catalog or a static profile in `credentials`.
- **No credential material anywhere**: `aws_access_key_id`, `aws_secret_access_key`, `aws_session_token` are rejected in `extra`. Static keys stay in `credentials`, and the catalog never learns their values — `import` checks for those key names and skips the section without reading further.
- Entries with `"new": true` block `apply` (listed by name). `discover` proposes names; a human chooses them. That review step is the whole point of the catalog.

### Rendering

`config` is fully regenerated, in a deterministic order so that diffs and the
drift hash are stable: header, `[sso-session]` blocks in catalog order, `sections`,
then profiles grouped by `group` (with `# ── GROUP ──` banners) in catalog order.
Key order inside a profile: `sso_session`, `sso_account_id`, `sso_role_name`,
`region`, `defaults` (minus `sso_session`), `extra`. Values go through one
`formatIniValue()` that rejects newlines and `[`-leading keys, so a catalog value
can never inject a section.

The round trip is the main test: `parseIni(render(catalog))` → `resolveProfiles()`
must yield exactly the model the catalog describes, and on a machine with the AWS
CLI, `aws configure list-profiles` and `aws configure get region|sso_account_id|sso_role_name`
on the generated fixture must agree.

### `import`

Same folding rules as the script, which proved right on the real data:

- Collect both files with the corrected precedence (decision 1). Sections with static keys stay in `credentials` and are reported.
- Group SSO profiles by `(session, account, role)`. Any hand-chosen name (not `<Account>-<Role>`, not `<Role>-<12 digits>`) is kept; the auto-generated names go to `former_names`. With only auto names, propose `<account-slug>-<role-short>` (`AdministratorAccess` → `admin`, `ReadOnlyAccess` → `read`, `ViewOnlyAccess` → `view`, `PowerUserAccess` → `power`, else slug), with a numeric suffix on collision.
- Account names from SSO (`list-accounts`, see `discover`) unless `--offline`, falling back to the auto name's prefix.
- `group` = the last comment line before the section that is not a separator rule. This needs comment positions `parseIni()` discards, so `src/ini.ts` gains `sectionSpans(text)`: per header, its line range and the preceding comment text. The hot-path `parseIni()` is unchanged.
- Refuses to overwrite an existing catalog without `--force`.

### `discover` and the SSO token

`discover` needs `sso:ListAccounts` and `sso:ListAccountRoles`, which take a bearer
token, not SigV4 credentials. The token is in `~/.aws/sso/cache/*.json`,
indexed by `startUrl` exactly as `src/sso.ts` already does (it gains a
`readAccessToken(startUrl)` alongside the expiry index).

The call goes through the AWS CLI, per ADR-0001's delegation rule, but **never
with the token in argv**: each call gets `--cli-input-json file://<path>` where
the file sits in a `mkdtemp` directory (`0700`, file `0600`) and is removed in a
`finally`. That is no more exposure than the cache file the token came from.
Calls run with a concurrency of 6 (≈ 30 accounts in ~1.5 s instead of ~8 s
serial), follow `nextToken`, and run with `cleanEnv()`.

No valid token → exit `1` with `run: aws sso login --sso-session <name>` (or
`awsx login`), never an implicit browser flow from a command the user ran to edit
a file.

## Options Considered

### Where the tool lives

| Option | Verdict |
|---|---|
| **`awsx profiles <verb>` in this package** *(chosen)* | Reuses `ini.ts`, `profiles.ts`, `sso.ts`, `aws.ts`, `store.ts`, the fixture harness and the differential test. Renames can update picker state, which only code that owns both files can do. One install. |
| Second `bin` (`aws-profiles`) in the same package | Same code reuse, but two command names for one tool, and the wrapper/passthrough question comes back for a binary the wrapper does not know. |
| Keep the Python script, add tests | Duplicates the INI dialect in a second language that is already wrong about it (defect 2); cannot touch `awsx` state on rename; Python is not a prerequisite of this package. |
| Separate npm package | Splits a ~600-line feature from the parser it depends on, for no user benefit. |

### Who owns `~/.aws/config`

| Option | Verdict |
|---|---|
| **Catalog is source, config is generated** *(chosen)* | Names are chosen once, in one place, with validation. Duplicates become structurally impossible. Cost: `aws configure sso` / `aws configure set` edits are drift (detected, adoptable). |
| Surgical in-place edits of `config` (rename/add/remove one section, keep the rest) | Preserves hand edits, but every write must round-trip formatting the CLI does not define, there is still no place to hold `account_name`, `group` or `former_names`, and duplicates stay possible. ADR-0001 already rejected round-tripping this file (Option B: "unavoidably lossy"). |
| Stay read-only, only lint (`awsx doctor` reports duplicates, shadowing, misnamed roles) | Zero risk, and part of it is kept (see doctor below). But it leaves the fix manual on 48+ profiles, which is the job the script just did. |

Considered and rejected on 2026-11-18: an `apply --prune-credentials` flag that
removes, by line range, the `credentials` sections shadowing catalog profiles (the
script did this unconditionally, and lost every comment in the file). Rejected
because it is a one-time migration need — the migrated machine has no shadowing
left — and it would end the guarantee that `awsx` never writes the one file that
holds static keys. Shadowing is reported by `apply` and `doctor`; removal stays manual.

### Where the catalog lives

| Option | Verdict |
|---|---|
| **`~/.aws/profiles.json`** *(chosen)* | Next to the files it generates, `0600`, already exists on the migrated machine. Contains account IDs and portal URLs, which belong with AWS config, not with picker state. |
| Inside `~/.config/awsx/config.json` | Honours ADR-0001 requirement 8 to the letter, but mixes sensitive inventory into a file documented as secret-free and hand-edited for UI settings, and couples `awsx`'s churny state writes to the AWS inventory. Requirement 8 is about `awsx` state; the catalog is not that. |
| A repo-committed, team-shared catalog | Attractive later (ADR-0001 "To revisit": shared account labels), but account IDs and portal URLs in git is exactly the leak the handoff warns about. Out of scope; `AWSX_PROFILES_FILE` leaves the door open. |

### How `discover` talks to the SSO portal

| Option | Verdict |
|---|---|
| **AWS CLI, token via `--cli-input-json file://` in a `0700` temp dir** *(chosen)* | Keeps ADR-0001's delegation rule, token never in argv. Cost: ~240 ms per call, mitigated by bounded concurrency on a rare command. |
| AWS CLI with `--access-token` in argv (the script) | Token visible in `ps` for every call. Rejected. |
| Native `fetch` to `portal.sso.<region>.amazonaws.com` with `x-amz-sso_bearer_token` | Fastest and simplest code, but `awsx` would start speaking an AWS API directly: endpoints per partition, pagination and error mapping become ours. Revisit only if `discover` latency matters, which it does not. |

### Command names

`import` instead of the script's `export`: the verb describes what happens to the
catalog, and `awsx export` already means "materialize credentials" — two
meanings of `export` one word apart is a support ticket. The script's `list` is
dropped: `awsx list` shows the applied state and `apply --dry-run` shows the
pending one. `discover` and `apply` keep their names.

## Consequences

**Easier**
- Profile names become a reviewed decision, made once, instead of whatever `aws configure sso` generated on the day.
- Duplicates and name/role mismatches cannot come back: validation rejects them before anything is written.
- Adding an account is `awsx login` → `awsx profiles discover` → name it → `awsx profiles apply`.
- Renames no longer silently reset the picker's memory, and broken shell aliases are pointed out.
- The default region shown by the picker matches the CLI for profiles in both files (decision 1), whether or not the catalog is used.

**Harder**
- `awsx` now writes `~/.aws/config`. ADR-0001's "never rewrite `~/.aws/credentials`, never silently mutate `~/.aws/config`" becomes: *only `awsx profiles apply` writes `~/.aws/config`, and it always shows the plan, backs up and writes atomically; nothing in `awsx` ever writes `~/.aws/credentials`*. CLAUDE.md's invariant line changes to that wording.
- A machine not yet migrated, with SSO profiles in `credentials`, needs those sections removed by hand after the first `apply`; until then they shadow the generated profiles, and `apply`/`doctor` list them.
- `aws configure sso` stops being a way to add a profile on a managed machine: its output is drift. `doctor` and `apply` say so, with `--adopt` as the way back.
- The catalog contains account IDs and portal URLs. It must never be committed; the tests use synthetic IDs only, and `awsx` never prints full account IDs in `apply` output (last 4 digits, as `list` does).
- ~600 lines of new code and a second parser consumer (`sectionSpans`) to maintain.

**`awsx doctor` gains** (read-only, all cheap): catalog present and valid; drift between catalog and `config`; profiles shadowed by `credentials`; `"new"` entries pending; profiles whose name ends in a role short-name that does not match `sso_role_name`.

## Implementation plan

Each step is one merge request, green on `npm run check` and on `FORCE_COLOR=1 npm test`.

1. **Precedence fix.** `collectRaw()`: credentials over config for every key. Fixture with conflicting `region`; extend the differential test to `aws configure get region`. Amend ADR-0001 "Config parsing" and CLAUDE.md "Data flow".
2. **Catalog core** — `src/catalog/schema.ts` (types, `load()` with aggregated validation, `save()` atomic `0600`), `src/catalog/render.ts` (`render()`, `formatIniValue()`, drift hash), `src/ini.ts` `sectionSpans()`. Tests: validation table, render golden files, `parseIni(render(x))` round trip, injection attempts (`\n[profile evil]` in a value).
3. **`import`** — `src/catalog/import.ts`, folding and naming rules, `--offline` path first. Fixtures reproducing the real shapes (auto + manual names for one triple, name in both files, static key, `role_arn` chain, nested `s3` map, `[services]` block), all redacted.
4. **`apply`** — `src/catalog/apply.ts`: plan, drift, backup + rotation, atomic writes, shadowing report for `credentials` (with a test asserting the file is byte-identical after `apply`), rename detection and `store.ts` migration, rc-file hints. Wire `awsx profiles` in `src/index.ts`, add `profiles` to `PASSTHROUGH_COMMANDS`, assert it in `test/shell.test.ts`. CLI tests through the existing `awsx()` helper in `test/cli.test.ts`, all paths env-overridden.
5. **`discover`** — `readAccessToken()` in `src/sso.ts`, SSO calls in `src/aws.ts` via `--cli-input-json`, concurrency limit. Tested with `AWSX_AWS_BIN` pointing at a stub that records its argv, and asserts the token is absent from it.
6. **`doctor` checks** listed above.
7. **Parity on the migrated machine, then retire the script.** `awsx profiles apply --dry-run` against the existing `~/.aws/profiles.json` must report no profile change (header line only). Then one real `apply`, `awsx doctor` clean, `aws configure list-profiles` count unchanged, `sts get-caller-identity` on one SSO, one custom-role and one chained profile. Delete `~/.local/bin/aws-profiles`.
8. README section and `awsx --help` entry.

## To revisit

- **Groups in the picker.** The catalog's `group` could section or filter the picker. Reading the catalog from the picker would make it a second source of truth for display; the alternative is rendering a comment the picker reads via `sectionSpans()`. Decide after using groups for a while.
- **A shared, committed catalog** for a team, with account IDs split into a local overlay.
- **`apply` hooks**, e.g. regenerate shell aliases from the catalog instead of grepping for stale ones.
