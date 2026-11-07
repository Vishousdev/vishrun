import { test, expect } from 'bun:test';
import { clickSend, handleTriggerSlash, parseSlash, setComposerText, splitPipeline } from './slash-runner';

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

test('/echo becomes a toast and unknown commands keep the clipboard path', async () => {
  const seen: unknown[] = [];
  const calls: unknown[] = [];
  const fallback = async (p: unknown) => { seen.push(p); };
  const rpc = async (op: string, args: Record<string, unknown>) => { calls.push([op, args]); return true; };
  await handleTriggerSlash({ command: '/echo severity=success hi' }, ctx, { fallback, rpc });
  await handleTriggerSlash({ command: '/setvar key=a 1' }, ctx, { fallback, rpc });
  expect(seen).toEqual([{ text: '/setvar key=a 1' }]);
  expect(calls).toEqual([['toast', { kind: 'success', message: 'hi' }]]);
});

test('/setentryfield with escaped pipes and a toast runs step by step', async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const rpc = async (op: string, args: Record<string, unknown>) => { calls.push([op, args]); return true; };
  const json = '{\n  "name": "A \\| B",\n  "x": "{y\\}"\n}';
  const cmd = `/setentryfield file="My Book" uid=2 field=content ${json} | /echo severity=success Saved\!`;
  await handleTriggerSlash({ command: cmd }, ctx, { rpc, fallback: async () => { throw new Error('fallback'); } });
  expect(calls[0][0]).toBe('wb_set_field');
  expect(calls[0][1]).toMatchObject({ file: 'My Book', uid: '2', field: 'content', value: '{\n  "name": "A | B",\n  "x": "{y}"\n}' });
  expect(calls[1]).toEqual(['toast', { kind: 'success', message: 'Saved!' }]);
});

test('setComposerText writes into the host input textarea', () => {
  document.body.innerHTML = '<div data-component="InputArea"><textarea></textarea></div>';
  expect(setComposerText('hello')).toBe(true);
  expect(document.querySelector('textarea')!.value).toBe('hello');
});

test('/send with /trigger fills the composer and sends', async () => {
  let composed = '';
  let sent = 0;
  let fellBack = false;
  await handleTriggerSlash({ command: '/send Reply: hi | ok|/trigger' }, ctx, {
    setComposer: (t) => { composed = t; return true; },
    send: async () => { sent++; return true; },
    fallback: async () => { fellBack = true; },
  });
  expect(composed).toBe('Reply: hi | ok');
  expect(sent).toBe(1);
  expect(fellBack).toBe(false);
});

test('/send without /trigger only fills the composer', async () => {
  let sent = 0;
  await handleTriggerSlash({ command: '/send Return to chat list' }, ctx, {
    setComposer: () => true,
    send: async () => { sent++; return true; },
  });
  expect(sent).toBe(0);
});

test('splitPipeline keeps pipes that do not start a command', () => {
  expect(splitPipeline('/send a|b | c|/trigger')).toEqual(['/send a|b | c', '/trigger']);
});

test('clickSend presses the host send button, not the stop button', async () => {
  document.body.innerHTML = '<div data-component="InputArea"><button class="_sendBtn_x _sendBtnStop_y" id="stop"></button></div>';
  expect(await clickSend(document, 0)).toBe(false);
  document.body.innerHTML = '<div data-component="InputArea"><div class="_sendBtnShell_z"><button class="_sendBtn_x" id="send"></button></div></div>';
  let clicked = false;
  document.getElementById('send')!.addEventListener('click', () => { clicked = true; });
  expect(await clickSend(document, 0)).toBe(true);
  expect(clicked).toBe(true);
});
