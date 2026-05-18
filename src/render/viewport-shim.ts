// Neutralize viewport-relative heights that feedback-loop with the size
// reporter. Tailwind classes via static CSS overrides (unchanged), raw CSS
// (inline style + matched stylesheet rules) via a runtime walk on
// DOMContentLoaded and load. Pure helper exported for tests; the injected
// JS uses the same regex/threshold verbatim.

const VIEWPORT_HEIGHT_PROPS = new Set(['min-height', 'height']);
const VIEWPORT_UNIT_VALUE_RE = /^\s*(\d+(?:\.\d+)?)\s*(vh|dvh|svh|lvh)\s*$/i;

/** True iff prop is `min-height` or `height` and value is a viewport unit
 *  (vh/dvh/svh/lvh) at >= 100. Sub-viewport values and non-height props are
 *  legitimate and return false. */
export function isLoopingViewportValue(prop: string, value: string): boolean {
  if (typeof prop !== 'string' || typeof value !== 'string') return false;
  if (!VIEWPORT_HEIGHT_PROPS.has(prop.trim().toLowerCase())) return false;
  const m = value.match(VIEWPORT_UNIT_VALUE_RE);
  if (!m) return false;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) && n >= 100;
}

/** Build the head-injection text: the static class-targeted `<style>` rules
 *  (unchanged from the original Tailwind-class shim) plus the new runtime
 *  walk script for the raw-CSS case. */
export function buildViewportHeightShim(): string {
  return (
    '<style>'
    + '.min-h-screen,.min-h-\\[100vh\\],.min-h-\\[100dvh\\]{min-height:0 !important}'
    + '.h-screen,.h-\\[100vh\\],.h-\\[100dvh\\]{height:auto !important}'
    + '</style>'
    + buildRawViewportNeutralizerScript()
  );
}

/** Inline script that mirrors `isLoopingViewportValue` (same unit set, same
 *  `>= 100` threshold, same two props). The sandbox cannot import TS. */
function buildRawViewportNeutralizerScript(): string {
  return `<script>(function(){
  function isLoopVal(v) {
    if (typeof v !== 'string') return false;
    var m = v.match(/^\\s*(\\d+(?:\\.\\d+)?)\\s*(vh|dvh|svh|lvh)\\s*$/i);
    if (!m) return false;
    var n = parseFloat(m[1]);
    return isFinite(n) && n >= 100;
  }
  function neutralize(el, prop) {
    try { el.style.setProperty(prop, 'auto', 'important'); } catch (e) {}
  }
  function scanInline() {
    if (document.body) {
      if (isLoopVal(document.body.style.minHeight)) neutralize(document.body, 'min-height');
      if (isLoopVal(document.body.style.height)) neutralize(document.body, 'height');
    }
    var styled = document.querySelectorAll('[style]');
    for (var i = 0; i < styled.length; i++) {
      var el = styled[i];
      if (isLoopVal(el.style.minHeight)) neutralize(el, 'min-height');
      if (isLoopVal(el.style.height)) neutralize(el, 'height');
    }
  }
  function walkRules(rules) {
    if (!rules) return;
    for (var j = 0; j < rules.length; j++) {
      var rule = rules[j];
      if (!rule) continue;
      if (rule.cssRules && !rule.selectorText) {
        try { walkRules(rule.cssRules); } catch (e) {}
        continue;
      }
      if (!rule.style || !rule.selectorText) continue;
      var mh = rule.style.getPropertyValue('min-height');
      var h = rule.style.getPropertyValue('height');
      var hitsMin = isLoopVal(mh);
      var hitsH = isLoopVal(h);
      if (!hitsMin && !hitsH) continue;
      var matched;
      try { matched = document.querySelectorAll(rule.selectorText); } catch (e) { continue; }
      for (var k = 0; k < matched.length; k++) {
        if (hitsMin) neutralize(matched[k], 'min-height');
        if (hitsH) neutralize(matched[k], 'height');
      }
    }
  }
  function scanRules() {
    var sheets = document.styleSheets;
    for (var i = 0; i < sheets.length; i++) {
      var rules;
      try { rules = sheets[i].cssRules || sheets[i].rules; } catch (e) { continue; }
      walkRules(rules);
    }
  }
  function pass() {
    try { scanInline(); } catch (e) {}
    try { scanRules(); } catch (e) {}
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', pass, { once: true });
  } else {
    pass();
  }
  window.addEventListener('load', pass);
})();</script>`;
}
