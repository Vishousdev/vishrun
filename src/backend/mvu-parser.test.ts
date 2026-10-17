import { test, expect } from 'bun:test';
import {
  computeVariablesSnapshot,
  extractInitvar,
  extractUpdateVariableBlocks,
  resolveActiveContent,
} from './mvu-parser';

const QB_INIT = `<UpdateVariable>
<initvar>
状态:
  校园声望: 0
兄弟会好感度:
  科尔: 0
</initvar>
</UpdateVariable>`;

test('extractUpdateVariableBlocks returns bodies in order, case-insensitive', () => {
  expect(extractUpdateVariableBlocks('a<UpdateVariable>x</UpdateVariable>b<updatevariable>y</updatevariable>')).toEqual(['x', 'y']);
  expect(extractUpdateVariableBlocks('none')).toEqual([]);
});

test('extractInitvar reads YAML and JSON blocks, with or without a code fence', () => {
  expect(extractInitvar('<initvar>\na: 1\nb: hi\nok: true\n</initvar>')).toEqual({ a: 1, b: 'hi', ok: true });
  expect(extractInitvar('<initvar>```json\n{"a": [0, "desc"]}\n```</initvar>')).toEqual({ a: [0, 'desc'] });
  expect(extractInitvar('no block')).toBe(null);
});

test('empty chat and chats without markup give empty stat_data', async () => {
  expect(await computeVariablesSnapshot([])).toEqual({ stat_data: {} });
  expect((await computeVariablesSnapshot([{ content: 'just narrative' }])).stat_data).toEqual({});
});

test('greeting initvar replaces the lorebook seed', async () => {
  const snap = await computeVariablesSnapshot([{ content: QB_INIT, index_in_chat: 0 }], undefined, { lore: 1 });
  expect(snap.stat_data).toEqual({ 状态: { 校园声望: 0 }, 兄弟会好感度: { 科尔: 0 } });
  const seeded = await computeVariablesSnapshot([{ content: 'hi', index_in_chat: 0 }], undefined, { lore: 1 });
  expect(seeded.stat_data).toEqual({ lore: 1 });
});

test('replies apply commands cumulatively; only the active swipe counts', async () => {
  const snap = await computeVariablesSnapshot([
    { content: QB_INIT, index_in_chat: 0 },
    { content: "<UpdateVariable>\n_.set('状态.校园声望', 0, 100);//up\n</UpdateVariable>", index_in_chat: 1 },
    {
      content: '',
      swipes: ["_.set('兄弟会好感度.科尔', 0, 999);", "<UpdateVariable>_.add('状态.校园声望', 50);</UpdateVariable>"],
      swipe_id: 1,
      index_in_chat: 2,
    },
  ]);
  expect(snap.stat_data).toEqual({ 状态: { 校园声望: 150 }, 兄弟会好感度: { 科尔: 0 } });
});

test('commands inside thinking or analysis blocks are ignored', async () => {
  const snap = await computeVariablesSnapshot([
    { content: QB_INIT, index_in_chat: 0 },
    { content: "<think>_.set('状态.校园声望', 0, 7);</think><UpdateVariable><Analysis>_.set('状态.校园声望', 0, 8);</Analysis>_.set('状态.校园声望', 0, 9);</UpdateVariable>", index_in_chat: 1 },
  ]);
  expect(snap.stat_data.状态).toEqual({ 校园声望: 9 });
});

test('a seed object is not mutated by the replay', async () => {
  const seed = { n: 1 };
  await computeVariablesSnapshot([{ content: "_.set('n', 2);", index_in_chat: 1 }], undefined, seed);
  expect(seed).toEqual({ n: 1 });
});

// ---- Queen Bee end-to-end fixtures (8 alternate greetings) ----

test('Queen Bee greeting 0 -> stat_data has time/location/rep/favors', async () => {
  const greeting = `<UpdateVariable>
<initvar>
世界:
  当前时间: Fall Semester, Saturday 19:45
  当前地点: Greyhounds Main Stadium · ΚΣ VIP Lounge

状态:
  校园声望: 0

兄弟会好感度:
  科尔: 0
  尼科: 0
  杰克斯: 0
  伊利亚: 0
  迪恩: 0
</initvar>
</UpdateVariable>`;
  const snap = await computeVariablesSnapshot([{ content: greeting }]);
  expect(snap.stat_data).toEqual({
    '世界': {
      '当前时间': 'Fall Semester, Saturday 19:45',
      '当前地点': 'Greyhounds Main Stadium · ΚΣ VIP Lounge',
    },
    '状态': { '校园声望': 0 },
    '兄弟会好感度': {
      '科尔': 0, '尼科': 0, '杰克斯': 0, '伊利亚': 0, '迪恩': 0,
    },
  });
});

