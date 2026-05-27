import type { SpindleFrontendContext } from 'lumiverse-spindle-types';
import { VSH_VISHRUN_DIAG } from '../core/diagnostics';
import { parseMessagesResponse } from '../lumiverse/fetch-message';

// Re-export for callers/tests that imported it from here historically.
export { parseMessagesResponse };

// On GENERATION_ENDED, write `<StatusPlaceHolderImpl></StatusPlaceHolderImpl>`
// into the assistant message so the Status Bar widget has a mount point.
// MVU upstream does this in update_variables.ts; Vishrun never ported it.
// Two paths: append the paired form when no placeholder exists; upgrade any
// self-closing form to paired (Vishrun's findRe only matches paired).
// Idempotent: paired-present + no self-closing → skip.

export const STATUS_PLACEHOLDER_PAIRED = '<StatusPlaceHolderImpl></StatusPlaceHolderImpl>';
export const STATUS_PLACEHOLDER_SELF_CLOSING = '<StatusPlaceHolderImpl/>';
// Tolerant of inner whitespace: `<StatusPlaceHolderImpl />` matches too.
export const SELF_CLOSING_RE = /<StatusPlaceHolderImpl\s*\/>/g;
const TRAILING_TRIGGER = '\n\n' + STATUS_PLACEHOLDER_PAIRED;

const LOG_PREFIX = '[vishrun:status-bar-inject]';

export interface InjectMessageView {
  id: string;
  content: string;
  isUser?: boolean;
  role?: 'system' | 'user' | 'assistant';
}

export interface InjectIO {
  fetchContent: (chatId: string, messageId: string) => Promise<InjectMessageView | null>;
  updateContent: (chatId: string, messageId: string, newContent: string) => Promise<void>;
}

export type InjectResult =
  | 'injected'
  | 'upgraded'
  | 'already-has-trigger'
  | 'not-assistant'
  | 'fetch-miss'
  | 'error';

function logInjectError(messageId: string, err: unknown): void {
  if (!VSH_VISHRUN_DIAG) return;
  try {
    console.log(`${LOG_PREFIX} inject-error`, JSON.stringify({
      messageId,
      error: err instanceof Error ? err.message : String(err),
    }));
  } catch { /* ignore stringify edge cases */ }
}

// Pure: testable without a SpindleFrontendContext. Reads via io.fetchContent,
// writes via io.updateContent.
export async function maybeInjectStatusPlaceholder(
  chatId: string,
  messageId: string,
  io: InjectIO,
): Promise<InjectResult> {
  let message: InjectMessageView | null;
  try {
    message = await io.fetchContent(chatId, messageId);
  } catch (err) {
    logInjectError(messageId, err);
    return 'error';
  }
  if (!message) return 'fetch-miss';

  const isUser = message.isUser === true || message.role === 'user';
  // Reset lastIndex defensively — SELF_CLOSING_RE is global.
  SELF_CLOSING_RE.lastIndex = 0;
  const selfClosingMatches = message.content.match(SELF_CLOSING_RE);
  const hasSelfClosing = selfClosingMatches !== null && selfClosingMatches.length > 0;
  const hasPaired = message.content.includes(STATUS_PLACEHOLDER_PAIRED);

  if (isUser) return 'not-assistant';
  if (hasPaired && !hasSelfClosing) return 'already-has-trigger';

  let newContent: string;
  let outcome: 'injected' | 'upgraded';
  if (hasSelfClosing) {
    newContent = message.content.replace(SELF_CLOSING_RE, STATUS_PLACEHOLDER_PAIRED);
    outcome = 'upgraded';
  } else {
    newContent = message.content + TRAILING_TRIGGER;
    outcome = 'injected';
  }

  try {
    await io.updateContent(chatId, messageId, newContent);
    return outcome;
  } catch (err) {
    logInjectError(messageId, err);
    return 'error';
  }
}

// Default IO: same-origin REST against Lumiverse. PUT {content} updates
// both `content` and `swipes[swipe_id]` on the server side.
export function defaultIO(): InjectIO {
  return {
    fetchContent: async (chatId, messageId) => {
      const r = await fetch(
        `/api/v1/chats/${encodeURIComponent(chatId)}/messages`,
        { credentials: 'same-origin' },
      );
      if (!r.ok) throw new Error(`messages fetch failed: HTTP ${r.status}`);
      const json = await r.json() as unknown;
      const list = parseMessagesResponse(json);
      const m = list.find((mm) => mm.id === messageId);
      if (!m) return null;
      return { id: m.id, content: m.content, isUser: m.is_user, role: m.role };
    },
    updateContent: async (chatId, messageId, newContent) => {
      const r = await fetch(
        `/api/v1/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`,
        {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: newContent }),
        },
      );
      if (!r.ok) throw new Error(`update failed: HTTP ${r.status}`);
    },
  };
}

interface GenerationEndedPayload {
  generationId?: string;
  chatId?: string;
  messageId?: string;
  content?: string;
  error?: string;
}

// GENERATION_ENDED fires once per LLM generation after the message is
// finalized; streaming events would race the post-stream commit.
export function installStatusBarInjectHook(
  ctx: SpindleFrontendContext,
  io: InjectIO = defaultIO(),
): () => void {
  return ctx.events.on('GENERATION_ENDED', (payload: unknown) => {
    const p = (payload || {}) as GenerationEndedPayload;
    if (p.error) return;
    if (!p.messageId || !p.chatId) return;
    void maybeInjectStatusPlaceholder(p.chatId, p.messageId, io);
  });
}
