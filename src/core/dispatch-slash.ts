import type { SpindleFrontendContext } from 'lumiverse-spindle-types';

// Frontend → backend bridge for the iframe shim's slash-command dispatch
// (intercepted `navigator.clipboard.writeText` from cards' pushToSillyTavern
// fallback). Per-request `onBackendMessage` subscription, unsubbed on every
// settle path — same pattern as `resolveMacrosBatch` in `macro-resolver.ts`.
// Timeout or backend error → reject; the caller decides whether to fall back
// to the real clipboard.

export interface DispatchSlashResult {
  handled: boolean;
  kind: 'setvar_chain' | 'sys_message' | 'none';
  error?: string;
}

interface DispatchSlashResponse {
  type: 'dispatch_slash_text_response';
  requestId: string;
  handled: boolean;
  kind: 'setvar_chain' | 'sys_message' | 'none';
  error?: string;
}

function isDispatchSlashResponse(p: unknown, requestId: string): p is DispatchSlashResponse {
  if (!p || typeof p !== 'object') return false;
  const r = p as Record<string, unknown>;
  return (
    r.type === 'dispatch_slash_text_response' &&
    r.requestId === requestId &&
    typeof r.handled === 'boolean' &&
    typeof r.kind === 'string'
  );
}

let requestCounter = 0;
function nextRequestId(): string {
  return `vishrun-ds-${Date.now()}-${++requestCounter}`;
}

const DISPATCH_TIMEOUT_MS = 5000;

export function dispatchSlashViaBackend(
  ctx: SpindleFrontendContext,
  chatId: string,
  text: string,
  timeoutMs = DISPATCH_TIMEOUT_MS,
): Promise<DispatchSlashResult> {
  return new Promise<DispatchSlashResult>((resolve, reject) => {
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
      if (!isDispatchSlashResponse(payload, requestId)) return;
      finish(() => resolve({ handled: payload.handled, kind: payload.kind, error: payload.error }));
    });

    timer = setTimeout(() => {
      finish(() => reject(new Error('dispatch_slash_text timeout')));
    }, timeoutMs);

    try {
      ctx.sendToBackend({ type: 'dispatch_slash_text', requestId, text, chatId });
    } catch (err) {
      finish(() => reject(err instanceof Error ? err : new Error(String(err))));
    }
  });
}
