// Measurement helpers for the size reporter shell. The shell is a string
// injected into the iframe srcdoc; the helpers below are also tested directly
// against synthetic ChildMetrics because happy-dom's getBoundingClientRect
// returns zeros (no layout engine).

export interface ChildMetrics {
  /** child.getBoundingClientRect().bottom + window.scrollY. */
  documentRelativeBottom: number;
  /** parseFloat(getComputedStyle(child).marginBottom) || 0. */
  marginBottom: number;
  /** Downward extension of the child's first box-shadow (0 if none/inward). */
  shadowDown: number;
}

const BOX_SHADOW_OFFSET_RE = /-?\d+px\s+(-?\d+)px\s+(-?\d+)px(?:\s+(-?\d+)px)?/;

/** Extract the downward extent of a CSS box-shadow value. Returns 0 for
 *  none, malformed, upward-only, or unparseable input. First-shadow-only on
 *  multi-shadow values (acceptable approximation for the cards in scope). */
export function parseBoxShadowDownExtent(boxShadow: string | null | undefined): number {
  if (!boxShadow || boxShadow === 'none') return 0;
  const m = boxShadow.match(BOX_SHADOW_OFFSET_RE);
  if (!m) return 0;
  const y = parseFloat(m[1]) || 0;
  if (y <= 0) return 0;
  const blur = parseFloat(m[2]) || 0;
  const spread = parseFloat(m[3] || '0') || 0;
  return y + blur + spread;
}

/** Final reported height from per-child metrics, falling back to scrollHeight.
 *  Adds a 4px sub-pixel safety. */
export function computeContentHeight(
  children: readonly ChildMetrics[],
  bodyScrollHeight: number,
): number {
  let maxBottom = 0;
  for (const c of children) {
    const bottom = c.documentRelativeBottom + c.marginBottom + c.shadowDown;
    if (bottom > maxBottom) maxBottom = bottom;
  }
  if (bodyScrollHeight > maxBottom) maxBottom = bodyScrollHeight;
  return Math.ceil(maxBottom) + 4;
}

/** True iff the last three measurement-to-measurement deltas are all equal
 *  and non-zero (the runaway-growth signature of a viewport-relative unit
 *  feeding back through the iframe resize). */
export function detectGrowthLoop(history: readonly number[]): boolean {
  if (history.length < 4) return false;
  const n = history.length;
  const d1 = history[n - 3] - history[n - 4];
  const d2 = history[n - 2] - history[n - 3];
  const d3 = history[n - 1] - history[n - 2];
  if (d1 === 0) return false;
  return d1 === d2 && d2 === d3;
}

/** Injected IIFE that mirrors the pure helpers above. */
export function buildSizeReporterShell(): string {
  return `
<script>
(function() {
  var history = [];
  var pinned = false;
  function postSize() {
    if (pinned) return;
    try {
      if (!document.body) return;
      var maxBottom = 0;
      var children = document.body.children;
      for (var i = 0; i < children.length; i++) {
        var child = children[i];
        var rect = child.getBoundingClientRect();
        var cs = getComputedStyle(child);
        var marginBottom = parseFloat(cs.marginBottom) || 0;
        var shadowDown = 0;
        var boxShadow = cs.boxShadow;
        if (boxShadow && boxShadow !== 'none') {
          var sm = boxShadow.match(/-?\\d+px\\s+(-?\\d+)px\\s+(-?\\d+)px(?:\\s+(-?\\d+)px)?/);
          if (sm) {
            var y = parseFloat(sm[1]) || 0;
            if (y > 0) {
              var blur = parseFloat(sm[2]) || 0;
              var spread = parseFloat(sm[3] || '0') || 0;
              shadowDown = y + blur + spread;
            }
          }
        }
        var bottom = rect.bottom + window.scrollY + marginBottom + shadowDown;
        if (bottom > maxBottom) maxBottom = bottom;
      }
      if (document.body.scrollHeight > maxBottom) maxBottom = document.body.scrollHeight;
      var h = Math.ceil(maxBottom) + 4;

      history.push(h);
      if (history.length > 4) history.shift();
      if (history.length === 4) {
        var dd1 = history[1] - history[0];
        var dd2 = history[2] - history[1];
        var dd3 = history[3] - history[2];
        if (dd1 !== 0 && dd1 === dd2 && dd2 === dd3) {
          pinned = true;
          return;
        }
      }

      if (window.spindleSandbox && typeof window.spindleSandbox.requestResize === 'function') {
        window.spindleSandbox.requestResize(h);
      }
    } catch (e) {}
  }
  function init() {
    postSize();
    if (typeof ResizeObserver !== 'undefined' && document.body) {
      try {
        var ro = new ResizeObserver(postSize);
        ro.observe(document.body);
      } catch (e) {}
    }
    window.addEventListener('load', postSize);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
</script>`;
}
