// MVU variable state as a pure function of chat content: every read replays
// the chat in order, on each message's active swipe. Per message, <initvar>
// blocks replace stat_data, then the update commands apply on top, as MVU
// does for the greeting and each reply. Nothing is persisted.

import { applyCommand, extractCommands } from './mvu-commands';
import { mergeInitvar, parseString } from './mvu-initvar';
import { VSH_VISHRUN_DIAG } from '../core/diagnostics';

import type { MvuData } from '../core/mvu-data';

export { emptyMvuData, type MvuData } from '../core/mvu-data';

// Accepts ChatMessageDTO and bare {content} fixtures. swipes[swipe_id] wins
// over content so the replay follows the displayed swipe.
export interface ChatMessageContent {
  content?: string;
  swipes?: string[];
  swipe_id?: number;
  id?: string;
  index_in_chat?: number;
  extra?: Record<string, unknown>;
}

// Lazy fetcher of the card's greetings ([first_mes, ...alternate_greetings]).
export type CardGreetingFetcher = () => Promise<string[]>;

export function resolveActiveContent(msg: ChatMessageContent): string {
  const swipes = msg.swipes;
  const swipeId = typeof msg.swipe_id === 'number' ? msg.swipe_id : 0;
  if (Array.isArray(swipes) && swipes.length > 0) {
    const c = swipes[swipeId];
    if (typeof c === 'string' && c.length > 0) return c;
  }
  if (typeof msg.content === 'string') return msg.content;
  return '';
}

const BLOCK_RE = /<UpdateVariable>([\s\S]*?)<\/UpdateVariable>/gim;
const INITVAR_RE = /<(initvar)>(?:\s*```.*)?([\s\S]*?)(?:```\s*)?<\/\1>/gim;

export function extractUpdateVariableBlocks(content: string): string[] {
  if (typeof content !== 'string' || !/<updatevariable>/i.test(content)) return [];
  return [...content.matchAll(BLOCK_RE)].map((m) => m[1]);
}

// Merged <initvar> payloads in the content, or null when there are none.
export function extractInitvar(content: string): Record<string, unknown> | null {
  let found = false;
  const out: Record<string, unknown> = {};
  for (const m of content.matchAll(INITVAR_RE)) {
    try {
      const data = parseString(m[2]);
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        mergeInitvar(out, data as Record<string, unknown>);
        found = true;
      }
    } catch (err) {
      console.warn('[vishrun:mvu-parser] initvar parse failed:', err instanceof Error ? err.message : String(err));
    }
  }
  return found ? out : null;
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function hashStripped(s: string): number {
  return fnv1a(s.replace(/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/gi, ''));
}

// Applies one message's variable markup to `state` in place.
export function applyMessage(state: MvuData, content: string, messageId: string | null = null): void {
  const init = extractInitvar(content);
  if (init) state.stat_data = init;
  for (const cmd of extractCommands(content)) {
    const r = applyCommand(state.stat_data, cmd);
    if (!r.ok && VSH_VISHRUN_DIAG) {
      console.log('[vishrun:mvu-parser] command skipped', JSON.stringify({ messageId, type: cmd.type, args: cmd.args, reason: r.reason }));
    }
  }
}

// seed: lorebook [initvar] data; a greeting <initvar> replaces it, as in MVU.
// recoveryFetcher: when message 0 carries no variable markup (edited or
// imported chat), the card greeting with the same text supplies it.
export async function computeVariablesSnapshot(
  messages: ChatMessageContent[],
  recoveryFetcher?: CardGreetingFetcher,
  seed?: Record<string, unknown>,
): Promise<MvuData> {
  const state: MvuData = { stat_data: structuredClone(seed ?? {}) };
  for (const msg of messages) {
    if (!msg) continue;
    let content = resolveActiveContent(msg);
    if (content.length === 0) continue;
    if (msg.index_in_chat === 0 && recoveryFetcher && !/<updatevariable>|<initvar>/i.test(content)) {
      let candidates: string[] = [];
      try {
        candidates = await recoveryFetcher();
      } catch (err) {
        console.warn('[vishrun:mvu-parser] recovery fetcher threw:', err instanceof Error ? err.message : String(err));
      }
      const target = hashStripped(content);
      const match = candidates.find((c) => typeof c === 'string' && /<updatevariable>|<initvar>/i.test(c) && hashStripped(c) === target);
      if (match) content = match;
    }
    applyMessage(state, content, typeof msg.id === 'string' ? msg.id : null);
  }
  return state;
}
