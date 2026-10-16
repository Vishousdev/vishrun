import type { RequestInitDTO } from 'lumiverse-spindle-types';
import { api } from './common';
import { vendoredBodyFor } from './vendored-cdn';

// `fetch_external` protocol: the frontend ctx has no CORS proxy, so to inline
// cross-origin assets into widget sandboxes (Tailwind / React / Babel CDNs) it
// sends `{ type:'fetch_external', requestId, url }` here; we proxy via
// `spindle.cors` (needs `cors_proxy`) and reply `fetch_external_response` with
// `ok: false` on failure (frontend then renders without the asset). Frontend
// side: `src/core/asset-injector.ts`.

interface FetchExternalRequest {
  type: 'fetch_external';
  requestId: string;
  url: string;
}

function isFetchExternalRequest(p: unknown): p is FetchExternalRequest {
  return (
    !!p &&
    typeof p === 'object' &&
    (p as { type?: unknown }).type === 'fetch_external' &&
    typeof (p as { requestId?: unknown }).requestId === 'string' &&
    typeof (p as { url?: unknown }).url === 'string'
  );
}

function extractBody(result: unknown): string {
  // spindle.cors(url, { responseType: 'text' }) resolves with
  // { status, statusText, headers, body } where body is the response text.
  if (result && typeof result === 'object' && typeof (result as { body?: unknown }).body === 'string') {
    return (result as { body: string }).body;
  }
  return '';
}

export function installFetchExternalHandler(): void {
  api.onFrontendMessage((payload, userId) => {
    if (!isFetchExternalRequest(payload)) return;
    const { requestId, url } = payload;
    const vendored = vendoredBodyFor(url);
    if (vendored !== null) {
      api.sendToFrontend({ type: 'fetch_external_response', requestId, ok: true, body: vendored }, userId);
      return;
    }
    const options: RequestInitDTO = { responseType: 'text' };
    api.cors(url, options).then(
      (result) => {
        api.sendToFrontend(
          { type: 'fetch_external_response', requestId, ok: true, body: extractBody(result) },
          userId,
        );
      },
      (err: unknown) => {
        api.sendToFrontend(
          {
            type: 'fetch_external_response',
            requestId,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          },
          userId,
        );
      },
    );
  });
}
