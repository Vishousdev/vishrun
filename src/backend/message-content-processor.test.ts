import { test, expect } from 'bun:test';
import type { MessageContentProcessorCtxDTO } from 'lumiverse-spindle-types';
import { expandSelfClosingTags, processMessageContent } from './message-content-processor';
import type { SetvarOp } from './setvar-ops';

function makeCtx(overrides: Partial<MessageContentProcessorCtxDTO> & { content: string }): MessageContentProcessorCtxDTO {
  return {
    chatId: 'chat-1',
    userId: 'user-1',
    origin: 'create',
    isUser: false,
    ...overrides,
  };
}

// Tracks /setvar applier calls without exercising the real backend writer.
function makeSetvarMock() {
  const calls: Array<{ op: SetvarOp; chatId: string; userId: string }> = [];
  return {
    calls,
    fn: async (op: SetvarOp, chatId: string, userId: string): Promise<boolean> => {
      calls.push({ op, chatId, userId });
      return true;
    },
  };
}
function noopSetvar() {
  return makeSetvarMock();
}

test('expandSelfClosingTags: simple custom tag', () => {
  expect(expandSelfClosingTags('<StatusPlaceHolderImpl/>')).toBe('<StatusPlaceHolderImpl></StatusPlaceHolderImpl>');
});

test('expandSelfClosingTags: with space before slash', () => {
  expect(expandSelfClosingTags('<StatusPlaceHolderImpl />')).toBe('<StatusPlaceHolderImpl></StatusPlaceHolderImpl>');
});

test('expandSelfClosingTags: with attributes', () => {
  expect(expandSelfClosingTags('<Widget type="status" />')).toBe('<Widget type="status"></Widget>');
});

test('expandSelfClosingTags: does not touch lowercase tags (standard HTML)', () => {
  const input = '<br/><img src="x"/><hr />';
  expect(expandSelfClosingTags(input)).toBe(input);
});

test('expandSelfClosingTags: does not touch paired tags', () => {
  const input = '<campus_gossip>content</campus_gossip>';
  expect(expandSelfClosingTags(input)).toBe(input);
});

test('expandSelfClosingTags: idempotent on already-expanded content', () => {
  const input = '<StatusPlaceHolderImpl></StatusPlaceHolderImpl>';
  expect(expandSelfClosingTags(input)).toBe(input);
});

test('expandSelfClosingTags: mixed content with self-closing and paired', () => {
  const input = '<date>Sept 10</date>\n<StatusPlaceHolderImpl/>\n<campus_gossip>news</campus_gossip>';
  const expected = '<date>Sept 10</date>\n<StatusPlaceHolderImpl></StatusPlaceHolderImpl>\n<campus_gossip>news</campus_gossip>';
  expect(expandSelfClosingTags(input)).toBe(expected);
});

test('expandSelfClosingTags: Queen Bee greeting shape', () => {
  const input = '<UpdateVariable>\n<initvar>\ndata\n</initvar>\n</UpdateVariable>\n\n<StatusPlaceHolderImpl/>\n\n<campus_gossip>\nnews\n</campus_gossip>';
  const result = expandSelfClosingTags(input);
  expect(result).toContain('<StatusPlaceHolderImpl></StatusPlaceHolderImpl>');
  expect(result).toContain('<UpdateVariable>');
  expect(result).toContain('<campus_gossip>');
});

test('expandSelfClosingTags: content without self-closing returns unchanged', () => {
  const input = 'Hello world, no tags here';
  expect(expandSelfClosingTags(input)).toBe(input);
});

test('expandSelfClosingTags: does not strip UpdateVariable blocks', () => {
  const input = '<UpdateVariable>_.set("x", 1)</UpdateVariable>\n<StatusPlaceHolderImpl/>';
  const result = expandSelfClosingTags(input);
  expect(result).toContain('<UpdateVariable>_.set("x", 1)</UpdateVariable>');
  expect(result).toContain('<StatusPlaceHolderImpl></StatusPlaceHolderImpl>');
});

