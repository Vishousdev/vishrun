import type { OffsetMapEntry } from './linearize-bubble';
import { renderedChildNodes, deepQuerySelectorAll } from './shadow-dom';

// Hides the raw text of a block trigger (e.g. `[ST_START]…[ST_END]`) while the
// model is still streaming it and while its widget is being built, the way
// SillyTavern never shows the raw block. Only whole elements inside the block
// are hidden; nothing is moved, so host re-renders stay safe.

const PENDING_ATTR = 'data-vishrun-pending';

const META = new Set(['\\', '^', '$', '.', '|', '?', '*', '+', '(', ')', '[', ']', '{', '}']);

// Literal text a regex source must start with, up to the first metacharacter.
// `\uXXXX` / `\xXX` escapes as the characters they stand for, unless that
// character is regex syntax.
function decodeEscapes(source: string): string {
  return source.replace(/\\u([0-9A-Fa-f]{4})|\\x([0-9A-Fa-f]{2})/g, (m, u, x) => {
    const ch = String.fromCharCode(parseInt(u ?? x, 16));
    return /[\\^$.*+?()[\]{}|\/-]/.test(ch) ? m : ch;
  });
}

export function literalPrefix(sourceIn: string): string {
  const source = decodeEscapes(sourceIn);
  let out = '';
  let i = 0;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === '\\') {
      const next = source[i + 1];
      const hex = next === 'u' ? /^[0-9A-Fa-f]{4}/.exec(source.slice(i + 2)) : next === 'x' ? /^[0-9A-Fa-f]{2}/.exec(source.slice(i + 2)) : null;
      if (hex) {
        out += String.fromCharCode(parseInt(hex[0], 16));
        i += 1 + hex[0].length;
        continue;
      }
      if (next === undefined || /[A-Za-z0-9]/.test(next)) break;
      out += next;
      i++;
      continue;
    }
    if (META.has(ch)) break;
    out += ch;
  }
  // A trailing quantifier would make the last char optional.
  const after = source.slice(i);
  return /^[?*{]/.test(after) ? out.slice(0, -1) : out;
}

// Top-level alternatives of the group whose body starts at `from` (just past
// its opening paren); returns the alternatives and the closing paren index.
function groupAlternatives(src: string, from: number): { alts: string[]; end: number } | null {
  let depth = 0;
  let start = from;
  const alts: string[] = [];
  for (let i = from; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\\') { i++; continue; }
    if (ch === '[') {
      while (i < src.length && src[i] !== ']') { if (src[i] === '\\') i++; i++; }
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      if (depth === 0) { alts.push(src.slice(start, i)); return { alts, end: i }; }
      depth--;
    } else if (ch === '|' && depth === 0) {
      alts.push(src.slice(start, i));
      start = i + 1;
    }
  }
  return null;
}

// Literal prefixes the source can start with: one, or one per alternative of a
// leading `(?:A|B|…)` group (bilingual tags such as `(?:<Status Bar>|<状态栏>)`).
export function leadingLiterals(src: string): string[] {
  if (!src.startsWith('(?:')) return [literalPrefix(src)];
  const g = groupAlternatives(src, 3);
  return g ? g.alts.map((a) => literalPrefix(a)) : [''];
}

// Literal suffixes the source can end with, likewise for a trailing `(?:A|B)`.
export function trailingLiterals(src: string): string[] {
  if (!src.endsWith(')')) return [literalSuffix(src)];
  for (let i = src.lastIndexOf('(?:'); i >= 0; i = src.lastIndexOf('(?:', i - 1)) {
    const g = groupAlternatives(src, i + 3);
    if (g && g.end === src.length - 1) return g.alts.map((a) => literalSuffix(a));
    if (i === 0) break;
  }
  return [literalSuffix(src)];
}

// Literal text a regex source must end with.
export function literalSuffix(sourceIn: string): string {
  const source = decodeEscapes(sourceIn);
  let out = '';
  let i = source.length - 1;
  while (i >= 0) {
    const ch = source[i];
    const escaped = i > 0 && source[i - 1] === '\\' && !(i > 1 && source[i - 2] === '\\');
    if (escaped) {
      if (/[A-Za-z0-9]/.test(ch)) break;
      out = ch + out;
      i -= 2;
      continue;
    }
    if (META.has(ch)) break;
    out = ch + out;
    i--;
  }
  return out;
}

// Ranges [open, end-of-text) for openers that have no closer yet.
export function unterminatedRanges(text: string, open: string, close: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  if (open.length < 3 || close.length === 0) return out;
  let from = 0;
  for (;;) {
    const o = text.indexOf(open, from);
    if (o < 0) break;
    const c = text.indexOf(close, o + open.length);
    if (c < 0) {
      out.push([o, text.length]);
      break;
    }
    from = c + close.length;
  }
  return out;
}

function hide(el: HTMLElement): void {
  if (el.hasAttribute(PENDING_ATTR)) return;
  el.setAttribute(PENDING_ATTR, el.style.getPropertyValue('display') || '');
  el.style.setProperty('display', 'none', 'important');
}

function unhide(el: HTMLElement): void {
  const prev = el.getAttribute(PENDING_ATTR);
  el.removeAttribute(PENDING_ATTR);
  if (prev) el.style.setProperty('display', prev); else el.style.removeProperty('display');
}

export function clearPending(root: ParentNode): void {
  deepQuerySelectorAll<HTMLElement>(root, `[${PENDING_ATTR}]`).forEach(unhide);
}

// Hide every element whose rendered text lies entirely inside [start, end).
export function hideRange(bubble: HTMLElement, offsetMap: OffsetMapEntry[], start: number, end: number): number {
  const byNode = new Map<Node, OffsetMapEntry>();
  for (const e of offsetMap) byNode.set(e.node, e);

  const span = (el: Element): [number, number] | null => {
    let lo = Infinity;
    let hi = -Infinity;
    const walk = (n: Node): void => {
      const e = byNode.get(n);
      if (e) { lo = Math.min(lo, e.sourceStart); hi = Math.max(hi, e.sourceEnd); }
      for (const c of renderedChildNodes(n)) walk(c);
    };
    walk(el);
    return lo === Infinity ? null : [lo, hi];
  };

  const hidden = new Set<Element>();
  for (const e of offsetMap) {
    if (e.sourceEnd <= start || e.sourceStart >= end) continue;
    let el: Element | null = e.node.parentElement;
    let best: Element | null = null;
    while (el && el !== bubble) {
      const s = span(el);
      if (!s || s[0] < start || s[1] > end) break;
      best = el;
      const p: Node | null = el.parentNode;
      el = p && p.nodeType === 11 ? null : (p as Element | null);
    }
    if (best && ![...hidden].some((h) => h.contains(best!))) hidden.add(best);
  }
  hidden.forEach((el) => hide(el as HTMLElement));
  return hidden.size;
}

export function unhideRange(bubble: HTMLElement): void {
  clearPending(bubble);
}
