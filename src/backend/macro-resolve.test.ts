import { test, expect, mock } from 'bun:test';
import { applyAndStripSetvars } from './macro-resolve';
import type { VarsApi } from './setvar-ops';

interface Call { scope: 'local' | 'chat' | 'global'; args: unknown[] }

interface FakeVarsOpts {
  throwOn?: { scope: 'local' | 'chat' | 'global'; key: string };
  initial?: { local?: Record<string, string>; chat?: Record<string, string> };
  listThrowsOn?: 'local' | 'chat';
}

function makeFakeVars(opts?: FakeVarsOpts): { vars: VarsApi; calls: Call[] } {
  const calls: Call[] = [];
  const state = {
    local: { ...(opts?.initial?.local ?? {}) } as Record<string, string>,
    chat: { ...(opts?.initial?.chat ?? {}) } as Record<string, string>,
  };
  const mkSet = (scope: 'local' | 'chat' | 'global') => async (...args: unknown[]) => {
    const keyArg = scope === 'global' ? args[0] : args[1];
    if (opts?.throwOn && opts.throwOn.scope === scope && opts.throwOn.key === keyArg) {
      throw new Error(`fake set throws for ${scope}/${keyArg}`);
    }
    calls.push({ scope, args });
    if (scope === 'local' || scope === 'chat') {
      state[scope][args[1] as string] = args[2] as string;
    }
  };
  const mkList = (scope: 'local' | 'chat') => async (_chatId: string) => {
    if (opts?.listThrowsOn === scope) throw new Error(`fake list throws for ${scope}`);
    return { ...state[scope] };
  };
  const vars = {
    local: { set: mkSet('local'), list: mkList('local') },
    chat: { set: mkSet('chat'), list: mkList('chat') },
    global: { set: mkSet('global') },
  } as unknown as VarsApi;
  return { vars, calls };
}

const CHAT = 'chatX';
const USER = 'userX';

test('single setvar writes the chat variables and is stripped', async () => {
  const { vars, calls } = makeFakeVars();
  const out = await applyAndStripSetvars('{{setvar::yen::5000}}foo', CHAT, USER, vars);
  expect(out).toBe('foo');
  expect(calls).toEqual([{ scope: 'chat', args: [CHAT, 'yen', '5000'] }]);
});

test('multiple setvars apply in order and are all stripped', async () => {
  const { vars, calls } = makeFakeVars();
  const out = await applyAndStripSetvars('{{setvar::yen::5000}}{{setvar::grade::Grade 2}}foo', CHAT, USER, vars);
  expect(out).toBe('foo');
  expect(calls).toEqual([
    { scope: 'chat', args: [CHAT, 'yen', '5000'] },
    { scope: 'chat', args: [CHAT, 'grade', 'Grade 2'] },
  ]);
});

test('duplicate name applied in document order', async () => {
  const { vars, calls } = makeFakeVars();
  const out = await applyAndStripSetvars('{{setvar::yen::5000}}foo{{setvar::yen::6000}}bar', CHAT, USER, vars);
  expect(out).toBe('foobar');
  expect(calls).toEqual([
    { scope: 'chat', args: [CHAT, 'yen', '5000'] },
    { scope: 'chat', args: [CHAT, 'yen', '6000'] },
  ]);
});

test('invalid NAME left in template, not applied', async () => {
  const { vars, calls } = makeFakeVars();
  const out = await applyAndStripSetvars('{{setvar::1bad::x}}foo', CHAT, USER, vars);
  expect(out).toBe('{{setvar::1bad::x}}foo');
  expect(calls).toEqual([]);
});

test('setgvar disabled — not stripped, no call', async () => {
  const restoreDebug = console.debug;
  console.debug = mock(() => {});
  try {
    const { vars, calls } = makeFakeVars();
    const out = await applyAndStripSetvars('{{setgvar::level::99}}foo', CHAT, USER, vars);
    expect(out).toBe('{{setgvar::level::99}}foo');
    expect(calls).toEqual([]);
  } finally {
    console.debug = restoreDebug;
  }
});

test('setglobalvar disabled — not stripped, no call', async () => {
  const restoreDebug = console.debug;
  console.debug = mock(() => {});
  try {
    const { vars, calls } = makeFakeVars();
    const out = await applyAndStripSetvars('{{setglobalvar::level::99}}foo', CHAT, USER, vars);
    expect(out).toBe('{{setglobalvar::level::99}}foo');
    expect(calls).toEqual([]);
  } finally {
    console.debug = restoreDebug;
  }
});

test('setchatvar routes to chat namespace', async () => {
  const { vars, calls } = makeFakeVars();
  const out = await applyAndStripSetvars('{{setchatvar::loc::Tokyo}}foo', CHAT, USER, vars);
  expect(out).toBe('foo');
  expect(calls).toEqual([{ scope: 'chat', args: [CHAT, 'loc', 'Tokyo'] }]);
});

