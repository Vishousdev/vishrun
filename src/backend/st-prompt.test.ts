import { expect, test } from 'bun:test';
import type { LlmMessageDTO } from 'lumiverse-spindle-types';

(globalThis as unknown as { spindle: unknown }).spindle = {};
const { depthPromptOf, insertAtDepth } = await import('./st-prompt');

const h = (content: string): LlmMessageDTO => ({ role: 'user', content, __isChatHistory: true });
const s = (content: string): LlmMessageDTO => ({ role: 'system', content });

test('depth prompt: object form only, with defaults', () => {
  expect(depthPromptOf({ extensions: { depth_prompt: { prompt: 'n', depth: 2, role: 'system' } } })).toEqual({ prompt: 'n', depth: 2, role: 'system' });
  expect(depthPromptOf({ extensions: { depth_prompt: { prompt: '  ' } } })).toBeNull();
  expect(depthPromptOf({ extensions: { depth_prompt: 'text' } })).toBeNull();
});

test('the note goes before the last `depth` chat-history turns', () => {
  const msgs = [s('sys'), h('a'), h('b'), h('c'), s('post')];
  const note = s('NOTE');
  expect(insertAtDepth(msgs, note, 2).messages.map((m) => m.content)).toEqual(['sys', 'a', 'NOTE', 'b', 'c', 'post']);
  expect(insertAtDepth(msgs, note, 0).messages.map((m) => m.content)).toEqual(['sys', 'a', 'b', 'c', 'NOTE', 'post']);
  expect(insertAtDepth(msgs, note, 9).messages.map((m) => m.content)).toEqual(['sys', 'NOTE', 'a', 'b', 'c', 'post']);
});
