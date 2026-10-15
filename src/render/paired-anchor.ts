import { deepQuerySelectorAll } from './shadow-dom';

// Paired tags are stripped before render, so their position is lost. When the
// tag sits inside authored HTML, the nearest classed ancestor in the raw
// message identifies where the widget belongs in the rendered DOM.

export interface PairedAnchor {
  selector: string;
  occurrence: number;
  beforeSelector: string | null;
}

const MARKER = 'vishrun-anchor-marker';

function cssEsc(s: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(s)
    : s.replace(/[^\w-]/g, (c) => '\\' + c);
}

function signature(el: Element): string | null {
  const classes = Array.from(el.classList).filter(Boolean);
  if (classes.length === 0) return null;
  return el.tagName.toLowerCase() + classes.map((c) => '.' + cssEsc(c)).join('');
}

export function computePairedAnchor(rawContentIn: string, fullMatchIn: string): PairedAnchor | null {
  // The host normalizes line endings before tag interception; stored content may keep CRLF.
  const rawContent = rawContentIn.replace(/\r\n?/g, '\n');
  const fullMatch = fullMatchIn.replace(/\r\n?/g, '\n');
  const idx = rawContent.indexOf(fullMatch);
  if (idx < 0 || typeof DOMParser === 'undefined') return null;
  const marked = rawContent.slice(0, idx) + `<${MARKER}></${MARKER}>` + rawContent.slice(idx + fullMatch.length);
  const doc = new DOMParser().parseFromString(marked, 'text/html');
  const marker = doc.querySelector(MARKER);
  if (!marker) return null;

  let anchor: Element | null = marker.parentElement;
  let sel: string | null = null;
  while (anchor && anchor !== doc.body) {
    sel = signature(anchor);
    if (sel) break;
    anchor = anchor.parentElement;
  }
  if (!anchor || !sel || anchor === doc.body) return null;

  const occurrence = Array.from(doc.querySelectorAll(sel)).indexOf(anchor);
  let beforeSelector: string | null = null;
  if (marker.parentElement === anchor) {
    for (let n = marker.nextElementSibling; n; n = n.nextElementSibling) {
      beforeSelector = signature(n);
      if (beforeSelector) break;
    }
  }
  return { selector: sel, occurrence, beforeSelector };
}

// Insert `widget` at the anchor inside `root` (crossing shadow roots).
// Returns false when the anchor cannot be resolved, leaving the caller to fall back.
export function placeAtAnchor(root: ParentNode, anchor: PairedAnchor, widget: Element): boolean {
  const candidates = deepQuerySelectorAll(root, anchor.selector)
    .filter((el) => !el.closest('[data-vishrun-widget]'));
  const target = candidates[anchor.occurrence];
  if (!target) return false;
  if (anchor.beforeSelector) {
    const ref = Array.from(target.children).find((c) => c.matches(anchor.beforeSelector!));
    if (ref) {
      target.insertBefore(widget, ref);
      return true;
    }
  }
  target.appendChild(widget);
  return true;
}
