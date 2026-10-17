// MVU update commands written by the model, applied to stat_data:
//   _.set(path, [old,] new)          path must exist; [value, "desc"] keeps desc
//   _.add(path, delta)               numbers, or ms on a date string
//   _.insert / _.assign(path, value) push to array or merge into object
//   _.insert / _.assign(path, key|index, value)
//   _.remove / _.unset / _.delete(path [, key|index|value])
// Commands are read from the whole message, minus thinking/analysis blocks,
// and must end with ");". Mirrors MagVarUpdate's update_variables.ts without
// its schema checks.

export type CommandType = 'set' | 'insert' | 'remove' | 'add';

export interface MvuCommand {
  type: CommandType;
  args: string[];
  index: number;
}

type Obj = Record<string, unknown>;

import { yamlLoad } from './mvu-yaml-schema';
import JSON5 from 'json5';

// ---- extraction ----

const HIDDEN_TAG_RE = /<(\/?)\s*(think|thinking|reasoning|analysis|analyze)\b[^>]*>/gi;

// Blank out thinking blocks with spaces so offsets stay valid.
export function maskThinking(text: string): string {
  const out = text.split('');
  const stack: string[] = [];
  let from = 0;
  for (const m of text.matchAll(HIDDEN_TAG_RE)) {
    const at = m.index ?? 0;
    const name = m[2].toLowerCase();
    if (stack.length > 0) {
      for (let i = from; i < at + m[0].length; i++) if (out[i] !== '\n') out[i] = ' ';
      if (m[1] && name === stack[stack.length - 1]) stack.pop();
      else if (!m[1]) stack.push(name);
      from = at + m[0].length;
    } else if (!m[1]) {
      stack.push(name);
      from = at;
    }
  }
  if (stack.length > 0) for (let i = from; i < out.length; i++) if (out[i] !== '\n') out[i] = ' ';
  return out.join('');
}

function findMatchingCloseParen(s: string, start: number): number {
  let depth = 1;
  let quote = '';
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if ((c === '"' || c === "'" || c === '`') && s[i - 1] !== '\\') {
      if (!quote) quote = c;
      else if (c === quote) quote = '';
    }
    if (quote) continue;
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return -1;
}

export function parseParameters(s: string): string[] {
  const params: string[] = [];
  let cur = '';
  let quote = '';
  let paren = 0, bracket = 0, brace = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if ((c === '"' || c === "'" || c === '`') && (i === 0 || s[i - 1] !== '\\')) {
      if (!quote) quote = c;
      else if (c === quote) quote = '';
    }
    if (!quote) {
      if (c === '(') paren++;
      else if (c === ')') paren--;
      else if (c === '[') bracket++;
      else if (c === ']') bracket--;
      else if (c === '{') brace++;
      else if (c === '}') brace--;
      if (c === ',' && paren === 0 && bracket === 0 && brace === 0) {
        params.push(cur.trim());
        cur = '';
        continue;
      }
    }
    cur += c;
  }
  if (cur.trim()) params.push(cur.trim());
  return params;
}

const CMD_RE = /_\.(set|insert|assign|remove|unset|delete|add)\(/g;
const ALIASES: Record<string, CommandType> = {
  set: 'set', insert: 'insert', assign: 'insert', remove: 'remove', unset: 'remove', delete: 'remove', add: 'add',
};

export function extractCommands(text: string): MvuCommand[] {
  const visible = maskThinking(text);
  const out: MvuCommand[] = [];
  CMD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CMD_RE.exec(visible)) !== null) {
    const open = m.index + m[0].length;
    const close = findMatchingCloseParen(text, open);
    if (close === -1) continue;
    if (text[close + 1] !== ';') { CMD_RE.lastIndex = close + 1; continue; }
    const args = parseParameters(text.slice(open, close));
    const type = ALIASES[m[1]];
    const ok = type === 'add' ? args.length === 2 : type === 'remove' ? args.length >= 1 : args.length >= 2;
    if (ok) out.push({ type, args, index: m.index });
    CMD_RE.lastIndex = close + 2;
  }
  return out;
}

// ---- values ----

