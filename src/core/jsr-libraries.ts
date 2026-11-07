// JS-Slash-Runner frames provide Vue and VueRouter as globals, so widgets built
// for it can use them without loading them. When a widget does that, add the
// usual CDN tags; the external-script step then serves Vishrun's bundled copies.

const USES_VUE = /(?<![\w$.'"`-])Vue(?![\w$'"`-])/;
const LOADS_VUE = /vue(?:@[^/'"]*)?\/dist\/vue\.global|vue\.global(?:\.prod)?(?:\.min)?\.js/i;
const VUE_TAG = '<script src="https://unpkg.com/vue@3/dist/vue.global.prod.js"></script>';

const USES_ROUTER = /(?<![\w$.'"`-])VueRouter(?![\w$'"`-])/;
const LOADS_ROUTER = /vue-router\.global(?:\.prod)?(?:\.min)?\.js/i;
const ROUTER_TAG = '<script src="https://unpkg.com/vue-router@4/dist/vue-router.global.prod.js"></script>';

export function withJsrGlobalLibraries(html: string): string {
  const router = USES_ROUTER.test(html) && !LOADS_ROUTER.test(html);
  // VueRouter needs the Vue global.
  const vue = (USES_VUE.test(html) || router) && !LOADS_VUE.test(html);
  const tags = (vue ? VUE_TAG : '') + (router ? ROUTER_TAG : '');
  if (!tags) return html;
  const head = /<head\b[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + tags + html.slice(head.index + head[0].length);
  return tags + html;
}
