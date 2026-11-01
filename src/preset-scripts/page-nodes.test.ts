import { test, expect } from 'bun:test';
import { Window } from 'happy-dom';
import { trackPageNodes } from './page-nodes';

test('page nodes: stopping removes what scripts added, keeps host nodes', async () => {
  const win = new Window();
  const doc = win.document as unknown as Document;
  (globalThis as { MutationObserver?: unknown }).MutationObserver ??= win.MutationObserver;
  const before = doc.createElement('div');
  before.id = 'root';
  doc.body.appendChild(before);

  const stop = trackPageNodes(doc);
  const panel = doc.createElement('div');
  panel.id = 'control-panel-container';
  doc.body.appendChild(panel);
  const portal = doc.createElement('div');
  (portal as unknown as Record<string, unknown>).__reactFiber$x = {};
  doc.body.appendChild(portal);
  const frame = doc.createElement('iframe');
  frame.setAttribute('data-vishrun-preset-script', 'A');
  doc.body.appendChild(frame);
  await new Promise((r) => setTimeout(r, 0));
  stop();

  expect(doc.getElementById('control-panel-container')).toBeNull();
  expect(doc.getElementById('root')).not.toBeNull();
  expect(portal.parentNode).toBe(doc.body as unknown as ParentNode);
  expect(frame.parentNode).toBe(doc.body as unknown as ParentNode);
});
