/**
 * Lumiverse REST helper for message content.
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
  const r = await fetch(
    `/api/v1/chats/${encodeURIComponent(chatId)}/messages`,
    { credentials: 'same-origin' },
  );
  if (!r.ok) throw new Error(`messages fetch failed: HTTP ${r.status}`);
  const json = await r.json() as unknown;
  const m = parseMessagesResponse(json).find((mm) => mm.id === messageId);
  return m ? m.content : null;
}
