import { test, expect } from 'bun:test';
import {
  maybeInjectStatusPlaceholder,
  parseMessagesResponse,
  STATUS_PLACEHOLDER_PAIRED,
  STATUS_PLACEHOLDER_SELF_CLOSING,
  type InjectIO,
  type InjectMessageView,
} from './status-bar-inject';

function makeIO(initial: InjectMessageView | null): {
  io: InjectIO;
  updates: Array<{ chatId: string; messageId: string; content: string }>;
  getMessage: () => InjectMessageView | null;
} {
  let current = initial;
  const updates: Array<{ chatId: string; messageId: string; content: string }> = [];
  return {
    updates,
    getMessage: () => current,
    io: {
      fetchContent: async () => current,
      updateContent: async (chatId, messageId, content) => {
        updates.push({ chatId, messageId, content });
        // Mirror Lumiverse's updateMessage semantics: PUT { content }
        // rewrites both messages.content and swipes[swipe_id]. Mock the
        // content side so the idempotency check sees the updated state
        // on a subsequent call.
        if (current) current = { ...current, content };
      },
    },
  };
}

test('assistant message without trigger: writes paired form on a new paragraph', async () => {
  const { io, updates } = makeIO({
    id: 'msg-asst-1',
    content: 'A bot response without any placeholder.',
    isUser: false,
    role: 'assistant',
  });
  const result = await maybeInjectStatusPlaceholder('chat-1', 'msg-asst-1', io);
  expect(result).toBe('injected');
  expect(updates).toHaveLength(1);
  expect(updates[0].content.endsWith('\n\n' + STATUS_PLACEHOLDER_PAIRED)).toBe(true);
  expect(updates[0].content).toBe('A bot response without any placeholder.\n\n' + STATUS_PLACEHOLDER_PAIRED);
});

test('assistant message that already has the paired trigger (at end): no write', async () => {
  const original = 'A bot response.\n\n' + STATUS_PLACEHOLDER_PAIRED;
  const { io, updates } = makeIO({
    id: 'msg-asst-2',
    content: original,
    isUser: false,
    role: 'assistant',
  });
  const result = await maybeInjectStatusPlaceholder('chat-1', 'msg-asst-2', io);
  expect(result).toBe('already-has-trigger');
  expect(updates).toEqual([]);
});

test('assistant message with paired trigger in middle of content: no write (position-agnostic)', async () => {
  const original = 'Intro... ' + STATUS_PLACEHOLDER_PAIRED + ' ...outro.';
  const { io, updates } = makeIO({
    id: 'msg-asst-3',
    content: original,
    isUser: false,
    role: 'assistant',
  });
  const result = await maybeInjectStatusPlaceholder('chat-1', 'msg-asst-3', io);
  expect(result).toBe('already-has-trigger');
  expect(updates).toEqual([]);
});

test('user message: no write even without trigger', async () => {
  const { io, updates } = makeIO({
    id: 'msg-user-1',
    content: 'User typed text.',
    isUser: true,
    role: 'user',
  });
  const result = await maybeInjectStatusPlaceholder('chat-1', 'msg-user-1', io);
  expect(result).toBe('not-assistant');
  expect(updates).toEqual([]);
});

test('idempotency: second invocation on the same message is a no-op after the first wrote paired form', async () => {
  const { io, updates } = makeIO({
    id: 'msg-asst-4',
    content: 'Bot reply',
    isUser: false,
    role: 'assistant',
  });
  const r1 = await maybeInjectStatusPlaceholder('chat-1', 'msg-asst-4', io);
  const r2 = await maybeInjectStatusPlaceholder('chat-1', 'msg-asst-4', io);
  expect(r1).toBe('injected');
  expect(r2).toBe('already-has-trigger');
  expect(updates).toHaveLength(1);
});

test('fetch-miss: message not found in chat -> no write, no crash', async () => {
  const { io, updates } = makeIO(null);
  const result = await maybeInjectStatusPlaceholder('chat-1', 'msg-missing', io);
  expect(result).toBe('fetch-miss');
  expect(updates).toEqual([]);
});

test('fetch throws: returns error, no write, no crash', async () => {
  const throwingIO: InjectIO = {
    fetchContent: async () => { throw new Error('db down'); },
    updateContent: async () => { throw new Error('should not be called'); },
  };
  const result = await maybeInjectStatusPlaceholder('chat-1', 'msg-x', throwingIO);
  expect(result).toBe('error');
});