test('expandSelfClosingTags: multiple self-closing tags', () => {
  const input = '<WidgetA/> text <WidgetB attr="x"/>';
  expect(expandSelfClosingTags(input)).toBe('<WidgetA></WidgetA> text <WidgetB attr="x"></WidgetB>');
});

// ---- regression: <UpdateVariable> must survive every origin ----
// Bug history: Phase 1 stripped <UpdateVariable> from the stored body on
// non-render origins, gated by `ctx.extra?.greeting === true` — a field
// that does not exist on MessageContentProcessorCtxDTO. The check never
// fired for the actual auto-inserted-greeting flow (origin: "create",
// no `extra.greeting`), so the strip ran on greetings and the
// replay-from-messages snapshot had nothing to read.

const GREETING_BODY = `narrative<UpdateVariable>
<initvar>
状态:
  校园声望: 100
</initvar>
</UpdateVariable>
<StatusPlaceHolderImpl/>`;

test('processMessageContent (create greeting): <UpdateVariable> survives in returned content', async () => {
  const setvar = makeSetvarMock();
  const result = await processMessageContent(
    makeCtx({ content: GREETING_BODY, origin: 'create' }),
    { applySetvarOp: setvar.fn },
  );
  const out = result?.content ?? GREETING_BODY;
  expect(out).toContain('<UpdateVariable>');
  expect(out).toContain('<initvar>');
  expect(out).toContain('校园声望: 100');
  expect(setvar.calls).toHaveLength(0);
});

test('processMessageContent (create greeting): expands <StatusPlaceHolderImpl/> to paired form', async () => {
  const result = await processMessageContent(
    makeCtx({ content: GREETING_BODY, origin: 'create' }),
    { applySetvarOp: noopSetvar().fn },
  );
  const out = result?.content ?? '';
  expect(out).toContain('<StatusPlaceHolderImpl></StatusPlaceHolderImpl>');
});

test('processMessageContent (render): <UpdateVariable> survives display-pass too', async () => {
  const result = await processMessageContent(
    makeCtx({ content: GREETING_BODY, origin: 'render' }),
    { applySetvarOp: noopSetvar().fn },
  );
  const out = result?.content ?? GREETING_BODY;
  expect(out).toContain('<UpdateVariable>');
});

test('processMessageContent (update / swipe_add / swipe_update): <UpdateVariable> survives', async () => {
  for (const origin of ['update', 'swipe_add', 'swipe_update'] as const) {
    const result = await processMessageContent(
      makeCtx({ content: GREETING_BODY, origin }),
      { applySetvarOp: noopSetvar().fn },
    );
    const out = result?.content ?? GREETING_BODY;
    expect(out).toContain('<UpdateVariable>');
    expect(out).toContain('<initvar>');
  }
});

test('processMessageContent: setvar pipeline still applies on user-typed origin', async () => {
  const setvar = makeSetvarMock();
  const result = await processMessageContent(
    makeCtx({ content: '/setvar key=foo value=bar', origin: 'create' }),
    { applySetvarOp: setvar.fn },
  );
  expect(setvar.calls).toHaveLength(1);
  // Content was nothing but setvar — should fall back to EMPTY_REPLACEMENT.
  expect(result?.content).toBe('_(variables updated)_');
});

test('processMessageContent: setvar + <UpdateVariable> in same message keeps the block', async () => {
  const setvar = makeSetvarMock();
  const content = `/setvar key=foo value=bar
<UpdateVariable><initvar>a: 1</initvar></UpdateVariable>
rest`;
  const result = await processMessageContent(
    makeCtx({ content, origin: 'create' }),
    { applySetvarOp: setvar.fn },
  );
  const out = result?.content ?? '';
  expect(setvar.calls).toHaveLength(1);
  expect(out).toContain('<UpdateVariable>');
  expect(out).toContain('<initvar>');
  expect(out).not.toContain('/setvar');
});

test('processMessageContent: plain narrative passes through unchanged', async () => {
  const result = await processMessageContent(
    makeCtx({ content: 'plain text', origin: 'create' }),
    { applySetvarOp: noopSetvar().fn },
  );
  expect(result).toBeUndefined();
});
