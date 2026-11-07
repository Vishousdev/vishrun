import { test, expect } from 'bun:test';
import { fontBlobUrl, fontLoaderShim, isFontRequest } from './font-cache';

test('each font URL is fetched once and shared', async () => {
  let calls = 0;
  const fetchFont = async () => { calls++; return { body: btoa('wOF2xxxx'), contentType: 'font/woff2' }; };
  const ctx = {} as never;
  const [a, b] = await Promise.all([fontBlobUrl('https://x/f.woff2', ctx, fetchFont), fontBlobUrl('https://x/f.woff2', ctx, fetchFont)]);
  expect(a).toBe(b);
  expect(a.startsWith('blob:')).toBe(true);
  expect(calls).toBe(1);
});

test('a failed fetch can be retried', async () => {
  let calls = 0;
  const fetchFont = async () => { calls++; if (calls === 1) throw new Error('down'); return { body: btoa('x'), contentType: 'font/ttf' }; };
  await expect(fontBlobUrl('https://x/retry.ttf', {} as never, fetchFont)).rejects.toThrow('down');
  expect((await fontBlobUrl('https://x/retry.ttf', {} as never, fetchFont)).startsWith('blob:')).toBe(true);
});

test('only http(s) font requests are answered', () => {
  expect(isFontRequest({ kind: 'font-request', requestId: '1', url: 'https://a/b.woff2' })).toBe(true);
  expect(isFontRequest({ kind: 'font-request', requestId: '1', url: 'file:///etc/passwd' })).toBe(false);
});

test('the frame loader carries the slice chooser', () => {
  expect(fontLoaderShim()).toContain('unicodeRange');
  expect(() => new Function(fontLoaderShim().replace(/^<script>|<\/script>$/g, ''))).not.toThrow();
});
