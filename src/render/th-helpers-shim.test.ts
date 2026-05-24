import { test, expect } from 'bun:test';
import { createThHelpers, thHelpersShim } from './th-helpers-shim';
import type { SnapshotMessage } from '../backend/th-helpers';

function noopBridge() {
  return { postRequest: async () => undefined };
}

function makeSnapshot(rows: Array<Partial<SnapshotMessage>>): SnapshotMessage[] {
  return rows.map((r, i) => ({
    id: r.id ?? `msg-${i}`,
    message_id: r.message_id ?? i,
    name: r.name ?? (r.role === 'user' ? 'user' : 'char'),
    role: r.role ?? 'assistant',
    is_hidden: r.is_hidden ?? false,
    message: r.message ?? '',
    swipe_id: r.swipe_id ?? 0,
    swipes: r.swipes ?? [r.message ?? ''],
    data: r.data ?? {},
    extra: r.extra ?? {},
  }));
}

test('getCurrentMessageId returns baked-in index sync', () => {
  const helpers = createThHelpers(
    { currentMessageIndex: 3, currentMessageId: 'uuid-3', chatId: 'cx', messagesSnapshot: [] },
    noopBridge(),
  );
  expect(helpers.getCurrentMessageId()).toBe(3);
});

test('getChatId returns baked-in id sync', () => {
  const helpers = createThHelpers(
    { currentMessageIndex: 0, currentMessageId: 'u', chatId: 'chat-x', messagesSnapshot: [] },
    noopBridge(),
  );
  expect(helpers.getChatId()).toBe('chat-x');
});

test('getChatMessages is synchronous (returns array directly, not a Promise) — News Flash contract', () => {
  const snap = makeSnapshot([{ message: 'greeting' }, { message: 'current', role: 'assistant' }]);
  const helpers = createThHelpers(
    { currentMessageIndex: 1, currentMessageId: 'u', chatId: 'c', messagesSnapshot: snap },
    noopBridge(),
  );
  const result = helpers.getChatMessages(1);
  // Crucial: result is an array, not a thenable. The News Flash card does
  // `chatMessages.length === 0` and `chatMessages[0].message` synchronously.
  expect(Array.isArray(result)).toBe(true);
  expect(typeof (result as unknown as { then?: unknown }).then).toBe('undefined');
  expect(result.length).toBe(1);
  expect((result[0] as { message: string }).message).toBe('current');
});

test('News Flash reproducer: getChatMessages(getCurrentMessageId()) returns [{message: "..."}]', () => {
  const snap = makeSnapshot([
    { message: 'first greeting' },
    { message: '<campus_gossip>[角色|X][评价|Y]</campus_gossip>' },
  ]);
  const helpers = createThHelpers(
    { currentMessageIndex: 1, currentMessageId: 'uuid-1', chatId: 'c', messagesSnapshot: snap },
    noopBridge(),
  );
  const id = helpers.getCurrentMessageId();
  const chatMessages = helpers.getChatMessages(id);
  expect(chatMessages.length).toBeGreaterThan(0);
  const first = chatMessages[0] as { message: string };
  expect(first.message).toBe('<campus_gossip>[角色|X][评价|Y]</campus_gossip>');
});

test('canonical shape (non-swiped): message_id, name, role, is_hidden, message, swipe_id, swipes, data, extra', () => {
  const snap = makeSnapshot([
    { message_id: 0, name: 'char', role: 'assistant', message: 'hi', swipes: ['hi', 'alt'], swipe_id: 0, extra: { foo: 1 } },
  ]);
  const helpers = createThHelpers(
    { currentMessageIndex: 0, currentMessageId: 'u', chatId: 'c', messagesSnapshot: snap },
    noopBridge(),
  );
  const [m] = helpers.getChatMessages(0) as unknown as Array<Record<string, unknown>>;
  expect(Object.keys(m).sort()).toEqual(
    ['message_id', 'name', 'role', 'is_hidden', 'message', 'swipe_id', 'swipes', 'data', 'extra'].sort(),
  );
  expect(m.message_id).toBe(0);
  expect(m.name).toBe('char');
  expect(m.role).toBe('assistant');
  expect(m.is_hidden).toBe(false);
  expect(m.message).toBe('hi');
  expect(m.swipe_id).toBe(0);
  expect(m.swipes).toEqual(['hi', 'alt']);
  expect(m.data).toEqual({});
  expect(m.extra).toEqual({ foo: 1 });
});

test('non-swiped shape carries swipes without include_swipes (greeting-choice swipe contract)', () => {
  const snap = makeSnapshot([{ message: 'g0', swipes: ['g0', 'g1', 'g2'], swipe_id: 0 }]);
  const helpers = createThHelpers(
    { currentMessageIndex: 0, currentMessageId: 'u', chatId: 'c', messagesSnapshot: snap },
    noopBridge(),
  );
  const messages = helpers.getChatMessages('0') as unknown as Array<{ swipes: string[] }>;
  expect(messages[0].swipes.length).toBe(3);
  expect(messages[0].swipes[1]).toBe('g1');
});

test('canonical shape (swiped): message_id, name, role, is_hidden, swipe_id, swipes, swipes_data, swipes_info — Choi Opening contract', () => {
  const snap = makeSnapshot([
    { swipes: ['g0', 'g1', 'g2'], swipe_id: 1, message: 'g1' },
  ]);
  const helpers = createThHelpers(
    { currentMessageIndex: 0, currentMessageId: 'u', chatId: 'c', messagesSnapshot: snap },
    noopBridge(),
  );
  const [m] = helpers.getChatMessages('0', { include_swipe: true }) as unknown as Array<Record<string, unknown>>;
  expect(Object.keys(m).sort()).toEqual(
    ['message_id', 'name', 'role', 'is_hidden', 'swipe_id', 'swipes', 'swipes_data', 'swipes_info'].sort(),
  );
  expect(m.swipes).toEqual(['g0', 'g1', 'g2']);
  expect(m.swipe_id).toBe(1);
  expect((m.swipes_data as unknown[]).length).toBe(3);
  expect((m.swipes_info as unknown[]).length).toBe(3);
});

