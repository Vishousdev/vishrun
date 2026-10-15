import { test, expect } from 'bun:test';
import { handleTriggerSlash, parseSlash, setComposerText } from './slash-runner';

const ctx = {} as never;

test('parseSlash splits name and argument text', () => {
  expect(parseSlash('/setinput I head to the Library')).toEqual({ name: 'setinput', rest: 'I head to the Library' });
  expect(parseSlash('plain text')).toBeNull();
});

test('/setinput goes to the composer, not the fallback', async () => {
  let composed = '';
  let fellBack = false;
  await handleTriggerSlash({ command: '/setinput I head to the Rooftop' }, ctx, {
    setComposer: (t) => { composed = t; return true; },
    fallback: async () => { fellBack = true; },
  });
  expect(composed).toBe('I head to the Rooftop');
  expect(fellBack).toBe(false);
});

test('/echo is swallowed and unknown commands keep the clipboard path', async () => {
  const seen: unknown[] = [];
  const fallback = async (p: unknown) => { seen.push(p); };
  await handleTriggerSlash({ command: '/echo severity=success hi' }, ctx, { fallback });
  await handleTriggerSlash({ command: '/setvar key=a 1' }, ctx, { fallback });
  expect(seen).toEqual([{ text: '/setvar key=a 1' }]);
});

test('setComposerText writes into the host input textarea', () => {
  document.body.innerHTML = '<div data-component="InputArea"><textarea></textarea></div>';
  expect(setComposerText('hello')).toBe(true);
  expect(document.querySelector('textarea')!.value).toBe('hello');
});
