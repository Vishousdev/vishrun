import { afterAll, beforeAll, expect, test } from 'bun:test';
import { registerIslandFonts } from './island-fonts';

const g = globalThis as { FontFace?: unknown };
const saved = g.FontFace;
class FakeFace { constructor(public family: string, public source: string, public desc: Record<string, string>) {} }
beforeAll(() => { g.FontFace = FakeFace; });
afterAll(() => { g.FontFace = saved; });

function island(css: string): HTMLElement {
  const row = document.createElement('div');
  const host = document.createElement('div');
  row.appendChild(host);
  host.attachShadow({ mode: 'open' }).innerHTML = `<style>${css}</style><p>x</p>`;
  return row;
}

test('island @font-face rules are registered on the page once', () => {
  const added: FakeFace[] = [];
  const fonts = { add: (f: FakeFace) => added.push(f) } as unknown as FontFaceSet;
  const css = `@font-face { font-family: 'Ye'; src: url('https://cdn.example/ye.ttf'); font-weight: 700; }
    @font-face { font-family: 'D'; src: url(data:font/woff2;base64,AA); }`;
  registerIslandFonts(island(css), fonts);
  registerIslandFonts(island(css), fonts);
  expect(added.map((f) => [f.family, f.source, f.desc.weight ?? ''])).toEqual([
    ['Ye', 'url("https://cdn.example/ye.ttf")', '700'],
    ['D', 'url("data:font/woff2;base64,AA")', ''],
  ]);
});

test('styles outside shadow roots are left to the page', () => {
  const added: unknown[] = [];
  const fonts = { add: (f: unknown) => added.push(f) } as unknown as FontFaceSet;
  const row = document.createElement('div');
  row.innerHTML = `<style>@font-face { font-family: 'P'; src: url('https://cdn.example/p.ttf'); }</style>`;
  registerIslandFonts(row, fonts);
  expect(added.length).toBe(0);
});
