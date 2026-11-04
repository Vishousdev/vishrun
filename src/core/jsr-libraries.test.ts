import { test, expect } from 'bun:test';
import { withJsrGlobalLibraries } from './jsr-libraries';
import { vendoredIdFor } from '../backend/vendored-cdn';

test('jsr libraries: widgets using global Vue get the bundled Vue', () => {
  const out = withJsrGlobalLibraries('<head><script type="module">const t=Vue;</script></head><body></body>');
  expect(out.startsWith('<head><script src="https://unpkg.com/vue@3/dist/vue.global.prod.js"></script>')).toBe(true);
  expect(vendoredIdFor('https://unpkg.com/vue@3/dist/vue.global.prod.js')).toBe('vue');
  expect(withJsrGlobalLibraries('<script>Vue.createApp({})</script>')).toContain('vue.global.prod.js');
});

test('jsr libraries: left alone when Vue is loaded or not used', () => {
  const loaded = '<script src="https://cdn.jsdelivr.net/npm/vue@3.4.0/dist/vue.global.js"></script><script>Vue.createApp({})</script>';
  expect(withJsrGlobalLibraries(loaded)).toBe(loaded);
  expect(withJsrGlobalLibraries('<div class="vue-card">a</div>')).toBe('<div class="vue-card">a</div>');
});
