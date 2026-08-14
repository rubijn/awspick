/**
 * The two interactive prompts.
 *
 * Ordering rules (ADR-0001, "Default selection and ordering"):
 *   - empty query: last selected first, then recents newest-first, then the rest
 *     alphabetically, with the cursor parked on the last selected profile
 *   - non-empty query: relevance wins, recency is only a tie-breaker
 *
 * Both prompts render on stderr so stdout stays clean for the shell code that
 * the wrapper evals.
 */

import search from '@inquirer/search';
import confirm from '@inquirer/confirm';
import { scoreFields } from './fuzzy.ts';
import type { Profile } from './profiles.ts';
import { isKnownRegion, labelFor, looksLikeRegion, REGIONS } from './regions.ts';
import { bold, dim, red, renderRow, type RowContext } from './render.ts';
import type { TokenIndex } from './sso.ts';

/** Esc or Ctrl-C: we exit 130 rather than crash, and never emit a selection. */
export class CancelledError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'CancelledError';
  }
}

const ESC = 0x1b;
/**
 * A lone Esc can also be the first byte of an arrow-key sequence that arrived
 * split across reads, so wait briefly for a follow-up before treating it as a
 * quit. This is the same escape-timeout trick terminals use.
 */
const ESC_TIMEOUT_MS = 40;

/**
 * Run a prompt with Esc wired to cancellation.
 *
 * The prompts have no cancel key of their own, but @inquirer/core rejects with
 * AbortPromptError when the context signal aborts — so watch stdin for a bare
 * Esc and abort. Adding a `data` listener does not steal bytes from the prompt's
 * own reader; both listeners see every chunk.
 */
async function prompt<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const input = process.stdin;
  const controller = new AbortController();
  let pending: NodeJS.Timeout | undefined;

  const onData = (chunk: Buffer | string): void => {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    if (bytes.length === 1 && bytes[0] === ESC) {
      pending ??= setTimeout(() => controller.abort(), ESC_TIMEOUT_MS);
      return;
    }
    if (pending) {
      clearTimeout(pending);
      pending = undefined;
    }
  };

  const watching = input.isTTY === true;
  if (watching) input.on('data', onData);
  try {
    return await run(controller.signal);
  } catch (err) {
    if (err instanceof Error && (err.name === 'ExitPromptError' || err.name === 'AbortPromptError')) {
      throw new CancelledError();
    }
    throw err;
  } finally {
    if (watching) input.off('data', onData);
    if (pending) clearTimeout(pending);
  }
}

/** Adds `esc quit` to the prompt's own key hints so the exit is discoverable. */
const keysHelpTip = (keys: Array<[key: string, action: string]>): string =>
  [...keys, ['esc', 'quit'] as [string, string]]
    .map(([key, action]) => `${bold(key)} ${dim(action)}`)
    .join(dim(' • '));

export type ProfilePickerOptions = {
  profiles: Profile[];
  tokens: TokenIndex;
  /** Highlighted by default, and listed first when the query is empty. */
  lastProfile?: string;
  /** Most-recent-first, used for empty-query ordering and tie-breaks. */
  recents: string[];
  message?: string;
};

/** Rank of a profile in the recents list; +inf when it is not in there. */
function recencyRank(name: string, recents: string[], lastProfile?: string): number {
  if (name === lastProfile) return -1;
  const at = recents.indexOf(name);
  return at === -1 ? Number.POSITIVE_INFINITY : at;
}

export function orderProfiles(
  term: string,
  { profiles, recents, lastProfile }: Pick<ProfilePickerOptions, 'profiles' | 'recents' | 'lastProfile'>,
): Profile[] {
  const query = term.trim();

  if (query === '') {
    return [...profiles].sort((a, b) => {
      const ra = recencyRank(a.name, recents, lastProfile);
      const rb = recencyRank(b.name, recents, lastProfile);
      if (ra !== rb) return ra - rb;
      return a.name.localeCompare(b.name);
    });
  }

  const scored: Array<{ profile: Profile; score: number }> = [];
  for (const profile of profiles) {
    const score = scoreFields(query, [profile.name, profile.accountId, profile.roleName]);
    if (score === null) continue;
    scored.push({ profile, score });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Relevance first, recency only to break a tie — otherwise a stale
    // favourite outranks an exact match, which is the wrong kind of surprise.
    const ra = recencyRank(a.profile.name, recents, lastProfile);
    const rb = recencyRank(b.profile.name, recents, lastProfile);
    if (ra !== rb) return ra - rb;
    return a.profile.name.localeCompare(b.profile.name);
  });
  return scored.map((entry) => entry.profile);
}

