import { test, expect } from 'bun:test';
import { eventEmitShim, isScriptEvent } from './script-events';

test('widget eventEmit posts the event and its args', () => {
  const sent: unknown[] = [];
  const win = { spindleSandbox: { postMessage: (m: unknown) => sent.push(m) } } as Record<string, unknown>;
  new Function('window', eventEmitShim().replace(/^<script>|<\/script>$/g, ''))(win);
  (win.eventEmit as (...a: unknown[]) => void)('Greeting Switched', { n: 1 });
  expect(sent).toEqual([{ kind: 'script-event', event: 'Greeting Switched', args: [{ n: 1 }] }]);
});

test('only named events with an args list are accepted', () => {
  expect(isScriptEvent({ kind: 'script-event', event: 'x', args: [] })).toBe(true);
  expect(isScriptEvent({ kind: 'script-event', event: '', args: [] })).toBe(false);
  expect(isScriptEvent({ kind: 'script-event', event: 'x' })).toBe(false);
});
