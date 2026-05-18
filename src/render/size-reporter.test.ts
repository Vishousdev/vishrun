import { test, expect } from 'bun:test';
import {
  computeContentHeight,
  detectGrowthLoop,
  parseBoxShadowDownExtent,
  buildSizeReporterShell,
} from './size-reporter';
import type { ChildMetrics } from './size-reporter';

function child(
  documentRelativeBottom: number,
  marginBottom = 0,
  shadowDown = 0,
): ChildMetrics {
  return { documentRelativeBottom, marginBottom, shadowDown };
}

// ── parseBoxShadowDownExtent ─────────────────────────────────────────

test('parseBoxShadowDownExtent: none/empty/null → 0', () => {
  expect(parseBoxShadowDownExtent('none')).toBe(0);
  expect(parseBoxShadowDownExtent('')).toBe(0);
  expect(parseBoxShadowDownExtent(null)).toBe(0);
  expect(parseBoxShadowDownExtent(undefined)).toBe(0);
});

test('parseBoxShadowDownExtent: 4-arg (offsetX offsetY blur spread) sums y+blur+spread', () => {
  // getComputedStyle prefixes a color: matches start mid-string.
  expect(parseBoxShadowDownExtent('rgb(0, 0, 0) 0px 8px 16px 2px')).toBe(8 + 16 + 2);
});

test('parseBoxShadowDownExtent: 3-arg (no spread) sums y+blur, spread defaults to 0', () => {
  expect(parseBoxShadowDownExtent('rgb(0, 0, 0) 0px 5px 10px')).toBe(5 + 10);
});

test('parseBoxShadowDownExtent: upward (negative y) → 0, never extends top', () => {
  expect(parseBoxShadowDownExtent('rgb(0, 0, 0) 0px -8px 16px 2px')).toBe(0);
});

test('parseBoxShadowDownExtent: zero y → 0 (no downward extent without offset)', () => {
  expect(parseBoxShadowDownExtent('rgb(0, 0, 0) 0px 0px 10px 2px')).toBe(0);
});

test('parseBoxShadowDownExtent: multi-shadow list, first-shadow approximation', () => {
  // Two shadows: first downward 4+8+0=12, second upward (-4). First wins.
  const v = parseBoxShadowDownExtent(
    'rgb(0, 0, 0) 0px 4px 8px 0px, rgba(255, 255, 255, 0.5) 0px -4px 6px 1px',
  );
  expect(v).toBe(4 + 8 + 0);
});

test('parseBoxShadowDownExtent: malformed input → 0, no crash, no NaN', () => {
  expect(parseBoxShadowDownExtent('inset')).toBe(0);
  expect(parseBoxShadowDownExtent('garbage value')).toBe(0);
  expect(Number.isNaN(parseBoxShadowDownExtent('NaNpx NaNpx NaNpx'))).toBe(false);
});

// ── computeContentHeight ─────────────────────────────────────────────

test('computeContentHeight: single child, no margin/shadow → ceil(bottom) + 4', () => {
  expect(computeContentHeight([child(123)], 0)).toBe(127);
});

test('computeContentHeight: single child with margin-bottom 30 includes margin', () => {
  expect(computeContentHeight([child(100, 30)], 0)).toBe(100 + 30 + 4);
});

test('computeContentHeight: single child with downward box-shadow 8+16+2 includes shadow', () => {
  expect(computeContentHeight([child(100, 0, 8 + 16 + 2)], 0)).toBe(100 + 26 + 4);
});

test('computeContentHeight: takes max across children (last child not always tallest)', () => {
  // 2nd child shorter rect but huge margin → wins.
  const cs = [child(200, 0), child(150, 100)];
  expect(computeContentHeight(cs, 0)).toBe(250 + 4);
});

test('computeContentHeight: scrollHeight wins when greater than computed maxBottom', () => {
  expect(computeContentHeight([child(100)], 500)).toBe(500 + 4);
});

test('computeContentHeight: empty children + scrollHeight 0 → 4 (sub-pixel floor)', () => {
  expect(computeContentHeight([], 0)).toBe(4);
});

test('computeContentHeight: fractional bottom is ceil()-ed before +4', () => {
  // 100.3 + 0 + 0 → ceil(100.3) = 101, + 4 = 105
  expect(computeContentHeight([child(100.3)], 0)).toBe(105);
});

test('regression: light card (small content, no margin/shadow) does NOT get +48 dead space', () => {
  // Pre-rewrite: 200 + 48 = 248. Post-rewrite: 200 + 4 = 204.
  expect(computeContentHeight([child(200)], 0)).toBe(204);
});

// ── detectGrowthLoop ─────────────────────────────────────────────────

test('detectGrowthLoop: history too short (< 4) → false', () => {
  expect(detectGrowthLoop([])).toBe(false);
  expect(detectGrowthLoop([100])).toBe(false);
  expect(detectGrowthLoop([100, 110, 120])).toBe(false);
});

test('detectGrowthLoop: three identical positive deltas → true (runaway growth)', () => {
  expect(detectGrowthLoop([100, 110, 120, 130])).toBe(true);
});

test('detectGrowthLoop: identical zero deltas → false (stable, not a loop)', () => {
  expect(detectGrowthLoop([100, 100, 100, 100])).toBe(false);
});

test('detectGrowthLoop: non-uniform deltas → false', () => {
  expect(detectGrowthLoop([100, 110, 130, 145])).toBe(false);
});

test('detectGrowthLoop: identical negative deltas (shrinkage) → true (still pathological)', () => {
  expect(detectGrowthLoop([400, 390, 380, 370])).toBe(true);
});

test('detectGrowthLoop: only checks the last 4 samples (older history ignored)', () => {
  // Older history was chaotic; recent four are uniform-delta.
  expect(detectGrowthLoop([10, 99, 7, 100, 110, 120, 130])).toBe(true);
});

// ── buildSizeReporterShell ───────────────────────────────────────────

test('buildSizeReporterShell: contract -no magic 48 anywhere', () => {
  const shell = buildSizeReporterShell();
  expect(shell.includes('+ 48')).toBe(false);
  expect(shell.includes('+= 48')).toBe(false);
});

test('buildSizeReporterShell: contract -preserves spindleSandbox.requestResize call', () => {
  const shell = buildSizeReporterShell();
  expect(shell.includes('window.spindleSandbox.requestResize')).toBe(true);
});

test('buildSizeReporterShell: contract -ResizeObserver + load listener wired identically to prior shell', () => {
  const shell = buildSizeReporterShell();
  expect(shell.includes('new ResizeObserver(postSize)')).toBe(true);
  expect(shell.includes("window.addEventListener('load', postSize)")).toBe(true);
  expect(shell.includes("document.addEventListener('DOMContentLoaded', init)")).toBe(true);
});

test('buildSizeReporterShell: contract -loop-detection pin path embedded', () => {
  const shell = buildSizeReporterShell();
  expect(shell.includes('pinned = true')).toBe(true);
});
