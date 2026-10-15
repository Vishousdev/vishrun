// Linearize a message bubble into a flat string + offset map so multi-line
// regex scripts can match across the `<p>...</p><p>...</p>` fragmentation that
// Lumiverse's markdown rendering produces. The offset map lets us walk back
// from a regex match's start/end in the linearized string to the actual Text
// nodes in the DOM, where we then perform the widget replacement.
//
// Linearization rules:
//   - <br>           → '\n'
//   - </p><p>        → '\n\n' (and other adjacent block-level sibling gaps)
//   - inline tags    → contents flattened, no separator
//   - data-vishrun-widget subtrees → SKIPPED (already-rendered widgets stay put)

import { deepTextContent, isNonTextElement, renderedChildNodes } from './shadow-dom';

export interface OffsetMapEntry {
  node: Text;
  /** Offset within `node.nodeValue`. */
  nodeStart: number;
  nodeEnd: number;
  /** Offset within the linearized string. */
  sourceStart: number;
  sourceEnd: number;
}

export interface LinearResult {
  text: string;
  offsetMap: OffsetMapEntry[];
}

const BLOCK_TAGS = new Set([
  'P', 'DIV', 'BLOCKQUOTE', 'PRE', 'UL', 'OL', 'LI',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR',
]);

export function linearizeBubble(root: HTMLElement): LinearResult {
  let text = '';
  const offsetMap: OffsetMapEntry[] = [];

  function walk(node: Node): void {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node as Text;
      const value = t.nodeValue ?? '';
      if (value.length === 0) return;
      const sourceStart = text.length;
      text += value;
      offsetMap.push({
        node: t,
        nodeStart: 0,
        nodeEnd: value.length,
        sourceStart,
        sourceEnd: text.length,
      });
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    if (el.hasAttribute && el.hasAttribute('data-vishrun-widget')) return;
    if (isNonTextElement(el)) return;
    if (el.tagName === 'BR') {
      text += '\n';
      return;
    }
    const isBlock = BLOCK_TAGS.has(el.tagName);
    let prevText = '';
    if (isBlock && text.length > 0 && !text.endsWith('\n\n')) {
      prevText = text.endsWith('\n') ? '\n' : '\n\n';
      text += prevText;
    }
    for (const child of renderedChildNodes(el)) walk(child);
    if (isBlock && text.length > 0 && !text.endsWith('\n\n')) {
      text += text.endsWith('\n') ? '\n' : '\n\n';
    }
  }

  for (const child of Array.from(root.childNodes)) walk(child);

  // Trim trailing block separator(s) added when the last child was a block.
  while (text.endsWith('\n')) text = text.slice(0, -1);
  return { text, offsetMap };
}

// Cache keyed by bubble element. Reused for every multi-line script on the
// same scan pass. Entries auto-drop when the bubble is GC'd (WeakMap).
interface CacheEntry { hash: string; result: LinearResult }
const cache = new WeakMap<HTMLElement, CacheEntry>();

export function getLinearizedBubble(root: HTMLElement): LinearResult {
  const tc = deepTextContent(root);
  const hash = quickHash(tc);
  const cached = cache.get(root);
  if (cached && cached.hash === hash) return cached.result;
  const result = linearizeBubble(root);
  cache.set(root, { hash, result });
  return result;
}

export function invalidateLinearizedBubble(root: HTMLElement): void {
  cache.delete(root);
}

// FNV-1a 32-bit. Fast, collision rate is fine for cache-key disambiguation
// since the WeakMap key (root element identity) already scopes it.
function quickHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
