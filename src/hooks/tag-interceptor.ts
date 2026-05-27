import type { SpindleFrontendContext } from 'lumiverse-spindle-types';
import type { CompiledScript } from '../core/parse-regex-script';
import { fetchMessageContentById } from '../lumiverse/fetch-message';

/**
 * Recovery hooks for multi-tag paired patterns. The host tag interceptor is
 * single-tag: it delivers a fullMatch scoped to the registered tag only, so a
 * multi-tag findRe can't re-match it. When that happens onCapture fetches the
 * full stored content and rebuilds captures from it, then re-renders.
 */
export interface CaptureRecovery {
  compiled: CompiledScript[];
  fetchContent: (chatId: string, messageId: string) => Promise<string | null>;
  reprocess: (messageId: string) => void;
}

/**
 * Paired-tag pipeline. ctx.messages.registerTagInterceptor fires during
 * MessageContent's render; the handler stores captures keyed by messageId
 * in `capturesByMessage`. The MutationObserver-driven processNode reads
 * this map and renders captures that don't yet have a widget in the DOM.
 *
 * The handler fires at most once per unique fullMatch per page load
 * (Lumiverse dedupes via a session-lifetime Set), so subsequent
 * re-renders of the same content rely on the map, not the handler.
 */

export interface CapturedTag {
  scriptId: string;
  scriptName: string;
  /** Fence-stripped, NOT yet substituted. processNode runs substitute(). */
  replaceString: string;
  /**
   * Card's findRe — re-applied against fullMatch at render time to recover
   * the real capture groups. The tag interceptor only delivers a single
   * pre-extracted inner string, which collapses multi-group cards (e.g.
   * Xiao Gu's 12 pipe-separated groups) into one $1 chorizo and leaves
   * $2..$N literal in the rendered HTML.
   */
  findRe: RegExp;
  fullMatch: string;
  attrs: Record<string, string>;
}

const capturesByMessage = new Map<string, CapturedTag[]>();

export function getCapturesForMessage(messageId: string): CapturedTag[] {
  return capturesByMessage.get(messageId) || [];
}

interface InterceptorPayload {
  tagName: string;
  attrs: Record<string, string>;
  content: string;
  fullMatch: string;
  messageId?: string;
  chatId?: string;
  isUser?: boolean;
  isStreaming?: boolean;
}

let activeUnsubs: (() => void)[] = [];
let activeTagNames = new Set<string>();

/**
 * Register tag interceptors for the paired-tag scripts in `compiled`.
 * Idempotent w.r.t. the set of tagNames currently registered: if the new
 * set matches the existing set, the call is a no-op (no tear-down/reset
 * of Lumiverse's `delivered` Set). If the set differs, we tear down all
 * old registrations and register fresh.
 *
 * `capturesByMessage` is NEVER cleared — the captured data is keyed by
 * messageId (UUID), so accumulation across chat switches is bounded by
 * total tags ever rendered in the session and harmless.
 */
type RegRole = 'capture' | 'strip';
interface Registration {
  script: CompiledScript;
  role: RegRole;
}

export function syncTagInterceptors(
  ctx: SpindleFrontendContext,
  compiled: CompiledScript[],
  recovery?: CaptureRecovery,
): void {
  // First tag of each paired-tag pattern is the capture anchor; the host
  // delivers a fullMatch scoped to it. For multi-tag patterns the remaining
  // tags need their own interceptors with removeFromMessage so the host
  // strips them from display too (otherwise they show as raw text). Anchors
  // always win a tag name; non-anchor tags only claim a name left unclaimed.
  const desired = new Map<string, Registration>();

  for (const s of compiled) {
    if (s.kind !== 'pairedTag') continue;
    const tags = extractAllTagNames(s.findRe.source);
    if (tags.length === 0) {
      // Should be unreachable if classify-trigger and the tag-name extractors
      // stay in sync — all share the "tolerant of \s* decoration" rule.
      // Logging anyway in case they drift.
      console.debug(
        `[vishrun] paired-tag script "${s.scriptName}" classified as pairedTag but ` +
        `no tag name extractable — skipping. findRegex source: ${s.findRe.source}`,
      );
      continue;
    }
    desired.set(tags[0].toLowerCase(), { script: s, role: 'capture' });
  }
  for (const s of compiled) {
    if (s.kind !== 'pairedTag') continue;
    const tags = extractAllTagNames(s.findRe.source);
    for (let i = 1; i < tags.length; i++) {
      const key = tags[i].toLowerCase();
      if (!desired.has(key)) desired.set(key, { script: s, role: 'strip' });
    }
  }

  // Same set as currently active? No-op.
  if (
    desired.size === activeTagNames.size &&
    [...desired.keys()].every((t) => activeTagNames.has(t))
  ) {
    return;
  }

  // Tear down existing.
  activeUnsubs.forEach((u) => {
    try { u(); } catch { /* swallow */ }
  });
  activeUnsubs = [];
  activeTagNames = new Set(desired.keys());

  // Register fresh.
  for (const [tagName, reg] of desired) {
    const handler =
      reg.role === 'capture'
        ? (payload: InterceptorPayload) => onCapture(payload, reg.script, recovery)
        : // Strip-only: the host removes the tag from display via
          // removeFromMessage; we don't capture it (its groups come from the
          // anchor script's full re-match).
          () => { /* strip-only */ };
    const unsub = ctx.messages.registerTagInterceptor(
      { tagName, removeFromMessage: true },
      handler,
    );
    activeUnsubs.push(unsub);
  }
}

