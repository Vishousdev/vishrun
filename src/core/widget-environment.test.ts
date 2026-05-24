import { test, expect, beforeEach } from 'bun:test';
import {
  classifyWidgetEnvironment,
  shouldInjectThHelpersShim,
  shouldInjectJQuery,
  shouldInjectLodash,
  shouldInjectMvuShim,
  extractScriptBodies,
  __resetWidgetEnvironmentCacheForTests,
} from './widget-environment';

beforeEach(() => __resetWidgetEnvironmentCacheForTests());

test('empty html -> static', () => {
  expect(classifyWidgetEnvironment('')).toBe('static');
});

test('plain html no scripts -> static', () => {
  expect(classifyWidgetEnvironment('<div>hello</div><p>world</p>')).toBe('static');
});

test('vanilla js DOM script -> static (Choi Siyoon Status_Bar shape)', () => {
  const html = `<div id="x"></div><script>
    (function(){
      const el = document.getElementById('x');
      const mo = new MutationObserver(function(){ el.textContent = 'updated'; });
      mo.observe(el, { childList: true });
    })();
  </script>`;
  expect(classifyWidgetEnvironment(html)).toBe('static');
});

test('SillyTavern in a string literal does NOT escalate (Satoru Gojo Intro shape)', () => {
  const html = `<script>
    const notice = 'Do not use on platforms other than SillyTavern (Discord allowed)';
    console.log(notice);
  </script>`;
  expect(classifyWidgetEnvironment(html)).toBe('static');
});

test('getChatMessages alone -> tavern-helpers-light (Yan Jiangxing Selection shape)', () => {
  const html = `<script>
    async function trySwitch(api, i){
      const r = await api.getChatMessages(0, { include_swipe: true });
      return r;
    }
  </script>`;
  expect(classifyWidgetEnvironment(html)).toBe('tavern-helpers-light');
});

test('setChatMessage (singular) -> tavern-helpers-light', () => {
  const html = `<script>
    setChatMessage('content', 0, { swipe_id: 1, refresh: 'display_and_render_current' });
  </script>`;
  expect(classifyWidgetEnvironment(html)).toBe('tavern-helpers-light');
});

test('getChatMessages + setChatMessage together -> tavern-helpers-light (Choi Opening shape)', () => {
  const html = `<script>
    (async () => {
      const r = await getChatMessages("0", { include_swipe: true });
      await setChatMessage(r[0].swipes[1], 0, { swipe_id: 1 });
    })();
  </script>`;
  expect(classifyWidgetEnvironment(html)).toBe('tavern-helpers-light');
});

test('jQuery dollar call -> tavern-jq (Queen Bee Anonymous News Flash shape)', () => {
  const html = `<script>
    function init(){ const m = getChatMessages(getCurrentMessageId()); }
    $(function(){ init(); });
  </script>`;
  expect(classifyWidgetEnvironment(html)).toBe('tavern-jq');
});

test('jQuery named -> tavern-jq', () => {
  const html = `<script>
    jQuery(document).ready(function(){ console.log('hi'); });
  </script>`;
  expect(classifyWidgetEnvironment(html)).toBe('tavern-jq');
});

test('lodash _.get alone -> tavern-mvu (lodash bundled with mvu tier)', () => {
  const html = `<script>
    const v = _.get(window, 'a.b.c', null);
  </script>`;
  expect(classifyWidgetEnvironment(html)).toBe('tavern-mvu');
});

test('Mvu + jQuery + lodash + waitGlobalInitialized -> tavern-mvu (Queen Bee Status Bar shape)', () => {
  const html = `<script>
    async function init(){
      await waitGlobalInitialized('Mvu');
      const all = getAllVariables();
      const t = _.get(all, 'stat_data.世界.当前时间', 'Unknown');
      $('#x').text(t);
      eventOn(Mvu.events.VARIABLE_UPDATE_ENDED, () => {});
    }
    $(errorCatched(init));
  </script>`;
  expect(classifyWidgetEnvironment(html)).toBe('tavern-mvu');
});

test('triggerSlash -> tavern-slash (Zhou Fang shape)', () => {
  const html = `<script>
    if (typeof triggerSlash === 'function') {
      triggerSlash('/send hi|/trigger');
    }
  </script>`;
  expect(classifyWidgetEnvironment(html)).toBe('tavern-slash');
});

