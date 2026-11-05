import { test, expect } from 'bun:test';
import { widgetStatus } from './widget-status';

test('widget status: who draws each widget, text-only regexes left out', () => {
  const scripts = [
    { scriptName: 'Status bar', findRegex: '<status>([\\s\\S]*?)</status>', replaceString: '<div><script>x()</script>$1</div>' },
    { scriptName: 'Card', findRegex: '/<card>(.*?)<\\/card>/s', replaceString: '<div class="c">$1</div>' },
    { scriptName: 'Odd shape', findRegex: '\\d+(x)', replaceString: '<b>$1</b>' },
    { scriptName: 'Old bar', findRegex: '<old>(.*?)</old>', replaceString: '<div>$1</div>', disabled: true },
    { scriptName: 'Hide tags', findRegex: '<think>[\\s\\S]*?</think>', replaceString: '' },
    { scriptName: 'Merge tags', findRegex: '/<\\/note>\\n*<note>/g', replaceString: '</note>\n<note>' },
    { scriptName: 'Page', findRegex: '\u3010PAGE\u3011', replaceString: '```\n<!DOCTYPE html><html><body>x</body></html>\n```' },
    { scriptName: 'Prompt only', findRegex: '<p>(.*?)</p>', replaceString: '<i>$1</i>', promptOnly: true },
  ];
  const native = new Set(['<card>(.*?)<\\/card>\u0000<div class="c">$1</div>']);
  expect(widgetStatus(scripts, native)).toEqual([
    { name: 'Status bar', state: 'vishrun' },
    { name: 'Card', state: 'lumiverse' },
    { name: 'Odd shape', state: 'unsupported' },
    { name: 'Old bar', state: 'off' },
    { name: 'Page', state: 'vishrun' },
  ]);
});
