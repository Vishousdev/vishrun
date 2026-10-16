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

test('lone non-HTML tags classify as strippedTag', () => {
  expect(classifyTrigger(/<StatusPlaceHolderImpl\/>/)).toBe('strippedTag');
  expect(classifyTrigger(/<Podcast Opening>/)).toBe('strippedTag');
  expect(classifyTrigger(/<Return to Home>/)).toBe('strippedTag');
  expect(classifyTrigger(/<br>/)).toBe('placeholder');
  expect(classifyTrigger(/【開場白】/)).toBe('placeholder');
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

// ─── angle-pipe markers ─────────────────────────────────────────────────

test('angle-pipe marker with captures classifies as delimitedCaptureMultiLine', () => {
  expect(classifyTrigger(new RegExp('\\<Music Play\\|(.*?)\\|(.*?)\\>'))).toBe('delimitedCaptureMultiLine');
  expect(classifyTrigger(new RegExp('<BGM\\|(.*?)>'))).toBe('delimitedCaptureMultiLine');
});

test('angle-pipe marker without captures stays placeholder', () => {
  expect(classifyTrigger(new RegExp('\\<Music Play\\|stop\\>'))).toBe('placeholder');
});

test('tag with attribute capture is not an angle-pipe marker', () => {
  expect(classifyTrigger(new RegExp('<img src="(.*?)">'))).toBe('unknown');
});

// ─── square-bracket block markers ───────────────────────────────────────

test('[X_START]…[X_END] markers with a capture classify as delimited', () => {
  expect(classifyTrigger(new RegExp('\\[ST_START\\]([\\s\\S]*?)\\[ST_END\\]'))).toBe('delimitedCaptureMultiLine');
  expect(classifyTrigger(new RegExp('\\[HUD\\](.*?)\\[/HUD\\]'))).toBe('delimitedCaptureMultiLine');
});

test('bracketed pipe status line is anchored by its literal opener', () => {
  expect(classifyTrigger(new RegExp('\\[Status Bar\\|(.*?)\\|(.*?)\\]'))).toBe('delimitedCaptureMultiLine');
});

test('literal-anchored capture blocks route through the linearized path', () => {
  expect(classifyTrigger(new RegExp('\\[Chat with (.*?)\\]([\\s\\S]*)'))).toBe('delimitedCaptureMultiLine');
  expect(classifyTrigger(new RegExp('\\[Incoming Message\\|(.*?)\\|(.*?)\\|(.*?)\\]', 'gs'))).toBe('delimitedCaptureMultiLine');
  expect(classifyTrigger(new RegExp('\\[Diary\\]\\s*Date:(.*?)\\s*Weather:(.*?)\\s*Content:([\\s\\S]*)'))).toBe('delimitedCaptureMultiLine');
  expect(classifyTrigger(new RegExp('╒═════([\\s\\S]*?)╘═════', 'g'))).toBe('delimitedCaptureMultiLine');
});

test('word-led or short-prefixed captures stay unknown', () => {
  expect(classifyTrigger(new RegExp('Time: (.*?)\\n'))).toBe('unknown');
  expect(classifyTrigger(new RegExp('\\[(.*?)\\]'))).toBe('unknown');
  expect(classifyTrigger(new RegExp('\\d+(x)'))).toBe('unknown');
});

test('self-closing tag with captures classifies as strippedTag', () => {
  expect(classifyTrigger(/\<bgm src\=\"(.*?)\" artist\=\"(.*?)\" song\=\"(.*?)\" \/\>/)).toBe('strippedTag');
  expect(classifyTrigger(/<sfx\s*name="([^"]+)"\s*\/>/)).toBe('strippedTag');
  expect(classifyTrigger(/<img src="(.*?)">/)).not.toBe('strippedTag');
  expect(classifyTrigger(/<bgm>(.*?)<\/bgm>/)).toBe('pairedTag');
});

test('non-ASCII tag blocks stay text on screen and classify as multi-line', () => {
  expect(classifyTrigger(/<简介>\s*([\s\S]*?)\s*<\/简介>\s*<原文>\s*([\s\S]*?)\s*<\/原文>/)).toBe('delimitedCaptureMultiLine');
  expect(classifyTrigger(/<div>(.*?)/)).toBe('unknown');
});
