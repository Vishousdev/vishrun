// SillyTavern chat markup names on Lumiverse's message list, for scripts that
// query `#chat > .mes[mesid]` and `.mes_text`. Only names are added, plus one
// structural match: SillyTavern renders every fenced block as <pre><code>,
// while Lumiverse renders a one-line block without a language as a bare
// <code>. Those get a <pre> so `pre:contains(...)` lookups find them.

const ROW_SELECTOR = '[data-message-id][data-message-index]';
const TEXT_SELECTORS = ['[class*="_prose_"]', '[class*="_content_"]'];
const MARK = 'data-vishrun-st-alias';
const PRE_MARK = 'data-vishrun-st-pre';
/** Bumped on a row whenever its text is re-rendered with new fenced blocks. */
export const RENDER_MARK = 'data-vishrun-st-render';
let renders = 0;

// A bare <code> directly in the message text comes from a fenced block;
// inline code sits inside a paragraph.
function wrapFencedCode(text: Element): number {
  let wrapped = 0;
  for (const code of [...text.children]) {
    if (code.tagName !== 'CODE') continue;
    const pre = code.ownerDocument.createElement('pre');
    pre.setAttribute(PRE_MARK, '');
    code.replaceWith(pre);
    pre.appendChild(code);
    wrapped++;
  }
  return wrapped;
}

function isTopRow(el: Element): boolean {
  return !el.parentElement?.closest(ROW_SELECTOR);
}

export function applyStAlias(doc: Document = document): Element[] {
  const rows = [...doc.querySelectorAll(ROW_SELECTOR)].filter(isTopRow);
  if (rows.length === 0) return rows;
  const list = rows[0].parentElement;
  if (list && !list.id && !doc.getElementById('chat')) {
    list.id = 'chat';
    list.setAttribute(MARK, '');
  }
  for (const row of rows) {
    if (!row.classList.contains('mes')) row.classList.add('mes');
    const idx = row.getAttribute('data-message-index') ?? '';
    if (row.getAttribute('mesid') !== idx) row.setAttribute('mesid', idx);
    // Re-checked on every pass: React may replace the text element, leaving
    // the name on an outer one that matched while the row was still mounting.
    let text: Element | null = null;
    for (const sel of TEXT_SELECTORS) {
      text = row.querySelector(sel);
      if (text) break;
    }
    for (const el of row.querySelectorAll('.mes_text')) if (el !== text) el.classList.remove('mes_text');
    if (text) {
      if (!text.classList.contains('mes_text')) text.classList.add('mes_text');
      // Lumiverse applies display regexes after the first render, so new
      // fenced blocks mean the message was drawn again.
      if (wrapFencedCode(text) > 0) row.setAttribute(RENDER_MARK, String(++renders));
    }
  }
  return rows;
}

export function clearStAlias(doc: Document = document): void {
  const list = doc.querySelector(`#chat[${MARK}]`);
  if (list) { list.removeAttribute('id'); list.removeAttribute(MARK); }
  for (const row of doc.querySelectorAll(`${ROW_SELECTOR}.mes`)) {
    row.classList.remove('mes');
    row.removeAttribute('mesid');
    row.removeAttribute(RENDER_MARK);
  }
  for (const el of doc.querySelectorAll('.mes_text')) el.classList.remove('mes_text');
  for (const pre of doc.querySelectorAll(`pre[${PRE_MARK}]`)) pre.replaceWith(...pre.childNodes);
}

// Keeps the names in place while the virtual list mounts and re-renders rows.
// `onRows` gets the current top-level rows after each pass.
export function watchStAlias(doc: Document = document, onRows?: (rows: Element[]) => void): () => void {
  let scheduled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = () => {
    if (!scheduled) return;
    scheduled = false;
    clearTimeout(timer);
    const rows = applyStAlias(doc);
    if (onRows && rows.length) onRows(rows);
  };
  // Next frame, or a short timer when frames are paused (background tabs).
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(run);
    timer = setTimeout(run, 100);
  });
  observer.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'data-message-index'] });
  scheduled = true;
  run();
  return () => {
    clearTimeout(timer);
    observer.disconnect();
    clearStAlias(doc);
  };
}
