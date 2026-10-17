import { test, expect } from 'bun:test';
import { cssUrlProxyShim } from './css-url-proxy';

test('runtime background-image URLs are swapped for proxied blob URLs', async () => {
  const w = window as any;
  w.__vishrunProxiedImageUrl = async (u: string) => 'blob:proxied/' + u.split('/').pop();
  new Function(cssUrlProxyShim().replace(/^<script>/, '').replace(/<\/script>$/, ''))();
  const el = document.createElement('div');
  document.body.appendChild(el);
  el.style.backgroundImage = 'url("https://img.test/bg.png")';
  await new Promise((r) => setTimeout(r, 10));
  expect(el.getAttribute('style')).toContain('blob:proxied/bg.png');
  el.setAttribute('style', 'background: url(https://img.test/two.png) center');
  await new Promise((r) => setTimeout(r, 10));
  expect(el.getAttribute('style')).toContain('blob:proxied/two.png');
  el.remove();
  delete w.__vishrunProxiedImageUrl;
});
