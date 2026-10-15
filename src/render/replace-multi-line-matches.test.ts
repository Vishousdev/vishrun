import { test, expect } from 'bun:test';
import { linearizeBubble } from './linearize-bubble';
import { replaceLinearRange } from './inject-into-message';

function bubble(html: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
}

function makeWidget(label: string): HTMLElement {
  const w = document.createElement('div');
  w.setAttribute('data-vishrun-widget', 'test');
  w.textContent = label;
  return w;
}

test('match spans 3 entire paragraphs: widget replaces them, surroundings intact', () => {
  const b = bubble(
    '<p>preamble</p>' +
    '<p>[ START ]<br>line 1</p>' +
    '<p>line 2</p>' +
    '<p>line 3<br>[ END ]</p>' +
    '<p>tail</p>',
  );
  const linear = linearizeBubble(b);
  const start = linear.text.indexOf('[ START ]');
  const end = linear.text.indexOf('[ END ]') + '[ END ]'.length;
  const widget = makeWidget('REPLACED');
  expect(replaceLinearRange(b, linear.offsetMap, start, end, widget)).toBe(true);
  // The three middle paragraphs are gone; widget sits where they were.
  const ps = Array.from(b.querySelectorAll('p')).map((p) => p.textContent);
  expect(ps).toEqual(['preamble', 'tail']);
  expect(b.querySelector('[data-vishrun-widget="test"]')!.textContent).toBe('REPLACED');
  // widget is between the two preserved paragraphs.
  const pre = b.querySelector('p:first-child')!;
  const post = b.querySelector('p:last-child')!;
  expect(pre.textContent).toBe('preamble');
  expect(post.textContent).toBe('tail');
});

test('partial paragraph match splits the text node and preserves surroundings', () => {
  const b = bubble('<p>before MATCH after</p>');
  const linear = linearizeBubble(b);
  const start = linear.text.indexOf('MATCH');
  const end = start + 'MATCH'.length;
  const widget = makeWidget('W');
  expect(replaceLinearRange(b, linear.offsetMap, start, end, widget)).toBe(true);
  const p = b.querySelector('p')!;
  expect(p.textContent).toBe('before W after');
  expect(p.querySelector('[data-vishrun-widget="test"]')!.textContent).toBe('W');
});

test('match at paragraph boundary keeps preceding and following text intact', () => {
  const b = bubble('<p>keep before</p><p>X</p><p>keep after</p>');
  const linear = linearizeBubble(b);
  const start = linear.text.indexOf('X');
  const end = start + 1;
  const widget = makeWidget('W');
  expect(replaceLinearRange(b, linear.offsetMap, start, end, widget)).toBe(true);
  const texts = Array.from(b.childNodes)
    .filter((n) => n.nodeType === Node.ELEMENT_NODE)
    .map((n) => (n as HTMLElement).tagName + ':' + ((n as HTMLElement).textContent ?? ''));
  expect(texts).toEqual([
    'P:keep before',
    'DIV:W',
    'P:keep after',
  ]);
});

test('multiple matches in reverse order do not interfere', () => {
  const b = bubble('<p>before [ ONE ] middle [ TWO ] after</p>');
  let linear = linearizeBubble(b);
  const startTwo = linear.text.indexOf('[ TWO ]');
  const endTwo = startTwo + '[ TWO ]'.length;
  expect(replaceLinearRange(b, linear.offsetMap, startTwo, endTwo, makeWidget('W2'))).toBe(true);
  // Rebuild linearization for the second pass — earlier offsetMap is now stale
  // for positions after TWO, but TWO's match was processed first (later in
  // source order), and ONE is before it. The original linear can still be
  // used for ONE because positions before TWO are unaffected.
  const startOne = linear.text.indexOf('[ ONE ]');
  const endOne = startOne + '[ ONE ]'.length;
  expect(replaceLinearRange(b, linear.offsetMap, startOne, endOne, makeWidget('W1'))).toBe(true);
  const p = b.querySelector('p')!;
  expect(p.textContent).toBe('before W1 middle W2 after');
});

test('out-of-range start/end returns false (defensive)', () => {
  const b = bubble('<p>foo</p>');
  const linear = linearizeBubble(b);
  expect(replaceLinearRange(b, linear.offsetMap, 999, 1000, makeWidget('Z'))).toBe(false);
  expect(b.textContent).toBe('foo');
});

test('angle-pipe marker split by a markdown autolink is replaced as one range', () => {
  const b = bubble(
    '<p>&lt;Music Play|The Verdict|<a href="https://x.test/a.mp3&gt;">https://x.test/a.mp3&gt;</a></p>' +
    '<p>story</p>',
  );
  const linear = linearizeBubble(b);
  const re = new RegExp('\\<Music Play\\|(.*?)\\|(.*?)\\>');
  const m = re.exec(linear.text)!;
  expect(m[1]).toBe('The Verdict');
  expect(m[2]).toBe('https://x.test/a.mp3');
  expect(replaceLinearRange(b, linear.offsetMap, m.index, m.index + m[0].length, makeWidget('MUSIC'))).toBe(true);
  expect(b.textContent).toBe('MUSICstory');
  expect(b.querySelector('a')).toBeNull();
});
