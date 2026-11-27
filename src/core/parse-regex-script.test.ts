import { test, expect } from 'bun:test';
import { stripCodeFence, parseRegexLiteral, mergeFlags, compileScripts, rewriteSelfClosingToPaired } from './parse-regex-script';
import type { RawRegexScript } from '../lumiverse/fetch-character';

test('stripCodeFence: lowercase html lang hint', () => {
  const t = '```html\n<!DOCTYPE html>\n<body>x</body>\n```';
  expect(stripCodeFence(t)).toBe('<!DOCTYPE html>\n<body>x</body>');
});

test('stripCodeFence: uppercase HTML lang hint preserves inner whitespace', () => {
  expect(stripCodeFence('```HTML\n  hi  \n```')).toBe('  hi  ');
});

test('stripCodeFence: no lang hint', () => {
  expect(stripCodeFence('```\nfoo\n```')).toBe('foo');
});

test('stripCodeFence: surrounding whitespace + CRLF + trailing space on opening line', () => {
  expect(stripCodeFence('   ```html  \r\nfoo\r\n```   ')).toBe('foo');
});

test('stripCodeFence: pass-through when no fence', () => {
  const t = '<!DOCTYPE html>\nno fence here';
  expect(stripCodeFence(t)).toBe(t);
});

test('stripCodeFence: pass-through when opening fence has no close', () => {
  const t = '```html\nopener but no close';
  expect(stripCodeFence(t)).toBe(t);
});

test('stripCodeFence: Vavesta-shaped block unwraps cleanly', () => {
  const t = '```html\n<!DOCTYPE html>\n<html lang="en">\n<body><div class="vav-home-wrap"></div></body>\n</html>\n```';
  const stripped = stripCodeFence(t);
  expect(stripped.startsWith('<!DOCTYPE html>')).toBe(true);
  expect(stripped.endsWith('</html>')).toBe(true);
});

test('parseRegexLiteral: arrow-delimited literal with g flag', () => {
  const r = parseRegexLiteral('/↦(\\S+)\\s([^:]+):([\\s\\S]*?)↤/g');
  expect(r.pattern).toBe('↦(\\S+)\\s([^:]+):([\\s\\S]*?)↤');
  expect(r.flags).toBe('g');
});

test('parseRegexLiteral: non-literal placeholder passes through', () => {
  const r = parseRegexLiteral('【VAVESTA_HOME】');
  expect(r.pattern).toBe('【VAVESTA_HOME】');
  expect(r.flags).toBe('');
});

test('parseRegexLiteral: paired-tag source without delimiters passes through', () => {
  const r = parseRegexLiteral('<\\s*PACIFICA_UI\\s*>([\\s\\S]*?)<\\s*\\/PACIFICA_UI\\s*>');
  expect(r.pattern).toBe('<\\s*PACIFICA_UI\\s*>([\\s\\S]*?)<\\s*\\/PACIFICA_UI\\s*>');
  expect(r.flags).toBe('');
});

test('parseRegexLiteral: escaped slash inside pattern is not a closer', () => {
  const r = parseRegexLiteral('/foo\\/bar/i');
  expect(r.pattern).toBe('foo\\/bar');
  expect(r.flags).toBe('i');
});

test('parseRegexLiteral: unmatched leading slash passes through', () => {
  const r = parseRegexLiteral('/no closer');
  expect(r.pattern).toBe('/no closer');
  expect(r.flags).toBe('');
});

test('mergeFlags: empty user flags defaults to gs', () => {
  expect(mergeFlags('')).toBe('gs');
});

test('mergeFlags: dedupes g and adds i for gi input', () => {
  expect([...mergeFlags('gi')].sort().join('')).toBe('gis');
});

function rawScript(over: Partial<RawRegexScript> & { findRegex: string }): RawRegexScript {
  return { replaceString: '', ...over };
}

test('compileScripts: skips promptOnly: true', () => {
  const out = compileScripts([
    rawScript({ scriptName: 'prompt-only', findRegex: '<X/>', promptOnly: true }),
  ]);
  expect(out.length).toBe(0);
});

test('compileScripts: keeps markdownOnly: true (Vishrun IS the display pipeline)', () => {
  const out = compileScripts([
    rawScript({ scriptName: 'md-only', findRegex: '<X/>', markdownOnly: true, replaceString: '<div>hi</div>' }),
  ]);
  expect(out.length).toBe(1);
  expect(out[0].scriptName).toBe('md-only');
});

