import { test, expect } from 'bun:test';
import { touchesActiveChat } from '../frontend';

test('SETTINGS_UPDATED wakes on single and batched active-chat keys', () => {
  expect(touchesActiveChat({ key: 'activeChatId' })).toBe(true);
  expect(touchesActiveChat({ keys: ['theme', 'activeCharacterId'] })).toBe(true);
  expect(touchesActiveChat({ keys: ['theme'] })).toBe(false);
  expect(touchesActiveChat(null)).toBe(false);
});
