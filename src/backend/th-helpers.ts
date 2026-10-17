import type { CharacterDTO, ChatMessageDTO, SpindleAPI } from 'lumiverse-spindle-types';
import { api } from './common';
import { computeVariablesSnapshot, emptyMvuData, type MvuData } from './mvu-parser';
import { initvarFromEntries, type InitvarEntry } from './mvu-initvar';

const LOG_PREFIX = '[vishrun:th-helpers]';
const log = {
  warn: (...args: unknown[]) => console.warn(LOG_PREFIX, ...args),
  debug: (...args: unknown[]) => console.debug(LOG_PREFIX, ...args),
};

interface ThHelpersRequest {
  type: 'th_helpers_request';
  requestId: string;
  op: 'th-get-messages-snapshot' | 'th-set-chat-message' | 'th-get-variables-snapshot';
  chatId: string;
  currentMessageId: string;
  currentMessageIndex: number;
  body: Record<string, unknown>;
}

interface ThHelpersResponse {
  type: 'th_helpers_response';
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

function isThHelpersRequest(p: unknown): p is ThHelpersRequest {
  if (!p || typeof p !== 'object') return false;
  const r = p as Record<string, unknown>;
  return (
    r.type === 'th_helpers_request' &&
    typeof r.requestId === 'string' &&
    typeof r.op === 'string' &&
    typeof r.chatId === 'string' &&
    typeof r.currentMessageId === 'string' &&
    typeof r.currentMessageIndex === 'number' &&
    !!r.body &&
    typeof r.body === 'object'
  );
}

function resolveRangeToIndex(
  range: unknown,
  total: number,
  currentMessageIndex: number,
): number | null {
  if (total === 0) return null;
  if (typeof range === 'number') {
    return range >= 0 ? range : total + range;
  }
  if (typeof range === 'string') {
    const trimmed = range.trim();
    if (trimmed === '' || trimmed === 'latest') return total - 1;
    if (trimmed === 'this') return currentMessageIndex;
    if (/^-?\d+$/.test(trimmed)) {
      const n = parseInt(trimmed, 10);
      return n >= 0 ? n : total + n;
    }
  }
  return null;
}

// Rich snapshot row: bakes both .message (active swipe content) and .swipes
// so the iframe-side shim can shape the JSR ChatMessage vs ChatMessageSwiped
// variants synchronously without round-tripping back to the backend.
export interface SnapshotMessage {
  /** Host UUID for the message row. Used by the widget-iframe build to
   * resolve the current iframe's hosting message to a snapshot array
   * position via id match — avoids the DOM-vs-DB index drift caused by
   * phantom DOM elements / hidden system rows / virtual-scroll
   * placeholders. The shim's `getCurrentMessageId()` does NOT expose
   * this UUID to cards; it returns the resolved numeric array index. */
  id: string;
  message_id: number;
  name: string;
  role: 'system' | 'user' | 'assistant';
  is_hidden: boolean;
  message: string;
  swipe_id: number;
  swipes: string[];
  data: Record<string, unknown>;
  extra: Record<string, unknown>;
}

function shapeSnapshotMessage(
  msg: ChatMessageDTO & { role?: 'system' | 'user' | 'assistant'; extra?: Record<string, unknown> },
): SnapshotMessage {
  const role =
    msg.role === 'system' || msg.role === 'user' || msg.role === 'assistant'
      ? msg.role
      : msg.is_user
        ? 'user'
        : 'assistant';
  const swipes =
    Array.isArray(msg.swipes) && msg.swipes.length > 0 ? msg.swipes : [msg.content];
  return {
    id: msg.id,
    message_id: msg.index_in_chat,
    name: msg.name,
    role,
    is_hidden: false,
    message: msg.content,
    swipe_id: msg.swipe_id ?? 0,
    swipes,
    data: {},
    extra: msg.extra ?? {},
  };
}

type ChatApi = SpindleAPI['chat'];
type ChatsApi = SpindleAPI['chats'];
type CharactersApi = SpindleAPI['characters'];

// Resolve a chat's greeting set (first_mes + alternate_greetings, in order)
// from the character metadata. Group greetings carry character_id on
// msg.extra; single-character chats fall back to the chat row. Empty array
// when unresolved. Shared by the initial-message swipes population and the
// variables-snapshot recovery below.
async function fetchChatCharacter(
  messages: ChatMessageDTO[],
  chatId: string,
  userId: string,
  chats: ChatsApi,
  characters: CharactersApi,
): Promise<CharacterDTO | null> {
  const msg0 = messages[0] as (ChatMessageDTO & { extra?: Record<string, unknown> }) | undefined;
  let charId: string | null = null;
  const fromExtra = msg0?.extra?.character_id ?? msg0?.extra?.greeting_character_id;
  if (typeof fromExtra === 'string' && fromExtra.length > 0) {
    charId = fromExtra;
  } else {
    // userId is required: chats/characters are operator-scoped (host injects
    // userId as onFrontendMessage's 2nd arg).
    const chatDto = await chats.get(chatId, userId);
    if (chatDto && typeof chatDto.character_id === 'string') charId = chatDto.character_id;
  }
  if (!charId) return null;
  return (await characters.get(charId, userId)) ?? null;
}

function greetingsOf(card: CharacterDTO | null): string[] {
  if (!card) return [];
  const first = typeof card.first_mes === 'string' ? card.first_mes : '';
  const alt = Array.isArray(card.alternate_greetings) ? card.alternate_greetings : [];
  return [first, ...alt];
}

async function fetchCharacterGreetings(
  messages: ChatMessageDTO[],
  chatId: string,
  userId: string,
  chats: ChatsApi,
  characters: CharactersApi,
): Promise<string[]> {
  return greetingsOf(await fetchChatCharacter(messages, chatId, userId, chats, characters));
}

type WorldBooksApi = { entries: { list(id: string, o?: { limit?: number; offset?: number; userId?: string }): Promise<{ data: InitvarEntry[]; total: number }> } };

// [initvar] seed from the character's attached world books when readable
// (world_books permission), else from the lorebook embedded in the card.
export async function initvarSeedFor(
  card: CharacterDTO | null,
  userId: string,
  worldBooks: WorldBooksApi | undefined = (api as unknown as { world_books?: WorldBooksApi }).world_books,
): Promise<Record<string, unknown>> {
  if (!card) return {};
  const ids = Array.isArray(card.world_book_ids) ? card.world_book_ids : [];
  if (worldBooks && ids.length > 0) {
    try {
      const entries: InitvarEntry[] = [];
      for (const id of ids) {
        for (let offset = 0; ; offset += 200) {
          const page = await worldBooks.entries.list(id, { limit: 200, offset, userId });
          entries.push(...page.data);
          if (page.data.length < 200 || entries.length >= page.total) break;
        }
      }
      if (entries.length > 0) return initvarFromEntries(entries);
    } catch {
      // no permission or missing book: use the embedded copy
    }
  }
  const book = card.extensions?.character_book as { entries?: Array<InitvarEntry & { name?: unknown }> } | undefined;
  const embedded = Array.isArray(book?.entries) ? book.entries : [];
  return initvarFromEntries(embedded.map((e) => ({ comment: e.comment ?? e.name, content: e.content })));
}

export async function handleGetMessagesSnapshot(
  chatId: string,
  userId: string,
  chat: ChatApi = api.chat,
  chats: ChatsApi = api.chats,
  characters: CharactersApi = api.characters,
): Promise<SnapshotMessage[]> {
  const messages = await chat.getMessages(chatId);
  const snapshot = messages.map((m) => shapeSnapshotMessage(m as ChatMessageDTO));
  // Initial greeting message: when the chat has not stored real swipe
  // alternatives yet (fresh chat), expose the full greeting set as swipes so
  // greeting-selection widgets can index into it, AND persist that array to
  // the DB so a later setChatMessage(swipe_id) validates against the same
  // length. A chat that already holds multiple swipes keeps them (no clobber).
  if (snapshot.length > 0 && snapshot[0].role !== 'user' && snapshot[0].swipes.length <= 1) {
    try {
      const greetings = await fetchCharacterGreetings(messages as ChatMessageDTO[], chatId, userId, chats, characters);
      if (greetings.length > 1) {
        // Keep the active slot equal to the currently displayed content so the
        // persist does not rewrite the visible greeting (macros, prior edits).
        const activeIdx = snapshot[0].swipe_id >= 0 && snapshot[0].swipe_id < greetings.length ? snapshot[0].swipe_id : 0;
        const aligned = greetings.slice();
        aligned[activeIdx] = snapshot[0].message;
        snapshot[0].swipes = aligned;
        try {
          // chat.updateMessage is not operator-scoped (owner derived from chatId,
          // like getMessages); auto-pads swipe_dates. Idempotent: the next read
          // sees length > 1 and skips. On failure the read still serves derived.
          await chat.updateMessage(chatId, (messages[0] as ChatMessageDTO).id, { swipes: aligned, swipe_id: activeIdx });
        } catch (persistErr) {
          log.warn('initial-message swipes persist failed (read serves derived):', persistErr instanceof Error ? persistErr.message : String(persistErr));
        }
      }
    } catch (err) {
      log.warn('initial-message swipes derive failed:', err instanceof Error ? err.message : String(err));
    }
  }
  return snapshot;
}

// Variables snapshot is computed by replaying all chat messages through
// the recognizer pipeline. Pure function of chat content — no persistence
// layer, swipe and edit fall out for free.
//
// We pass the raw DTOs (which include `swipes`, `swipe_id`) straight in;
// computeVariablesSnapshot resolves each message's active swipe via
// resolveActiveContent so swiping greeting 0 → greeting N is followed.
//
// Recovery: if message 0's active content has no <UpdateVariable> block
// (existing chat stripped under buggy code, imported chat, edited
// content), the lazy fetcher reads the card's greetings and lets the
// replay match by stripped-content hash.
export async function handleGetVariablesSnapshot(
  chatId: string,
  userId: string,
  chat: ChatApi = api.chat,
  chats: ChatsApi = api.chats,
  characters: CharactersApi = api.characters,
  messageCount?: number,
): Promise<MvuData> {
  try {
    const all = await chat.getMessages(chatId);
    // Prompt macros pass the context's message count, so a regenerated
    // reply does not see its own previous update.
    const messages = typeof messageCount === 'number' && messageCount >= 0 ? all.slice(0, messageCount) : all;
    let card: CharacterDTO | null = null;
    try {
      card = await fetchChatCharacter(messages as ChatMessageDTO[], chatId, userId, chats, characters);
    } catch (err) {
      log.warn('character lookup failed:', err instanceof Error ? err.message : String(err));
    }
    const seed = await initvarSeedFor(card, userId);
    return await computeVariablesSnapshot(messages, async () => greetingsOf(card), seed);
  } catch (err) {
    log.warn('getVariablesSnapshot failed:', err instanceof Error ? err.message : String(err));
    return emptyMvuData();
  }
}

export async function handleSetChatMessage(
  body: Record<string, unknown>,
  chatId: string,
  currentMessageIndex: number,
  chat: ChatApi = api.chat,
): Promise<void> {
  const fieldValues = (body.fieldValues as Record<string, unknown> | undefined) ?? {};
  const messageRange = body.messageId;

  const messages = await chat.getMessages(chatId);
  if (messages.length === 0) {
    log.warn('setChatMessage: empty chat, ignoring');
    return;
  }

  const idx = resolveRangeToIndex(messageRange, messages.length, currentMessageIndex);
  if (idx === null || idx < 0 || idx >= messages.length) {
    log.warn('setChatMessage: unresolved message index', messageRange);
    return;
  }

  const target = messages[idx] as ChatMessageDTO;
  const content = typeof fieldValues.message === 'string' ? fieldValues.message : undefined;
  if (typeof content !== 'string') {
    log.warn('setChatMessage: no message string in fieldValues, ignoring');
    return;
  }

  // Send { content } only and ignore opts.swipe_id. The native greeting
  // selector also writes { content } without swipe_id, so the host
  // overwrites swipes[existing.swipe_id]. Keeping swipe_id at 0 lets
  // both writers cooperate on slot 0 without corrupting other slots.
  await chat.updateMessage(chatId, target.id, { content });
}

export function installThHelpersHandler(): void {
  api.onFrontendMessage((payload, userId) => {
    if (!isThHelpersRequest(payload)) return;
    const { requestId, op, chatId, currentMessageIndex, body } = payload;
    void (async () => {
      let response: ThHelpersResponse;
      try {
        if (op === 'th-get-messages-snapshot') {
          const result = await handleGetMessagesSnapshot(chatId, userId);
          response = { type: 'th_helpers_response', requestId, ok: true, result };
        } else if (op === 'th-get-variables-snapshot') {
          const result = await handleGetVariablesSnapshot(chatId, userId);
          response = { type: 'th_helpers_response', requestId, ok: true, result };
        } else if (op === 'th-set-chat-message') {
          await handleSetChatMessage(body, chatId, currentMessageIndex);
          response = { type: 'th_helpers_response', requestId, ok: true, result: undefined };
        } else {
          response = {
            type: 'th_helpers_response',
            requestId,
            ok: false,
            error: 'unknown op: ' + String(op),
          };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn('handler threw for op', op, msg);
        response = { type: 'th_helpers_response', requestId, ok: false, error: msg };
      }
      api.sendToFrontend(response, userId);
    })();
  });
}
