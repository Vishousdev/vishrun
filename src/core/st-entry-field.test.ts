import { test, expect } from 'bun:test';
import { entryFieldPatch, resolveStUid, unescapeSlashArg } from './st-entry-field';

test('STscript escapes are undone', () => {
  expect(unescapeSlashArg('a \\| b')).toBe('a | b');
  expect(unescapeSlashArg('Pavilion\\!')).toBe('Pavilion\\!');
  expect(unescapeSlashArg('\\{\\{x\\}\\}')).toBe('{{x}}');
  // A JSON backslash before a pipe was doubled by the card, then escaped.
  expect(unescapeSlashArg('"a\\\\\\|b"')).toBe('"a\\|b"');
  expect(unescapeSlashArg('{"n":"x\\ny"}')).toBe('{"n":"x\\ny"}');
});

test('ST uid resolves through the card book', () => {
  const entries = [
    { id: 'u-a', comment: 'User Information', extensions: { display_index: 8 } },
    { id: 'u-b', comment: 'Worldview', extensions: { display_index: 10 } },
  ];
  const book = [
    { id: 2, comment: 'User Information', extensions: { display_index: 8 } },
    { id: 669357, comment: 'Worldview', extensions: { display_index: 10 } },
  ];
  expect(resolveStUid('2', entries, book)?.id).toBe('u-a');
  expect(resolveStUid('669357', entries, book)?.id).toBe('u-b');
  expect(resolveStUid('u-b', entries, book)?.id).toBe('u-b');
  expect(resolveStUid('7', entries, book)).toBeNull();
});

test('same comment is told apart by display index', () => {
  const entries = [
    { id: 'x', comment: 'Dup', extensions: { display_index: 1 } },
    { id: 'y', comment: 'Dup', extensions: { display_index: 2 } },
  ];
  expect(resolveStUid('5', entries, [{ id: 5, comment: 'Dup', extensions: { display_index: 2 } }])?.id).toBe('y');
});

test('field names map to host fields', () => {
  expect(entryFieldPatch('content', 'hi')).toEqual({ content: 'hi' });
  expect(entryFieldPatch('key', 'a, b,')).toEqual({ key: ['a', 'b'] });
  expect(entryFieldPatch('disable', 'true')).toEqual({ disabled: true });
  expect(entryFieldPatch('order', '5')).toBeNull();
});
