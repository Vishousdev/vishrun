import { parseYaml } from './mvu-yaml';

// MVU seeds stat_data from lorebook entries whose comment contains
// "[initvar]", enabled or not. Content is JSON or YAML, optionally wrapped in
// <initvar> tags or a code fence. Entries merge in order; arrays replace.

export interface InitvarEntry {
  comment?: unknown;
  content?: unknown;
}

type Obj = Record<string, unknown>;

function isPlainObject(v: unknown): v is Obj {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function mergeInitvar(target: Obj, source: Obj): Obj {
  for (const [k, v] of Object.entries(source)) {
    const cur = target[k];
    target[k] = isPlainObject(cur) && isPlainObject(v) ? mergeInitvar({ ...cur }, v) : v;
  }
  return target;
}

export function parseInitvarContent(raw: string): Obj | null {
  let text = raw.trim();
  const xml = text.match(/.*<initvar>.*\n([\s\S]*)\n.*<\/initvar>.*/m);
  if (xml) text = xml[1];
  const fence = text.trim().match(/```.*\n([\s\S]*)\n```/m);
  if (fence) text = fence[1];
  text = text.trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    // not JSON, fall through to YAML
  }
  try {
    const parsed = parseYaml(text) as unknown;
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function initvarFromEntries(entries: InitvarEntry[]): Obj {
  const out: Obj = {};
  for (const e of entries) {
    if (typeof e.comment !== 'string' || !e.comment.toLowerCase().includes('[initvar]')) continue;
    if (typeof e.content !== 'string') continue;
    const data = parseInitvarContent(e.content);
    if (data) mergeInitvar(out, data);
  }
  return out;
}
