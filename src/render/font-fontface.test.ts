import { test, expect } from 'bun:test';
import { selectFontEntries, type FontEntryLike } from './font-fontface';

const e = (name: string, family: string, range?: string, weight = '400', style = 'normal'): FontEntryLike =>
  ({ family, url: name, weight, style, ...(range ? { range } : {}) });

const lxgw = [
  e('latin', 'LXGW WenKai', 'U+0000-00FF'),
  e('ni-hao', 'LXGW WenKai', 'U+4F60, U+597D'),
  e('other', 'LXGW WenKai', 'U+4E00-4E10'),
  e('bold-ni-hao', 'LXGW WenKai', 'U+4F60, U+597D', '700'),
  e('mono-ni-hao', 'LXGW WenKai Mono', 'U+4F60, U+597D'),
];
const urls = (list: FontEntryLike[]) => list.map((x) => x.url);

test('only slices covering the drawn text load', () => {
  const picked = selectFontEntries(lxgw, [{ families: ["'LXGW WenKai'", 'serif'], weight: 400, style: 'normal', text: 'Hi 你好' }]);
  expect(urls(picked)).toEqual(['latin', 'ni-hao']);
});

test('nearest weight wins, other families are skipped', () => {
  const picked = selectFontEntries(lxgw, [{ families: ['LXGW WenKai'], weight: 600, style: 'normal', text: '你' }]);
  expect(urls(picked)).toEqual(['bold-ni-hao']);
});

test('fonts without slices always load', () => {
  const fa = e('fa', 'Font Awesome 6 Free', undefined, '900');
  expect(urls(selectFontEntries([fa, ...lxgw], []))).toEqual(['fa']);
});

test('wildcard ranges and variable weights', () => {
  const v = e('var', 'Inter', 'U+00??', '100 900');
  expect(urls(selectFontEntries([v], [{ families: ['Inter'], weight: 650, style: 'normal', text: 'a' }]))).toEqual(['var']);
  expect(urls(selectFontEntries([v], [{ families: ['Inter'], weight: 400, style: 'normal', text: '你' }]))).toEqual([]);
});

test('italic prefers italic faces', () => {
  const list = [e('up', 'X', 'U+0-FF'), e('it', 'X', 'U+0-FF', '400', 'italic')];
  expect(urls(selectFontEntries(list, [{ families: ['X'], weight: 400, style: 'italic', text: 'a' }]))).toEqual(['it']);
});

test('source is self-contained for injection', () => {
  const fn = new Function(`return (${selectFontEntries.toString()})`)();
  expect(urls(fn(lxgw, [{ families: ['LXGW WenKai'], weight: 400, style: 'normal', text: '好' }]))).toEqual(['ni-hao']);
});
