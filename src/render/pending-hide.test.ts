import { test, expect } from 'bun:test';
import { clearPending, hideRange, literalPrefix, literalSuffix, unterminatedRanges } from './pending-hide';
import { linearizeBubble } from './linearize-bubble';

test('literal affixes come from the regex source', () => {
  expect(literalPrefix('\\[ST_START\\]([\\s\\S]*?)\\[ST_END\\]')).toBe('[ST_START]');
  expect(literalSuffix('\\[ST_START\\]([\\s\\S]*?)\\[ST_END\\]')).toBe('[ST_END]');
  expect(literalPrefix('\\<Music Play\\|(.*?)\\|(.*?)\\>')).toBe('<Music Play|');
  expect(literalSuffix('\\<Music Play\\|(.*?)\\|(.*?)\\>')).toBe('>');
  expect(literalPrefix('(\\d+)x')).toBe('');
});

test('only openers without a closer are pending', () => {
  const t = 'a [ST_START] x [ST_END] b [ST_START] y';
  expect(unterminatedRanges(t, '[ST_START]', '[ST_END]')).toEqual([[26, t.length]]);
});

test('whole paragraphs inside the block are hidden and restored', () => {
  const b = document.createElement('div');
  b.innerHTML = '<p>story</p><p>[ST_START]<br>DATE:x</p><p>TIME:y</p>';
  const lin = linearizeBubble(b);
  const start = lin.text.indexOf('[ST_START]');
  expect(hideRange(b, lin.offsetMap, start, lin.text.length)).toBe(2);
  const ps = b.querySelectorAll('p');
  expect((ps[0] as HTMLElement).style.display).toBe('');
  expect((ps[1] as HTMLElement).style.display).toBe('none');
  expect((ps[2] as HTMLElement).style.display).toBe('none');
  clearPending(b);
  expect((ps[1] as HTMLElement).style.display).toBe('');
});

test('leading and trailing alternations yield each side', async () => {
  const { leadingLiterals, trailingLiterals } = await import('./pending-hide');
  const src = /(?:<Status Bar>|<状态栏>)\s*(.*?)\s*(?:<\/Status Bar>|<\/状态栏>)/s.source;
  expect(leadingLiterals(src)).toEqual(['<Status Bar>', '<状态栏>']);
  expect(trailingLiterals(src)).toEqual(['</Status Bar>', '</状态栏>']);
  expect(leadingLiterals('\\[ST_START\\](.*)')).toEqual(['[ST_START]']);
});
