import type { SpindleFrontendContext } from 'lumiverse-spindle-types';

// Single access point to Lumiverse data from the frontend. No direct fetch():
// character reads and message writes use the frontend ctx; chat and message
// reads go through the backend worker (spindle.chat / spindle.chats).

export interface HostMessage {
  id: string;
  content: string;
  is_user: boolean;
  role?: 'system' | 'user' | 'assistant';
}

interface HostCtx {
  characters?: { get(characterId: string): Promise<unknown> };
  chats?: { updateMessage(chatId: string, messageId: string, input: { content?: string }): Promise<unknown> };
}

let ctxRef: SpindleFrontendContext | null = null;

export function setHostContext(ctx: SpindleFrontendContext | null): void {
  ctxRef = ctx;
}

function ctx(): SpindleFrontendContext {
  if (!ctxRef) throw new Error('[vishrun] host context not initialised');
  return ctxRef;
}

export async function getCharacter(characterId: string): Promise<unknown> {
  const c = ctx() as unknown as HostCtx;
  if (!c.characters) throw new Error('[vishrun] ctx.characters unavailable on this host');
  return c.characters.get(characterId);
}

export async function updateMessageContent(chatId: string, messageId: string, content: string): Promise<void> {
  const c = ctx() as unknown as HostCtx;
  if (!c.chats) throw new Error('[vishrun] ctx.chats unavailable on this host');
  await c.chats.updateMessage(chatId, messageId, { content });
}

const TIMEOUT_MS = 8000;
let counter = 0;

function hostRead<T>(op: 'chat_character' | 'messages', chatId: string): Promise<T> {
  const c = ctx();
  const requestId = `vishrun-hr-${Date.now()}-${++counter}`;
  return new Promise<T>((resolve, reject) => {
    let unsub: (() => void) | null = null;
    const timer = setTimeout(() => {
      unsub?.();
      reject(new Error(`[vishrun] host_read ${op} timed out`));
    }, TIMEOUT_MS);
    unsub = c.onBackendMessage((payload) => {
      const p = payload as { type?: string; requestId?: string; result?: T; error?: string } | null;
      if (!p || p.type !== 'host_read_response' || p.requestId !== requestId) return;
      clearTimeout(timer);
      unsub?.();
      if (p.error) reject(new Error(p.error)); else resolve(p.result as T);
    });
    c.sendToBackend({ type: 'host_read', requestId, op, chatId });
  });
}

export function getChatCharacterId(chatId: string): Promise<string | null> {
  return hostRead<string | null>('chat_character', chatId);
}

export function getChatMessages(chatId: string): Promise<HostMessage[]> {
  return hostRead<HostMessage[]>('messages', chatId);
}
