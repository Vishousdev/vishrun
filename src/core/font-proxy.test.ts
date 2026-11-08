import { test, expect, beforeEach } from 'bun:test';
import { __resetFontCacheForTests, parseFontFaces, transformHtmlForStylesheets } from './font-proxy';

beforeEach(() => __resetFontCacheForTests());

function fakeFetch(files: Record<string, string>) {
  const count: Record<string, number> = {};
  const fetchText = async (url: string) => {
    count[url] = (count[url] ?? 0) + 1;
    if (!(url in files)) throw new Error('404 ' + url);
    return files[url];
  };
  return { fetchText, count };
}

const fontsIn = (html: string) =>
  [...html.matchAll(/<script type="application\/vishrun-font-config" data-vishrun-fonts>([\s\S]*?)<\/script>/g)]
    .flatMap((m) => JSON.parse(m[1]));

const GOOGLE = `
@font-face {
  font-family: 'Cinzel';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/cinzel/v23/cinzel-400.woff2) format('woff2');
  unicode-range: U+0000-00FF, U+0131;
}`;

test('@font-face rules become entries with every descriptor', () => {
  expect(parseFontFaces(GOOGLE, 'https://fonts.googleapis.com/css2')).toEqual([{
    family: 'Cinzel',
    url: 'https://fonts.gstatic.com/s/cinzel/v23/cinzel-400.woff2',
    weight: '400',
    style: 'normal',
    display: 'swap',
    range: 'U+0000-00FF, U+0131',
  }]);
});

test('relative sources resolve against the sheet, woff2 preferred', () => {
  const css = `@font-face{font-family:"FA";src:url(../webfonts/fa.ttf) format("truetype"),url(../webfonts/fa.woff2) format("woff2");font-weight:900}`;
  expect(parseFontFaces(css, 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css')[0].url)
    .toBe('https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/webfonts/fa.woff2');
});

test('a <link> stylesheet is inlined with its fonts, any host', async () => {
  const { fetchText } = fakeFetch({
    'https://cdnjs.cloudflare.com/fa/css/all.css': `.fa-user:before{content:"\\f007"}@font-face{font-family:'FA';src:url(../webfonts/fa.woff2)}.bg{background:url(img/x.png)}`,
  });
  const html = '<head><link rel="stylesheet" href="https://cdnjs.cloudflare.com/fa/css/all.css"></head><i class="fa-user"></i>';
  const out = await transformHtmlForStylesheets(html, fetchText);
  expect(out).not.toContain('<link');
  expect(out).toContain('.fa-user:before{content:"\\f007"}');
  expect(out).toContain('url(https://cdnjs.cloudflare.com/fa/css/img/x.png)');
  expect(out).not.toContain('@font-face');
  expect(fontsIn(out)).toEqual([{ family: 'FA', url: 'https://cdnjs.cloudflare.com/fa/webfonts/fa.woff2' }]);
});

test('nested relative @imports are followed (jsdelivr style.css)', async () => {
  const base = 'https://cdn.jsdelivr.net/npm/lxgw-wenkai-webfont/';
  const { fetchText } = fakeFetch({
    [base + 'style.css']: `@import url('./lxgwwenkai-regular.css');\n@import url('./lxgwwenkai-bold.css');`,
    [base + 'lxgwwenkai-regular.css']: `@font-face{font-family:'LXGW WenKai';font-weight:400;src:url('./files/r-4.woff2') format('woff2');unicode-range:U+4F60}`,
    [base + 'lxgwwenkai-bold.css']: `@font-face{font-family:'LXGW WenKai';font-weight:700;src:url('./files/b-4.woff2') format('woff2');unicode-range:U+4F60}`,
  });
  const html = `<style>@import url('${base}style.css');\n.t{font-family:'LXGW WenKai'}</style>`;
  const out = await transformHtmlForStylesheets(html, fetchText);
  expect(out).toContain(".t{font-family:'LXGW WenKai'}");
  expect(out).not.toContain('@import');
  expect(fontsIn(out).map((f: { url: string }) => f.url)).toEqual([base + 'files/r-4.woff2', base + 'files/b-4.woff2']);
  expect(out.indexOf('data-vishrun-fonts')).toBeLessThan(out.indexOf('<style>'));
});

test('sheets are cached; failures keep the original and retry later', async () => {
  const files: Record<string, string> = {};
  const { fetchText, count } = fakeFetch(files);
  const url = 'https://fonts.googleapis.com/css2?family=Cinzel';
  const html = `<link href="${url.replace('&', '&amp;')}" rel="stylesheet">`;
  expect(await transformHtmlForStylesheets(html, fetchText)).toBe(html);
  files[url] = GOOGLE;
  const out = await transformHtmlForStylesheets(html, fetchText);
  expect(fontsIn(out)).toHaveLength(1);
  await transformHtmlForStylesheets(html, fetchText);
  expect(count[url]).toBe(2);
});

test('non-stylesheet links and relative URLs are left alone', async () => {
  const { fetchText, count } = fakeFetch({});
  const html = '<link rel="icon" href="https://x/y.png"><link rel="stylesheet" href="local.css"><style>@import "theme.css";</style>';
  expect(await transformHtmlForStylesheets(html, fetchText)).toBe(html);
  expect(Object.keys(count)).toEqual([]);
});

test('fetched CSS cannot close the style block or the font script', async () => {
  const { fetchText } = fakeFetch({ 'https://evil/x.css': `a{}</style><script>alert(1)</script>@font-face{font-family:'</script>';src:url(https://e/f.woff2)}` });
  const out = await transformHtmlForStylesheets('<link rel="stylesheet" href="https://evil/x.css">', fetchText);
  const doc = new DOMParser().parseFromString(out, 'text/html');
  expect([...doc.querySelectorAll('script')].map((s) => s.getAttribute('type'))).toEqual(['application/vishrun-font-config']);
  expect(doc.querySelectorAll('style')).toHaveLength(1);
  expect(JSON.parse(doc.querySelector('script')!.textContent!)[0].family).toBe('</script>');
});
