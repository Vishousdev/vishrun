// SillyTavern lorebook matching for the entries Lumiverse matches differently:
// keys written as /regex/flags, the "Match …" options that add card or persona
// text to what an entry scans, and whole-word matching (ST exports use_regex
// on every entry, and the host skips whole words for regex entries). Other
// entries are left to the host.

export interface StEntry {
  id: string;
  disabled: boolean;
  constant: boolean;
  key: readonly string[];
  keysecondary: readonly string[];
  selective: boolean;
  selective_logic: number;
  case_sensitive: boolean;
  match_whole_words: boolean;
  use_regex?: boolean;
  scan_depth: number | null;
  extensions: Readonly<Record<string, unknown>>;
}

export interface StSources {
  depthPrompt?: string;
  description?: string;
  personality?: string;
  scenario?: string;
  creatorNotes?: string;
  persona?: string;
}

const MATCH_SOURCES: Record<string, keyof StSources> = {
  match_character_depth_prompt: 'depthPrompt',
  match_character_description: 'description',
  match_character_personality: 'personality',
  match_scenario: 'scenario',
  match_creator_notes: 'creatorNotes',
  match_persona_description: 'persona',
};

const SLASH = /^\/([\s\S]+)\/([dgimsuvy]*)$/;

export function slashRegex(key: string): RegExp | null {
  const m = SLASH.exec(key);
  if (!m) return null;
  try { return new RegExp(m[1], m[2].replace('g', '')); } catch { return null; }
}

const matchFlags = (e: StEntry) => Object.keys(MATCH_SOURCES).filter((k) => e.extensions?.[k] === true);

// Entries whose activation ST decides differently from the host.
export function needsSt(e: StEntry): boolean {
  if (e.disabled || e.constant) return false;
  return [...e.key, ...e.keysecondary].some((k) => SLASH.test(k)) || matchFlags(e).length > 0
    || (e.use_regex === true && e.match_whole_words);
}

// ST's matchKeys: /regex/ keys test the raw text; others are plain text,
// lower-cased unless case-sensitive, whole-word only for single-word keys.
export function keyMatches(key: string, text: string, e: StEntry): boolean {
  const k = key.trim();
  if (!k) return false;
  const re = slashRegex(k);
  if (re) return re.test(text);
  const hay = e.case_sensitive ? text : text.toLowerCase();
  const needle = e.case_sensitive ? k : k.toLowerCase();
  if (e.match_whole_words && !/\s/.test(needle)) {
    const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|\\W)(${esc})(?:$|\\W)`).test(hay);
  }
  return hay.includes(needle);
}

// selective_logic: 0 AND ANY, 1 NOT ALL, 2 NOT ANY, 3 AND ALL.
export function stActive(e: StEntry, text: string): boolean {
  if (!e.key.some((k) => keyMatches(k, text, e))) return false;
  const sec = e.keysecondary.filter((k) => k.trim());
  if (!e.selective || sec.length === 0) return true;
  const hits = sec.filter((k) => keyMatches(k, text, e)).length;
  switch (e.selective_logic) {
    case 1: return hits < sec.length;
    case 2: return hits === 0;
    case 3: return hits === sec.length;
    default: return hits > 0;
  }
}

/** messages: chat contents, oldest first. */
export function stDecisions(
  entries: readonly StEntry[],
  messages: readonly string[],
  sources: StSources,
  globalDepth: number | null,
): { forced: string[]; disabled: string[] } {
  const forced: string[] = [], disabled: string[] = [];
  for (const e of entries) {
    if (!needsSt(e)) continue;
    const depth = e.scan_depth ?? globalDepth;
    const chat = depth === null ? messages : depth > 0 ? messages.slice(-depth) : [];
    const extra = matchFlags(e).map((k) => sources[MATCH_SOURCES[k]] ?? '').filter(Boolean);
    const text = [...chat].reverse().concat(extra).join('\n');
    (stActive(e, text) ? forced : disabled).push(e.id);
  }
  return { forced, disabled };
}
