import type { SpindleFrontendContext } from 'lumiverse-spindle-types';
import { fetchViaBackend } from './asset-injector';

// External stylesheets in widgets (`<link rel="stylesheet">`, `@import`): the
// frame CSP allows inline styles only, so the backend fetches the CSS, nested
// imports and relative URLs are resolved, plain rules are inlined, and each
// @font-face becomes an entry the frame loads through the font proxy when its
// text needs it.

export interface VishrunFontEntry {
  family: string;
  url: string;
  weight?: string;
  style?: string;
  display?: string;
  range?: string;
}

export interface FetchedSheet {
  css: string;
  fonts: VishrunFontEntry[];
}

const MAX_DEPTH = 3;
const LINK_RE = /<link\b[^>]*>/gi;
const STYLE_BLOCK_RE = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
const IMPORT_RE = /@import\s+(?:url\(\s*(['"]?)([^'")]+)\1\s*\)|(['"])([^'"]+)\3)[^;]*;?/gi;
const FONT_FACE_RE = /@font-face\s*\{([^}]*)\}/gi;
const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;

const attr = (tag: string, name: string) =>
  new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)?.slice(1).find((v) => v !== undefined);

const decodeEntities = (s: string) =>
  s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

function absolute(url: string, base: string): string | null {
  if (/^(?:data|blob):/i.test(url)) return url;
  try {
    const u = new URL(url, base);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

const descriptor = (body: string, name: string) =>
  new RegExp(`(?:^|;|\\s)${name}\\s*:\\s*([^;]+)`, 'i').exec(body)?.[1].trim();

// woff2 first, then any other format the browser accepts.
function fontSource(src: string, base: string): string | null {
  const urls: Array<{ url: string; woff2: boolean }> = [];
  for (const part of src.split(/,(?![^()]*\))/)) {
    const m = /url\(\s*(['"]?)([^'")]+)\1\s*\)/i.exec(part);
    if (!m) continue;
    const url = absolute(m[2].trim(), base);
    if (url) urls.push({ url, woff2: /woff2/i.test(part) });
  }
  return (urls.find((u) => u.woff2) ?? urls[0])?.url ?? null;
}

export function parseFontFaces(css: string, base: string): VishrunFontEntry[] {
  const out: VishrunFontEntry[] = [];
  for (const m of css.matchAll(FONT_FACE_RE)) {
    const body = m[1];
    const family = descriptor(body, 'font-family')?.replace(/^['"]|['"]$/g, '').trim();
    const src = descriptor(body, 'src');
    const url = src ? fontSource(src, base) : null;
    if (!family || !url || !/^https?:/i.test(url)) continue;
    const entry: VishrunFontEntry = { family, url };
    const weight = descriptor(body, 'font-weight');
    const style = descriptor(body, 'font-style');
    const display = descriptor(body, 'font-display');
    const range = descriptor(body, 'unicode-range');
    if (weight) entry.weight = weight;
    if (style) entry.style = style;
    if (display) entry.display = display;
    if (range) entry.range = range;
    out.push(entry);
  }
  return out;
}

// Plain rules with absolute url()s, so later steps can proxy their images.
function plainRules(css: string, base: string): string {
  return css
    .replace(FONT_FACE_RE, '')
    .replace(IMPORT_RE, '')
    .replace(CSS_URL_RE, (all, q: string, u: string) => {
      const abs = absolute(u.trim(), base);
      return abs ? `url(${q}${abs}${q})` : all;
    })
    .replace(/<\/style/gi, '<\\/style');
}

type TextFetch = (url: string) => Promise<string>;

const sheetCache = new Map<string, Promise<FetchedSheet>>();

export function fetchSheet(url: string, fetchText: TextFetch, depth = 0): Promise<FetchedSheet> {
  const cached = sheetCache.get(url);
  if (cached) return cached;
  const pending = (async (): Promise<FetchedSheet> => {
    const css = await fetchText(url);
    const children = depth < MAX_DEPTH
      ? [...css.matchAll(IMPORT_RE)].map((m) => absolute((m[2] ?? m[4]).trim(), url)).filter((u): u is string => !!u)
      : [];
    // Fetched together, kept in import order.
    const parts = await Promise.all(children.map((c) => fetchSheet(c, fetchText, depth + 1).catch(() => ({ css: '', fonts: [] }))));
    return {
      css: parts.map((p) => p.css).join('\n') + plainRules(css, url),
      fonts: parts.flatMap((p) => p.fonts).concat(parseFontFaces(css, url)),
    };
  })();
  sheetCache.set(url, pending);
  pending.catch(() => {
    if (sheetCache.get(url) === pending) sheetCache.delete(url);
  });
  return pending;
}

const htmlSafeJson = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');

const fontScript = (fonts: VishrunFontEntry[]) =>
  fonts.length ? `<script type="application/vishrun-font-config" data-vishrun-fonts>${htmlSafeJson(fonts)}</script>` : '';

const inlined = (sheet: FetchedSheet) =>
  fontScript(sheet.fonts) + (sheet.css.trim() ? `<style>${sheet.css}</style>` : '');

// Widgets have no base URL, so only absolute http(s) sheets can be fetched.
const external = (u: string) => (/^https?:\/\//i.test(u) ? u : null);

const isStylesheetLink = (tag: string) => /\bstylesheet\b/i.test(attr(tag, 'rel') ?? '');

export async function transformHtmlForStylesheets(html: string, fetchText: TextFetch): Promise<string> {
  if (!/<link\b|@import/i.test(html)) return html;
  const load = (url: string) =>
    fetchSheet(url, fetchText).catch((err) => {
      console.warn('[vishrun] stylesheet fetch failed:', url, err instanceof Error ? err.message : String(err));
      return null;
    });

  let out = html;
  for (const tag of new Set(html.match(LINK_RE) ?? [])) {
    if (!isStylesheetLink(tag)) continue;
    const href = attr(tag, 'href');
    const url = href ? external(decodeEntities(href.trim())) : null;
    if (!url) continue;
    const sheet = await load(url);
    if (sheet) out = out.split(tag).join(inlined(sheet));
  }

  const blocks = [...out.matchAll(STYLE_BLOCK_RE)].filter((m) => m[1].includes('@import'));
  for (const block of new Set(blocks.map((m) => m[0]))) {
    let changed = block;
    const fonts: string[] = [];
    for (const m of block.matchAll(IMPORT_RE)) {
      const url = external((m[2] ?? m[4]).trim());
      if (!url) continue;
      const sheet = await load(url);
      if (!sheet) continue;
      // Rules replace the import in place; fonts go before the block.
      changed = changed.split(m[0]).join(sheet.css);
      fonts.push(fontScript(sheet.fonts));
    }
    if (changed !== block) out = out.split(block).join(fonts.join('') + changed);
  }
  return out;
}

export function transformHtmlForExternalStylesheets(html: string, ctx: SpindleFrontendContext): Promise<string> {
  return transformHtmlForStylesheets(html, (url) => fetchViaBackend(url, ctx));
}

// Test-only.
export function __resetFontCacheForTests(): void {
  sheetCache.clear();
}