test('JSX inline style untouched, setvar stripped', async () => {
  const { vars, calls } = makeFakeVars();
  const input = `<div style={{position:'absolute'}}>{{setvar::yen::5000}}</div>`;
  const out = await applyAndStripSetvars(input, CHAT, USER, vars);
  expect(out).toBe(`<div style={{position:'absolute'}}></div>`);
  expect(calls).toEqual([{ scope: 'chat', args: [CHAT, 'yen', '5000'] }]);
});

test('empty value', async () => {
  const { vars, calls } = makeFakeVars();
  const out = await applyAndStripSetvars('{{setvar::yen::}}foo', CHAT, USER, vars);
  expect(out).toBe('foo');
  expect(calls).toEqual([{ scope: 'chat', args: [CHAT, 'yen', ''] }]);
});

test('set throws → match not stripped', async () => {
  const restoreWarn = console.warn;
  console.warn = mock(() => {});
  try {
    const { vars, calls } = makeFakeVars({ throwOn: { scope: 'chat', key: 'yen' } });
    const out = await applyAndStripSetvars('{{setvar::yen::5000}}foo', CHAT, USER, vars);
    expect(out).toBe('{{setvar::yen::5000}}foo');
    expect(calls).toEqual([]);
  } finally {
    console.warn = restoreWarn;
  }
});

test('mix setvar + getvar — setvar stripped, getvar untouched', async () => {
  const { vars, calls } = makeFakeVars();
  const out = await applyAndStripSetvars('{{setvar::yen::5000}}precio={{getvar::yen}}', CHAT, USER, vars);
  expect(out).toBe('precio={{getvar::yen}}');
  expect(calls).toEqual([{ scope: 'chat', args: [CHAT, 'yen', '5000'] }]);
});

// ── Idempotency (Corte 1) ──────────────────────────────────────────────────

test('idempotent setvar (same value already present) -> stripped, not written', async () => {
  const { vars, calls } = makeFakeVars({ initial: { chat: { yen: '5000' } } });
  const out = await applyAndStripSetvars('{{setvar::yen::5000}}foo', CHAT, USER, vars);
  expect(out).toBe('foo');
  expect(calls).toEqual([]);
});

test('idempotent setchatvar (same value already present) -> stripped, not written', async () => {
  const { vars, calls } = makeFakeVars({ initial: { chat: { loc: 'Tokyo' } } });
  const out = await applyAndStripSetvars('{{setchatvar::loc::Tokyo}}foo', CHAT, USER, vars);
  expect(out).toBe('foo');
  expect(calls).toEqual([]);
});

test('different value -> written (not idempotent)', async () => {
  const { vars, calls } = makeFakeVars({ initial: { chat: { yen: '5000' } } });
  const out = await applyAndStripSetvars('{{setvar::yen::6000}}foo', CHAT, USER, vars);
  expect(out).toBe('foo');
  expect(calls).toEqual([{ scope: 'chat', args: [CHAT, 'yen', '6000'] }]);
});

test('variable not present yet -> written', async () => {
  const { vars, calls } = makeFakeVars({ initial: { chat: {} } });
  const out = await applyAndStripSetvars('{{setvar::yen::5000}}foo', CHAT, USER, vars);
  expect(out).toBe('foo');
  expect(calls).toEqual([{ scope: 'chat', args: [CHAT, 'yen', '5000'] }]);
});

test('multiple setvars mixed: some idempotent, some new -> only new written, all stripped', async () => {
  const { vars, calls } = makeFakeVars({ initial: { chat: { yen: '5000', grade: 'Grade 2' } } });
  const template = '{{setvar::yen::5000}}{{setvar::grade::Grade 3}}{{setvar::rep::5}}foo';
  const out = await applyAndStripSetvars(template, CHAT, USER, vars);
  expect(out).toBe('foo');
  expect(calls).toEqual([
    { scope: 'chat', args: [CHAT, 'grade', 'Grade 3'] },
    { scope: 'chat', args: [CHAT, 'rep', '5'] },
  ]);
});

test('list() throws -> safe fallback: writes proceed', async () => {
  const { vars, calls } = makeFakeVars({ initial: { chat: { yen: '5000' } }, listThrowsOn: 'chat' });
  const out = await applyAndStripSetvars('{{setvar::yen::5000}}foo', CHAT, USER, vars);
  expect(out).toBe('foo');
  expect(calls).toEqual([{ scope: 'chat', args: [CHAT, 'yen', '5000'] }]);
});