export function trimQuotes(s: string): string {
  return s.replace(/^[\\"'` ]*(.*?)[\\"'` ]*$/s, '$1');
}

// Arithmetic on number literals: + - * / % ** and parentheses.
function evalArithmetic(src: string): number | undefined {
  const toks = src.match(/\d+(?:\.\d+)?(?:e[+-]?\d+)?|\*\*|[-+*/%()]|\S/gi) ?? [];
  let p = 0;
  const peek = () => toks[p];
  const num = (): number => {
    const t = toks[p++];
    if (t === '(') { const v = sum(); if (toks[p++] !== ')') throw 0; return v; }
    if (t === '-') return -unary();
    if (t === '+') return unary();
    if (t !== undefined && /^\d/.test(t)) return Number(t);
    throw 0;
  };
  const unary = (): number => {
    const b = num();
    if (peek() === '**') { p++; return b ** unary(); }
    return b;
  };
  const product = (): number => {
    let v = unary();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = toks[p++];
      const r = unary();
      v = op === '*' ? v * r : op === '/' ? v / r : v % r;
    }
    return v;
  };
  const sum = (): number => {
    let v = product();
    while (peek() === '+' || peek() === '-') v = toks[p++] === '+' ? v + product() : v - product();
    return v;
  };
  try {
    const v = sum();
    return p === toks.length && Number.isFinite(v) ? parseFloat(v.toPrecision(12)) : undefined;
  } catch {
    return undefined;
  }
}

export function parseCommandValue(raw: string): unknown {
  const t = raw.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null') return null;
  if (t === 'undefined') return undefined;
  try {
    return JSON.parse(t);
  } catch {
    if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
      try {
        const v = JSON5.parse(t);
        if (v !== null && typeof v === 'object') return v;
      } catch { /* not a literal */ }
    }
  }
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) {
    try { return yamlLoad(t); } catch { /* fall through */ }
  }
  if (/[\d)]/.test(t) && /^[\d\s.+\-*/%()e]+$/i.test(t)) {
    const n = evalArithmetic(t);
    if (n !== undefined) return n;
  }
  try {
    return yamlLoad(t);
  } catch {
    return trimQuotes(raw);
  }
}

// ---- paths ----

export function toPath(raw: string): string[] {
  const path = trimQuotes(raw);
  const out: string[] = [];
  const re = /\[\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^\]]*?))\s*\]|([^.[\]]+)/g;
  for (const m of path.matchAll(re)) {
    const seg = m[1] ?? m[2] ?? m[3] ?? m[4];
    out.push(m[1] !== undefined || m[2] !== undefined ? seg.replace(/\\(.)/g, '$1') : seg.trim());
  }
  return out.filter((s, i) => s !== '' || i > 0);
}

function isObj(v: unknown): v is Obj {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isCollection(v: unknown): v is Obj | unknown[] {
  return v !== null && typeof v === 'object';
}

function getIn(root: unknown, segs: string[]): unknown {
  let cur = root;
  for (const s of segs) {
    if (!isCollection(cur)) return undefined;
    cur = (cur as Obj)[s];
  }
  return cur;
}

function hasIn(root: unknown, segs: string[]): boolean {
  let cur = root;
  for (const s of segs) {
    if (!isCollection(cur) || !Object.prototype.hasOwnProperty.call(cur, s)) return false;
    cur = (cur as Obj)[s];
  }
  return true;
}

function setIn(root: Obj, segs: string[], value: unknown): void {
  let cur: Obj | unknown[] = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const next = (cur as Obj)[segs[i]];
    if (!isCollection(next)) (cur as Obj)[segs[i]] = /^\d+$/.test(segs[i + 1]) ? [] : {};
    cur = (cur as Obj)[segs[i]] as Obj | unknown[];
  }
  (cur as Obj)[segs[segs.length - 1]] = value;
}

function unsetIn(root: Obj, segs: string[]): void {
  const parent = getIn(root, segs.slice(0, -1));
  if (isCollection(parent)) delete (parent as Obj)[segs[segs.length - 1]];
}