test('Queen Bee greeting 3 -> mid-game seeded values', async () => {
  const greeting = `<UpdateVariable>
<initvar>
世界:
  当前时间: Fall Semester, Wednesday 14:30
  当前地点: St. Oak Main Lawn · Greek Week Beer Pong Zone

状态:
  校园声望: 420

兄弟会好感度:
  科尔: 65
  尼科: 58
  杰克斯: 52
  伊利亚: 48
  迪恩: 62
</initvar>
</UpdateVariable>`;
  const snap = await computeVariablesSnapshot([{ content: greeting }]);
  // Spot-check the widget-consumed paths.
  expect(snap.stat_data['状态']).toEqual({ '校园声望': 420 });
  expect(snap.stat_data['兄弟会好感度']).toEqual({
    '科尔': 65, '尼科': 58, '杰克斯': 52, '伊利亚': 48, '迪恩': 62,
  });
});

test('Queen Bee greeting 6 -> max-reputation/endgame seeded values', async () => {
  const greeting = `<UpdateVariable>
<initvar>
世界:
  当前时间: Summer Semester, Saturday 14:00
  当前地点: St. Oak Main Lawn · Graduation Ceremony

状态:
  校园声望: 1000

兄弟会好感度:
  科尔: 100
  尼科: 100
  杰克斯: 100
  伊利亚: 100
  迪恩: 100
</initvar>
</UpdateVariable>`;
  const snap = await computeVariablesSnapshot([{ content: greeting }]);
  expect(snap.stat_data['状态']).toEqual({ '校园声望': 1000 });
  expect(snap.stat_data['兄弟会好感度']).toEqual({
    '科尔': 100, '尼科': 100, '杰克斯': 100, '伊利亚': 100, '迪恩': 100,
  });
});

// ---- resolveActiveContent (swipe-aware resolution) ----

test('resolveActiveContent: prefers swipes[swipe_id] when populated', () => {
  expect(
    resolveActiveContent({
      content: 'mirror-of-swipe-0',
      swipes: ['s0', 's1', 's2'],
      swipe_id: 1,
    }),
  ).toBe('s1');
});

test('resolveActiveContent: swipe_id defaults to 0 when absent', () => {
  expect(
    resolveActiveContent({ swipes: ['first', 'second'] }),
  ).toBe('first');
});

test('resolveActiveContent: empty/missing swipe entry falls back to content', () => {
  expect(
    resolveActiveContent({ content: 'fallback', swipes: ['', 'second'], swipe_id: 0 }),
  ).toBe('fallback');
});

test('resolveActiveContent: out-of-bounds swipe_id falls back to content', () => {
  expect(
    resolveActiveContent({ content: 'fallback', swipes: ['only-one'], swipe_id: 5 }),
  ).toBe('fallback');
});

test('resolveActiveContent: empty swipes array falls back to content', () => {
  expect(resolveActiveContent({ content: 'fallback', swipes: [] })).toBe('fallback');
});

test('resolveActiveContent: no swipes array uses content directly (user messages)', () => {
  expect(resolveActiveContent({ content: 'user typed' })).toBe('user typed');
});

test('resolveActiveContent: nothing present returns empty string', () => {
  expect(resolveActiveContent({})).toBe('');
});

// ---- computeVariablesSnapshot: swipe-aware behaviour ----

test('computeVariablesSnapshot: reads active swipe (swipe_id=1) not the canonical content', async () => {
  // Simulates the bug scenario: content mirrors swipes[0] (greeting A) but
  // the user swiped to greeting B at swipes[1]. The replay must read B.
  const greetingA = '<UpdateVariable><initvar>状态:\n  校园声望: 0</initvar></UpdateVariable>';
  const greetingB = '<UpdateVariable><initvar>状态:\n  校园声望: 420</initvar></UpdateVariable>';
  const snap = await computeVariablesSnapshot([
    {
      content: greetingA,
      swipes: [greetingA, greetingB],
      swipe_id: 1,
      id: 'msg-0',
    },
  ]);
  expect(snap.stat_data).toEqual({ '状态': { '校园声望': 420 } });
});

test('computeVariablesSnapshot: with swipes only — uses swipes[0] when swipe_id is missing', async () => {
  const block = '<UpdateVariable><initvar>a: 1</initvar></UpdateVariable>';
  const snap = await computeVariablesSnapshot([{ swipes: [block, 'unrelated'] }]);
  expect(snap.stat_data).toEqual({ a: 1 });
});

test('computeVariablesSnapshot: falls back to content when swipe_id points to empty slot', async () => {
  const block = '<UpdateVariable><initvar>a: 7</initvar></UpdateVariable>';
  const snap = await computeVariablesSnapshot([
    { content: block, swipes: ['', ''], swipe_id: 0 },
  ]);
  expect(snap.stat_data).toEqual({ a: 7 });
});

test('computeVariablesSnapshot: user message (no swipes) replays via content', async () => {
  const block = '<UpdateVariable><initvar>a: 9</initvar></UpdateVariable>';
  const snap = await computeVariablesSnapshot([{ content: block }]);
  expect(snap.stat_data).toEqual({ a: 9 });
});

