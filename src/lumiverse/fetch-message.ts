import { getChatMessages } from './host-api';

/**
 * Lumiverse helper for message content (reads go through the backend worker).
 *
 * GET /api/v1/chats/:chatId/messages returns PaginatedResult<Message>
 * (`{ data, total, limit, offset }`). parseMessagesResponse unwraps that
 * (tolerant of a bare-array shape too); fetchMessageContentById resolves a
 * single message's content by id.
 */

interface RawMessageRow {
  id: string;
  content: string;
  is_user: boolean;
  role?: 'system' | 'user' | 'assistant';
}

export function parseMessagesResponse(json: unknown): RawMessageRow[] {
  if (Array.isArray(json)) return json as RawMessageRow[];
  if (json && typeof json === 'object' && Array.isArray((json as { data?: unknown }).data)) {
    return (json as { data: RawMessageRow[] }).data;
  }
  return [];
}

// Resolve a single message's stored content by id. Returns null on miss.
export async function fetchMessageContentById(
  chatId: string,
  messageId: string,
): Promise<string | null> {
  const m = (await getChatMessages(chatId)).find((mm) => mm.id === messageId);
  return m ? m.content : null;
}

export const fetchMessageContent = fetchMessageContentById;
