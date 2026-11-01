import { test, expect } from 'bun:test';
import { matchStIds, referencesUnknownIds, stIdOf, stPromptSequence } from './st-ids';

const st = {
  prompts: [
    { identifier: 'leftover', name: 'Extra', content: 'x' },
    { identifier: 'main', name: 'Main', content: 'sys' },
    { identifier: 'u-1', name: 'Divider', content: '' },
    { identifier: 'u-2', name: 'Divider', content: '' },
    { identifier: 'u-3', name: 'Style', content: 'write well' },
  ],
  prompt_order: [{ character_id: 100001, order: [{ identifier: 'main' }, { identifier: 'u-1' }, { identifier: 'u-3' }, { identifier: 'u-2' }] }],
};

test('st ids: sequence follows prompt_order, then leftover prompts', () => {
  expect(stPromptSequence(st).map((p) => p.identifier)).toEqual(['main', 'u-1', 'u-3', 'u-2', 'leftover']);
});

test('st ids: duplicates map in order, markers by type, edits by name', () => {
  const blocks = [
    { id: 'b0', name: 'Main', content: 'sys', marker: 'main_prompt' },
    { id: 'b1', name: 'Divider', content: '' },
    { id: 'b2', name: 'Style', content: 'edited in Lumiverse' },
    { id: 'b3', name: 'Divider', content: '' },
    { id: 'b4', name: 'Extra', content: 'x' },
  ];
  const r = matchStIds(st, blocks);
  expect(r.map).toEqual({ b0: 'main', b1: 'u-1', b2: 'u-3', b3: 'u-2', b4: 'leftover' });
  expect(r.unmatched).toEqual([]);
});

test('st ids: entries missing from Lumiverse are reported', () => {
  const r = matchStIds(st, [{ id: 'b0', name: 'Main', content: 'sys', marker: 'main_prompt' }]);
  expect(Object.keys(r.map)).toEqual(['b0']);
  expect(r.unmatched).toEqual(['Divider', 'Style', 'Divider', 'Extra']);
});

test('st ids: needed only when group data names unknown ids', () => {
  const meta = { baibaiToolkit: { presetPromptGroups: { prompts: { 'u-1': {}, b0: {} } } } };
  expect(referencesUnknownIds(meta, [{ id: 'b0' }])).toBe(true);
  expect(referencesUnknownIds(meta, [{ id: 'b0' }, { id: 'u-1' }])).toBe(false);
  expect(referencesUnknownIds({}, [{ id: 'b0' }])).toBe(false);
});

test('st ids: markers answer to their fixed ST ids without a link', () => {
  const blocks = [{ id: 'x1', marker: 'main_prompt' }, { id: 'u-1' }, { id: 'x2', marker: 'chat_history' }];
  const meta = { baibaiToolkit: { presetPromptGroups: { prompts: { main: {}, 'u-1': {}, chatHistory: {} } } } };
  expect(referencesUnknownIds(meta, blocks)).toBe(false);
  expect(blocks.map((b) => stIdOf(b, {}))).toEqual(['main', 'u-1', 'chatHistory']);
  expect(stIdOf({ id: 'b9' }, { b9: 'old-id' })).toBe('old-id');
});
