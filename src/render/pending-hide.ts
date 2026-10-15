import type { OffsetMapEntry } from './linearize-bubble';
import { renderedChildNodes, deepQuerySelectorAll } from './shadow-dom';

// Hides the raw text of a block trigger (e.g. `[ST_START]…[ST_END]`) while the
// model is still streaming it and while its widget is being built, the way
// SillyTavern never shows the raw block. Only whole elements inside the block
// are hidden; nothing is moved, so host re-renders stay safe.

const PENDING_ATTR = 'data-vishrun-pending';

const META = new Set(['\\', '^', '$', '.', '|', '?', '*', '+', '(', ')', '[', ']', '{', '}']);

// Literal text a regex source must start with, up to the first metacharacter.
export function literalPrefix(source: string): string {
  let out = '';
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '\\') {
      const next = source[i + 1];
      if (next === undefined || /[A-Za-z0-9]/.test(next)) break;
      out += next;
      i++;
      continue;
    }
    if (META.has(ch)) break;
    out += ch;
  }
  // A trailing quantifier would make the last char optional.
  const after = source.slice(out.length);
  return /^[?*{]/.test(after) ? out.slice(0, -1) : out;
}

// Literal text a regex source must end with.
export function literalSuffix(source: string): string {
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
