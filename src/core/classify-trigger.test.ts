import { test, expect } from 'bun:test';
import { classifyTrigger } from './classify-trigger';

// Cases involving unicode delimiters (【】「」《》『』↦↤) use `new RegExp(...)`
// instead of regex literals. Bun's TS parser escapes literal unicode chars in
// regex sources to \uXXXX form, while `bun build` and the runtime path in
// production (cards arrive as findRegex strings → new RegExp(...)) preserve
// the literal chars. The constructor form matches production behavior.

test('CJK brackets with no captures classify as placeholder', () => {
  expect(classifyTrigger(new RegExp('【女王蜂】'))).toBe('placeholder');
});

test('self-closing tag with no captures classifies as placeholder', () => {
  expect(classifyTrigger(/<StatusPlaceHolderImpl\/>/)).toBe('placeholder');
});

test('paired tag with single capture classifies as pairedTag', () => {
  expect(classifyTrigger(/<status_top>([\s\S]*?)<\/status_top>/)).toBe('pairedTag');
});

test('paired tag with attribute and captures classifies as pairedTag', () => {
  expect(classifyTrigger(/<phone app="([^"]*)">([\s\S]*?)<\/phone>/)).toBe('pairedTag');
});

test('paired tag with multiple attributes classifies as pairedTag', () => {
  expect(classifyTrigger(/<phone a="x" b="y">([\s\S]*?)<\/phone>/)).toBe('pairedTag');
});

test('paired tag with dash in name classifies as pairedTag', () => {
  expect(classifyTrigger(/<my-widget>([\s\S]*?)<\/my-widget>/)).toBe('pairedTag');
});

test('CJK brackets with captures classify as delimitedCapture', () => {
  expect(classifyTrigger(new RegExp('【SYS_HUD \\| Loc: (.*?) \\| Time: (.*?)】'))).toBe('delimitedCapture');
});

test('double CJK brackets with [\\s\\S] body classify as delimitedCaptureMultiLine', () => {
  expect(classifyTrigger(new RegExp('『Present Characters Start』([\\s\\S]*?)『Present Characters End』'))).toBe('delimitedCaptureMultiLine');
});

test('asymmetric arrows with [\\s\\S] body classify as delimitedCaptureMultiLine', () => {
  expect(classifyTrigger(new RegExp('↦(\\S+)\\s([^:]+):([\\s\\S]*?)↤'))).toBe('delimitedCaptureMultiLine');
});

test('corner brackets with capture classify as delimitedCapture', () => {
  expect(classifyTrigger(new RegExp('「(.*?)」'))).toBe('delimitedCapture');
});

test('double angle brackets with capture classify as delimitedCapture', () => {
  expect(classifyTrigger(new RegExp('《(.*?)》'))).toBe('delimitedCapture');
});

test('START OF / END OF textual markers with [\\s\\S] body classify as delimitedCaptureMultiLine', () => {
  const re = new RegExp('\\[\\s*START OF ANN SYS\\s*\\]([\\s\\S]*?)\\[\\s*END OF ANN SYS\\s*\\]');
  expect(classifyTrigger(re)).toBe('delimitedCaptureMultiLine');
});

test('capture with no recognized delimiter classifies as unknown', () => {
  expect(classifyTrigger(/foo(.*?)bar/)).toBe('unknown');
});

// ─── single-char literal delimiters around a brace JSON capture (Option A') ──

test('single-char literal delimiters around a brace JSON capture classify as delimitedCaptureMultiLine', () => {
  expect(classifyTrigger(new RegExp('S\\s*(\\{[\\s\\S]*?\\})\\s*E'))).toBe('delimitedCaptureMultiLine');
});

test('single-char delimiters with non-JSON body stay unknown', () => {
  expect(classifyTrigger(/S(.*?)E/)).toBe('unknown');
});

test('single-char delimiters around a brace JSON capture accept differing letters', () => {
  expect(classifyTrigger(new RegExp('A\\s*(\\{[\\s\\S]*?\\})\\s*Z'))).toBe('delimitedCaptureMultiLine');
});

// ─── delimitedCaptureMultiLine — additional heuristics ──────────────────
// The unicode cases above with [\s\S] in the body now classify as
// delimitedCaptureMultiLine (regression-checked); the remaining heuristics
// for m-flag and explicit \n are covered here.

test('m flag plus ^ anchor classifies as delimitedCaptureMultiLine', () => {
  const re = new RegExp('【block】([^\\n]+)$', 'm');
  expect(classifyTrigger(re)).toBe('delimitedCaptureMultiLine');
});

test('explicit \\\\n in source classifies as delimitedCaptureMultiLine', () => {
  const re = new RegExp('【capt】([^\\n]+)\\n([^\\n]+)');
  expect(classifyTrigger(re)).toBe('delimitedCaptureMultiLine');
});
