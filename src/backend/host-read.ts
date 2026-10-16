import { api } from './common';

// Backend side of lumiverse/host-api.ts: chat and message reads for the
// frontend, so it never needs fetch() against the REST API.

interface HostReadRequest {
  type: 'host_read';
  requestId: string;
  op: 'chat_character' | 'messages';
  chatId: string;
}

function isHostReadRequest(p: unknown): p is HostReadRequest {
  if (!p || typeof p !== 'object') return false;
  const r = p as Record<string, unknown>;
  return r.type === 'host_read' && typeof r.requestId === 'string'
    && typeof r.chatId === 'string' && (r.op === 'chat_character' || r.op === 'messages');
}

export async function hostRead(op: HostReadRequest['op'], chatId: string, userId: string): Promise<unknown> {
  if (op === 'chat_character') {
    const chat = await api.chats.get(chatId, userId);
    return (chat as { character_id?: string } | null)?.character_id ?? null;
  }
  const messages = await api.chat.getMessages(chatId);
  return messages.map((m) => {
    const mm = m as { id: string; content: string; is_user: boolean; role?: string };
    return { id: mm.id, content: mm.content, is_user: mm.is_user, role: mm.role };
  });
}

export function installHostReadHandler(): void {
  api.onFrontendMessage((payload, userId) => {
    if (!isHostReadRequest(payload)) return;
    const { requestId, op, chatId } = payload;
    void (async () => {
      try {
        const result = await hostRead(op, chatId, userId);
        api.sendToFrontend({ type: 'host_read_response', requestId, result }, userId);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        api.sendToFrontend({ type: 'host_read_response', requestId, error }, userId);
      }
    })();
  });
}
