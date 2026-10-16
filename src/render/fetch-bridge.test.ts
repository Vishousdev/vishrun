import { test, expect } from 'bun:test';
import { fetchBridgeShim } from './fetch-bridge';

test('external fetch goes over the frame channel and resolves to a Response; relative URLs stay native', async () => {
  const w = window as any;
  const savedFetch = w.fetch;
  w.fetch = async () => new Response('native');
  let listener: ((m: unknown) => void) | null = null;
  const sent: any[] = [];
  w.spindleSandbox = {
    onMessage(fn: (m: unknown) => void) { listener = fn; },
    postMessage(m: any) {
      sent.push(m);
      setTimeout(() => listener!({ kind: 'widget-fetch-response', requestId: m.requestId, ok: true, status: 200, headers: { 'content-type': 'application/json' }, body: '[{"id":1}]' }), 0);
    },
  };
  new Function(fetchBridgeShim().replace(/^<script>/, '').replace(/<\/script>$/, ''))();
  const r = await w.fetch('https://api.test/x?q=1');
  expect(await r.json()).toEqual([{ id: 1 }]);
  expect(sent[0].url).toBe('https://api.test/x?q=1');
  expect(sent[0].method).toBe('GET');
  expect(await (await w.fetch('/local')).text()).toBe('native');
  w.fetch = savedFetch;
  delete w.spindleSandbox;
});
