// Lumiverse lorebook entries <-> JS-Slash-Runner's two entry formats: the
// worldbook API (getWorldbook, replaceWorldbook...) and the older lorebook API
// (getLorebookEntries, setLorebookEntries...). Mirrors JSR's own converters.
// Lumiverse keeps SillyTavern's position numbers, so those map directly. An
// entry's uid is its ST uid when the card's embedded book still has it, else
// the Lumiverse entry id.

export interface HostEntry {
  id: string;
  /** Original ST uid, set by the backend for entries from the card's book. */
  st_uid?: number;
  key: string[];
  keysecondary: string[];
  content: string;
  comment: string;
  position: number;
  depth: number;
  role: string | null;
  order_value: number;
  selective: boolean;
  constant: boolean;
  disabled: boolean;
  group_name: string;
  group_override: boolean;
  group_weight: number;
  probability: number;
  scan_depth: number | null;
  case_sensitive: boolean;
  match_whole_words: boolean;
  automation_id: string | null;
  prevent_recursion: boolean;
  exclude_recursion: boolean;
  delay_until_recursion: boolean;
  sticky: number;
  cooldown: number;
  delay: number;
  selective_logic: number;
  use_probability: boolean;
  vectorized: boolean;
}

export type EntryInput = Partial<Omit<HostEntry, 'id' | 'st_uid'>>;

export const uidOf = (e: HostEntry): string | number => e.st_uid ?? e.id;

// Host id for a uid a script passes back (ST uid or host id).
export function hostIdOf(uid: unknown, entries: HostEntry[]): string | null {
  const s = String(uid);
  return entries.find((e) => e.id === s || (e.st_uid !== undefined && String(e.st_uid) === s))?.id ?? null;
}

type Obj = Record<string, unknown>;

const POSITION_TO_JSR: Record<number, string> = {
  0: 'before_character_definition',
  1: 'after_character_definition',
  2: 'before_author_note',
  3: 'after_author_note',
  4: 'at_depth',
  5: 'before_example_messages',
  6: 'after_example_messages',
  7: 'outlet',
};
const POSITION_FROM_JSR: Record<string, number> = Object.fromEntries(
  Object.entries(POSITION_TO_JSR).map(([n, s]) => [s, Number(n)]),
);
const LOGIC = ['and_any', 'not_all', 'not_any', 'and_all'] as const;
const ROLES = ['system', 'user', 'assistant'];

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const positive = (v: unknown): number | null => (typeof v === 'number' && v > 0 ? v : null);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const roleOf = (r: unknown): string => (typeof r === 'string' && ROLES.includes(r) ? r : 'system');

// ── worldbook API ───────────────────────────────────────────────────────────

export function toWorldbookEntry(e: HostEntry): Obj {
  return {
    uid: uidOf(e),
    name: e.comment,
    enabled: !e.disabled,
    strategy: {
      type: e.constant ? 'constant' : e.vectorized ? 'vectorized' : 'selective',
      keys: [...e.key],
      keys_secondary: { logic: LOGIC[e.selective_logic] ?? 'and_any', keys: [...e.keysecondary] },
      scan_depth: e.scan_depth ?? 'same_as_global',
    },
    position: {
      type: POSITION_TO_JSR[e.position] ?? 'at_depth',
      role: roleOf(e.role),
      depth: e.depth,
      order: e.order_value,
    },
    content: e.content,
    probability: e.use_probability ? e.probability : 100,
    recursion: {
      prevent_incoming: e.exclude_recursion,
      prevent_outgoing: e.prevent_recursion,
      delay_until: e.delay_until_recursion ? 1 : null,
    },
    effect: { sticky: positive(e.sticky), cooldown: positive(e.cooldown), delay: positive(e.delay) },
    group: e.group_name,
    groupOverride: e.group_override,
    groupWeight: e.group_weight,
    caseSensitive: e.case_sensitive,
    matchWholeWords: e.match_whole_words,
    automationId: e.automation_id ?? '',
  };
}