test('list() called once even with many matches for same scope', async () => {
  let listCallCount = 0;
  const state: Record<string, string> = {};
  const vars = {
    local: { set: async () => {}, list: async () => ({}) },
    chat: {
      set: async (_chatId: string, key: string, value: string) => { state[key] = value; },
      list: async () => { listCallCount++; return { ...state }; },
    },
    global: { set: async () => {} },
  } as unknown as VarsApi;
  await applyAndStripSetvars('{{setvar::a::1}}{{setvar::b::2}}{{setvar::c::3}}', CHAT, USER, vars);
  expect(listCallCount).toBe(1);
});

test('list() not called when no setvar/setchatvar matches', async () => {
  let listCallCount = 0;
  const vars = {
    local: { set: async () => {}, list: async () => { listCallCount++; return {}; } },
    chat: { set: async () => {}, list: async () => { listCallCount++; return {}; } },
    global: { set: async () => {} },
  } as unknown as VarsApi;
  await applyAndStripSetvars('no setvars here {{getvar::yen}}', CHAT, USER, vars);
  expect(listCallCount).toBe(0);
});

test('setvar and setchatvar share one chat list, local is never read', async () => {
  let localListed = 0;
  let chatListed = 0;
  const vars = {
    local: { set: async () => {}, list: async () => { localListed++; return {}; } },
    chat: { set: async () => {}, list: async () => { chatListed++; return {}; } },
    global: { set: async () => {} },
  } as unknown as VarsApi;
  await applyAndStripSetvars('{{setvar::a::1}}{{setchatvar::loc::Tokyo}}', CHAT, USER, vars);
  expect(chatListed).toBe(1);
  expect(localListed).toBe(0);
});

test('idempotent skip updates local view: second match against same key sees current value', async () => {
  const { vars, calls } = makeFakeVars({ initial: { chat: { yen: '5000' } } });
  // First match: idempotent. Second: same value (still 5000), also idempotent.
  const out = await applyAndStripSetvars('{{setvar::yen::5000}}a{{setvar::yen::5000}}b', CHAT, USER, vars);
  expect(out).toBe('ab');
  expect(calls).toEqual([]);
});

test('first write updates local view so subsequent same-value match is idempotent', async () => {
  const { vars, calls } = makeFakeVars({ initial: { chat: {} } });
  const out = await applyAndStripSetvars('{{setvar::yen::5000}}a{{setvar::yen::5000}}b', CHAT, USER, vars);
  expect(out).toBe('ab');
  expect(calls).toEqual([{ scope: 'chat', args: [CHAT, 'yen', '5000'] }]);
});

// ── Per-chat mutex (race condition across concurrent invocations) ─────────

test('concurrent invocations on the same chat: only the first writes, the rest skip', async () => {
  const { vars, calls } = makeFakeVars({ initial: { chat: {} } });
  const tpl = '{{setvar::yen::5000}}foo';
  const [a, b, c] = await Promise.all([
    applyAndStripSetvars(tpl, CHAT, USER, vars),
    applyAndStripSetvars(tpl, CHAT, USER, vars),
    applyAndStripSetvars(tpl, CHAT, USER, vars),
  ]);
  expect(a).toBe('foo');
  expect(b).toBe('foo');
  expect(c).toBe('foo');
  expect(calls).toEqual([{ scope: 'chat', args: [CHAT, 'yen', '5000'] }]);
});

test('concurrent invocations on different chats run independently (no cross-chat serialization)', async () => {
  const { vars, calls } = makeFakeVars({ initial: { chat: {} } });
  await Promise.all([
    applyAndStripSetvars('{{setvar::yen::5000}}', 'chatA', USER, vars),
    applyAndStripSetvars('{{setvar::yen::7000}}', 'chatB', USER, vars),
  ]);
  expect(calls).toEqual(expect.arrayContaining([
    { scope: 'chat', args: ['chatA', 'yen', '5000'] },
    { scope: 'chat', args: ['chatB', 'yen', '7000'] },
  ]));
  expect(calls).toHaveLength(2);
});

test('mutex survives an error in a prior call: next call still runs', async () => {
  const restoreWarn = console.warn;
  console.warn = mock(() => {});
  try {
    const { vars, calls } = makeFakeVars({ initial: { chat: {} }, throwOn: { scope: 'chat', key: 'a' } });
    const results = await Promise.allSettled([
      applyAndStripSetvars('{{setvar::a::1}}x', CHAT, USER, vars),
      applyAndStripSetvars('{{setvar::b::2}}y', CHAT, USER, vars),
    ]);
    expect(results[0].status).toBe('fulfilled');
    expect(results[1].status).toBe('fulfilled');
    expect(calls).toEqual([{ scope: 'chat', args: [CHAT, 'b', '2'] }]);
  } finally {
    console.warn = restoreWarn;
  }
});
