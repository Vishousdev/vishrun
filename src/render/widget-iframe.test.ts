import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveCurrentMessageIndex } from './widget-iframe';
import type { SnapshotMessage } from '../backend/th-helpers';

function makeSnap(ids: string[]): SnapshotMessage[] {
  return ids.map((id, i) => ({
    id,
    message_id: i,
    name: i === 0 ? 'char' : 'user',
    role: 'assistant',
    is_hidden: false,
    message: `content-${i}`,
    swipe_id: 0,
    swipes: [`content-${i}`],
    data: {},
    extra: {},
  }));
}

test('resolveCurrentMessageIndex: messageId at snapshot position 0 -> 0, source snapshot', () => {
  const snap = makeSnap(['msg-greeting', 'msg-user', 'msg-llm']);
  expect(resolveCurrentMessageIndex('msg-greeting', snap, 99)).toEqual({ index: 0, source: 'snapshot' });
});

test('resolveCurrentMessageIndex: messageId at snapshot position 2 -> 2, source snapshot (DOM has phantoms)', () => {
  // DOM index claims 4 (phantoms in the DOM: hidden system rows, virtual-scroll
  // placeholders). Real DB position is 2. The fix returns 2.
  const snap = makeSnap(['msg-greeting', 'msg-user', 'msg-llm']);
  expect(resolveCurrentMessageIndex('msg-llm', snap, 4)).toEqual({ index: 2, source: 'snapshot' });
});

test('resolveCurrentMessageIndex: messageId not in snapshot -> falls back to dom index', () => {
  const snap = makeSnap(['msg-greeting', 'msg-user']);
  // Streaming race: new LLM message not yet in snapshot.
  expect(resolveCurrentMessageIndex('msg-llm-fresh', snap, 4)).toEqual({ index: 4, source: 'dom-fallback' });
});

test('resolveCurrentMessageIndex: empty snapshot -> dom-fallback', () => {
  expect(resolveCurrentMessageIndex('any-id', [], 0)).toEqual({ index: 0, source: 'dom-fallback' });
});

test('resolveCurrentMessageIndex: dom index of -1 (DOM lookup also failed) propagates as fallback', () => {
  const snap = makeSnap(['msg-a']);
  expect(resolveCurrentMessageIndex('not-present', snap, -1)).toEqual({ index: -1, source: 'dom-fallback' });
});

test('resolveCurrentMessageIndex: greeting case is identity (DOM 0, snap 0)', () => {
  const snap = makeSnap(['msg-greeting']);
  expect(resolveCurrentMessageIndex('msg-greeting', snap, 0)).toEqual({ index: 0, source: 'snapshot' });
});

test('resolveCurrentMessageIndex: duplicate ids in snapshot -> findIndex returns first match', () => {
  // Defensive: shouldn't happen in practice (UUIDs are unique). If it
  // ever does, the function picks the first occurrence rather than
  // throwing.
  const snap = makeSnap(['dup', 'dup', 'dup']);
  expect(resolveCurrentMessageIndex('dup', snap, 99)).toEqual({ index: 0, source: 'snapshot' });
});

// ─── widget iframe sandbox-flag seam ─────────────────────────────────────
//
// Source-text guard. The seam under test sits inside buildWidgetIframe and
// must run while frame.element is still detached from the DOM, because
// browsers consult the sandbox attribute at insertion time. Exercising
// buildWidgetIframe end-to-end would require booting the snapshot fetchers,
// shim injection and size-reporter scaffolding, which is disproportionate
// for one line. We instead assert the literal call exists with the exact
// flag set and sits in the detached window between the data-* setAttribute
// chain and the iframe.style.margin write. Covers: line removal, token
// drift, accidental relocation past the styling block. Does NOT cover a
// future change that inserts an appendChild between the data-* attrs and
// the sandbox attr.
test('widget-iframe.ts: sandbox is widened to the four-token set in the detached seam', () => {
  const src = readFileSync(join(__dirname, 'widget-iframe.ts'), 'utf8');
  const msgIdIdx = src.indexOf("setAttribute('data-vishrun-message-id'");
  const sandboxIdx = src.indexOf(
    "setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-forms')"
  );
  const marginIdx = src.indexOf('iframe.style.margin =');
  expect(msgIdIdx).toBeGreaterThan(-1);
  expect(sandboxIdx).toBeGreaterThan(-1);
  expect(marginIdx).toBeGreaterThan(-1);
  expect(sandboxIdx).toBeGreaterThan(msgIdIdx);
  expect(sandboxIdx).toBeLessThan(marginIdx);
});
