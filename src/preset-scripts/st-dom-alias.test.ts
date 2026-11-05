import { test, expect } from 'bun:test';
import { Window } from 'happy-dom';
import { applyStAlias, clearStAlias, RENDER_MARK } from './st-dom-alias';

function makeDoc() {
  const doc = new Window().document as unknown as Document;
  doc.body.innerHTML = `
    <div class="_list_x"><div class="_virtualSpace_x">
      <div data-message-id="a" data-message-index="0"><div class="_content_x"><div class="_prose_x">hi</div></div></div>
      <div data-message-id="b" data-message-index="1"><div class="_content_x">no prose</div></div>
    </div></div>`;
  return doc;
}

test('st alias: names the list, rows and text like SillyTavern', () => {
  const doc = makeDoc();
  const rows = applyStAlias(doc);
  expect(rows.length).toBe(2);
  expect(doc.querySelectorAll('#chat > .mes[mesid]').length).toBe(2);
  expect(doc.querySelector('#chat > .mes[mesid="0"] .mes_text')?.textContent).toBe('hi');
  expect(doc.querySelector('#chat > .mes[mesid="1"] .mes_text')?.textContent).toBe('no prose');
});

test('st alias: clear removes only the added names', () => {
  const doc = makeDoc();
  applyStAlias(doc);
  clearStAlias(doc);
  expect(doc.getElementById('chat')).toBeNull();
  expect(doc.querySelectorAll('.mes, .mes_text, [mesid]').length).toBe(0);
  expect(doc.querySelectorAll('._prose_x').length).toBe(1);
});

test('st alias: a fenced one-line block gets a <pre> like SillyTavern, inline code does not', () => {
  const doc = new Window().document as unknown as Document;
  doc.body.innerHTML = `
    <div><div data-message-id="a" data-message-index="0"><div class="_prose_x">
      <p>text <code>inline</code></p><code>&lt;msg&gt;a|b|hi&lt;/msg&gt;</code><p>more</p>
    </div></div></div>`;
  applyStAlias(doc);
  applyStAlias(doc);
  expect(doc.querySelectorAll('pre > code').length).toBe(1);
  expect(doc.querySelector('pre')?.textContent).toBe('<msg>a|b|hi</msg>');
  expect(doc.querySelector('p code')?.parentElement?.tagName).toBe('P');
  clearStAlias(doc);
  expect(doc.querySelectorAll('pre').length).toBe(0);
  expect(doc.querySelectorAll('._prose_x > code').length).toBe(1);
});

test('st alias: the name moves to the text element when React replaces it', () => {
  const doc = new Window().document as unknown as Document;
  doc.body.innerHTML = `<div><div data-message-id="a" data-message-index="0"><div class="_content_x">loading</div></div></div>`;
  applyStAlias(doc);
  const content = doc.querySelector('._content_x')!;
  content.innerHTML = '<div class="_prose_x">text</div>';
  applyStAlias(doc);
  expect(doc.querySelectorAll('.mes_text').length).toBe(1);
  expect(doc.querySelector('.mes_text')?.className).toContain('_prose_x');
});

test('st alias: a re-render with new fenced blocks marks the row, a stable one does not', () => {
  const doc = new Window().document as unknown as Document;
  doc.body.innerHTML = `<div><div data-message-id="a" data-message-index="0"><div class="_prose_x"><p>raw</p></div></div></div>`;
  applyStAlias(doc);
  const row = doc.querySelector('[data-message-id]')!;
  expect(row.getAttribute(RENDER_MARK)).toBeNull();
  doc.querySelector('._prose_x')!.innerHTML = '<p>x</p><code>&lt;msg&gt;a&lt;/msg&gt;</code>';
  applyStAlias(doc);
  const first = row.getAttribute(RENDER_MARK);
  expect(first).not.toBeNull();
  applyStAlias(doc);
  expect(row.getAttribute(RENDER_MARK)).toBe(first);
});
