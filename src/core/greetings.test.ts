import { test, expect } from 'bun:test';
import { cardGreetings, greetingIndex } from './greetings';

test('the shown greeting is found by its text', () => {
  const g = cardGreetings({ firstMes: '【Profile】', alternateGreetings: ['A\r\nline', 'B'] });
  expect(greetingIndex('【Profile】', g)).toBe(0);
  expect(greetingIndex('A\nline ', g)).toBe(1);
  expect(greetingIndex('B', g)).toBe(2);
  expect(greetingIndex('edited', g)).toBe(-1);
  expect(cardGreetings(null)).toEqual([]);
});
