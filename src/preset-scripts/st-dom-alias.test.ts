import { test, expect } from 'bun:test';
import { Window } from 'happy-dom';
import { applyStAlias, clearStAlias } from './st-dom-alias';

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
