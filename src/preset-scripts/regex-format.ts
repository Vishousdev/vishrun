import { rewriteDollarZero } from '../core/takeover-policy';

// Lumiverse regex rows <-> JS-Slash-Runner's TavernRegex. Mirrors JSR's
// to/from_tavern_regex and Lumiverse's own SillyTavern import mapping
// (markdownOnly -> display, promptOnly -> prompt, neither -> response).

export interface HostRegexRow {
  id: string;
  name: string;
  find_regex: string;
  replace_string: string;
  flags: string;
  placement: string[];
  target: string | string[];
  min_depth: number | null;
  max_depth: number | null;
  trim_strings: string[];
  run_on_edit: boolean;
  disabled: boolean;
  can_mutate?: boolean;
  preset_id?: string | null;
  metadata?: Record<string, unknown>;
}

export type RegexInput = Partial<Omit<HostRegexRow, 'id' | 'can_mutate' | 'preset_id'>>;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const targetsOf = (t: string | string[]) => (Array.isArray(t) ? t : [t]);

function vishrunMeta(row: HostRegexRow): { takeover?: unknown; dollarZero?: unknown; original?: unknown } {
  const v = row.metadata?.vishrun;
  return isObj(v) ? v : {};
}

// SillyTavern keeps the pattern in /pattern/flags form.
export function splitRegexLiteral(find: string): { pattern: string; flags: string } {
  const m = find.match(/^\/(.+)\/([dgimsuvy]*)$/s);
  return m ? { pattern: m[1], flags: m[2] || 'gi' } : { pattern: find, flags: 'gi' };
}

// Rows Vishrun took over still count as enabled, and a rewritten $0 shows its
// original text, so scripts see the card's regexes as written.
export function toTavernRegex(row: HostRegexRow): Obj {
  const v = vishrunMeta(row);
  const targets = targetsOf(row.target);
  const placement = row.placement ?? [];
  return {
    id: row.id,
    script_name: row.name,
    enabled: !row.disabled || v.takeover === true,
    find_regex: `/${row.find_regex}/${row.flags ?? ''}`,
    trim_strings: [...(row.trim_strings ?? [])],
    replace_string: v.dollarZero === true && typeof v.original === 'string' ? v.original : row.replace_string,
    source: {
      user_input: placement.includes('user_input'),
      ai_output: placement.includes('ai_output'),
      slash_command: false,
      world_info: placement.includes('world_info'),
      reasoning: placement.includes('reasoning'),
    },
    destination: { display: targets.includes('display'), prompt: targets.includes('prompt') },
    run_on_edit: row.run_on_edit,
    min_depth: typeof row.min_depth === 'number' ? row.min_depth : null,
    max_depth: typeof row.max_depth === 'number' ? row.max_depth : null,
  };
}

export function fromTavernRegex(raw: unknown): RegexInput {
  const t = isObj(raw) ? raw : {};
  const source = isObj(t.source) ? t.source : {};
  const destination = isObj(t.destination) ? t.destination : {};
  const { pattern, flags } = splitRegexLiteral(String(t.find_regex ?? ''));
  const placement = (['user_input', 'ai_output', 'world_info', 'reasoning'] as const).filter((p) => source[p] === true);
  const target = [...(destination.display === true ? ['display'] : []), ...(destination.prompt === true ? ['prompt'] : [])];
  const original = String(t.replace_string ?? '');
  const replace = rewriteDollarZero(original);
  return {
    name: String(t.script_name ?? '') || `未命名-${String(t.id ?? '')}`,
    find_regex: pattern,
    flags,
    replace_string: replace,
    placement: [...placement],
    target: target.length > 0 ? target : ['response'],
    min_depth: typeof t.min_depth === 'number' ? t.min_depth : null,
    max_depth: typeof t.max_depth === 'number' ? t.max_depth : null,
    trim_strings: Array.isArray(t.trim_strings) ? t.trim_strings.map(String) : [],
    run_on_edit: t.run_on_edit === true,
    disabled: t.enabled === false,
    ...(replace !== original ? { metadata: { vishrun: { dollarZero: true, original } } } : {}),
  };
}

export interface RegexPlan {
  create: RegexInput[];
  update: Array<{ id: string; patch: RegexInput }>;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// replaceTavernRegexes without deletes: rows matched by id are updated where
// they changed, the rest are created. Rows the script left out stay.
export function planRegexReplace(current: HostRegexRow[], next: unknown[]): RegexPlan {
  const byId = new Map(current.map((r) => [r.id, r]));
  const plan: RegexPlan = { create: [], update: [] };
  for (const raw of next) {
    const row = isObj(raw) ? byId.get(String(raw.id ?? '')) : undefined;
    if (!row) {
      plan.create.push(fromTavernRegex(raw));
      continue;
    }
    if (row.can_mutate === false) continue;
    const want = fromTavernRegex(raw) as Obj;
    const have = fromTavernRegex(toTavernRegex(row)) as Obj;
    const patch: Obj = {};
    for (const k of ['name', 'find_regex', 'flags', 'placement', 'target', 'min_depth', 'max_depth', 'trim_strings', 'run_on_edit']) {
      if (!same(have[k], want[k])) patch[k] = want[k];
    }
    if (!same(have.replace_string, want.replace_string)) {
      patch.replace_string = want.replace_string;
      patch.metadata = { ...(row.metadata ?? {}), ...((want.metadata as Obj | undefined) ?? {}) };
    }
    // A row Vishrun took over is shown as enabled; only an explicit change counts.
    if (have.disabled !== want.disabled && vishrunMeta(row).takeover !== true) patch.disabled = want.disabled;
    if (Object.keys(patch).length > 0) plan.update.push({ id: row.id, patch: patch as RegexInput });
  }
  return plan;
}