test('compileScripts: keeps script with both flags false/undefined', () => {
  const out = compileScripts([
    rawScript({ scriptName: 'plain', findRegex: '<X/>' }),
  ]);
  expect(out.length).toBe(1);
  expect(out[0].scriptName).toBe('plain');
});

test('compileScripts: skips disabled: true (pre-existing behavior, confirm)', () => {
  const out = compileScripts([
    rawScript({ scriptName: 'off', findRegex: '<X/>', disabled: true }),
  ]);
  expect(out.length).toBe(0);
});

test('compileScripts: Queen Bee promptOnly vs markdownOnly with same trigger leaves only the widget', () => {
  // Real shape from Queen Bee's regex_scripts array: script [3] is
  // promptOnly with empty replace (would consume the trigger), [7] is
  // markdownOnly with the Status Bar widget HTML.
  const out = compileScripts([
    rawScript({ scriptName: 'Hide Status Bar from AI', findRegex: '<StatusPlaceHolderImpl/>', promptOnly: true, replaceString: '' }),
    rawScript({ scriptName: 'Queen Bee Status Bar', findRegex: '<StatusPlaceHolderImpl/>', markdownOnly: true, replaceString: '<div class="status-bar">widget</div>' }),
  ]);
  expect(out.length).toBe(1);
  expect(out[0].scriptName).toBe('Queen Bee Status Bar');
  expect(out[0].replaceString).toBe('<div class="status-bar">widget</div>');
});

test('compileScripts: promptOnly skip happens before placement / regex compile', () => {
  // Even with a placement that would otherwise match render-side, a
  // promptOnly script is skipped.
  const out = compileScripts([
    rawScript({ scriptName: 'bad regex but skipped', findRegex: '[(invalid', promptOnly: true }),
  ]);
  expect(out.length).toBe(0);
});

// ─── Self-closing tag rewrite ─────────────────────────────────────────

test('rewriteSelfClosingToPaired: simple self-closing tag', () => {
  expect(rewriteSelfClosingToPaired('<StatusPlaceHolderImpl/>')).toBe('<StatusPlaceHolderImpl></StatusPlaceHolderImpl>');
});

test('rewriteSelfClosingToPaired: with space before slash', () => {
  expect(rewriteSelfClosingToPaired('<StatusPlaceHolderImpl />')).toBe('<StatusPlaceHolderImpl></StatusPlaceHolderImpl>');
});

test('rewriteSelfClosingToPaired: with attributes', () => {
  expect(rewriteSelfClosingToPaired('<Widget type="status"/>')).toBe('<Widget type="status"></Widget>');
});

test('rewriteSelfClosingToPaired: lowercase tag returns null (not custom)', () => {
  expect(rewriteSelfClosingToPaired('<br/>')).toBeNull();
});

test('rewriteSelfClosingToPaired: paired tag returns null', () => {
  expect(rewriteSelfClosingToPaired('<campus_gossip>[\\s\\S]*?</campus_gossip>')).toBeNull();
});

test('rewriteSelfClosingToPaired: placeholder returns null', () => {
  expect(rewriteSelfClosingToPaired('【女王蜂】')).toBeNull();
});

test('compileScripts: self-closing findRegex becomes pairedTag kind', () => {
  const out = compileScripts([
    rawScript({ scriptName: 'Status Bar', findRegex: '<StatusPlaceHolderImpl/>', replaceString: '<div>widget</div>' }),
  ]);
  expect(out.length).toBe(1);
  expect(out[0].kind).toBe('pairedTag');
  expect(out[0].findRe.test('<StatusPlaceHolderImpl></StatusPlaceHolderImpl>')).toBe(true);
});

test('compileScripts: self-closing findRe matches expanded content', () => {
  const out = compileScripts([
    rawScript({ scriptName: 'Status Bar', findRegex: '<StatusPlaceHolderImpl/>', replaceString: '<div>widget</div>' }),
  ]);
  const content = 'Hello <StatusPlaceHolderImpl></StatusPlaceHolderImpl> world';
  out[0].findRe.lastIndex = 0;
  const m = out[0].findRe.exec(content);
  expect(m).not.toBeNull();
  expect(m![0]).toBe('<StatusPlaceHolderImpl></StatusPlaceHolderImpl>');
});

test('parseRegexLiteral: unescaped slash inside the pattern (closing tag), like ST', () => {
  const r = parseRegexLiteral('/<tag>\\s*(.*?)\\s*</tag>/gs');
  expect(r).toEqual({ pattern: '<tag>\\s*(.*?)\\s*</tag>', flags: 'gs' });
  expect(new RegExp(r.pattern, r.flags).exec('<tag> hi </tag>')?.[1]).toBe('hi');
});
