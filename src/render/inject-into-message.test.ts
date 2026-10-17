import { test, expect, beforeEach } from 'bun:test';
import {
  clearEditingMessageIds,
  computeEditModeTransition,
  getEditingMessageIdsForTest,
  processNode,
  type EditTransition,
} from './inject-into-message';
import { computeVariablesSnapshot } from '../backend/mvu-parser';
import type { SpindleFrontendContext } from 'lumiverse-spindle-types';

function makeCard(messageId: string, inner: string): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute('data-message-id', messageId);
  el.innerHTML = inner;
  return el;
}

function editingCard(messageId: string): HTMLElement {
  // Lumiverse edit-mode shape: textarea, no [data-component="MessageContent"].
  return makeCard(messageId, '<div class="edit"><textarea autofocus></textarea></div>');
}

function normalCard(messageId: string, body = 'hello'): HTMLElement {
  return makeCard(
    messageId,
    `<div data-component="MessageContent" class="content">${body}</div>`,
  );
}

// Minimal ctx stub. With empty scripts the pipeline never touches createSandboxFrame
// or sendToBackend; getActiveChat() is only consulted if scripts have `{{` macros.
const stubCtx = {
  getActiveChat: () => ({ chatId: 'chat-test', characterId: 'char-test' }),
  dom: {
    createElement: (tag: string, attrs?: Record<string, string>) => {
      const el = document.createElement(tag);
      if (attrs) for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      return el;
    },
    createSandboxFrame: () => { throw new Error('createSandboxFrame should not run in these tests'); },
    cleanup: () => {},
  },
  events: { on: () => () => {} },
  messages: {
    registerTagInterceptor: () => () => {},
    registerMessageContentProcessor: () => () => {},
  },
  sendToBackend: async () => { throw new Error('sendToBackend should not run in these tests'); },
  onBackendMessage: () => () => {},
  permissions: {},
  manifest: {},
} as unknown as SpindleFrontendContext;

beforeEach(() => {
  clearEditingMessageIds();
});

// ─── computeEditModeTransition: pure state machine ───────────────────────

test('computeEditModeTransition: enter when textarea present, MessageContent absent, id not in set', () => {
  const set = new Set<string>();
  const root = editingCard('m1');
  expect(computeEditModeTransition(root, 'm1', set)).toBe('enter' as EditTransition);
  expect(set.has('m1')).toBe(true);
});

test('computeEditModeTransition: still when in edit mode and id already in set, set unchanged', () => {
  const set = new Set<string>(['m1']);
  const root = editingCard('m1');
  expect(computeEditModeTransition(root, 'm1', set)).toBe('still' as EditTransition);
  expect(set.has('m1')).toBe(true);
  expect(set.size).toBe(1);
});

test('computeEditModeTransition: exit when MessageContent back, id was in set', () => {
  const set = new Set<string>(['m1']);
  const root = normalCard('m1');
  expect(computeEditModeTransition(root, 'm1', set)).toBe('exit' as EditTransition);
  expect(set.has('m1')).toBe(false);
});

test('computeEditModeTransition: idle when not in edit mode and never was', () => {
  const set = new Set<string>();
  const root = normalCard('m1');
  expect(computeEditModeTransition(root, 'm1', set)).toBe('idle' as EditTransition);
  expect(set.size).toBe(0);
});

test('computeEditModeTransition: ambiguous DOM (both textarea AND MessageContent present) treated as not-in-edit-mode', () => {
  // Defensive: a renderer override or transient state could in principle have both.
  // The signal is conjunctive (textarea AND NO MessageContent), so this path yields idle.
  const set = new Set<string>();
  const root = makeCard(
    'm1',
    '<div data-component="MessageContent">x</div><textarea></textarea>',
  );
  expect(computeEditModeTransition(root, 'm1', set)).toBe('idle' as EditTransition);
  expect(set.size).toBe(0);
});

// ─── Set hygiene ─────────────────────────────────────────────────────────

test('clearEditingMessageIds: empties the module-scoped Set', () => {
  const root = editingCard('m1');
  computeEditModeTransition(root, 'm1', getEditingMessageIdsForTest() as Set<string>);
  expect(getEditingMessageIdsForTest().size).toBe(1);
  clearEditingMessageIds();
  expect(getEditingMessageIdsForTest().size).toBe(0);
});

// ─── processNode integration: pipeline gate ──────────────────────────────

test('processNode: enter transition adds id to Set and short-circuits (no pipeline work)', async () => {
  const root = editingCard('m1');
  expect(getEditingMessageIdsForTest().size).toBe(0);
  const total = await processNode(root, [], stubCtx);
  // No widgets to add: pipeline-or-no-pipeline both return 0 here. The
  // load-bearing observable is the Set state.
  expect(total).toBe(0);
  expect(getEditingMessageIdsForTest().has('m1')).toBe(true);
});

