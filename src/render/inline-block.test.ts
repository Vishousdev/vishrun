import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { inlineBlock } from './inline-block';

const g = globalThis as { CSSScopeRule?: unknown };

describe('inlineBlock', () => {
  beforeAll(() => { g.CSSScopeRule = class {}; });
  afterAll(() => { delete g.CSSScopeRule; });

  test('script-free markup renders inline with scoped styles', () => {
    const f = inlineBlock('<div class="a"><style>.a{color:red}</style>hi</div>')!;
    expect(f.querySelector('.a')?.lastChild?.textContent).toBe('hi');
    expect(f.querySelector('style')?.textContent).toContain('@scope ([data-component="MessageContent"], [data-vishrun-widget]) {');
    expect(f.querySelector('style')?.textContent).toContain('.a{color:red}');
  });

  test.each([
    '<div><script>x()</script></div>',
    '<img src=x onerror="x()">',
    '<img/onerror=x() src=y>',
    '<svg><animate onbegin="x()"/></svg>',
    '<a href="jav&#x61;script:x()">a</a>',
    '<a href=" javascript:x()">a</a>',
    '<iframe src="a"></iframe>',
    '<link rel="stylesheet" href="a.css">',
    '<base href="https://a">',
    '<meta http-equiv="refresh" content="0">',
    '<form><input></form>',
    '<html><body>a</body></html>',
    '```html\n<div>a</div>\n```',
  ])('keeps the frame for %s', (html) => {
    expect(inlineBlock(html)).toBeNull();
  });

  test('keeps the frame without @scope support', () => {
    delete g.CSSScopeRule;
    expect(inlineBlock('<div>a</div>')).toBeNull();
    g.CSSScopeRule = class {};
  });
});
