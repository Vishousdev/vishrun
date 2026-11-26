import { afterEach, expect, test } from 'bun:test';
import type { SpindleFrontendContext } from 'lumiverse-spindle-types';
import { createSillyTavern, toStChat, toStCharacter } from './st-context';
import type { RuntimeState } from './th-api';
import { setHostContext, type HostMessage } from '../lumiverse/host-api';
import { clearActiveCard, setActiveCard } from '../state/active-card';

const greetings = ['【Home】', 'Greeting A', 'Greeting B'];

// Fake host: records content writes and rpc calls, serves the message list.
function fakeState(messages: HostMessage[]) {
  const writes: { id: string; content: string }[] = [];
  const rpcs: { op: string; args: Record<string, unknown> }[] = [];
  let handler: ((p: unknown) => void) | null = null;
  const ctx = {
    getActiveChat: () => ({ chatId: 'c1', characterId: 'ch1' }),
    chats: { updateMessage: async (_c: string, id: string, input: { content?: string }) => {
      writes.push({ id, content: input.content ?? '' });
      const m = messages.find((x) => x.id === id);
      if (m) m.content = input.content ?? '';
    } },
    onBackendMessage: (fn: (p: unknown) => void) => { handler = fn; return () => {}; },
    sendToBackend: (p: { type: string; requestId: string; op?: string; args?: Record<string, unknown> }) => {
      if (p.type === 'vr_preset') rpcs.push({ op: p.op!, args: p.args! });
      const reply = p.type === 'host_read'
        ? { type: 'host_read_response', requestId: p.requestId, result: messages.map((m) => ({ ...m })) }
        : { type: 'vr_preset_response', requestId: p.requestId, result: p.op === 'generate' ? { content: 'reply', reasoning: '' } : true };
      queueMicrotask(() => handler?.(reply));
    },
  } as unknown as SpindleFrontendContext;
  setHostContext(ctx);
  const state = {
    ctx, messages: messages.map((m) => ({ ...m })), character: { id: 'ch1', name: 'Char', extensions: { k: 1 } },
    vars: { global: {}, chat: { a: 1 }, character: {} }, stMeta: {}, userName: 'Me', listeners: new Map(),
  } as unknown as RuntimeState;
  return { state, writes, rpcs };
}

afterEach(() => { clearActiveCard(); setHostContext(null); });

test('chat: the greeting gets the card greetings as swipes and the shown one as swipe_id', () => {
  const chat = toStChat([{ id: 'm0', content: 'Greeting B', is_user: false }, { id: 'm1', content: 'hi', is_user: true }], greetings);
  expect(chat[0].swipes).toEqual(greetings);
  expect(chat[0].swipe_id).toBe(2);
  expect(chat[1]).toMatchObject({ is_user: true, mes: 'hi', swipe_id: 0, swipes: ['hi'] });
});

test('character: card fields and extensions under data', () => {
  const c = toStCharacter({ id: 'x', name: 'N', first_mes: 'F', alternate_greetings: ['A'], extensions: { e: 1 } });
  expect(c.name).toBe('N');
  expect(c.data).toMatchObject({ name: 'N', first_mes: 'F', alternate_greetings: ['A'], extensions: { e: 1 } });
});

test('saveChat: a new greeting swipe_id rewrites message 0 with that greeting', async () => {
  setActiveCard({ characterId: 'ch1', characterName: 'Char', scripts: [], firstMes: greetings[0], alternateGreetings: greetings.slice(1) });
  const { state, writes } = fakeState([{ id: 'm0', content: 'Greeting A', is_user: false }]);
  const st = createSillyTavern(state);
  const chat = st.chat as { swipe_id: number; mes: string; swipes: string[] }[];
  expect(chat[0].swipe_id).toBe(1);
  chat[0].swipe_id = 0;
  chat[0].mes = chat[0].swipes[0];
  await (st.saveChat as () => Promise<void>)();
  expect(writes).toEqual([{ id: 'm0', content: '【Home】' }]);
  expect(state.messages[0].content).toBe('【Home】');
});

test('getContext is the global itself, with the character at characterId', () => {
  const { state } = fakeState([]);
  const st = createSillyTavern(state);
  const c = (st.getContext as () => Record<string, unknown>)();
  expect(c).toBe(st);
  expect(((c.characters as Record<string, unknown>[])[c.characterId as number].data as Record<string, unknown>).extensions).toEqual({ k: 1 });
  expect(c.name1).toBe('Me');
  expect(c.name2).toBe('Char');
});

test('variables.local reads and writes the chat scope', () => {
  const { state, rpcs } = fakeState([]);
  const st = createSillyTavern(state);
  const local = (st.variables as { local: { get(n: string): unknown; set(n: string, v: unknown): void; inc(n: string): void } }).local;
  expect(local.get('a')).toBe(1);
  local.inc('a');
  local.set('b', 'x');
  expect(state.vars.chat).toEqual({ a: 2, b: 'x' });
  expect(rpcs.at(-1)).toMatchObject({ op: 'vars_replace', args: { scope: 'chat', vars: { a: 2, b: 'x' } } });
});

test('saveChat: is_system hides the message and extra is stored', async () => {
  const { state, rpcs } = fakeState([{ id: 'm0', content: 'a', is_user: false }, { id: 'm1', content: 'b', is_user: true, hidden: true, stExtra: { k: 1 } }]);
  const st = createSillyTavern(state);
  const chat = st.chat as { is_system: boolean; extra: Record<string, unknown> }[];
  expect(chat[1].is_system).toBe(true);
  expect(chat[1].extra).toEqual({ k: 1 });
  chat[0].is_system = true;
  chat[0].extra.mark = 1;
  chat[1].is_system = false;
  await (st.saveChat as () => Promise<void>)();
  expect(rpcs.map((r) => r.op)).toEqual(['set_hidden', 'set_hidden', 'msg_extra']);
  expect(rpcs[0].args).toMatchObject({ messageIds: ['m0'], hidden: true });
  expect(rpcs[1].args).toMatchObject({ messageIds: ['m1'], hidden: false });
  expect(rpcs[2].args).toMatchObject({ items: [{ id: 'm0', extra: { mark: 1 } }] });
});

test('generation: processRequest keeps roles, generateRaw adds the system prompt', async () => {
  const { state, rpcs } = fakeState([]);
  const st = createSillyTavern(state) as Record<string, any>;
  expect(st.mainApi).toBe('openai');
  expect(await st.ChatCompletionService.processRequest({ messages: [{ role: 'system', content: 's' }, { role: 'user', content: [{ text: 'u' }] }], max_tokens: 50 }))
    .toEqual({ content: 'reply', reasoning: '' });
  expect(rpcs.at(-1)).toMatchObject({ op: 'generate', args: { messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }], max_tokens: 50 } });
  expect(await st.generateRaw({ systemPrompt: 'sys', prompt: 'p' })).toBe('reply');
  expect(rpcs.at(-1)?.args.messages).toEqual([{ role: 'system', content: 'sys' }, { role: 'user', content: 'p' }]);
});

test('setExtensionPrompt: sends a value once until it changes', () => {
  const { state, rpcs } = fakeState([]);
  const st = createSillyTavern(state) as Record<string, any>;
  st.setExtensionPrompt('k', 'v', 1, 2, false, 0);
  st.setExtensionPrompt('k', 'v', 1, 2, false, 0);
  st.setExtensionPrompt('k', 'w', 1, 2, false, 0);
  expect(rpcs.filter((r) => r.op === 'ext_prompt').map((r) => r.args.value)).toEqual(['v', 'w']);
});