test('update throws: returns error', async () => {
  const io: InjectIO = {
    fetchContent: async () => ({ id: 'msg-asst-5', content: 'plain', isUser: false, role: 'assistant' }),
    updateContent: async () => { throw new Error('update failed'); },
  };
  const result = await maybeInjectStatusPlaceholder('chat-1', 'msg-asst-5', io);
  expect(result).toBe('error');
});

// ---- Path A: upgrade self-closing -> paired ----

test('upgrade: self-closing trigger in content -> writes upgraded content, outcome "upgraded"', async () => {
  const original = 'Bot reply.\n\n' + STATUS_PLACEHOLDER_SELF_CLOSING;
  const { io, updates } = makeIO({
    id: 'msg-asst-upg-1',
    content: original,
    isUser: false,
    role: 'assistant',
  });
  const result = await maybeInjectStatusPlaceholder('chat-1', 'msg-asst-upg-1', io);
  expect(result).toBe('upgraded');
  expect(updates).toHaveLength(1);
  // After upgrade, the content has paired form where self-closing was.
  expect(updates[0].content).toBe('Bot reply.\n\n' + STATUS_PLACEHOLDER_PAIRED);
  // And no self-closing literal remains.
  expect(updates[0].content.includes(STATUS_PLACEHOLDER_SELF_CLOSING)).toBe(false);
});

test('upgrade: idempotency loop — second call after upgrade is "already-has-trigger"', async () => {
  const { io, updates } = makeIO({
    id: 'msg-asst-upg-2',
    content: 'Bot reply.\n\n' + STATUS_PLACEHOLDER_SELF_CLOSING,
    isUser: false,
    role: 'assistant',
  });
  const r1 = await maybeInjectStatusPlaceholder('chat-1', 'msg-asst-upg-2', io);
  const r2 = await maybeInjectStatusPlaceholder('chat-1', 'msg-asst-upg-2', io);
  expect(r1).toBe('upgraded');
  expect(r2).toBe('already-has-trigger');
  expect(updates).toHaveLength(1);
});

test('upgrade: mixed paired AND self-closing present -> upgrades self-closing, keeps paired', async () => {
  // Edge case: a card embeds the paired trigger and a prior inject run
  // added the self-closing form afterward. The upgrade replaces only
  // the self-closing occurrences; the paired form stays untouched.
  const mixed = 'Intro... ' + STATUS_PLACEHOLDER_PAIRED + ' ...mid... ' + STATUS_PLACEHOLDER_SELF_CLOSING + ' ...outro.';
  const { io, updates } = makeIO({
    id: 'msg-asst-mixed',
    content: mixed,
    isUser: false,
    role: 'assistant',
  });
  const result = await maybeInjectStatusPlaceholder('chat-1', 'msg-asst-mixed', io);
  expect(result).toBe('upgraded');
  expect(updates).toHaveLength(1);
  // Both spots end up paired; the original paired is unchanged, the
  // self-closing is rewritten.
  expect(updates[0].content).toBe(
    'Intro... ' + STATUS_PLACEHOLDER_PAIRED + ' ...mid... ' + STATUS_PLACEHOLDER_PAIRED + ' ...outro.',
  );
  expect(updates[0].content.includes(STATUS_PLACEHOLDER_SELF_CLOSING)).toBe(false);
});

test('upgrade: self-closing with whitespace (<StatusPlaceHolderImpl />) is matched and upgraded', async () => {
  const original = 'Bot.\n\n<StatusPlaceHolderImpl />';
  const { io, updates } = makeIO({
    id: 'msg-asst-ws',
    content: original,
    isUser: false,
    role: 'assistant',
  });
  const result = await maybeInjectStatusPlaceholder('chat-1', 'msg-asst-ws', io);
  expect(result).toBe('upgraded');
  expect(updates).toHaveLength(1);
  expect(updates[0].content).toBe('Bot.\n\n' + STATUS_PLACEHOLDER_PAIRED);
});

