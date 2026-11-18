/**
 * Minimal INI reader for the AWS shared config files.
 *
 * Deliberately not a general-purpose INI parser: it encodes the quirks the AWS
 * CLI actually has (see ADR-0001, "Config parsing"), and nothing else.
 *
 *   - `[profile NAME]` in ~/.aws/config, bare `[NAME]` in ~/.aws/credentials,
 *     `[default]` unprefixed in both, `[sso-session NAME]` for SSO sessions.
 *   - A key with an empty value followed by indented lines is a nested map
 *     (how `s3 = ` / `  addressing_style = path` is written).
 *   - `#` and `;` start a comment on their own line, or inline when preceded
 *     by whitespace.
 */

export type IniSection = {
  /** Top-level `key = value` pairs. */
  keys: Record<string, string>;
  /** Indented sub-maps, keyed by their parent key. */
  nested: Record<string, Record<string, string>>;
};

/** Section header text as written, without brackets: `profile foo`, `default`. */
export type IniFile = Map<string, IniSection>;

const emptySection = (): IniSection => ({ keys: {}, nested: {} });

function stripComment(line: string): string {
  let out = line;
  for (const marker of ['#', ';']) {
    const at = out.indexOf(marker);
    if (at === 0) return '';
    // Inline comments only count when whitespace-separated, so a value like
    // `role/My#Role` survives.
    if (at > 0 && /\s/.test(out[at - 1] as string)) out = out.slice(0, at);
  }
  return out;
}

export function parseIni(text: string): IniFile {
  const file: IniFile = new Map();
  let section: IniSection | undefined;
  let lastKey: string | undefined;

  for (const rawLine of text.split(/\r?\n/)) {
    const indented = /^[ \t]/.test(rawLine);
    const line = stripComment(rawLine).trim();
    if (line === '') continue;

    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      const name = (header[1] as string).trim();
      // Later definitions of the same section merge into the earlier one, which
      // is what the AWS CLI does with duplicate headers.
      section = file.get(name) ?? emptySection();
      file.set(name, section);
      lastKey = undefined;
      continue;
    }

    if (!section) continue; // keys before any header: ignored, as the CLI does

    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === '') continue;

    // Indented under a key that was left empty => nested sub-map.
    if (indented && lastKey !== undefined && section.keys[lastKey] === '') {
      const bucket = (section.nested[lastKey] ??= {});
      bucket[key] = value;
      continue;
    }

    section.keys[key] = value;
    lastKey = key;
  }

  return file;
}

/** Split a section header into its type and name: `profile foo` -> `['profile', 'foo']`. */
export function splitHeader(header: string): { type: string; name: string } {
  const at = header.search(/\s/);
  if (at === -1) return { type: '', name: header };
  return { type: header.slice(0, at), name: header.slice(at + 1).trim() };
}

export type SectionSpan = {
  /** Header text as written, without brackets. */
  header: string;
  /** 0-based line of the header. */
  line: number;
  /** 0-based line where the next section's header (or the end of file) is. */
  end: number;
  /**
   * Text of the comment lines between the previous section's last key and this
   * header, `#`/`;` markers removed, empty ones dropped. `import` reads profile
   * groups from these (ADR-0002); `parseIni()` discards them.
   */
  comments: string[];
};

/** Where each section sits in the text, with the comments just above it. */
export function sectionSpans(text: string): SectionSpan[] {
  const lines = text.split(/\r?\n/);
  const spans: SectionSpan[] = [];
  let pending: string[] = [];

  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (line === '') return;
    if (line.startsWith('#') || line.startsWith(';')) {
      const comment = line.replace(/^[#;]+/, '').trim();
      if (comment !== '') pending.push(comment);
      return;
    }
    const header = /^\[(.+)\]$/.exec(stripComment(raw).trim());
    if (header) {
      const previous = spans.at(-1);
      if (previous) previous.end = index;
      spans.push({ header: (header[1] as string).trim(), line: index, end: lines.length, comments: pending });
    }
    pending = [];
  });

  return spans;
}
