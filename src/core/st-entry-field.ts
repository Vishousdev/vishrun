// SillyTavern /setentryfield: write one field of a lorebook entry. Cards name
// entries by ST's numeric uid, which Lumiverse's import replaces with its own
// id; the card's embedded book still carries the original uid.

export interface EntryLike {
  id: string;
  comment?: string;
  extensions?: Record<string, unknown> | null;
}

export interface CardBookEntry {
  id?: unknown;
  comment?: unknown;
  extensions?: Record<string, unknown> | null;
}

// STscript escapes: a backslash run before | { } is halved; an odd run leaves
// the character literal.
export function unescapeSlashArg(s: string): string {
  return s.replace(/(\\+)([|{}])/g, (_m, run: string, ch: string) => '\\'.repeat(run.length >> 1) + ch);
}

const displayIndex = (e: { extensions?: Record<string, unknown> | null }) => e.extensions?.display_index;

export function resolveStUid(uid: string, entries: EntryLike[], cardBook: CardBookEntry[]): EntryLike | null {
  const direct = entries.find((e) => e.id === uid);
  if (direct) return direct;
  const src = cardBook.find((e) => String(e.id) === uid);
  if (!src) return null;
  const sameComment = entries.filter((e) => (e.comment ?? '') === String(src.comment ?? ''));
  if (sameComment.length === 1) return sameComment[0];
  const di = displayIndex(src);
  return sameComment.find((e) => di !== undefined && displayIndex(e) === di) ?? null;
}

// Lumiverse entry id -> the card's ST uid, for entries still traceable to the
// card's embedded book.
export function stUidMap(entries: EntryLike[], cardBook: CardBookEntry[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const src of cardBook) {
    if (typeof src.id !== 'number') continue;
    const hit = resolveStUid(String(src.id), entries, cardBook);
    if (hit && !out.has(hit.id)) out.set(hit.id, src.id);
  }
  return out;
}

const keys = (v: string) => v.split(',').map((k) => k.trim()).filter(Boolean);
const bool = (v: string) => ['true', '1', 'on', 'yes'].includes(v.trim().toLowerCase());

// Host patch for an ST field name, or null when the field is not supported.
export function entryFieldPatch(field: string, value: string): Record<string, unknown> | null {
  switch (field) {
    case 'content': return { content: value };
    case 'comment': return { comment: value };
    case 'key': return { key: keys(value) };
    case 'keysecondary': return { keysecondary: keys(value) };
    case 'constant': return { constant: bool(value) };
    case 'disable': return { disabled: bool(value) };
    default: return null;
  }
}