export async function pickProfile(options: ProfilePickerOptions): Promise<Profile> {
  const byName = new Map(options.profiles.map((p) => [p.name, p]));
  const ctx: RowContext = {
    tokens: options.tokens,
    now: new Date(),
    columns: process.stderr.columns ?? 100,
  };
  if (options.lastProfile) ctx.lastProfile = options.lastProfile;

  const name = await prompt((signal) =>
    search<string>(
      {
        message: options.message ?? 'AWS profile',
        pageSize: Math.max(8, Math.min((process.stderr.rows ?? 24) - 6, 20)),
        // Cursor opens on the last selected profile, even when a query has
        // reordered the list around it.
        ...(options.lastProfile && byName.has(options.lastProfile)
          ? { default: options.lastProfile }
          : {}),
        source: (term) =>
          orderProfiles(term ?? '', options).map((profile) => ({
            value: profile.name,
            name: renderRow(profile, ctx),
            short: profile.name,
          })),
        theme: { style: { keysHelpTip } },
      },
      { output: process.stderr, signal },
    ),
  );

  const picked = byName.get(name);
  if (!picked) throw new Error(`profile disappeared while picking: ${name}`);
  return picked;
}

export type RegionPickerOptions = {
  /** Shortlist from settings.regions, offered above the full list. */
  shortlist: string[];
  /** Pre-selected: last region for this profile, or the profile's own. */
  current?: string;
  message?: string;
};

export async function pickRegion(options: RegionPickerOptions): Promise<string> {
  const shortlist = options.shortlist.filter((id, i, all) => all.indexOf(id) === i);

  const candidates = (term: string): Array<{ value: string; name: string; short?: string }> => {
    const query = term.trim();
    const rank = (id: string): number => {
      if (id === options.current) return -2;
      const at = shortlist.indexOf(id);
      return at === -1 ? Number.POSITIVE_INFINITY : at;
    };

    const all = REGIONS.map((r) => r.id);
    for (const id of shortlist) if (!all.includes(id)) all.push(id);

    let list: string[];
    if (query === '') {
      list = [...all].sort((a, b) => {
        const ra = rank(a);
        const rb = rank(b);
        if (ra !== rb) return ra - rb;
        return a.localeCompare(b);
      });
    } else {
      const scored: Array<{ id: string; score: number }> = [];
      for (const id of all) {
        const score = scoreFields(query, [id, labelFor(id)]);
        if (score !== null) scored.push({ id, score });
      }
      scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : rank(a.id) - rank(b.id)));
      list = scored.map((entry) => entry.id);
    }

    const choices = list.map((id) => {
      const label = labelFor(id);
      const marks = [
        id === options.current ? dim('(current)') : '',
        shortlist.includes(id) ? dim('★') : '',
      ]
        .filter(Boolean)
        .join(' ');
      return {
        value: id,
        name: `${id.padEnd(16)} ${dim(label ?? '')} ${marks}`.trimEnd(),
        short: id,
      };
    });

    // Free text: accept anything region-shaped that is not already listed.
    if (query !== '' && !isKnownRegion(query) && looksLikeRegion(query)) {
      choices.unshift({ value: query, name: `${query.padEnd(16)} ${dim('(not in list — use anyway)')}`, short: query });
    }
    return choices;
  };

  return prompt((signal) =>
    search<string>(
      {
        message: options.message ?? 'AWS region',
        pageSize: Math.max(8, Math.min((process.stderr.rows ?? 24) - 6, 16)),
        ...(options.current ? { default: options.current } : {}),
        source: (term) => candidates(term ?? ''),
        theme: { style: { keysHelpTip } },
      },
      { output: process.stderr, signal },
    ),
  );
}

export async function confirmProd(profile: Profile): Promise<boolean> {
  return confirmPrompt(`${red(bold(profile.name))} looks like production. Select it?`, false);
}

export async function confirmPrompt(message: string, fallback = true): Promise<boolean> {
  return prompt((signal) => confirm({ message, default: fallback }, { output: process.stderr, signal }));
}
