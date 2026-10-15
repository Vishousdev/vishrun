import { test, expect } from 'bun:test';
import { computePairedAnchor, placeAtAnchor } from './paired-anchor';
import { linearizeBubble } from './linearize-bubble';
import { deepContains, deepClosest } from './shadow-dom';

const RAW = `<content><style>.x{}</style><div class="lt-wrap"><input type="radio" id="a">
<div class="lt-page lt-p1"><label for="b">Enter</label></div>
<div class="lt-page lt-p2">

<story_launcher_pink>
[Config|Book]
</story_launcher_pink>

</div></div></content>`;
const FULL = '<story_launcher_pink>\n[Config|Book]\n</story_launcher_pink>';

function island(html: string): HTMLElement {
  const root = document.createElement('div');
  const host = document.createElement('div');
  root.appendChild(host);
  host.attachShadow({ mode: 'open' }).innerHTML = html;
  return root;
}

test('anchor resolves to the nearest classed ancestor of the stripped tag', () => {
  const a = computePairedAnchor(RAW, FULL)!;
  expect(a.selector).toBe('div.lt-page.lt-p2');
  expect(a.occurrence).toBe(0);
  expect(a.beforeSelector).toBeNull();
});

test('anchor is null when the tag is not inside authored HTML', () => {
  expect(computePairedAnchor('plain text\n' + FULL, FULL)).toBeNull();
  expect(computePairedAnchor('no match here', FULL)).toBeNull();
});

test('widget is placed inside the matching element of a shadow island', () => {
  const root = island('<div class="lt-wrap"><div class="lt-page lt-p1">p1</div><div class="lt-page lt-p2"></div></div>');
  const w = document.createElement('iframe');
  expect(placeAtAnchor(root, computePairedAnchor(RAW, FULL)!, w)).toBe(true);
  expect((w.parentNode as Element).className).toBe('lt-page lt-p2');
  expect(deepContains(root, w)).toBe(true);
});

test('linearize reads text inside shadow islands and skips style blocks', () => {
  const root = island('<style>.a{color:red}</style><div class="s">[ST_START]x[ST_END]</div>');
  const lin = linearizeBubble(root);
  expect(lin.text).toBe('[ST_START]x[ST_END]');
  expect(deepContains(root, lin.offsetMap[0].node)).toBe(true);
});

test('deepClosest crosses the shadow boundary', () => {
  const msg = document.createElement('div');
  msg.setAttribute('data-message-id', 'm1');
  const host = document.createElement('div');
  msg.appendChild(host);
  const sr = host.attachShadow({ mode: 'open' });
  const f = document.createElement('iframe');
  sr.appendChild(f);
  expect(deepClosest(f, '[data-message-id]')).toBe(msg);
});

test('anchor tolerates CRLF in stored content vs LF in the intercepted match', () => {
  const a = computePairedAnchor(RAW.replace(/\n/g, '\r\n'), FULL);
  expect(a?.selector).toBe('div.lt-page.lt-p2');
});
