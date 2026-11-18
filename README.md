# awsx

Interactive picker for `AWS_PROFILE` and `AWS_REGION`, driven by the `~/.aws/config`
and `~/.aws/credentials` you already have. Type to search 90+ profiles, see the
account, role, region and SSO expiry next to each one, and get the selection into
the shell you are standing in.

```
❯ awsx
? AWS profile acme prod
❯ ★ acme-prod-AdministratorAccess            111111111111 AdministratorAccess  eu-west-1   ✓ 7h
    acme-observability-prod-AdministratorAc… 222222222222 AdministratorAccess  eu-west-1   ✓ 7h
    acme_prod                                111111111111 OrganizationAccount… eu-west-1*  role
    acme-preprod-AdministratorAccess         333333333333 AdministratorAccess  eu-west-1   ✗ expired
```

- `★` is the last profile you selected — it is where the cursor opens, so re-confirming yesterday's context is one keypress.
- Production-looking profiles are red. Configure what counts as production.
- `✓ 7h` / `✗ expired` is the SSO token for that profile's session. Pick an expired one and it offers `aws sso login` before handing back a selection that would fail.
- `*` on a region means it was inherited from a parent profile or the SSO session, not set on the profile itself.
- **`esc` quits** without changing anything (so does `ctrl-c`). Nothing is applied and nothing is remembered.

## Install

Requires **Node ≥ 20** and the **AWS CLI v2** (`brew install awscli`).

```bash
npm install -g awspick             # installs the `awsx` command
eval "$(awsx init zsh)"            # add this line to ~/.zshrc
```

That second line is not optional decoration: a child process cannot change its
parent's environment, so `awsx` prints shell code and a small function installed
by `init` evaluates it. Without it `awsx` still works, but it prints the `export`
lines for you to run instead of applying them.

Other shells: `awsx init bash`, `awsx init fish`, `awsx init pwsh`.

Try it without installing:

```bash
npx awspick list                   # no shell integration needed
npx awspick init zsh               # print the snippet
```

## Use