// JSR's fromWorldbookEntry, including its defaults for missing fields (an
// entry without a strategy is constant).
export function fromWorldbookEntry(raw: unknown): EntryInput {
  const e = isObj(raw) ? raw : {};
  const strategy = isObj(e.strategy) ? e.strategy : {};
  const secondary = isObj(strategy.keys_secondary) ? strategy.keys_secondary : {};
  const position = isObj(e.position) ? e.position : {};
  const recursion = isObj(e.recursion) ? e.recursion : {};
  const effect = isObj(e.effect) ? e.effect : {};
  const type = typeof strategy.type === 'string' ? strategy.type : undefined;
  const logic = LOGIC.indexOf((secondary.logic ?? 'and_any') as typeof LOGIC[number]);
  const out: EntryInput = {
    comment: String(e.name ?? ''),
    disabled: !(e.enabled ?? true),
    constant: type ? type === 'constant' : true,
    selective: type === 'selective',
    vectorized: type === 'vectorized',
    key: strs(strategy.keys),
    keysecondary: strs(secondary.keys),
    selective_logic: logic < 0 ? 0 : logic,
    scan_depth: typeof strategy.scan_depth === 'number' ? strategy.scan_depth : null,
    position: POSITION_FROM_JSR[String(position.type ?? 'at_depth')] ?? 4,
    role: roleOf(position.role),
    depth: num(position.depth, 4),
    order_value: num(position.order, 100),
    content: String(e.content ?? ''),
    use_probability: true,
    probability: num(e.probability, 100),
    exclude_recursion: recursion.prevent_incoming === true,
    prevent_recursion: recursion.prevent_outgoing === true,
    delay_until_recursion: !!recursion.delay_until,
    sticky: num(effect.sticky, 0),
    cooldown: num(effect.cooldown, 0),
    delay: num(effect.delay, 0),
  };
  if (typeof e.group === 'string') out.group_name = e.group;
  if (typeof e.groupOverride === 'boolean') out.group_override = e.groupOverride;
  if (typeof e.groupWeight === 'number') out.group_weight = e.groupWeight;
  if (typeof e.caseSensitive === 'boolean') out.case_sensitive = e.caseSensitive;
  if (typeof e.matchWholeWords === 'boolean') out.match_whole_words = e.matchWholeWords;
  if (typeof e.automationId === 'string') out.automation_id = e.automationId || null;
  return out;
}

