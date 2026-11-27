import { test, expect, mock } from 'bun:test';
import { dispatchSlashText } from './dispatch-slash';
import type { VarsApi } from './setvar-ops';

interface VarCall { scope: 'local' | 'chat' | 'global'; args: unknown[] }
interface AppendCall { chatId: string; role: string; content: string }

function makeFakes() {
  const varCalls: VarCall[] = [];
  const mk = (scope: 'local' | 'chat' | 'global') => async (...args: unknown[]) => {
    varCalls.push({ scope, args });
  };
  const vars = {
    local: { set: mk('local') },
    chat: { set: mk('chat') },
    global: { set: mk('global') },
  } as unknown as VarsApi;
  const appendCalls: AppendCall[] = [];
  const appendMessage = async (chatId: string, msg: { role: 'system' | 'user' | 'assistant'; content: string }) => {
    appendCalls.push({ chatId, role: msg.role, content: msg.content });
    return { id: 'fake-id' };
  };
  return { vars, varCalls, appendMessage, appendCalls };
}

const CHAT = 'chatX';
const USER = 'userX';

test('single /setvar', async () => {
  const { vars, varCalls, appendMessage, appendCalls } = makeFakes();
  const result = await dispatchSlashText('/setvar key=yen 5000', CHAT, USER, { vars, appendMessage });
  expect(result).toEqual({ handled: true, kind: 'setvar_chain' });
  expect(varCalls).toEqual([{ scope: 'chat', args: [CHAT, 'yen', '5000'] }]);
  expect(appendCalls).toEqual([]);
});

test('chained /setvar pairs in document order', async () => {
  const { vars, varCalls, appendMessage } = makeFakes();
  const result = await dispatchSlashText('/setvar key=yen 5000 | /setvar key=grade "Grade 2"', CHAT, USER, { vars, appendMessage });
  expect(result).toEqual({ handled: true, kind: 'setvar_chain' });
  expect(varCalls).toEqual([
    { scope: 'chat', args: [CHAT, 'yen', '5000'] },
    { scope: 'chat', args: [CHAT, 'grade', 'Grade 2'] },
  ]);
});

test('/sys with body appends system message', async () => {
  const { vars, appendMessage, appendCalls } = makeFakes();
  const result = await dispatchSlashText('/sys [ANNOUNCEMENT] body text', CHAT, USER, { vars, appendMessage });
  expect(result).toEqual({ handled: true, kind: 'sys_message' });
  expect(appendCalls).toEqual([{ chatId: CHAT, role: 'system', content: '[ANNOUNCEMENT] body text' }]);
});

test('/sys alone produces empty system message', async () => {
  const { vars, appendMessage, appendCalls } = makeFakes();
  const result = await dispatchSlashText('/sys', CHAT, USER, { vars, appendMessage });
  expect(result).toEqual({ handled: true, kind: 'sys_message' });
  expect(appendCalls).toEqual([{ chatId: CHAT, role: 'system', content: '' }]);
});

test('mix /setvar + /setgvar applies chat, skips gvar, handled true', async () => {
  // varsLog.debug fires in the gvar skip branch; swallow so test output stays clean.
  const restoreDebug = console.debug;
  console.debug = mock(() => {});
  try {
    const { vars, varCalls, appendMessage } = makeFakes();
    const result = await dispatchSlashText('/setvar key=yen 5000 | /setgvar key=level 99', CHAT, USER, { vars, appendMessage });
    expect(result).toEqual({ handled: true, kind: 'setvar_chain' });
    expect(varCalls).toEqual([{ scope: 'chat', args: [CHAT, 'yen', '5000'] }]);
  } finally {
    console.debug = restoreDebug;
  }
});

test('non-matching plain URL returns handled false', async () => {
  const { vars, varCalls, appendMessage, appendCalls } = makeFakes();
  const result = await dispatchSlashText('https://example.com/foo', CHAT, USER, { vars, appendMessage });
  expect(result).toEqual({ handled: false, kind: 'none' });
  expect(varCalls).toEqual([]);
  expect(appendCalls).toEqual([]);
});

test('slash command not in whitelist returns handled false', async () => {
  const { vars, varCalls, appendMessage, appendCalls } = makeFakes();
  const result = await dispatchSlashText('/exec something', CHAT, USER, { vars, appendMessage });
  expect(result).toEqual({ handled: false, kind: 'none' });
  expect(varCalls).toEqual([]);
  expect(appendCalls).toEqual([]);
});