test('upgrade: multiple self-closing occurrences are all upgraded in one pass', async () => {
  const original = 'One ' + STATUS_PLACEHOLDER_SELF_CLOSING + ' two ' + STATUS_PLACEHOLDER_SELF_CLOSING + ' three.';
  const { io, updates } = makeIO({
    id: 'msg-asst-multi',
    content: original,
    isUser: false,
    role: 'assistant',
  });
  const result = await maybeInjectStatusPlaceholder('chat-1', 'msg-asst-multi', io);
  expect(result).toBe('upgraded');
  expect(updates).toHaveLength(1);
  expect(updates[0].content).toBe(
    'One ' + STATUS_PLACEHOLDER_PAIRED + ' two ' + STATUS_PLACEHOLDER_PAIRED + ' three.',
  );
});

// ---- Bug 1 regression: paginated response wrapper ----
// `GET /api/v1/chats/:chatId/messages` returns `PaginatedResult<Message>`
// shaped as `{ data: [...], total, limit, offset }`. The original
// defaultIO assumed a bare array and threw `list.find is not a function`
// at runtime. parseMessagesResponse unwraps either shape.

test('parseMessagesResponse: bare array passes through', () => {
  expect(parseMessagesResponse([{ id: 'a' }, { id: 'b' }])).toEqual([{ id: 'a' }, { id: 'b' }] as any);
});

test('parseMessagesResponse: PaginatedResult wrapper unwraps to data', () => {
  const wrapped = { data: [{ id: 'a', content: 'hi', is_user: false }], total: 1, limit: 50, offset: 0 };
  expect(parseMessagesResponse(wrapped)).toEqual([{ id: 'a', content: 'hi', is_user: false }] as any);
});

test('parseMessagesResponse: malformed response returns []', () => {
  expect(parseMessagesResponse(null)).toEqual([]);
  expect(parseMessagesResponse({ wrong: 'shape' })).toEqual([]);
  expect(parseMessagesResponse(undefined)).toEqual([]);
  expect(parseMessagesResponse('a string')).toEqual([]);
});

test('inject IO over PaginatedResult shape: find succeeds, write fires paired form', async () => {
  // Simulates what defaultIO does after parseMessagesResponse — operating
  // over the unwrapped list, .find returns the target row.
  const wrapped = {
    data: [
      { id: 'msg-greeting', content: 'greeting body', is_user: false, role: 'assistant' },
      { id: 'msg-user', content: 'user line', is_user: true, role: 'user' },
      { id: 'msg-llm-1', content: 'first bot reply', is_user: false, role: 'assistant' },
    ],
    total: 3, limit: 50, offset: 0,
  };
  const updates: Array<{ chatId: string; messageId: string; content: string }> = [];
  const io: InjectIO = {
    fetchContent: async (_chatId, messageId) => {
      const list = parseMessagesResponse(wrapped);
      const m = list.find((mm) => mm.id === messageId);
      if (!m) return null;
      return { id: m.id, content: m.content, isUser: m.is_user, role: m.role };
    },
    updateContent: async (chatId, messageId, content) => {
      updates.push({ chatId, messageId, content });
    },
  };
  const result = await maybeInjectStatusPlaceholder('chat-1', 'msg-llm-1', io);
  expect(result).toBe('injected');
  expect(updates).toHaveLength(1);
  expect(updates[0].messageId).toBe('msg-llm-1');
  expect(updates[0].content.endsWith('\n\n' + STATUS_PLACEHOLDER_PAIRED)).toBe(true);
});

test('inferred assistant (no role field, is_user: false): writes paired form', async () => {
  const { io, updates } = makeIO({
    id: 'msg-asst-6',
    content: 'No role hint',
    isUser: false,
    // role intentionally omitted
  });
  const result = await maybeInjectStatusPlaceholder('chat-1', 'msg-asst-6', io);
  expect(result).toBe('injected');
  expect(updates).toHaveLength(1);
  expect(updates[0].content.endsWith('\n\n' + STATUS_PLACEHOLDER_PAIRED)).toBe(true);
});

test('only cards with a StatusPlaceHolderImpl script get the placeholder', async () => {
  const { cardUsesStatusPlaceholder } = await import('./status-bar-inject');
  expect(cardUsesStatusPlaceholder([{ findRegex: '<StatusPlaceHolderImpl/>' }])).toBe(true);
  expect(cardUsesStatusPlaceholder([{ findRegex: '<StatusPlaceHolderImpl/>', disabled: true }])).toBe(false);
  expect(cardUsesStatusPlaceholder([{ findRegex: '<TXT>(.*?)</TXT>' }])).toBe(false);
});