export interface ApplyPlan {
  create: EntryInput[];
  update: Array<{ id: string; patch: EntryInput }>;
  delete: string[];
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

// Only fields that really change. Both sides go through the same conversion,
// so values JSR's format cannot express (e.g. use_probability with 100%) do
// not count as changes.
function diff(current: HostEntry, next: EntryInput): EntryInput {
  const base = fromWorldbookEntry(toWorldbookEntry(current)) as Obj;
  const patch: Obj = {};
  for (const [k, v] of Object.entries(next)) if (!same(base[k], v)) patch[k] = v;
  return patch as EntryInput;
}

// replaceWorldbook: entries matched by uid are updated, new ones created, and
// the ones left out deleted, like JS-Slash-Runner.
export function planReplace(current: HostEntry[], next: unknown[]): ApplyPlan {
  const byId = new Map(current.map((e) => [e.id, e]));
  const kept = new Set<string>();
  const plan: ApplyPlan = { create: [], update: [], delete: [] };
  for (const raw of next) {
    const id = isObj(raw) && raw.uid !== undefined ? hostIdOf(raw.uid, current) : null;
    const cur = id ? byId.get(id) : undefined;
    if (cur && !kept.has(cur.id)) {
      kept.add(cur.id);
      const patch = diff(cur, fromWorldbookEntry(raw));
      if (Object.keys(patch).length > 0) plan.update.push({ id: cur.id, patch });
    } else {
      plan.create.push(fromWorldbookEntry(raw));
    }
  }
  for (const e of current) if (!kept.has(e.id)) plan.delete.push(e.id);
  return plan;
}

// ── older lorebook API ──────────────────────────────────────────────────────

export function toLorebookEntry(e: HostEntry, index: number): Obj {
  const atDepth = e.position === 4;
  const keys = [...e.key];
  const filters = [...e.keysecondary];
  return {
    uid: uidOf(e),
    display_index: index,
    comment: e.comment,
    enabled: !e.disabled,
    type: e.constant ? 'constant' : e.vectorized ? 'vectorized' : 'selective',
    position: atDepth ? `at_depth_as_${roleOf(e.role)}` : POSITION_TO_JSR[e.position] ?? 'before_character_definition',
    depth: atDepth ? e.depth : null,
    order: e.order_value,
    probability: e.probability,
    key: keys,
    keys,
    logic: LOGIC[e.selective_logic] ?? 'and_any',
    filter: filters,
    filters,
    scan_depth: e.scan_depth ?? 'same_as_global',
    case_sensitive: e.case_sensitive,
    match_whole_words: e.match_whole_words,
    use_group_scoring: 'same_as_global',
    automation_id: e.automation_id,
    exclude_recursion: e.exclude_recursion,
    prevent_recursion: e.prevent_recursion,
    delay_until_recursion: e.delay_until_recursion,
    content: e.content,
    group: e.group_name,
    group_prioritized: e.group_override,
    group_weight: e.group_weight,
    sticky: positive(e.sticky),
    cooldown: positive(e.cooldown),
    delay: positive(e.delay),
  };
}

// Only the fields present in the partial entry, as setLorebookEntries merges.
export function fromLorebookPatch(raw: unknown): EntryInput {
  const e = isObj(raw) ? raw : {};
  const out: EntryInput = {};
  const has = (k: string) => Object.prototype.hasOwnProperty.call(e, k);
  if (has('comment')) out.comment = String(e.comment ?? '');
  if (has('enabled')) out.disabled = e.enabled === false;
  if (has('type')) {
    out.constant = e.type === 'constant';
    out.selective = e.type === 'selective';
    out.vectorized = e.type === 'vectorized';
  }
  if (typeof e.position === 'string') {
    const m = /^at_depth_as_(system|assistant|user)$/.exec(e.position);
    if (m) {
      out.position = 4;
      out.role = m[1];
    } else if (e.position in POSITION_FROM_JSR) {
      out.position = POSITION_FROM_JSR[e.position];
    }
  }
  if (typeof e.depth === 'number') out.depth = e.depth;
  if (typeof e.order === 'number') out.order_value = e.order;
  if (typeof e.probability === 'number') out.probability = e.probability;
  if (has('keys') || has('key')) out.key = strs(e.keys ?? e.key);
  if (has('filters') || has('filter')) out.keysecondary = strs(e.filters ?? e.filter);
  if (typeof e.logic === 'string') {
    const i = LOGIC.indexOf(e.logic as typeof LOGIC[number]);
    if (i >= 0) out.selective_logic = i;
  }
  if (has('scan_depth')) out.scan_depth = typeof e.scan_depth === 'number' ? e.scan_depth : null;
  if (typeof e.case_sensitive === 'boolean') out.case_sensitive = e.case_sensitive;
  if (typeof e.match_whole_words === 'boolean') out.match_whole_words = e.match_whole_words;
  if (has('automation_id')) out.automation_id = typeof e.automation_id === 'string' && e.automation_id ? e.automation_id : null;
  if (typeof e.exclude_recursion === 'boolean') out.exclude_recursion = e.exclude_recursion;
  if (typeof e.prevent_recursion === 'boolean') out.prevent_recursion = e.prevent_recursion;
  if (has('delay_until_recursion')) out.delay_until_recursion = !!e.delay_until_recursion;
  if (has('content')) out.content = String(e.content ?? '');
  if (typeof e.group === 'string') out.group_name = e.group;
  if (typeof e.group_prioritized === 'boolean') out.group_override = e.group_prioritized;
  if (typeof e.group_weight === 'number') out.group_weight = e.group_weight;
  for (const k of ['sticky', 'cooldown', 'delay'] as const) if (has(k)) out[k] = num(e[k], 0);
  return out;
}
