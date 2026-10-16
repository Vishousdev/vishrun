import { test, expect } from 'bun:test';
import { takeoverCharacterRows, type RegexApi } from './regex-takeover';

function fakeApi(rows: any[]) {
  const updates: Array<[string, any]> = [];
  const api: RegexApi = {
    list: async () => ({ data: rows, total: rows.length }),
    update: async (id, input) => { updates.push([id, input]); return {}; },
  };
  return { api, updates };
}

const SCRIPT = { findRegex: '/<a>(.*?)<\\/a>/s', replaceString: '<script>1</script>$1' };
const base = { find_regex: '<a>(.*?)<\\/a>', replace_string: '<script>1</script>$1', disabled: false, metadata: {} };

test('disables matching display copies and tags them', async () => {
  const { api, updates } = fakeApi([{ id: 'r1', target: ['display'], ...base }]);
  expect(await takeoverCharacterRows(api, 'c1', [SCRIPT], 'u', () => 42)).toBe(1);
  expect(updates).toEqual([['r1', { disabled: true, metadata: { vishrun: { takeover: true, at: 42 } } }]]);
});

test('leaves prompt rows, user-edited rows, re-enabled rows and disabled rows alone', async () => {
  const { api, updates } = fakeApi([
    { id: 'prompt', target: ['display', 'prompt'], ...base },
    { id: 'edited', target: 'display', ...base, replace_string: '<b>user edit</b>' },
    { id: 'reenabled', target: 'display', ...base, metadata: { vishrun: { takeover: true, at: 1 } } },
    { id: 'off', target: 'display', ...base, disabled: true },
    { id: 'locked', target: 'display', ...base, can_mutate: false },
  ]);
  expect(await takeoverCharacterRows(api, 'c1', [SCRIPT], 'u')).toBe(0);
  expect(updates).toEqual([]);
});

test('nativeDisplayKeys lists enabled display rows only', async () => {
  const { nativeDisplayKeys } = await import('./regex-takeover');
  const api = {
    async list() {
      return {
        total: 3,
        data: [
          { id: 'a', find_regex: '<TXT>(.*?)</TXT>', replace_string: '<b>$1</b>', target: ['display'], disabled: false },
          { id: 'b', find_regex: '<X>', replace_string: '<script>1</script>', target: ['display'], disabled: true },
          { id: 'c', find_regex: 'p', replace_string: 'q', target: ['prompt'], disabled: false },
        ],
      };
    },
    async update() { return null; },
  } as unknown as RegexApi;
  expect(await nativeDisplayKeys(api, 'c1', 'u')).toEqual(['<TXT>(.*?)</TXT>\u0000<b>$1</b>']);
});
