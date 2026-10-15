import { test, expect } from 'bun:test';
import { hostPatternOf, selectTakeoverCandidates, takeoverReasons } from './takeover-policy';

test('reasons cover what the host renderer drops', () => {
  expect(takeoverReasons('<div><script>x()</script></div>')).toEqual(['script']);
  expect(takeoverReasons('<div onclick="go()">a</div>')).toEqual(['event-handler']);
  expect(takeoverReasons('<a href="javascript:go()">a</a>')).toEqual(['js-url']);
  expect(takeoverReasons('<link rel="stylesheet" href="https://fonts.googleapis.com/x">')).toEqual(['blocked-tag']);
  expect(takeoverReasons('<b>{{getvar::grade}}</b>')).toEqual(['macro']);
  expect(takeoverReasons('<b>$0</b>')).toEqual(['dollar-zero']);
});

test('static HTML stays with the native renderer', () => {
  expect(takeoverReasons('<div class="card"><style>.a{}</style><audio src="$2"></audio>$1</div>')).toEqual([]);
  expect(takeoverReasons('<b>$10</b>')).toEqual([]);
});

test('only renderable, non-prompt scripts that need Vishrun are selected', () => {
  const picked = selectTakeoverCandidates([
    { scriptName: 'js', findRegex: '\\[ST_START\\]([\\s\\S]*?)\\[ST_END\\]', replaceString: '<script>1</script>$1' },
    { scriptName: 'static', findRegex: '【HOME】', replaceString: '<div>home</div>' },
    { scriptName: 'prompt', findRegex: '【P】', replaceString: '<script></script>', promptOnly: true },
    { scriptName: 'off', findRegex: '【O】', replaceString: '<script></script>', disabled: true },
    { scriptName: 'unknown', findRegex: '\\d+(x)', replaceString: '<script></script>' },
  ]);
  expect(picked.map((p) => p.name)).toEqual(['js']);
});

test('host pattern parsing strips the literal slashes and flags', () => {
  expect(hostPatternOf('/<a>(.*?)<\\/a>/s')).toBe('<a>(.*?)<\\/a>');
  expect(hostPatternOf('\\[X\\]')).toBe('\\[X\\]');
});
