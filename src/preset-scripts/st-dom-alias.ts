// SillyTavern chat markup names on Lumiverse's message list, for preset
// scripts that query `#chat > .mes[mesid]` and `.mes_text`. Only names are
// added; Lumiverse's own classes and structure stay untouched.

const ROW_SELECTOR = '[data-message-id][data-message-index]';
const TEXT_SELECTORS = ['[class*="_prose_"]', '[class*="_content_"]'];
const MARK = 'data-vishrun-st-alias';

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
    if (!row.querySelector('.mes_text')) {
      for (const sel of TEXT_SELECTORS) {
        const text = row.querySelector(sel);
        if (text) { text.classList.add('mes_text'); break; }
      }
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
  }
  for (const el of doc.querySelectorAll('.mes_text')) el.classList.remove('mes_text');
}

// Keeps the names in place while the virtual list mounts and re-renders rows.
// `onRows` gets the current top-level rows after each pass.
export function watchStAlias(doc: Document = document, onRows?: (rows: Element[]) => void): () => void {
  let scheduled = false;
  const run = () => {
    scheduled = false;
    const rows = applyStAlias(doc);
    if (onRows && rows.length) onRows(rows);
  };
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(run);
  });
  observer.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'data-message-index'] });
  run();
  return () => {
    observer.disconnect();
    clearStAlias(doc);
  };
}