export function teardownTagInterceptors(): void {
  activeUnsubs.forEach((u) => {
    try { u(); } catch { /* swallow */ }
  });
  activeUnsubs = [];
  activeTagNames = new Set();
}

/**
 * Recompute capturesByMessage[messageId] from a raw message content string,
 * bypassing the host tag interceptor.
 *
 * Workaround: Lumiverse's `delivered` Set in
 * frontend/src/lib/spindle/message-interceptors.ts dedupes interceptor fires
 * by (extensionId, messageId, isStreaming, tagName, fullMatch) and never
 * clears. Swiping back to a previously-seen swipe doesn't re-fire the
 * interceptor, so capturesByMessage would hold stale content from the last
 * fired swipe. MESSAGE_SWIPED / MESSAGE_EDITED handlers call this with the
 * fresh content from the WS payload instead.
 *
 * Scripts run in compiled order against an accumulatively-stripped working
 * copy (mirrors the host's stripMessageTags), so a nested script doesn't
 * double-capture. Per script: last match wins. Scripts that don't match
 * drop their capture — that's how widgets disappear when a swipe omits the tag.
 *
 * Returns true if capturesByMessage[messageId] changed, signalling the
 * caller to trigger processMessageById.
 */
export function rebuildCapturesFromContent(
  messageId: string,
  content: string,
  compiled: CompiledScript[],
  _eventName?: string,
): boolean {
  const newList: CapturedTag[] = [];

  // compileScripts merges `g` into paired-tag regexes, so `replace(findRe, '')`
  // strips every occurrence.
  let working = content;
  for (const script of compiled) {
    if (script.kind !== 'pairedTag') continue;
    script.findRe.lastIndex = 0;
    let lastMatch: RegExpExecArray | null = null;
    let m: RegExpExecArray | null;
    while ((m = script.findRe.exec(working)) !== null) {
      lastMatch = m;
      if (m[0].length === 0) script.findRe.lastIndex++;
    }
    if (lastMatch) {
      newList.push({
        scriptId: script.id,
        scriptName: script.scriptName,
        replaceString: script.replaceString,
        findRe: script.findRe,
        fullMatch: lastMatch[0],
        attrs: {},
      });
    }
    // Strip this tag's matches before the next script scans — accumulative,
    // like the host's stripMessageTags.
    script.findRe.lastIndex = 0;
    working = working.replace(script.findRe, '');
    script.findRe.lastIndex = 0;
  }

  const existing = capturesByMessage.get(messageId) || [];
  let changed = existing.length !== newList.length;
  if (!changed) {
    for (const next of newList) {
      const prev = existing.find((c) => c.scriptId === next.scriptId);
      if (!prev || prev.fullMatch !== next.fullMatch) {
        changed = true;
        break;
      }
    }
  }

  if (changed) {
    if (newList.length === 0) {
      capturesByMessage.delete(messageId);
    } else {
      capturesByMessage.set(messageId, newList);
    }
  }
  return changed;
}

// messageIds with an in-flight full-content recovery, to coalesce the
// per-tag interceptor fires of one message into a single fetch+rebuild.
const recoveryInFlight = new Set<string>();

