import { test, expect } from 'bun:test';

test('outermostMessageNodes keeps one element per message', async () => {
  const { outermostMessageNodes } = await import('./message-rendered');
  const root = document.createElement('div');
  root.innerHTML = '<div data-message-id="a" id="row"><div data-message-id="a" id="card"></div></div><div data-message-id="b" id="b"></div>';
  expect(outermostMessageNodes(root).map((n) => n.id)).toEqual(['row', 'b']);
});
