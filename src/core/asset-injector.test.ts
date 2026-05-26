import { test, expect, beforeEach } from 'bun:test';
import type { SpindleFrontendContext } from 'lumiverse-spindle-types';
import {
  isCdnScriptUrl,
  extractCdnScriptUrls,
  transformHtmlForCdnScripts,
  __resetBundleCacheForTests,
} from './asset-injector';

// Fake backend: resolves `fetch_external` requests from `responses`, or fails
// them from `errors`. Mirrors the font-proxy test harness.
interface FakeBackend {
  ctx: SpindleFrontendContext;
  responses: Map<string, string>;
  errors: Map<string, string>;
  fetchCount: Map<string, number>;
}

function makeFakeBackend(): FakeBackend {
  const responses = new Map<string, string>();
  const errors = new Map<string, string>();
  const fetchCount = new Map<string, number>();
  const listeners = new Set<(p: unknown) => void>();

  const ctx = {
    getActiveChat: () => ({ chatId: 'chatX', characterId: null }),
    sendToBackend: (payload: unknown) => {
      const p = payload as { type?: string; requestId?: string; url?: string };
      if (p.type !== 'fetch_external' || !p.requestId || !p.url) return;
      const url = p.url;
      const requestId = p.requestId;
      fetchCount.set(url, (fetchCount.get(url) ?? 0) + 1);
      queueMicrotask(() => {
        if (errors.has(url)) {
          for (const l of listeners) {
            l({ type: 'fetch_external_response', requestId, ok: false, error: errors.get(url) });
          }
          return;
        }
        for (const l of listeners) {
          l({ type: 'fetch_external_response', requestId, ok: true, body: responses.get(url) ?? '' });
        }
      });
    },
    onBackendMessage: (cb: (p: unknown) => void) => {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
  } as unknown as SpindleFrontendContext;

  return { ctx, responses, errors, fetchCount };
}

const VUE = 'https://unpkg.com/vue@3/dist/vue.global.js';
const REACT = 'https://unpkg.com/react@18/umd/react.production.min.js';
const REACT_DOM = 'https://unpkg.com/react-dom@18/umd/react-dom.production.min.js';
const BABEL = 'https://unpkg.com/@babel/standalone/babel.min.js';
const JSDELIVR = 'https://cdn.jsdelivr.net/npm/lodash@4/lodash.min.js';
const CDNJS = 'https://cdnjs.cloudflare.com/ajax/libs/d3/7.8.5/d3.min.js';

beforeEach(() => {
  __resetBundleCacheForTests();
});

// isCdnScriptUrl ─────────────────────────────────────────────────────────────

test('isCdnScriptUrl accepts known CDN hosts', () => {
  expect(isCdnScriptUrl(VUE)).toBe(true);
  expect(isCdnScriptUrl(JSDELIVR)).toBe(true);
  expect(isCdnScriptUrl(CDNJS)).toBe(true);
  expect(isCdnScriptUrl('https://esm.sh/preact')).toBe(true);
});

test('isCdnScriptUrl rejects dedicated-path hosts and decoys', () => {
  expect(isCdnScriptUrl('https://cdn.tailwindcss.com')).toBe(false); // Tailwind own path
  expect(isCdnScriptUrl('https://code.jquery.com/jquery-3.6.0.min.js')).toBe(false); // vendored path
  expect(isCdnScriptUrl('https://unpkg.com.evil.com/x.js')).toBe(false); // decoy host
  expect(isCdnScriptUrl('/local.js')).toBe(false); // not a URL
});

// extractCdnScriptUrls ───────────────────────────────────────────────────────

test('extractCdnScriptUrls returns [] when no script tags present', () => {
  expect(extractCdnScriptUrls('<div>hi</div>')).toEqual([]);
});

test('extractCdnScriptUrls picks up a single CDN script', () => {
  expect(extractCdnScriptUrls(`<script src="${VUE}"></script>`)).toEqual([VUE]);
});

test('extractCdnScriptUrls preserves document order and dedupes', () => {
  const html = `<script src="${REACT}"></script><script src="${REACT_DOM}"></script><script src="${REACT}"></script>`;
  expect(extractCdnScriptUrls(html)).toEqual([REACT, REACT_DOM]);
});

test('extractCdnScriptUrls ignores same-origin/relative and non-CDN scripts', () => {
  const html = `<script src="/local.js"></script><script src="./rel.js"></script><script src="https://cdn.tailwindcss.com"></script><script>inline()</script>`;
  expect(extractCdnScriptUrls(html)).toEqual([]);
});

// transformHtmlForCdnScripts: positive ──────────────────────────────────────

test('inlines a Vue global build as <script> with the bundle body', async () => {
  const { ctx, responses } = makeFakeBackend();
  responses.set(VUE, 'window.Vue={};');
  const out = await transformHtmlForCdnScripts(`<div id="app"></div><script src="${VUE}"></script>`, ctx);
  expect(out).toContain('<script>window.Vue={};</script>');
  expect(out).not.toContain(`src="${VUE}"`);
  expect(out).toContain('<div id="app"></div>'); // surrounding HTML preserved
});

test('inlines a jsdelivr bundle', async () => {
  const { ctx, responses } = makeFakeBackend();
  responses.set(JSDELIVR, '/*lodash*/');
  const out = await transformHtmlForCdnScripts(`<script src="${JSDELIVR}"></script>`, ctx);
  expect(out).toBe('<script>/*lodash*/</script>');
});

test('inlines a cdnjs bundle', async () => {
  const { ctx, responses } = makeFakeBackend();
  responses.set(CDNJS, '/*d3*/');
  const out = await transformHtmlForCdnScripts(`<script src="${CDNJS}"></script>`, ctx);
  expect(out).toBe('<script>/*d3*/</script>');
});

test('inlines a bundle containing the literal </script> with proper escape', async () => {
  const { ctx, responses } = makeFakeBackend();
  const url = 'https://unpkg.com/fake@1/dist/lib.js';
  const bundle = `var lib = { close: '</script>', tag: '</SCRIPT>' };`;
  responses.set(url, bundle);
  const result = await transformHtmlForCdnScripts(
    `<html><script src="${url}"></script></html>`,
    ctx,
  );
  // A raw </script> inside the body would close the wrapper here; must be gone.
  expect(result).not.toMatch(/<\/script>\s*var lib/);
  // Escaped form present (both casings escaped).
  expect(result).toContain('<\\/script');
  expect(result).not.toContain("'</script>'");
  // Wrapping <script>...</script> stays balanced.
  const openCount = (result.match(/<script(?:\s[^>]*)?>/gi) ?? []).length;
  const closeCount = (result.match(/<\/script>/gi) ?? []).length;
  expect(openCount).toBe(closeCount);
});

test('escapes <!-- so a body with an HTML tokenizer cannot break out of the wrap', async () => {
  // Real shape from Vue's bundle: a lone `<!--` (no matching `-->`) followed by
  // `<script` literals. Unescaped, the HTML parser enters script-data-escaped
  // then double-escaped state and the wrapping </script> stops closing.
  const { ctx, responses } = makeFakeBackend();
  const url = 'https://unpkg.com/fake@2/dist/lib.js';
  const bundle = `var msgs = { a: "Unexpected '<!--' here", b: "(<script> and <style>)" };`;
  responses.set(url, bundle);
  const result = await transformHtmlForCdnScripts(`<head><script src="${url}"></script></head>`, ctx);
  // The escaped-state entry must be neutralized.
  expect(result).toContain('<\\!--');
  expect(result).not.toContain('<!--');
  // One inline <script> wrap, cleanly closed.
  expect((result.match(/<\/script>/gi) ?? []).length).toBe(1);
  // `<\!--` is identical to `<!--` inside the JS string literal: semantics hold.
  const inlinedBody = result.match(/<script>([\s\S]*)<\/script>/)![1];
  const msgs = new Function(`${inlinedBody}; return msgs;`)();
  expect(msgs.a).toBe("Unexpected '<!--' here");
});

test('preserves type="module" when inlining a module script', async () => {
  const { ctx, responses } = makeFakeBackend();
  const url = 'https://cdn.jsdelivr.net/npm/emoji-picker-element@1/index.js';
  responses.set(url, 'export const x=1;');
  const out = await transformHtmlForCdnScripts(`<script type="module" src="${url}"></script>`, ctx);
  expect(out).toBe('<script type="module">export const x=1;</script>');
});

// transformHtmlForCdnScripts: React/Babel regression ─────────────────────────

test('inlines React, ReactDOM and Babel in authoring order, position preserved', async () => {
  const { ctx, responses } = makeFakeBackend();
  responses.set(REACT, 'REACT');
  responses.set(REACT_DOM, 'REACTDOM');
  responses.set(BABEL, 'BABEL');
  const html =
    `<head><script src="${REACT}"></script><script src="${REACT_DOM}"></script>` +
    `<script src="${BABEL}"></script></head>` +
    `<body><script type="text/babel">render()</script></body>`;
  const out = await transformHtmlForCdnScripts(html, ctx);
  // Each external tag replaced in place, in order.
  expect(out).toBe(
    '<head><script>REACT</script><script>REACTDOM</script><script>BABEL</script></head>' +
      '<body><script type="text/babel">render()</script></body>',
  );
  // text/babel script (no src) left untouched for Babel's on-load scanner.
  expect(out).toContain('<script type="text/babel">render()</script>');
});

test('the same URL across renders is fetched once (cache)', async () => {
  const { ctx, responses, fetchCount } = makeFakeBackend();
  responses.set(VUE, 'V');
  await transformHtmlForCdnScripts(`<script src="${VUE}"></script>`, ctx);
  await transformHtmlForCdnScripts(`<script src="${VUE}"></script>`, ctx);
  expect(fetchCount.get(VUE)).toBe(1);
});

// transformHtmlForCdnScripts: negative / edge ───────────────────────────────

test('does not touch same-origin/relative scripts', async () => {
  const { ctx } = makeFakeBackend();
  const html = '<script src="/local.js"></script><script src="./rel.js"></script>';
  expect(await transformHtmlForCdnScripts(html, ctx)).toBe(html);
});

test('does not touch inline scripts with no src', async () => {
  const { ctx } = makeFakeBackend();
  const html = '<script>console.log(1)</script>';
  expect(await transformHtmlForCdnScripts(html, ctx)).toBe(html);
});

test('leaves the original tag in place when the fetch fails (silent fallback)', async () => {
  const { ctx, errors } = makeFakeBackend();
  errors.set(VUE, '404');
  const html = `<script src="${VUE}"></script>`;
  expect(await transformHtmlForCdnScripts(html, ctx)).toBe(html);
});

test('mixed success/failure: inlines the ok one, leaves the failed tag', async () => {
  const { ctx, responses, errors } = makeFakeBackend();
  responses.set(REACT, 'REACT');
  errors.set(BABEL, '500');
  const html = `<script src="${REACT}"></script><script src="${BABEL}"></script>`;
  const out = await transformHtmlForCdnScripts(html, ctx);
  expect(out).toBe(`<script>REACT</script><script src="${BABEL}"></script>`);
});