function onCapture(
  payload: InterceptorPayload,
  script: CompiledScript,
  recovery?: CaptureRecovery,
): void {
  // No streaming guard: the paired-tag regex doesn't match until the close
  // tag arrives, by which point the captured inner is final.
  if (!payload.messageId) return;

  // The host delivers a fullMatch scoped to the registered (first) tag only.
  // If the script's full findRe matches it, this is a single-tag pattern and
  // the span is complete, so store directly (synchronous, unchanged path).
  script.findRe.lastIndex = 0;
  const selfMatches = script.findRe.test(payload.fullMatch);
  script.findRe.lastIndex = 0;
  if (selfMatches) {
    storeCapture(payload.messageId, script, payload.fullMatch, payload.attrs);
    return;
  }

  // Multi-tag pattern: the host span is a truncated prefix. Recover the full
  // span from the stored message content. Fire-and-forget: rebuild triggers
  // its own re-render. Fall back to the truncated store if recovery isn't
  // wired or the fetch fails, so $1 still renders (no worse than before).
  if (!recovery || !payload.chatId) {
    storeCapture(payload.messageId, script, payload.fullMatch, payload.attrs);
    return;
  }
  void recoverFullCapture(payload.messageId, payload.chatId, script, payload, recovery);
}

function storeCapture(
  messageId: string,
  script: CompiledScript,
  fullMatch: string,
  attrs: Record<string, string>,
): void {
  // Drop any prior capture for this scriptId — only the latest fullMatch
  // is canonical. Trade-off: the same paired tag emitted multiple times
  // in one message renders only the last instance (no card in scope hits this).
  const existing = capturesByMessage.get(messageId) || [];
  const list = existing.filter((c) => c.scriptId !== script.id);
  list.push({
    scriptId: script.id,
    scriptName: script.scriptName,
    replaceString: script.replaceString,
    findRe: script.findRe,
    fullMatch,
    attrs,
  });
  capturesByMessage.set(messageId, list);
}

async function recoverFullCapture(
  messageId: string,
  chatId: string,
  script: CompiledScript,
  payload: InterceptorPayload,
  recovery: CaptureRecovery,
): Promise<void> {
  if (recoveryInFlight.has(messageId)) return;
  recoveryInFlight.add(messageId);
  try {
    let content: string | null = null;
    try {
      content = await recovery.fetchContent(chatId, messageId);
    } catch {
      content = null;
    }
    if (content == null) {
      // Fetch failed: keep the truncated capture so $1 still renders.
      storeCapture(messageId, script, payload.fullMatch, payload.attrs);
      recovery.reprocess(messageId);
      return;
    }
    // rebuildCapturesFromContent re-runs every paired-tag findRe against the
    // full content and rewrites capturesByMessage with the true spans.
    const changed = rebuildCapturesFromContent(messageId, content, recovery.compiled);
    if (changed) recovery.reprocess(messageId);
  } finally {
    recoveryInFlight.delete(messageId);
  }
}

// Opening-tag matcher: `<` then optional `\s*`-decoration / whitespace, then
// an identifier. Closing tags (`<\/TAG>`) don't match — the char after `<` is
// `\`, not an identifier or decoration. Global for repeated scanning.
const OPEN_TAG_RE = /<(?:\\s\*|\s)*([a-zA-Z_][a-zA-Z0-9_-]*)/g;

/**
 * Pull the tag names out of a paired-tag findRegex source, in source order,
 * deduped (case-insensitive). The first entry is the capture anchor.
 *
 * Tolerates whitespace-allowance decorations between `<` and the tag name —
 * card authors sometimes pad with `\s*` for paranoia (Pacifica:
 * `<\s*PACIFICA_UI\s*>...`). Multi-tag patterns yield every distinct tag the
 * pattern spans (status bars: ID, Time, Location, ...).
 *
 * Stays in sync with `isPairedTag` in `classify-trigger.ts` — both must
 * accept the same shapes, otherwise classification routes to pairedTag but
 * registration silently fails.
 */
export function extractAllTagNames(reSource: string): string[] {
  OPEN_TAG_RE.lastIndex = 0;
  const names: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = OPEN_TAG_RE.exec(reSource)) !== null) {
    const lower = m[1].toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    names.push(m[1]);
  }
  return names;
}
