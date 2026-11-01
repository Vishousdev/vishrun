import type { SpindleFrontendContext } from 'lumiverse-spindle-types';

// Frontend side of backend/preset-scripts.ts.

const TIMEOUT_MS = 10000;
let counter = 0;

export function presetRpc<T>(ctx: SpindleFrontendContext, op: string, args: Record<string, unknown> = {}): Promise<T> {
  const requestId = `vishrun-ps-${Date.now()}-${++counter}`;
  return new Promise<T>((resolve, reject) => {
    let unsub: (() => void) | null = null;
    const timer = setTimeout(() => {
      unsub?.();
      reject(new Error(`[vishrun] preset ${op} timed out`));
    }, TIMEOUT_MS);
    unsub = ctx.onBackendMessage((payload) => {
      const p = payload as { type?: string; requestId?: string; result?: T; error?: string } | null;
      if (!p || p.type !== 'vr_preset_response' || p.requestId !== requestId) return;
      clearTimeout(timer);
      unsub?.();
      if (p.error) reject(new Error(p.error)); else resolve(p.result as T);
    });
    ctx.sendToBackend({ type: 'vr_preset', requestId, op, args });
  });
}
