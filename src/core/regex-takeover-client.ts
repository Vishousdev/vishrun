import type { SpindleFrontendContext } from 'lumiverse-spindle-types';
import type { RawRegexScript } from '../lumiverse/fetch-character';
import { selectTakeoverCandidates } from './takeover-policy';

const TIMEOUT_MS = 8000;
const done = new Set<string>();
let counter = 0;

// Asks the backend to disable the host's copies of this card's Vishrun-rendered
// scripts. Once per character per session; resolves to the number of rows disabled.
export function requestRegexTakeover(
  ctx: SpindleFrontendContext,
  characterId: string,
  scripts: RawRegexScript[],
): Promise<number> {
  if (done.has(characterId)) return Promise.resolve(0);
  const candidates = selectTakeoverCandidates(scripts);
  if (candidates.length === 0) {
    done.add(characterId);
    return Promise.resolve(0);
  }
  done.add(characterId);
  const requestId = `vishrun-rt-${Date.now()}-${++counter}`;
  return new Promise<number>((resolve) => {
    let unsub: (() => void) | null = null;
    const timer = setTimeout(() => { unsub?.(); done.delete(characterId); resolve(0); }, TIMEOUT_MS);
    unsub = ctx.onBackendMessage((payload) => {
      const p = payload as { type?: string; requestId?: string; disabled?: number; error?: string } | null;
      if (!p || p.type !== 'regex_takeover_response' || p.requestId !== requestId) return;
      clearTimeout(timer);
      unsub?.();
      if (p.error) done.delete(characterId);
      resolve(typeof p.disabled === 'number' ? p.disabled : 0);
    });
    ctx.sendToBackend({
      type: 'regex_takeover',
      requestId,
      characterId,
      scripts: candidates.map((c) => ({ findRegex: c.findRegex, replaceString: c.replaceString })),
    });
  });
}