test('computeVariablesSnapshot: chat with no <UpdateVariable> in any swipe -> empty stat_data', async () => {
  const snap = await computeVariablesSnapshot([
    { content: 'narrative', swipes: ['narrative', 'other narrative'], swipe_id: 1 },
    { content: 'still none' },
  ]);
  expect(snap.stat_data).toEqual({});
});

test('Queen Bee: greeting followed by non-MVU AI messages keeps the seeded state', async () => {
  const messages = [
    {
      content: `<UpdateVariable>
<initvar>
状态:
  校园声望: 100
</initvar>
</UpdateVariable>`,
    },
    { content: 'user: hello' },
    { content: 'ai narrative only, no UpdateVariable here' },
  ];
  const snap = await computeVariablesSnapshot(messages);
  expect(snap.stat_data).toEqual({ '状态': { '校园声望': 100 } });
});

// ---- Recovery from card greetings (Step 4) ----

const QB_GREETING_3 = `<UpdateVariable>
<initvar>
状态:
  校园声望: 420
</initvar>
</UpdateVariable>
<StatusPlaceHolderImpl></StatusPlaceHolderImpl>
Some prose about Greek Week...`;

const QB_GREETING_0 = `<UpdateVariable>
<initvar>
状态:
  校园声望: 0
</initvar>
</UpdateVariable>
<StatusPlaceHolderImpl></StatusPlaceHolderImpl>
Welcome to ΚΣ...`;

// stripped: same text as above but with <UpdateVariable>...</UpdateVariable>
// removed. Mirrors what an old buggy code path persisted to the DB.
const QB_GREETING_3_STRIPPED = `
<StatusPlaceHolderImpl></StatusPlaceHolderImpl>
Some prose about Greek Week...`;

test('recovery: stripped greeting content matches card greeting and recovers stat_data', async () => {
  const snap = await computeVariablesSnapshot(
    [{ content: QB_GREETING_3_STRIPPED, index_in_chat: 0, id: 'msg-0' }],
    async () => ['<first_mes>', QB_GREETING_0, '<greeting-2>', QB_GREETING_3],
  );
  expect(snap.stat_data).toEqual({ '状态': { '校园声望': 420 } });
});

test('recovery: no matching greeting in card -> empty snapshot, no crash', async () => {
  const snap = await computeVariablesSnapshot(
    [{ content: 'totally-unrelated-stripped-content', index_in_chat: 0, id: 'msg-0' }],
    async () => [QB_GREETING_0, QB_GREETING_3],
  );
  expect(snap.stat_data).toEqual({});
});

test('recovery: undefined alternate_greetings (card with no alternates) -> empty snapshot', async () => {
  const snap = await computeVariablesSnapshot(
    [{ content: QB_GREETING_3_STRIPPED, index_in_chat: 0, id: 'msg-0' }],
    // The caller of computeVariablesSnapshot wraps "no alternates" as [first_mes]
    // (or []). Either way recovery should not crash and just yield empty.
    async () => [],
  );
  expect(snap.stat_data).toEqual({});
});

test('recovery: NOT attempted on a fresh chat where the block is in the active content', async () => {
  let fetcherCalls = 0;
  const snap = await computeVariablesSnapshot(
    [{ content: QB_GREETING_3, index_in_chat: 0, id: 'msg-0' }],
    async () => { fetcherCalls++; return [QB_GREETING_3]; },
  );
  expect(snap.stat_data).toEqual({ '状态': { '校园声望': 420 } });
  expect(fetcherCalls).toBe(0);
});

test('recovery: NOT attempted for non-greeting messages (index_in_chat > 0)', async () => {
  let fetcherCalls = 0;
  const snap = await computeVariablesSnapshot(
    [
      { content: QB_GREETING_3, index_in_chat: 0, id: 'msg-0' },
      // Message at index 1 has no block — recovery should NOT fire for it.
      { content: 'plain ai narrative no block', index_in_chat: 1, id: 'msg-1' },
    ],
    async () => { fetcherCalls++; return [QB_GREETING_3]; },
  );
  expect(snap.stat_data).toEqual({ '状态': { '校园声望': 420 } });
  expect(fetcherCalls).toBe(0); // greeting at index 0 had the block, no recovery needed
});

test('recovery: fetcher invoked at most once per snapshot read', async () => {
  let fetcherCalls = 0;
  await computeVariablesSnapshot(
    [{ content: QB_GREETING_3_STRIPPED, index_in_chat: 0, id: 'msg-0' }],
    async () => { fetcherCalls++; return [QB_GREETING_3]; },
  );
  expect(fetcherCalls).toBe(1);
});

test('recovery: fetcher throwing -> falls back to empty candidate list, no crash', async () => {
  const restoreWarn = console.warn;
  console.warn = () => {};
  try {
    const snap = await computeVariablesSnapshot(
      [{ content: QB_GREETING_3_STRIPPED, index_in_chat: 0, id: 'msg-0' }],
      async () => { throw new Error('character fetch failed'); },
    );
    expect(snap.stat_data).toEqual({});
  } finally {
    console.warn = restoreWarn;
  }
});
