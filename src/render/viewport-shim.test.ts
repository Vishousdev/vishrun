import { test, expect } from 'bun:test';
import { isLoopingViewportValue, buildViewportHeightShim } from './viewport-shim';

// ── isLoopingViewportValue ───────────────────────────────────────────

test('isLoopingViewportValue: min-height 100vh (with space) → true', () => {
  expect(isLoopingViewportValue('min-height', '100vh')).toBe(true);
});

test('isLoopingViewportValue: min-height 100vh (no leading/trailing space) → true', () => {
  expect(isLoopingViewportValue('min-height', '100vh')).toBe(true);
});

test('isLoopingViewportValue: height 100dvh → true', () => {
  expect(isLoopingViewportValue('height', '100dvh')).toBe(true);
});

test('isLoopingViewportValue: min-height 100svh → true', () => {
  expect(isLoopingViewportValue('min-height', '100svh')).toBe(true);
});

test('isLoopingViewportValue: min-height 100lvh → true', () => {
  expect(isLoopingViewportValue('min-height', '100lvh')).toBe(true);
});

test('isLoopingViewportValue: min-height 100.0vh → true (fractional ≥ 100)', () => {
  expect(isLoopingViewportValue('min-height', '100.0vh')).toBe(true);
});

test('isLoopingViewportValue: min-height 120vh → true (over 100)', () => {
  expect(isLoopingViewportValue('min-height', '120vh')).toBe(true);
});

test('isLoopingViewportValue: min-height 99vh → false (sub-viewport, legitimate)', () => {
  expect(isLoopingViewportValue('min-height', '99vh')).toBe(false);
});

test('isLoopingViewportValue: min-height 10vh → false', () => {
  expect(isLoopingViewportValue('min-height', '10vh')).toBe(false);
});

test('isLoopingViewportValue: min-height 99.99vh → false (just below threshold)', () => {
  expect(isLoopingViewportValue('min-height', '99.99vh')).toBe(false);
});

test('isLoopingViewportValue: min-height auto → false', () => {
  expect(isLoopingViewportValue('min-height', 'auto')).toBe(false);
});

test('isLoopingViewportValue: min-height 100px → false (non-viewport unit)', () => {
  expect(isLoopingViewportValue('min-height', '100px')).toBe(false);
});

test('isLoopingViewportValue: min-height 100% → false (percent is not the loop signature)', () => {
  expect(isLoopingViewportValue('min-height', '100%')).toBe(false);
});

test('isLoopingViewportValue: width 100vw → false (not a height property)', () => {
  expect(isLoopingViewportValue('width', '100vw')).toBe(false);
});

test('isLoopingViewportValue: max-height 100vh → false (max-height does not cause loop)', () => {
  expect(isLoopingViewportValue('max-height', '100vh')).toBe(false);
});

test('isLoopingViewportValue: property is case-insensitive (MIN-HEIGHT) → true', () => {
  expect(isLoopingViewportValue('MIN-HEIGHT', '100vh')).toBe(true);
});

test('isLoopingViewportValue: unit is case-insensitive (100VH) → true', () => {
  expect(isLoopingViewportValue('min-height', '100VH')).toBe(true);
});

test('isLoopingViewportValue: calc(100vh - 50px) → false (not a bare unit value)', () => {
  expect(isLoopingViewportValue('min-height', 'calc(100vh - 50px)')).toBe(false);
});

test('isLoopingViewportValue: leading/trailing whitespace tolerated', () => {
  expect(isLoopingViewportValue('min-height', '  100vh  ')).toBe(true);
});

test('isLoopingViewportValue: non-string args → false (no crash)', () => {
  // @ts-expect-error: intentional bad input
  expect(isLoopingViewportValue(null, '100vh')).toBe(false);
  // @ts-expect-error: intentional bad input
  expect(isLoopingViewportValue('min-height', null)).toBe(false);
  // @ts-expect-error: intentional bad input
  expect(isLoopingViewportValue(undefined, undefined)).toBe(false);
});

// buildViewportHeightShim - shell contract

test('buildViewportHeightShim: preserves the existing Tailwind-class static overrides', () => {
  const shim = buildViewportHeightShim();
  expect(shim.includes('.min-h-screen')).toBe(true);
  expect(shim.includes('.h-screen')).toBe(true);
  expect(shim.includes('.min-h-\\[100vh\\]')).toBe(true);
  expect(shim.includes('.h-\\[100vh\\]')).toBe(true);
  expect(shim.includes('.min-h-\\[100dvh\\]')).toBe(true);
  expect(shim.includes('.h-\\[100dvh\\]')).toBe(true);
});

test('buildViewportHeightShim: emits the runtime walk for the raw-CSS case', () => {
  const shim = buildViewportHeightShim();
  // The detection regex pattern, the override technique, and the two run
  // points (DOMContentLoaded + load) are all required for the fix.
  expect(shim.includes('vh|dvh|svh|lvh')).toBe(true);
  expect(shim.includes("setProperty(prop, 'auto', 'important')")).toBe(true);
  expect(shim.includes("'DOMContentLoaded'")).toBe(true);
  expect(shim.includes("'load'")).toBe(true);
});

test('buildViewportHeightShim: walks both inline styles and CSS rules', () => {
  const shim = buildViewportHeightShim();
  expect(shim.includes('scanInline')).toBe(true);
  expect(shim.includes('scanRules')).toBe(true);
  expect(shim.includes('document.styleSheets')).toBe(true);
  expect(shim.includes("document.querySelectorAll('[style]')")).toBe(true);
});