function isVwd(v: unknown): v is [unknown, string] {
  return Array.isArray(v) && v.length === 2 && typeof v[1] === 'string';
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function deepMerge(target: Obj, src: Obj): void {
  for (const [k, v] of Object.entries(src)) {
    if (isObj(target[k]) && isObj(v)) deepMerge(target[k] as Obj, v);
    else target[k] = v;
  }
}

// ---- apply ----

export type CommandResult = { ok: true } | { ok: false; reason: string };

// Applies one command to `stat` in place.
export function applyCommand(stat: Obj, cmd: MvuCommand): CommandResult {
  const segs = toPath(cmd.args[0] ?? '');
  const atRoot = segs.length === 0;
  switch (cmd.type) {
    case 'set': {
      if (atRoot || !hasIn(stat, segs)) return { ok: false, reason: 'path-missing' };
      const old = getIn(stat, segs);
      const next = parseCommandValue(cmd.args[cmd.args.length - 1]);
      if (isVwd(old) && !Array.isArray(old[0])) {
        old[0] = typeof old[0] === 'number' && next !== null ? Number(next) : next;
      } else if (typeof old === 'number' && typeof next === 'string') {
        setIn(stat, segs, Number(next));
      } else {
        setIn(stat, segs, next);
      }
      return { ok: true };
    }
    case 'add': {
      if (atRoot || !hasIn(stat, segs)) return { ok: false, reason: 'path-missing' };
      const holder = getIn(stat, segs);
      const vwd = isVwd(holder) && typeof holder[0] !== 'object';
      const cur = vwd ? (holder as unknown[])[0] : holder;
      const delta = parseCommandValue(cmd.args[1]);
      if (typeof delta !== 'number') return { ok: false, reason: 'delta-not-number' };
      let next: unknown;
      const date = typeof cur === 'string' && isNaN(Number(cur)) ? new Date(cur) : null;
      if (date && !isNaN(date.getTime())) next = new Date(date.getTime() + delta).toISOString();
      else if (typeof cur === 'number') next = parseFloat((cur + delta).toPrecision(12));
      else return { ok: false, reason: 'not-a-number' };
      if (vwd) (holder as unknown[])[0] = next;
      else setIn(stat, segs, next);
      return { ok: true };
    }
    case 'insert': {
      const existing = atRoot ? stat : getIn(stat, segs);
      if (existing !== undefined && existing !== null && !isCollection(existing)) return { ok: false, reason: 'primitive-target' };
      if (!atRoot && existing === undefined && segs.length > 1 && !getIn(stat, segs.slice(0, -1))) {
        return { ok: false, reason: 'parent-missing' };
      }
      if (cmd.args.length === 2) {
        const value = parseCommandValue(cmd.args[1]);
        let coll = existing;
        if (!isCollection(coll)) {
          coll = Array.isArray(value) ? [] : {};
          setIn(stat, segs, coll);
        }
        if (Array.isArray(coll)) { coll.push(value); return { ok: true }; }
        if (isObj(value)) { deepMerge(coll as Obj, value); return { ok: true }; }
        return { ok: false, reason: 'merge-non-object' };
      }
      const key = parseCommandValue(cmd.args[1]);
      const value = parseCommandValue(cmd.args[2]);
      if (Array.isArray(existing) && (typeof key === 'number' || key === '-')) {
        existing.splice(key === '-' ? existing.length : (key as number), 0, value);
        return { ok: true };
      }
      if (isObj(existing)) { existing[String(key)] = value; return { ok: true }; }
      const created: Obj = { [String(key)]: value };
      setIn(stat, segs, created);
      return { ok: true };
    }
    case 'remove': {
      if (cmd.args.length === 1 && segs.length > 0 && /^\d+$/.test(segs[segs.length - 1])) {
        const container = getIn(stat, segs.slice(0, -1));
        const idx = Number(segs[segs.length - 1]);
        if (Array.isArray(container) && idx < container.length) { container.splice(idx, 1); return { ok: true }; }
      }
      if (atRoot || !hasIn(stat, segs)) return { ok: false, reason: 'path-missing' };
      if (cmd.args.length === 1) { unsetIn(stat, segs); return { ok: true }; }
      const target = parseCommandValue(cmd.args[1]);
      const coll = getIn(stat, segs);
      if (Array.isArray(coll)) {
        const idx = typeof target === 'number' ? target : coll.findIndex((x) => deepEqual(x, target));
        if (idx >= 0 && idx < coll.length) { coll.splice(idx, 1); return { ok: true }; }
        return { ok: false, reason: 'not-found' };
      }
      if (isObj(coll)) {
        const key = typeof target === 'number' ? Object.keys(coll)[target] : String(typeof target === 'string' ? trimQuotes(target) : target);
        if (key !== undefined && Object.prototype.hasOwnProperty.call(coll, key)) { delete coll[key]; return { ok: true }; }
        return { ok: false, reason: 'not-found' };
      }
      return { ok: false, reason: 'not-a-collection' };
    }
  }
}
