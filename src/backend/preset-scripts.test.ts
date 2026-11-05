import { test, expect, mock } from 'bun:test';

mock.module('./common', () => ({ api: {} }));
const { enabledScripts, listScripts } = await import('./preset-scripts');

test('preset scripts: flattens folders and skips disabled or empty scripts', () => {
  const metadata = {
    tavern_helper: {
      scripts: [
        {
          type: 'folder', enabled: true, scripts: [
            { type: 'script', id: 'a', name: 'A', enabled: true, content: 'run()', button: { enabled: true, buttons: [{ name: 'Open', visible: false }] }, data: { k: 1 } },
            { type: 'script', id: 'b', name: 'B', enabled: false, content: 'run()' },
            { type: 'script', id: 'c', name: 'C', enabled: true, content: '  ' },
          ],
        },
        { type: 'folder', enabled: false, scripts: [{ type: 'script', id: 'd', name: 'D', enabled: true, content: 'x' }] },
        { type: 'script', id: 'e', name: 'E', enabled: true, content: 'y', button: { enabled: false, buttons: [{ name: 'X' }] } },
      ],
    },
  };
  expect(enabledScripts(metadata)).toEqual([
    { id: 'a', name: 'A', content: 'run()', data: { k: 1 }, buttons: [{ name: 'Open', visible: false }] },
    { id: 'e', name: 'E', content: 'y', data: {}, buttons: [] },
  ]);
});

test('preset scripts: no tavern_helper means no scripts', () => {
  expect(enabledScripts({})).toEqual([]);
  expect(enabledScripts(null)).toEqual([]);
});

test('preset scripts: lists every script with how it ships, and switches win', () => {
  const metadata = {
    tavern_helper: {
      scripts: [
        { type: 'script', id: 'a', name: 'A', enabled: true, content: 'a()', info: 'by someone' },
        { type: 'script', id: 'b', name: 'B', enabled: false, content: 'b()' },
        { type: 'folder', enabled: false, scripts: [{ type: 'script', id: 'c', name: 'C', enabled: true, content: 'c()' }] },
      ],
    },
  };
  expect(listScripts(metadata).map((s) => [s.id, s.defaultEnabled, s.info])).toEqual([['a', true, 'by someone'], ['b', false, ''], ['c', false, '']]);
  expect(enabledScripts(metadata).map((s) => s.id)).toEqual(['a']);
  expect(enabledScripts(metadata, { a: false, b: true, c: true }).map((s) => s.id)).toEqual(['b', 'c']);
});
