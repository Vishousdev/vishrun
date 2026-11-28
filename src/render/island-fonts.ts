import { parseFontFaces } from '../core/font-proxy';
import { deepQuerySelectorAll } from './shadow-dom';

// Lumiverse renders some messages in shadow-DOM islands, where browsers ignore
// @font-face. SillyTavern renders the same CSS in the page, so register those
// fonts on the page, where shadow trees can use them. The browser loads each
// one when text first needs it.

const seen = new WeakMap<Element, string>();
const added = new Set<string>();

export function registerIslandFonts(root: ParentNode, fonts: FontFaceSet | undefined = document.fonts): void {
  if (!fonts || typeof FontFace === 'undefined') return;
  for (const style of deepQuerySelectorAll(root, 'style')) {
    const css = style.textContent ?? '';
    if (!css.includes('@font-face') || seen.get(style) === css) continue;
    if (!(style.getRootNode() instanceof ShadowRoot)) continue;
    seen.set(style, css);
    for (const f of parseFontFaces(css, 'about:blank', false)) {
      const key = [f.family, f.url, f.weight, f.style, f.range].join('\u0000');
      if (added.has(key)) continue;
      added.add(key);
      try {
        fonts.add(new FontFace(f.family, `url("${f.url}")`, {
          ...(f.weight ? { weight: f.weight } : {}),
          ...(f.style ? { style: f.style } : {}),
          ...(f.display ? { display: f.display as FontDisplay } : {}),
          ...(f.range ? { unicodeRange: f.range } : {}),
        }));
      } catch {
        // Invalid descriptors: the browser would skip this rule too.
      }
    }
  }
}
