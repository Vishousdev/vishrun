import { api } from './common';
import { handleGetVariablesSnapshot } from './th-helpers';

// JS-Slash-Runner prompt macros over MVU message variables:
//   {{get_message_variable::path}}    string as-is, anything else as JSON
//   {{format_message_variable::path}} string as-is, anything else as YAML
// Keys starting with "$" are omitted, a missing path yields null.

export function toPath(path: string): string[] {
  const out: string[] = [];
  const re = /\[(?:'([^']*)'|"([^"]*)"|([^\]]*))\]|([^.[\]]+)/g;
  for (const m of path.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3] ?? m[4]);
  return out;
}

export function getAtPath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const seg of toPath(path.trim())) {
    if (cur === null || typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[seg];
    if (cur === undefined) return null;
  }
  return cur === undefined ? null : cur;
}

export function omitDollarKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(omitDollarKeys);
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (!k.startsWith('$')) out[k] = omitDollarKeys(x);
    return out;
  }
  return v;
}

const PLAIN_RE = /^[^\s\-?:,[\]{}#&*!|>'"%@`][^:#\n]*$/;
const RESERVED_RE = /^(?:true|false|null|~|yes|no|on|off|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?|0x[0-9a-f]+|\.inf|\.nan)$/i;

function yamlString(s: string, indent: string): string {
  if (s.includes('\n')) {
    const body = s.replace(/\n+$/, '').split('\n').map((l) => (l ? indent + '  ' + l : '')).join('\n');
    return (s.endsWith('\n') ? '|' : '|-') + '\n' + body;
  }
  if (s === '' || !PLAIN_RE.test(s) || /\s$/.test(s) || RESERVED_RE.test(s)) return JSON.stringify(s);
  return s;
}

function yamlKey(k: string): string {
  return k !== '' && PLAIN_RE.test(k) && !/\s$/.test(k) && !RESERVED_RE.test(k) ? k : JSON.stringify(k);
}

function yamlScalar(v: unknown, indent: string): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return yamlString(v, indent);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

function isNode(v: unknown): v is Record<string, unknown> | unknown[] {
  return v !== null && typeof v === 'object' && (Array.isArray(v) ? v.length > 0 : Object.keys(v).length > 0);
}

function yamlLines(v: unknown, indent: string): string {
  if (Array.isArray(v)) {
    if (v.length === 0) return indent + '[]';
    return v.map((item) => {
      if (!isNode(item)) return `${indent}- ${Array.isArray(item) ? '[]' : item !== null && typeof item === 'object' ? '{}' : yamlScalar(item, indent)}`;
      const inner = yamlLines(item, indent + '  ');
      return `${indent}- ${inner.slice(indent.length + 2)}`;
    }).join('\n');
  }
  if (v !== null && typeof v === 'object') {
    const entries = Object.entries(v);
    if (entries.length === 0) return indent + '{}';
    return entries.map(([k, x]) => {
      if (isNode(x)) return `${indent}${yamlKey(k)}:\n${yamlLines(x, indent + '  ')}`;
      const empty = Array.isArray(x) ? '[]' : x !== null && typeof x === 'object' ? '{}' : yamlScalar(x, indent);
      return `${indent}${yamlKey(k)}: ${empty}`;
    }).join('\n');
  }
  return indent + yamlScalar(v, indent);
}

export function toYaml(v: unknown): string {
  return yamlLines(v, '').trimEnd();
}

export function formatVariable(data: unknown, path: string, mode: 'json' | 'yaml'): string {
  const value = omitDollarKeys(getAtPath(data, path));
  if (typeof value === 'string') return value;
  return mode === 'json' ? JSON.stringify(value) : toYaml(value);
}

interface MacroCtx {
  args?: unknown[];
  chatId?: string;
  userId?: string;
  env?: { chat?: { messageCount?: unknown } };
}

// Macro calls carry no userId, but character reads need one. Remember the
// owner of each chat from frontend traffic, plus the latest user as fallback.
const chatOwners = new Map<string, string>();
let lastUserId: string | undefined;

function rememberOwner(payload: unknown, userId: string): void {
  if (typeof userId !== 'string' || !userId) return;
  lastUserId = userId;
  const chatId = (payload as { chatId?: unknown } | null)?.chatId;
  if (typeof chatId === 'string' && chatId) chatOwners.set(chatId, userId);
}

function macroHandler(mode: 'json' | 'yaml') {
  return async (ctx: unknown): Promise<string> => {
    const c = (ctx ?? {}) as MacroCtx;
    const path = typeof c.args?.[0] === 'string' ? c.args[0] : '';
    if (!c.chatId) return '';
    const userId = c.userId ?? chatOwners.get(c.chatId) ?? lastUserId;
    const count = c.env?.chat?.messageCount;
    const data = await handleGetVariablesSnapshot(
      c.chatId, userId as string, undefined, undefined, undefined,
      typeof count === 'number' ? count : undefined,
    );
    return formatVariable(data, path, mode);
  };
}

export function installMvuMacros(): void {
  api.onFrontendMessage((payload, userId) => rememberOwner(payload, userId));
  const reg = api.registerMacro as unknown as (def: Record<string, unknown>) => void;
  reg({
    name: 'get_message_variable',
    category: 'Vishrun',
    description: 'MVU message variable at a path, as JSON.',
    args: [{ name: 'path', required: true }],
    volatile: true,
    handler: macroHandler('json'),
  });
  reg({
    name: 'format_message_variable',
    category: 'Vishrun',
    description: 'MVU message variable at a path, as YAML.',
    args: [{ name: 'path', required: true }],
    volatile: true,
    handler: macroHandler('yaml'),
  });
}

