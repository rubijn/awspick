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
| `awsx doctor` | check the AWS CLI, the shell integration, and the config parser |

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

`awsx` never writes to `~/.aws/config` or `~/.aws/credentials`.

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
`docs/adr/ADR-0001-aws-profile-region-switcher.md` (not shipped in the npm tarball).
