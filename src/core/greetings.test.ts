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

test('an empty first_mes is dropped when there are alternates, as in SillyTavern', () => {
  expect(cardGreetings({ firstMes: '', alternateGreetings: ['Home', 'A'] })).toEqual(['Home', 'A']);
  expect(cardGreetings({ firstMes: null, alternateGreetings: ['Home'] })).toEqual(['Home']);
  expect(cardGreetings({ firstMes: '', alternateGreetings: [] })).toEqual(['']);
  expect(cardGreetings({ firstMes: 'F', alternateGreetings: ['A'] })).toEqual(['F', 'A']);
});
