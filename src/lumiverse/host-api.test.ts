import { test, expect } from 'bun:test';
import { getCharacter, getChatMessages, setHostContext, updateMessageContent } from './host-api';

function fakeCtx() {
  const sent: any[] = [];
  let handler: ((p: unknown) => void) | null = null;
  const ctx: any = {
    characters: { get: async (id: string) => ({ id, extensions: { regex_scripts: [] } }) },
    chats: { updateMessage: async (c: string, m: string, i: any) => { sent.push(['update', c, m, i]); } },
    sendToBackend: (p: any) => {
      sent.push(p);
      queueMicrotask(() => handler?.({ type: 'host_read_response', requestId: p.requestId, result: [{ id: 'm1', content: 'hi', is_user: false }] }));
    },
    onBackendMessage: (h: (p: unknown) => void) => { handler = h; return () => { handler = null; }; },
  };
  return { ctx, sent };
}

test('character reads and message writes use the frontend ctx, reads use the backend', async () => {
  const { ctx, sent } = fakeCtx();
  setHostContext(ctx);
  expect(await getCharacter('c1')).toEqual({ id: 'c1', extensions: { regex_scripts: [] } });
  await updateMessageContent('chat', 'm1', 'new');
  expect(sent[0]).toEqual(['update', 'chat', 'm1', { content: 'new' }]);
  expect(await getChatMessages('chat')).toEqual([{ id: 'm1', content: 'hi', is_user: false }]);
  expect(sent[1]).toMatchObject({ type: 'host_read', op: 'messages', chatId: 'chat' });
  setHostContext(null);
});
