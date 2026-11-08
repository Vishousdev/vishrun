import { test, expect } from 'bun:test';
import { replaceMinHeightVh, viewportVarShim } from './viewport-vh';

test('min-height vh becomes the chat window height', () => {
  expect(replaceMinHeightVh('.w{ aspect-ratio: unset; min-height: 80vh; }'))
    .toBe('.w{ aspect-ratio: unset; min-height: calc(var(--TH-viewport-height) * 0.8); }');
  expect(replaceMinHeightVh('.w{min-height:100vh}')).toBe('.w{min-height:var(--TH-viewport-height)}');
  expect(replaceMinHeightVh('<div style="min-height: 50vh">')).toBe('<div style="min-height: calc(var(--TH-viewport-height) * 0.5)">');
  expect(replaceMinHeightVh("el.style.minHeight = '60vh';")).toBe("el.style.minHeight = 'calc(var(--TH-viewport-height) * 0.6)';");
  expect(replaceMinHeightVh("el.style.setProperty('min-height', '30vh')")).toBe("el.style.setProperty('min-height', 'calc(var(--TH-viewport-height) * 0.3)')");
});

test('other vh uses are left alone', () => {
  const css = '.a{height:80vh;max-height:90vh;width:10vw}';
  expect(replaceMinHeightVh(css)).toBe(css);
  expect(replaceMinHeightVh('<p>min-height</p>')).toBe('<p>min-height</p>');
});

test('viewport shim sets the variable', () => {
  expect(viewportVarShim()).toContain('--TH-viewport-height');
});