test('include_swipes (plural) also returns swiped shape', () => {
  const snap = makeSnapshot([{ swipes: ['a', 'b'], swipe_id: 0, message: 'a' }]);
  const helpers = createThHelpers(
    { currentMessageIndex: 0, currentMessageId: 'u', chatId: 'c', messagesSnapshot: snap },
    noopBridge(),
  );
  const [m] = helpers.getChatMessages(0, { include_swipes: true }) as unknown as Array<Record<string, unknown>>;
  expect(m.swipes).toEqual(['a', 'b']);
  expect((m as { message?: string }).message).toBeUndefined();
});

test('getChatMessages numeric, "latest", "this", negative range', () => {
  const snap = makeSnapshot([
    { message: 'a' },
    { message: 'b' },
    { message: 'c' },
  ]);
  const helpers = createThHelpers(
    { currentMessageIndex: 1, currentMessageId: 'u', chatId: 'c', messagesSnapshot: snap },
    noopBridge(),
  );
  expect((helpers.getChatMessages(0)[0] as { message: string }).message).toBe('a');
  expect((helpers.getChatMessages('latest')[0] as { message: string }).message).toBe('c');
  expect((helpers.getChatMessages('this')[0] as { message: string }).message).toBe('b');
  expect((helpers.getChatMessages(-1)[0] as { message: string }).message).toBe('c');
});

test('getChatMessages out-of-range returns []', () => {
  const snap = makeSnapshot([{ message: 'a' }]);
  const helpers = createThHelpers(
    { currentMessageIndex: 0, currentMessageId: 'u', chatId: 'c', messagesSnapshot: snap },
    noopBridge(),
  );
  expect(helpers.getChatMessages(5)).toEqual([]);
  expect(helpers.getChatMessages(-99)).toEqual([]);
});

test('getChatMessages on empty snapshot returns []', () => {
  const helpers = createThHelpers(
    { currentMessageIndex: 0, currentMessageId: 'u', chatId: 'c', messagesSnapshot: [] },
    noopBridge(),
  );
  expect(helpers.getChatMessages(0)).toEqual([]);
  expect(helpers.getChatMessages('latest')).toEqual([]);
});

test('getChatMessages unsupported range returns []', () => {
  const snap = makeSnapshot([{ message: 'a' }]);
  const helpers = createThHelpers(
    { currentMessageIndex: 0, currentMessageId: 'u', chatId: 'c', messagesSnapshot: snap },
    noopBridge(),
  );
  expect(helpers.getChatMessages({ weird: true } as unknown as string)).toEqual([]);
});

test('setChatMessage normalizes string fieldValues to { message } and goes through bridge', async () => {
  const calls: Array<{ kind: string; body: Record<string, unknown> }> = [];
  const helpers = createThHelpers(
    { currentMessageIndex: 0, currentMessageId: 'u', chatId: 'c', messagesSnapshot: [] },
    {
      async postRequest(kind, body) {
        calls.push({ kind, body });
        return undefined;
      },
    },
  );
  await helpers.setChatMessage('new content', 0, { swipe_id: 1 });
  expect(calls).toEqual([
    {
      kind: 'th-set-chat-message',
      body: { fieldValues: { message: 'new content' }, messageId: 0, opts: { swipe_id: 1 } },
    },
  ]);
});

test('setChatMessage passes object fieldValues unchanged', async () => {
  const calls: Array<{ kind: string; body: Record<string, unknown> }> = [];
  const helpers = createThHelpers(
    { currentMessageIndex: 0, currentMessageId: 'u', chatId: 'c', messagesSnapshot: [] },
    {
      async postRequest(kind, body) {
        calls.push({ kind, body });
        return undefined;
      },
    },
  );
  await helpers.setChatMessage({ message: 'x', data: { y: 1 } } as Record<string, unknown>, 0, {});
  expect(calls[0].body.fieldValues).toEqual({ message: 'x', data: { y: 1 } });
});

test('setChatMessage bubbles bridge errors', async () => {
  const helpers = createThHelpers(
    { currentMessageIndex: 0, currentMessageId: 'u', chatId: 'c', messagesSnapshot: [] },
    {
      async postRequest() {
        throw new Error('bridge down');
      },
    },
  );
  await expect(helpers.setChatMessage('x', 0)).rejects.toThrow('bridge down');
});

test('thHelpersShim produces a script with baked constants and sync getChatMessages', () => {
  const out = thHelpersShim({
    currentMessageIndex: 7,
    currentMessageId: 'abc',
    chatId: 'chatZ',
    messagesSnapshot: makeSnapshot([{ message: 'hi' }]),
  });
  expect(out.startsWith('<script>')).toBe(true);
  expect(out.includes('"currentMessageIndex":7')).toBe(true);
  expect(out.includes('"chatId":"chatZ"')).toBe(true);
  expect(out.includes('"messagesSnapshot"')).toBe(true);
  expect(out.includes('"message":"hi"')).toBe(true);
  expect(out.includes('window.getChatMessages = function(')).toBe(true);
  // Confirm getChatMessages is no longer routed through postRequest in the shim
  expect(out.includes("postRequest('th-get-chat-messages'")).toBe(false);
  expect(out.includes('th-set-chat-message')).toBe(true);
});
