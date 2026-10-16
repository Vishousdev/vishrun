import { test, expect } from 'bun:test';
import { substitute } from './substitute';

test('$$ is left as written, like SillyTavern', () => {
  expect(substitute('var $$=function(){}; $1', 'm', ['g'])).toBe('var $$=function(){}; g');
  expect(substitute('$$1', 'm', ['g'])).toBe('$g');
});

test('$N, $0 and {{match}} still substitute', () => {
  expect(substitute('<b>$1</b>|$0|{{match}}', 'whole', ['one'])).toBe('<b>one</b>|whole|whole');
});
