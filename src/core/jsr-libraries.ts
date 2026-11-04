// JS-Slash-Runner frames provide some libraries as globals, so widgets built
// for it can use `Vue` without loading it. When a widget does that, add the
// usual CDN tag; the external-script step then serves Vishrun's bundled copy.

const USES_VUE = /(?<![\w$.'"`-])Vue(?![\w$'"`-])/;
const LOADS_VUE = /vue(?:@[^/'"]*)?\/dist\/vue\.global|vue\.global(?:\.prod)?(?:\.min)?\.js/i;
const VUE_TAG = '<script src="https://unpkg.com/vue@3/dist/vue.global.prod.js"></script>';

export function withJsrGlobalLibraries(html: string): string {
  if (!USES_VUE.test(html) || LOADS_VUE.test(html)) return html;
  const head = /<head\b[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + VUE_TAG + html.slice(head.index + head[0].length);
  return VUE_TAG + html;
}
