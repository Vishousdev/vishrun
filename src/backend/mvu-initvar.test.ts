import { test, expect } from 'bun:test';
import { initvarFromEntries, parseInitvarContent } from './mvu-initvar';

test('initvar entries parse JSON and YAML, ignore other entries', () => {
  expect(initvarFromEntries([
    { comment: '[initvar] Variable Init', content: '{\n  "favor": 5,\n  "stress": 30\n}\n' },
    { comment: 'Rules', content: '{"ignored": 1}' },
    { comment: 'more [InitVar]', content: 'World:\n  Time: 08:00\n' },
  ])).toEqual({ favor: 5, stress: 30, World: { Time: '08:00' } });
});

test('initvar unwraps tags and code fences, merges nested objects', () => {
  expect(parseInitvarContent('<initvar>\n```json\n{"a": {"b": 1}}\n```\n</initvar>')).toEqual({ a: { b: 1 } });
  expect(initvarFromEntries([
    { comment: '[initvar] 1', content: '{"a": {"b": 1, "c": [1, 2]}}' },
    { comment: '[initvar] 2', content: '{"a": {"d": 2, "c": [3]}}' },
  ])).toEqual({ a: { b: 1, c: [3], d: 2 } });
});

test('seed prefers attached world books, falls back to the embedded lorebook', async () => {
  const { initvarSeedFor } = await import('./th-helpers');
  const card = {
    world_book_ids: ['wb1'],
    extensions: { character_book: { entries: [{ comment: '[initvar] e', content: '{"from":"card"}' }] } },
  } as never;
  const books = { entries: { list: async () => ({ data: [{ comment: '[initvar] w', content: '{"from":"book"}' }], total: 1 }) } };
  expect(await initvarSeedFor(card, 'u', books)).toEqual({ from: 'book' });
  const denied = { entries: { list: async () => { throw new Error('PERMISSION_DENIED'); } } };
  expect(await initvarSeedFor(card, 'u', denied)).toEqual({ from: 'card' });
  expect(await initvarSeedFor(null, 'u', books)).toEqual({});
});
