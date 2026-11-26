import { describe, expect, test } from 'bun:test';
import { inlineJson } from './inline-json';

describe('inlineJson', () => {
  test('escapes tags so they cannot break out of a script', () => {
    const out = inlineJson({ s: '<head></script><!--' });
    expect(out).not.toContain('<');
    expect(JSON.parse(out)).toEqual({ s: '<head></script><!--' });
  });
});
