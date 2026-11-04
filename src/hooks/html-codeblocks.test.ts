import { test, expect } from 'bun:test';
import { isFrontendCode } from './html-codeblocks';

test('html code blocks: only HTML pages count, like JS-Slash-Runner', () => {
  expect(isFrontendCode('<!DOCTYPE html>\n<html lang="zh-CN"><head></head><body></body></html>')).toBe(true);
  expect(isFrontendCode('<head><script type="module">const t=Vue</script></head><body><div id="app"></div></body>')).toBe(true);
  expect(isFrontendCode('<div class="card">hi</div>')).toBe(false);
  expect(isFrontendCode('const x = 1;\nconsole.log(x);')).toBe(false);
});