| | |
|---|---|
| `awsx` | pick a profile, then a region if none is known |
| `awsx prod` | pre-filter; selects directly when only one profile matches |
| `awsx -` | switch back to the previous profile |
| `awsx region eu-west-3` | change only the region |
| `awsx status` | what this shell is pointed at, verified with `sts get-caller-identity` |
| `awsx list [--json]` | every profile, with account, region and token state |
| `awsx login` | `aws sso login` for the current profile's session |
| `awsx export` | materialize real keys (`AWS_ACCESS_KEY_ID`, …) into the shell |
| `awsx exec -- terraform plan` | run one command with the selection applied, without changing the shell |
| `awsx doctor` | check the AWS CLI, the shell integration, the config parser and the profile catalog |
| `awsx profiles …` | manage `~/.aws/config` from a JSON catalog — see [Profile catalog](#profile-catalog) |

Non-interactive: `--profile <name>`, `--region <name>`, `--keep-region`,
`--no-region`, `--yes`, `--json`.

Search matches the profile name, the account ID and the role name, so
`prod acme`, `4444` and `observ` all work. With an empty query the list is
ordered last-selected first, then recents, then alphabetical; once you type,
relevance wins and recency only breaks ties.

## Pointer vs credentials

By default `awsx` exports `AWS_PROFILE` and `AWS_REGION` — a pointer. Nothing
secret enters your environment and tokens keep refreshing on their own.

`awsx export` instead materializes real credentials via
`aws configure export-credentials`, for tools that only understand
`AWS_ACCESS_KEY_ID`. Those are short-lived secrets that then sit in your
environment and leak into every child process, so it is a separate, explicit
command — and it refuses to print them to a terminal unless you pass `--print`.

## Configuration

Everything lives in `~/.config/awsx/config.json` (or `$XDG_CONFIG_HOME/awsx/`).
The `settings` half is yours to edit; the rest `awsx` maintains.

```jsonc
{
  "version": 1,
  "lastProfile": "acme-prod-AdministratorAccess",
  "previousProfile": "acme-dev-AdministratorAccess",
  "recents": ["acme-prod-AdministratorAccess", "sandbox"],
  "perProfile": {
    "acme-prod-AdministratorAccess": { "lastRegion": "eu-west-1", "uses": 34 }
  },
  "settings": {
    "prodPatterns": ["prod", "prd"],   // substrings that mark a profile as production
    "prodProfiles": ["tfstate"],       // always production, whatever the name
    "regions": ["eu-west-1", "eu-west-3", "me-south-1"],  // shortlist, offered first
    "recentsLimit": 10,
    "confirmProd": false               // ask before selecting a production profile
  }
}
```

Writes are atomic, the file is `0600`, keys `awsx` does not know are preserved,
and a corrupt file is a warning rather than a crash. It never contains
credentials — profile names, regions and counters only.

`awsx` never writes `~/.aws/credentials`, and writes `~/.aws/config` only through
`awsx profiles apply` (below).

## Profile catalog

Optional. `aws configure sso` names profiles `<Account>-<Role>`, people add their
own names in `~/.aws/credentials`, and after a while the same account and role
exist twice under two names. The catalog fixes the names in one JSON file and
generates `~/.aws/config` from it. The picker does not need it and never reads it.

```bash
awsx profiles import            # build ~/.aws/profiles.json from your current files
$EDITOR ~/.aws/profiles.json    # choose names, groups, regions
awsx profiles apply --dry-run   # see what would change
awsx profiles apply             # write ~/.aws/config (asks first)
```

- **import** folds duplicates by SSO session, account and role: a name you chose
  is kept, names made by `aws configure sso` go to `former_names`, and an
  `<account>-<role>` name (`acme-prod-admin`) is proposed when only those exist.
  Account names come from SSO when you are logged in (`--offline` to skip).
- **apply** shows the plan first, asks (or needs `--yes`), backs up to
  `~/.aws/backup/<UTC stamp>/` (the last 20 are kept), and writes atomically. It
  refuses when `~/.aws/config` was edited since the last apply, or holds profiles
  the catalog does not know: `--adopt` brings them into the catalog, `--force`
  drops them (they stay in the backup). A renamed profile keeps its picker
  history, and lines of `~/.zshrc`/`~/.bashrc` that still use the old name are
  pointed out.
- **discover** adds the account/role pairs your SSO session reaches and the
  catalog lacks, marked `"new": true` with a proposed name. Rename them, remove
  `"new"`, then apply.
- **credentials is never written.** Static keys stay there and never enter the
  catalog. A profile defined there again wins over `~/.aws/config` (as in the AWS
  CLI): `apply` and `doctor` list those sections for you to remove.

Once you use the catalog, add profiles with `discover` rather than
`aws configure sso`: anything written to `~/.aws/config` by hand is drift.

The catalog holds account IDs and SSO portal URLs. It is `0600` and lives next to
the files it generates (`$AWSX_PROFILES_FILE` to move it). Do not commit it.

```jsonc
{
  "version": 1,
  "sso_sessions": { "corp": { "sso_start_url": "https://…/start", "sso_region": "eu-west-1" } },
  "defaults": { "sso_session": "corp", "cli_pager": "" },
  "profiles": [
    { "name": "acme-prod-admin", "group": "ACME", "account_name": "acme-prod",
      "account_id": "111111111111", "role": "AdministratorAccess", "region": "eu-west-3",
      "former_names": ["acme-prod-AdministratorAccess"] },
    { "name": "ops-read", "extra": { "role_arn": "arn:aws:iam::222222222222:role/Read",
                                     "source_profile": "acme-prod-admin" } }
  ]
}
```

## Develop

```bash
npm install
npm test          # node:test, no watch mode needed
npm run typecheck
npm run build     # single-file bundle in dist/
npm run check     # all of the above plus publint
```

Tests need Node ≥ 23.6 (they run TypeScript directly via type stripping). One
test compares the parser against `aws configure list-profiles` on fixture files
and skips itself if the AWS CLI is absent.

Design rationale, including the options that were rejected, is in the repository at
`.ai/adr/ADR-0001-aws-profile-region-switcher.md` and, for the profile catalog,
`.ai/adr/ADR-0002-profile-catalog.md` (not shipped in the npm tarball).
