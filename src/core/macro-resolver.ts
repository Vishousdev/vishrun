import type { SpindleFrontendContext } from 'lumiverse-spindle-types';

// Frontend → backend bridge for `{{macro}}` resolution (the frontend ctx has no
// macro API). One call carries every widget template for a rendered message.
// Per-request `onBackendMessage` subscription, unsubbed on every settle path —
// same pattern as `fetchViaBackend` in `asset-injector.ts`. Timeout or backend
// error → reject; callers fall back to the raw (unresolved) templates.

interface ResolveMacrosResponse {
  type: 'resolve_macros_response';
  requestId: string;
  results: string[];
}

function isResolveMacrosResponse(p: unknown, requestId: string): p is ResolveMacrosResponse {
  return (
    !!p &&
    typeof p === 'object' &&
    (p as { type?: unknown }).type === 'resolve_macros_response' &&
    (p as { requestId?: unknown }).requestId === requestId &&
    Array.isArray((p as { results?: unknown }).results)
  );
}

let requestCounter = 0;
function nextRequestId(): string {
  return `vishrun-rm-${Date.now()}-${++requestCounter}`;
}

const RESOLVE_TIMEOUT_MS = 5000;

export function resolveMacrosBatch(
  ctx: SpindleFrontendContext,
  chatId: string,
  characterId: string | null,
  templates: string[],
  timeoutMs = RESOLVE_TIMEOUT_MS,
): Promise<string[]> {
  if (templates.length === 0) return Promise.resolve([]);

  return new Promise<string[]>((resolve, reject) => {
    const requestId = nextRequestId();
    let settled = false;
    let unsub: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (run: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (unsub) {
        try {
          unsub();
        } catch {
          /* ignore */
        }
        unsub = null;
      }
      run();
    };

    unsub = ctx.onBackendMessage((payload) => {
      if (!isResolveMacrosResponse(payload, requestId)) return;
      if (payload.results.length === templates.length && payload.results.every((r) => typeof r === 'string')) {
        const results = payload.results;
        finish(() => resolve(results));
      } else {
        finish(() => reject(new Error('resolve_macros malformed response')));
      }
    });

    timer = setTimeout(() => {
      finish(() => reject(new Error('resolve_macros timeout')));
    }, timeoutMs);

    try {
      ctx.sendToBackend({
        type: 'resolve_macros',
        requestId,
        chatId,
        characterId: characterId ?? undefined,
        templates,
      });
    } catch (err) {
      finish(() => reject(err instanceof Error ? err : new Error(String(err))));
    }
  });
}