test('processNode: still editing on the second pass does not double-touch the Set or throw', async () => {
  const root = editingCard('m1');
  await processNode(root, [], stubCtx); // enter
  expect(getEditingMessageIdsForTest().has('m1')).toBe(true);
  await processNode(root, [], stubCtx); // still
  expect(getEditingMessageIdsForTest().has('m1')).toBe(true);
  expect(getEditingMessageIdsForTest().size).toBe(1);
});

test('processNode: exit transition removes id from Set and falls through to pipeline', async () => {
  // Seed the Set as if a prior enter pass ran.
  const enterRoot = editingCard('m2');
  await processNode(enterRoot, [], stubCtx);
  expect(getEditingMessageIdsForTest().has('m2')).toBe(true);

  // Now the same message id presents the post-edit DOM shape.
  const exitRoot = normalCard('m2', 'edited content');
  await processNode(exitRoot, [], stubCtx);
  expect(getEditingMessageIdsForTest().has('m2')).toBe(false);
});

test('processNode: idle (never edited) leaves the Set untouched', async () => {
  const root = normalCard('m3');
  await processNode(root, [], stubCtx);
  expect(getEditingMessageIdsForTest().size).toBe(0);
});

test('processNode: multiple messages tracked independently in the Set', async () => {
  const a = editingCard('a');
  const b = editingCard('b');
  const c = normalCard('c');
  await processNode(a, [], stubCtx);
  await processNode(b, [], stubCtx);
  await processNode(c, [], stubCtx);
  expect(getEditingMessageIdsForTest().has('a')).toBe(true);
  expect(getEditingMessageIdsForTest().has('b')).toBe(true);
  expect(getEditingMessageIdsForTest().has('c')).toBe(false);

  // Save/cancel on `a` -- transition to exit.
  await processNode(normalCard('a', 'saved'), [], stubCtx);
  expect(getEditingMessageIdsForTest().has('a')).toBe(false);
  expect(getEditingMessageIdsForTest().has('b')).toBe(true);
});

// ─── MVU invariant: state lives in message content, not the iframe ───────

test('MVU snapshot determinism: same message content yields the same stat_data across calls', async () => {
  // Encodes the user's MVU concern. Tearing down a widget on edit and
  // remounting it on exit cannot lose variable state because the state
  // was never in the widget -- computeVariablesSnapshot reads it from the
  // persisted message content, which the teardown does not touch.
  const msgs = [
    {
      content:
        '<UpdateVariable><initvar>\nrep: 42\nlocation: dorm\n</initvar></UpdateVariable>',
    },
    {
      content:
        "<UpdateVariable>\n_.set('rep', 42, 50);\n_.set('location', 'dorm', 'library');\n</UpdateVariable>",
    },
  ];
  const snap1 = await computeVariablesSnapshot(msgs);
  // Simulate the enter/exit teardown surface: nothing about computeVariablesSnapshot's
  // inputs has changed.
  const snap2 = await computeVariablesSnapshot(msgs);
  expect(snap1).toEqual(snap2);
  expect(snap1.stat_data).toEqual({ rep: 50, location: 'library' });
});

test('placeByRawOrder follows the stored message order', async () => {
  const { placeByRawOrder } = await import('./inject-into-message');
  const { compileScripts } = await import('../core/parse-regex-script');
  const scripts = compileScripts([
    { id: 'home', scriptName: 'home', findRegex: '【HOME】', replaceString: '<b>h</b>' },
    { id: 'bar', scriptName: 'bar', findRegex: '<bar>(.*?)</bar>', replaceString: '<i>$1</i>' },
  ]);
  const text = 'Intro text\n<bar>x</bar>\n【HOME】\n';
  const pos = { text, start: text.indexOf('<bar>'), end: text.indexOf('</bar>') + 6 };
  const root = document.createElement('div');
  root.innerHTML = '<p>Intro text</p><p><iframe data-vishrun-widget="home" data-vishrun-script-id="home"></iframe></p>';
  const bar = document.createElement('iframe');
  bar.setAttribute('data-vishrun-widget', 'bar');
  placeByRawOrder(root, bar, pos, scripts, [{ scriptId: 'bar', fullMatch: '<bar>x</bar>' }]);
  expect(bar.nextElementSibling?.getAttribute('data-vishrun-script-id')).toBe('home');

  const lead = document.createElement('iframe');
  const t2 = '  <bar>y</bar> rest';
  placeByRawOrder(root, lead, { text: t2, start: 2, end: 14 }, scripts, []);
  expect(root.firstChild).toBe(lead);
});

test('firstScriptPerBlock keeps the earlier script when two match the same block', async () => {
  const { firstScriptPerBlock } = await import('./inject-into-message');
  const scripts = [{ id: 'night', sourceIndex: 1 }, { id: 'day', sourceIndex: 2 }] as never;
  const caps = [
    { scriptId: 'day', fullMatch: '<status>x</status>' },
    { scriptId: 'night', fullMatch: '<status>x</status>' },
    { scriptId: 'day', fullMatch: '<other>y</other>' },
  ];
  expect(firstScriptPerBlock(caps, scripts).map((c) => c.scriptId + ':' + c.fullMatch)).toEqual(['night:<status>x</status>', 'day:<other>y</other>']);
});
