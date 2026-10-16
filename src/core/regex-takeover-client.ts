import type { SpindleFrontendContext } from 'lumiverse-spindle-types';
import type { RawRegexScript } from '../lumiverse/fetch-character';
import { selectTakeoverCandidates } from './takeover-policy';

const TIMEOUT_MS = 8000;
let counter = 0;

export interface TakeoverResult {
  disabled: number;
  /** pattern + NUL + replacement of rows the host still renders itself. */
  native: string[];
}

const results = new Map<string, Promise<TakeoverResult>>();
const known = new Map<string, string[]>();

// Native rows from an earlier answer this session, so a reopened card renders
// right away without waiting for the round trip.
export function knownNativeKeys(characterId: string): string[] | undefined {
  return known.get(characterId);
}

// Asks the backend to disable the host's copies of this card's Vishrun-rendered
// scripts and to report which of the card's rows the host keeps rendering.
// Once per character per session; failures are retried on the next call.
export function requestRegexTakeover(
  ctx: SpindleFrontendContext,
  characterId: string,
  scripts: RawRegexScript[],
): Promise<TakeoverResult> {
  const hit = results.get(characterId);
  if (hit) return hit;
  const candidates = selectTakeoverCandidates(scripts);
  const requestId = `vishrun-rt-${Date.now()}-${++counter}`;
  const pending = new Promise<TakeoverResult>((resolve) => {
    let unsub: (() => void) | null = null;
    const timer = setTimeout(() => { unsub?.(); results.delete(characterId); resolve({ disabled: 0, native: [] }); }, TIMEOUT_MS);
    unsub = ctx.onBackendMessage((payload) => {
      const p = payload as { type?: string; requestId?: string; disabled?: number; native?: unknown; error?: string } | null;
      if (!p || p.type !== 'regex_takeover_response' || p.requestId !== requestId) return;
      clearTimeout(timer);
      unsub?.();
      if (p.error) results.delete(characterId);
      const native = Array.isArray(p.native) ? p.native.filter((k): k is string => typeof k === 'string') : [];
      if (!p.error) known.set(characterId, native);
      resolve({ disabled: typeof p.disabled === 'number' ? p.disabled : 0, native });
    });
    ctx.sendToBackend({
      type: 'regex_takeover',
      requestId,
      characterId,
      scripts: candidates.map((c) => ({ findRegex: c.findRegex, replaceString: c.replaceString })),
    });
  });
  results.set(characterId, pending);
  return pending;
}
