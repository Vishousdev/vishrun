import { test, expect } from 'bun:test';
import { Window } from 'happy-dom';
import { installStandIns } from './st-stand-ins';

test('stand-ins: writes to Start Reply With reach the prefill callback', async () => {
  const win = new Window();
  const doc = win.document as unknown as Document;
  (globalThis as { HTMLTextAreaElement?: unknown }).HTMLTextAreaElement ??= win.HTMLTextAreaElement;
  const seen: string[] = [];
  const stop = installStandIns('<old>', (v) => seen.push(v), doc);
  const box = doc.getElementById('start_reply_with') as HTMLTextAreaElement;
  expect(box.value).toBe('<old>');
  box.value = '<old>';
  box.value = '<electric>';
  await new Promise((r) => setTimeout(r, 250));
  expect(seen).toEqual(['<electric>']);
  expect((doc.getElementById('chat-show-reply-prefix-checkbox') as HTMLInputElement).checked).toBe(true);
  stop();
  expect(doc.getElementById('start_reply_with')).toBeNull();
});
