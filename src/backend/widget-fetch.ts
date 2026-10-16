import type { RequestInitDTO } from 'lumiverse-spindle-types';
import { api } from './common';

// Text fetches for card code inside widget frames (the frame CSP blocks all
// network). Public http(s) hosts only: the host proxy may reach private
// addresses, which a card must not use to probe the user's network.

export interface WidgetFetchRequest {
  type: 'widget_fetch';
  requestId: string;
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

const METHODS = new Set(['GET', 'POST', 'HEAD']);

function isWidgetFetchRequest(p: unknown): p is WidgetFetchRequest {
  if (!p || typeof p !== 'object') return false;
  const r = p as Record<string, unknown>;
  return r.type === 'widget_fetch' && typeof r.requestId === 'string' && typeof r.url === 'string';
}

export function isPublicHttpUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return false;
  if (h === '::1' || h === '::' || /^(?:fc|fd|fe80)/.test(h) || h.startsWith('::ffff:')) return false;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
  } else if (!h.includes('.')) {
    return false;
  }
  return true;
}

export function installWidgetFetchHandler(): void {
  api.onFrontendMessage((payload, userId) => {
    if (!isWidgetFetchRequest(payload)) return;
    const { requestId, url } = payload;
    const method = (payload.method ?? 'GET').toUpperCase();
    const reply = (msg: Record<string, unknown>) =>
      api.sendToFrontend({ type: 'widget_fetch_response', requestId, ...msg }, userId);
    if (!isPublicHttpUrl(url) || !METHODS.has(method)) {
      reply({ ok: false, error: 'widget fetch refused: only GET/POST/HEAD to public http(s) hosts' });
      return;
    }
    const options: RequestInitDTO = { method, responseType: 'text' };
    if (payload.headers && typeof payload.headers === 'object') options.headers = payload.headers;
    if (typeof payload.body === 'string' && method === 'POST') options.body = payload.body;
    api.cors(url, options).then(
      (result) => {
        const r = (result ?? {}) as { status?: number; statusText?: string; headers?: Record<string, string>; body?: unknown };
        reply({
          ok: true,
          status: typeof r.status === 'number' ? r.status : 200,
          statusText: r.statusText ?? '',
          headers: r.headers ?? {},
          body: typeof r.body === 'string' ? r.body : '',
        });
      },
      (err: unknown) => reply({ ok: false, error: err instanceof Error ? err.message : String(err) }),
    );
  });
}