test('helpers + triggerSlash fallback -> tavern-helpers-light (hybrid card gets the helpers shim)', () => {
  const html = `<script>
    async function go(i){
      if (typeof getChatMessages === 'function' && typeof setChatMessage === 'function') {
        const m = await getChatMessages("0");
        await setChatMessage({ message: m[0].swipes[i] }, 0, { swipe_id: i });
      } else {
        sendSlashCommand('/swipe 0 ' + i);
      }
    }
    function sendSlashCommand(msg){
      if (typeof triggerSlash === 'function') { triggerSlash(msg); }
    }
  </script>`;
  expect(classifyWidgetEnvironment(html)).toBe('tavern-helpers-light');
  expect(shouldInjectThHelpersShim(classifyWidgetEnvironment(html))).toBe(true);
});

test('jQuery + getChatMessages -> tavern-jq (jq wins over helpers-light tier order)', () => {
  const html = `<script>
    const m = getChatMessages(0);
    $(function(){});
  </script>`;
  expect(classifyWidgetEnvironment(html)).toBe('tavern-jq');
});

test('lodash + helpers + jq + triggerSlash -> tavern-mvu (highest tier wins)', () => {
  const html = `<script>
    const v = _.get({}, 'a');
    triggerSlash('/x');
    $(function(){});
    getChatMessages(0);
  </script>`;
  expect(classifyWidgetEnvironment(html)).toBe('tavern-mvu');
});

test('comments/attributes outside <script> ignored', () => {
  const html = `<!-- this uses $ jQuery and Mvu in description --><div data-foo="$"><script>console.log('hi');</script></div>`;
  expect(classifyWidgetEnvironment(html)).toBe('static');
});

test('multiple script blocks merged', () => {
  const html = `<script>function a(){}</script><div></div><script>getChatMessages(0);</script>`;
  expect(classifyWidgetEnvironment(html)).toBe('tavern-helpers-light');
});

test('extractScriptBodies handles attributes on script tag', () => {
  const body = extractScriptBodies(`<script type="text/javascript" defer>const x=1;</script>`);
  expect(body.trim()).toBe('const x=1;');
});

test('shouldInjectThHelpersShim activates for helpers-light/jq/mvu', () => {
  expect(shouldInjectThHelpersShim('static')).toBe(false);
  expect(shouldInjectThHelpersShim('tavern-helpers-light')).toBe(true);
  expect(shouldInjectThHelpersShim('tavern-jq')).toBe(true);
  expect(shouldInjectThHelpersShim('tavern-mvu')).toBe(true);
  expect(shouldInjectThHelpersShim('tavern-slash')).toBe(false);
});

test('shouldInjectJQuery activates for jq/mvu only', () => {
  expect(shouldInjectJQuery('static')).toBe(false);
  expect(shouldInjectJQuery('tavern-helpers-light')).toBe(false);
  expect(shouldInjectJQuery('tavern-jq')).toBe(true);
  expect(shouldInjectJQuery('tavern-mvu')).toBe(true);
  expect(shouldInjectJQuery('tavern-slash')).toBe(false);
});

test('shouldInjectLodash activates for mvu only', () => {
  expect(shouldInjectLodash('static')).toBe(false);
  expect(shouldInjectLodash('tavern-helpers-light')).toBe(false);
  expect(shouldInjectLodash('tavern-jq')).toBe(false);
  expect(shouldInjectLodash('tavern-mvu')).toBe(true);
  expect(shouldInjectLodash('tavern-slash')).toBe(false);
});

test('shouldInjectMvuShim activates for mvu only', () => {
  expect(shouldInjectMvuShim('static')).toBe(false);
  expect(shouldInjectMvuShim('tavern-helpers-light')).toBe(false);
  expect(shouldInjectMvuShim('tavern-jq')).toBe(false);
  expect(shouldInjectMvuShim('tavern-mvu')).toBe(true);
  expect(shouldInjectMvuShim('tavern-slash')).toBe(false);
});

test('dollar sign in CSS selector strings (not call) does NOT escalate', () => {
  const html = `<script>
    const placeholder = 'use $ as escape, e.g. /\\$1/';
  </script>`;
  expect(classifyWidgetEnvironment(html)).toBe('static');
});

test('a property named _x (not lodash) does NOT escalate', () => {
  const html = `<script>const o = { _x: 1 }; console.log(o._x);</script>`;
  expect(classifyWidgetEnvironment(html)).toBe('static');
});

test('window._ assignment does NOT escalate (not a member call)', () => {
  const html = `<script>window._helpful = function(){};</script>`;
  expect(classifyWidgetEnvironment(html)).toBe('static');
});
