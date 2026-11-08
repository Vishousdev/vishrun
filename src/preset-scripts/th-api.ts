import type { SpindleFrontendContext } from 'lumiverse-spindle-types';
import { presetRpc } from './rpc';
import { inputDialog, popupDialog, splitNamedArgs } from './dialogs';
import { clickSend, parseSlash, runStSlashCommand, setComposerText, splitPipeline } from '../render/slash-runner';
import { getCharacter, getChatMessages as hostChatMessages, updateMessageContent, type HostMessage } from '../lumiverse/host-api';
import { stIdOf } from './st-ids';
import { setMvuSchema } from './mvu-schema';
import {
  fromLorebookPatch, fromWorldbookEntry, hostIdOf, planReplace, toLorebookEntry, toWorldbookEntry,
  type ApplyPlan, type HostEntry,
} from './worldbook-format';
import { planRegexReplace, toTavernRegex, type HostRegexRow } from './regex-format';
import { resolveMacrosBatch } from '../core/macro-resolver';
import { cardGreetings, greetingIndex } from '../core/greetings';
import { getActiveCard } from '../state/active-card';

// JS-Slash-Runner globals for preset and character scripts. Sync getters (getVariables,
// getPreset, getLastMessageId) read caches that the runtime keeps fresh.

export const TAVERN_EVENTS: Record<string, string> = {
  APP_READY: 'app_ready',
  CHAT_CHANGED: 'chat_id_changed',
  SETTINGS_UPDATED: 'settings_updated',
  EXTENSION_SETTINGS_LOADED: 'extension_settings_loaded',
  CHATCOMPLETION_SOURCE_CHANGED: 'chatcompletion_source_changed',
  CHATCOMPLETION_MODEL_CHANGED: 'chatcompletion_model_changed',
  CONNECTION_PROFILE_LOADED: 'connection_profile_loaded',
  CONNECTION_PROFILE_UPDATED: 'connection_profile_updated',
  MAIN_API_CHANGED: 'main_api_changed',
  OAI_PRESET_CHANGED_AFTER: 'oai_preset_changed_after',
  PRESET_CHANGED: 'preset_changed',
  MESSAGE_SENT: 'message_sent',
  MESSAGE_RECEIVED: 'message_received',
  MESSAGE_EDITED: 'message_edited',
  MESSAGE_DELETED: 'message_deleted',
  MESSAGE_SWIPED: 'message_swiped',
  MESSAGE_UPDATED: 'message_updated',
  CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
  USER_MESSAGE_RENDERED: 'user_message_rendered',
  GENERATION_STARTED: 'generation_started',
  GENERATION_ENDED: 'generation_ended',
  GENERATION_STOPPED: 'generation_stopped',
  STREAM_TOKEN_RECEIVED: 'stream_token_received',
};

export interface PresetBlock {
  id: string;
  name?: string;
  enabled: boolean;
  role?: string;
  content?: string;
  [k: string]: unknown;
}

export interface PresetSnapshot {
  name: string;
  prefill: string;
  parameters: Record<string, unknown>;
  metadata: Record<string, unknown>;
  blocks: PresetBlock[];
}

type Listener = (...args: unknown[]) => unknown;

export interface ScriptButton { name: string; visible: boolean }

/** owner: preset id, or `character:<id>` for card scripts. */
export interface RuntimeScript { id: string; owner: string; data: Record<string, unknown> }

export interface RuntimeState {
  ctx: SpindleFrontendContext;
  presetId: string;
  presetName: string;
  characterId: string | null;
  preset: PresetSnapshot | null;
  /** Lumiverse block id → SillyTavern identifier, when known. */
  stIds: Record<string, string>;
  vars: { global: Record<string, unknown>; chat: Record<string, unknown>; character: Record<string, unknown> };
  messages: HostMessage[];
  character: Record<string, unknown> | null;
  /** The character's lorebook names and all lorebook names, for JSR's sync getters. */
  worldbooks: { primary: string | null; additional: string[]; all: string[] };
  /** Regex rows of the chat's character and the global ones, for JSR's sync getter. */
  regexes: { character: HostRegexRow[]; global: HostRegexRow[] };
  listeners: Map<string, Set<Listener>>;
  setButtons(scriptId: string, buttons: ScriptButton[]): void;
  getButtons(scriptId: string): ScriptButton[];
}

export function emit(state: RuntimeState, event: string, ...args: unknown[]): void {
  const set = state.listeners.get(event);
  if (!set) return;
  for (const fn of [...set]) {
    try { void Promise.resolve(fn(...args)).catch((e) => console.warn('[vishrun] preset script listener', e)); } catch (e) {
      console.warn('[vishrun] preset script listener', e);
    }
  }
}

export async function refreshPreset(state: RuntimeState): Promise<void> {
  const chatId = state.ctx.getActiveChat().chatId;
  state.preset = await presetRpc<PresetSnapshot | null>(state.ctx, 'get_preset', { chatId, presetId: state.presetId });
}

export async function refreshVars(state: RuntimeState): Promise<void> {
  const chatId = state.ctx.getActiveChat().chatId;
  const characterId = state.characterId;
  const [global, chat, character] = await Promise.all([
    presetRpc<Record<string, unknown>>(state.ctx, 'vars_get', { scope: 'global' }),
    chatId ? presetRpc<Record<string, unknown>>(state.ctx, 'vars_get', { scope: 'chat', chatId }) : Promise.resolve({}),
    characterId ? presetRpc<Record<string, unknown>>(state.ctx, 'vars_get', { scope: 'character', characterId }) : Promise.resolve({}),
  ]);
  state.vars = { global, chat, character };
}

export async function refreshCharacter(state: RuntimeState): Promise<void> {
  const id = state.ctx.getActiveChat().characterId;
  state.character = id ? ((await getCharacter(id).catch(() => null)) as Record<string, unknown> | null) : null;
}

export async function refreshWorldbooks(state: RuntimeState): Promise<void> {
  const chatId = state.ctx.getActiveChat().chatId;
  const [own, all] = await Promise.all([
    presetRpc<{ primary: string | null; additional: string[] }>(state.ctx, 'wb_char_names', { chatId }),
    presetRpc<string[]>(state.ctx, 'wb_all_names', {}),
  ]);
  state.worldbooks = { primary: own.primary, additional: own.additional, all };
}

export async function refreshRegexes(state: RuntimeState): Promise<void> {
  const chatId = state.ctx.getActiveChat().chatId;
  state.regexes = await presetRpc<RuntimeState['regexes']>(state.ctx, 'regex_rows', { chatId });
}

export async function refreshMessages(state: RuntimeState): Promise<void> {
  const chatId = state.ctx.getActiveChat().chatId;
  state.messages = chatId ? await hostChatMessages(chatId).catch(() => []) : [];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(target: Record<string, unknown>, src: Record<string, unknown>): Record<string, unknown> {
  for (const [k, v] of Object.entries(src)) {
    if (isPlainObject(v) && isPlainObject(target[k])) deepMerge(target[k] as Record<string, unknown>, v);
    else target[k] = v;
  }
  return target;
}

// Builds the ST preset shape JS-Slash-Runner scripts expect, with the original
// SillyTavern identifiers when they are known.
function toStPreset(p: PresetSnapshot, stIds: Record<string, string>): Record<string, unknown> {
  return {
    settings: { ...p.parameters },
    prompts: p.blocks.map((b) => ({
      ...b,
      id: stIdOf(b as { id: string; marker?: string | null }, stIds),
      name: b.name ?? '',
      enabled: b.enabled,
      role: b.role ?? 'system',
      content: b.content ?? '',
      position: { type: 'relative' },
    })),
    prompts_unused: [],
    extensions: { ...p.metadata },
  };
}

export function buildThApi(state: RuntimeState, script: RuntimeScript, win: Window) {
  const ctx = state.ctx;
  const clone = <T>(v: T): T => (v === undefined ? v : (win as unknown as { JSON: JSON }).JSON.parse(JSON.stringify(v)));
  const scriptVarsKey = `vishrun:preset-script-vars:${script.owner}:${script.id}`;

  const readScriptVars = (): Record<string, unknown> => {
    try {
      const raw = localStorage.getItem(scriptVarsKey);
      if (raw) return JSON.parse(raw);
    } catch { /* fall through */ }
    return { ...script.data };
  };

  const scopeOf = (opt: unknown): string => (isPlainObject(opt) && typeof opt.type === 'string' ? opt.type : 'chat');

  const getVars = (opt?: unknown): Record<string, unknown> => {
    const type = scopeOf(opt);
    if (type === 'global') return state.vars.global;
    if (type === 'script') return readScriptVars();
    if (type === 'chat') return state.vars.chat;
    if (type === 'character') return state.vars.character;
    return {};
  };

  const setVars = (vars: Record<string, unknown>, opt?: unknown): void => {
    const type = scopeOf(opt);
    const copy = JSON.parse(JSON.stringify(vars ?? {}));
    if (type === 'script') {
      try { localStorage.setItem(scriptVarsKey, JSON.stringify(copy)); } catch { /* quota */ }
      return;
    }
    if (type !== 'global' && type !== 'chat' && type !== 'character') return;
    if (type === 'character' && !state.characterId) return;
    state.vars[type] = copy;
    const chatId = ctx.getActiveChat().chatId;
    void presetRpc(ctx, 'vars_replace', { scope: type, chatId, characterId: state.characterId, vars: copy })
      .catch((e) => console.warn('[vishrun] preset script vars write', e));
  };

  const loadedName = () => state.presetName;
  const isActiveName = (name: unknown) => name === undefined || name === 'in_use' || name === state.presetName;

  const getPreset = (name?: unknown) => (isActiveName(name) && state.preset ? clone(toStPreset(state.preset, state.stIds)) : null);

  const applyPreset = async (next: unknown): Promise<void> => {
    if (!state.preset || !isPlainObject(next) || !Array.isArray(next.prompts)) return;
    const current = new Map(state.preset.blocks.map((b) => [b.id, b.enabled]));
    const blockOf = new Map(state.preset.blocks.map((b) => [stIdOf(b as { id: string; marker?: string | null }, state.stIds), b.id]));
    const changes: Record<string, boolean> = {};
    for (const p of next.prompts as { id?: unknown; enabled?: unknown }[]) {
      const raw = String(p?.id ?? '');
      const id = blockOf.get(raw) ?? raw;
      if (!current.has(id)) continue;
      const enabled = p.enabled !== false;
      if (current.get(id) !== enabled) changes[id] = enabled;
    }
    if (Object.keys(changes).length === 0) return;
    for (const b of state.preset.blocks) if (b.id in changes) b.enabled = changes[b.id];
    await presetRpc(ctx, 'set_block_states', { presetId: state.presetId, states: changes });
    await refreshPreset(state).catch(() => {});
  };

  const updatePresetWith = async (name: unknown, fn: (p: unknown) => unknown) => {
    if (!isActiveName(name) || !state.preset) return null;
    const draft = clone(toStPreset(state.preset, state.stIds));
    const result = (await fn(draft)) ?? draft;
    await applyPreset(result);
    return getPreset();
  };

  const setPreset = async (name: unknown, preset: unknown) => {
    if (isActiveName(name)) await applyPreset(preset);
  };

  const lastMessageId = () => state.messages.length - 1;

  // Lorebooks. Each call reads the book fresh, so concurrent edits elsewhere
  // are not overwritten from a stale copy.
  const wbRpc = <T>(op: string, args: Record<string, unknown>) =>
    presetRpc<T>(ctx, op, { chatId: ctx.getActiveChat().chatId, ...args });
  const entriesOf = (name: unknown) => wbRpc<HostEntry[]>('wb_entries', { name: String(name ?? '') });
  const applyTo = (name: unknown, plan: Partial<ApplyPlan>) =>
    wbRpc<{ entries: HostEntry[]; created: string[] }>('wb_apply', { name: String(name ?? ''), create: [], update: [], delete: [], ...plan });
  const isCurrentChar = (name: unknown) =>
    name === undefined || name === 'current' || (state.character !== null && name === state.character.name);
  const charBooks = (name: unknown) =>
    clone(isCurrentChar(name)
      ? { primary: state.worldbooks.primary, additional: state.worldbooks.additional }
      : { primary: null, additional: [] });
  const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

  // Regexes. JSR's `type` option, or its older `scope` + `enable_state` form,
  // which tags each regex with its scope.
  const presetRows = () => state.regexes.global.filter((r) => r.preset_id && r.preset_id === state.presetId);
  const globalRows = () => state.regexes.global.filter((r) => !r.preset_id);
  const regexesFor = (opt: unknown): unknown[] => {
    const o = isPlainObject(opt) ? opt : {};
    if (typeof o.type === 'string') {
      if (o.type === 'character') return isCurrentChar(o.name) ? state.regexes.character.map(toTavernRegex) : [];
      if (o.type === 'preset') return o.name === undefined || o.name === 'in_use' || o.name === state.presetName ? presetRows().map(toTavernRegex) : [];
      return globalRows().map(toTavernRegex);
    }
    const scope = typeof o.scope === 'string' ? o.scope : 'all';
    let out: Record<string, unknown>[] = [];
    if (scope === 'all' || scope === 'global') out = out.concat(globalRows().map((r) => ({ ...toTavernRegex(r), scope: 'global' })));
    if (scope === 'all' || scope === 'character') out = out.concat(state.regexes.character.map((r) => ({ ...toTavernRegex(r), scope: 'character' })));
    if (o.enable_state === 'enabled' || o.enable_state === 'disabled') out = out.filter((r) => r.enabled === (o.enable_state === 'enabled'));
    return out;
  };
  const getTavernRegexes = (opt?: unknown) => clone(regexesFor(opt));
  const applyRegexes = async (scope: 'global' | 'character', rows: HostRegexRow[], next: unknown[]) => {
    const plan = planRegexReplace(rows, next);
    if (plan.create.length === 0 && plan.update.length === 0) return;
    await presetRpc(ctx, 'regex_apply', { chatId: ctx.getActiveChat().chatId, scope, ...plan });
  };
  // Adds and updates only; regexes left out of the list are kept.
  const replaceTavernRegexes = async (regexes: unknown, opt?: unknown) => {
    const o = isPlainObject(opt) ? opt : {};
    const items = list(regexes);
    if (typeof o.type === 'string') {
      if (o.type === 'character' && isCurrentChar(o.name)) await applyRegexes('character', state.regexes.character, items);
      else if (o.type === 'global') await applyRegexes('global', globalRows(), items);
    } else {
      const scope = typeof o.scope === 'string' ? o.scope : 'all';
      const isGlobal = (r: unknown) => isPlainObject(r) && r.scope === 'global';
      if (scope === 'all' || scope === 'global') await applyRegexes('global', globalRows(), items.filter(isGlobal));
      if (scope === 'all' || scope === 'character') await applyRegexes('character', state.regexes.character, items.filter((r) => !isGlobal(r)));
    }
    await refreshRegexes(state).catch(() => {});
    (ctx as { display?: { invalidate?: (vars: string[]) => void } }).display?.invalidate?.(['*']);
  };

  const resolveRange = (range: unknown): [number, number] => {
    const last = lastMessageId();
    const norm = (n: number) => (n < 0 ? last + 1 + n : n);
    if (typeof range === 'number') return [norm(range), norm(range)];
    const s = String(range ?? `0-${last}`).replace(/\{\{lastMessageId\}\}/g, String(last));
    const m = /^\s*(-?\d+)\s*(?:-\s*(-?\d+))?\s*$/.exec(s);
    if (!m) return [0, last];
    const a = norm(Number(m[1]));
    const b = m[2] !== undefined ? norm(Number(m[2])) : a;
    return [Math.min(a, b), Math.max(a, b)];
  };

  const getChatMessages = (range?: unknown, opt?: unknown) => {
    const [a, b] = resolveRange(range);
    const role = isPlainObject(opt) && typeof opt.role === 'string' ? opt.role : 'all';
    const withSwipes = isPlainObject(opt) && (opt.include_swipes === true || opt.include_swipe === true);
    const greetings = cardGreetings(getActiveCard());
    const out = [];
    for (let i = a; i <= b && i < state.messages.length; i++) {
      const m = state.messages[i];
      if (!m) continue;
      const r = m.is_user ? 'user' : m.role === 'system' ? 'system' : 'assistant';
      if (role !== 'all' && role !== r) continue;
      const row: Record<string, unknown> = { message_id: i, name: m.name ?? '', role: r, is_hidden: m.hidden === true, message: m.content, data: {}, extra: {} };
      if (withSwipes) {
        const greeting = i === 0 && !m.is_user && greetings.length > 1;
        row.swipe_id = greeting ? greetingIndex(m.content, greetings) : 0;
        row.swipes = greeting ? [...greetings] : [m.content];
        row.swipes_data = (row.swipes as string[]).map(() => ({}));
      }
      out.push(row);
    }
    return clone(out);
  };

  // SillyTavern macros Lumiverse has no equivalent for.
  const charAvatar = () => (state.character?.id ? `/api/v1/characters/${String(state.character.id)}/avatar` : '');
  const userAvatar = () => {
    try {
      const s = (ctx as unknown as { state?: { get(id: string): unknown } }).state;
      const id = s?.get('persona.activeId');
      return typeof id === 'string' && id ? `/api/v1/personas/${id}/avatar` : '';
    } catch {
      return '';
    }
  };
  const localMacros = (text: string) => text
    .replace(/\{\{lastMessageId\}\}/gi, String(lastMessageId()))
    .replace(/\{\{charAvatarPath\}\}/gi, charAvatar())
    .replace(/\{\{userAvatarPath\}\}/gi, userAvatar());
  const resolveMacros = async (text: string): Promise<string> => {
    const local = localMacros(text);
    const chatId = ctx.getActiveChat().chatId;
    if (!chatId || !local.includes('{{')) return local;
    const characterId = typeof state.character?.id === 'string' ? state.character.id : null;
    return (await resolveMacrosBatch(ctx, chatId, characterId, [local]).catch(() => [local]))[0] ?? local;
  };

  const triggerSlash = async (command: unknown): Promise<string> => {
    let pipe = '';
    for (const step of splitPipeline(String(command ?? ''))) {
      const parsed = parseSlash(step);
      if (!parsed) continue;
      const rest = parsed.rest.replace(/\{\{pipe\}\}/g, pipe);
      switch (parsed.name) {
        case 'pass':
          pipe = await resolveMacros(rest);
          break;
        case 'send':
        case 'setinput':
          setComposerText(rest);
          pipe = rest;
          break;
        case 'trigger':
          await clickSend();
          break;
        case 'input': {
          const { named, text } = splitNamedArgs(rest);
          pipe = await inputDialog(text, named.okButton, named.cancelButton);
          break;
        }
        case 'popup': {
          const { text } = splitNamedArgs(rest);
          pipe = await popupDialog(text);
          break;
        }
        default:
          if (!(await runStSlashCommand(parsed.name, rest, ctx.getActiveChat().chatId ?? null, (op, args) => presetRpc(ctx, op, args)))) {
            console.warn('[vishrun] preset script: unsupported slash command', parsed.name);
          } else if (parsed.name === 'echo') {
            pipe = splitNamedArgs(rest).text;
          }
      }
    }
    return pipe;
  };

  const toast = (kind: string) => (message: unknown, title?: unknown) => {
    void presetRpc(ctx, 'toast', { kind, message: String(message ?? ''), title: typeof title === 'string' ? title : undefined })
      .catch(() => {});
  };

  const on = (event: string, fn: Listener, once = false) => {
    let set = state.listeners.get(event);
    if (!set) state.listeners.set(event, (set = new Set()));
    const wrapped: Listener = once ? (...a) => { set!.delete(wrapped); return fn(...a); } : fn;
    set.add(wrapped);
    const stop = () => { set!.delete(wrapped); };
    return Object.assign(stop, { stop });
  };

  const buttonEvent = (name: unknown) => `vishrun_button:${script.id}:${String(name)}`;

  const normButtons = (list: unknown): ScriptButton[] =>
    Array.isArray(list)
      ? list.map((b) => (typeof b === 'string' ? { name: b, visible: true } : { name: String(b?.name ?? ''), visible: b?.visible !== false }))
        .filter((b) => b.name)
      : [];

  // Both (buttons) and (scriptId, buttons) call forms exist across JSR versions.
  const buttonsArg = (a: unknown, b: unknown) => normButtons(Array.isArray(a) ? a : b);

  const api: Record<string, unknown> = {
    getVariables: (opt?: unknown) => clone(getVars(opt)),
    getAllVariables: () => clone({ ...state.vars.global, ...state.vars.character, ...state.vars.chat }),
    replaceVariables: (vars: Record<string, unknown>, opt?: unknown) => setVars(vars, opt),
    updateVariablesWith: (fn: (v: Record<string, unknown>) => unknown, opt?: unknown) => {
      const draft = JSON.parse(JSON.stringify(getVars(opt)));
      const next = (fn(draft) as Record<string, unknown> | undefined) ?? draft;
      setVars(next, opt);
      return clone(next);
    },
    insertOrAssignVariables: (vars: Record<string, unknown>, opt?: unknown) => {
      const next = deepMerge(JSON.parse(JSON.stringify(getVars(opt))), JSON.parse(JSON.stringify(vars ?? {})));
      setVars(next, opt);
      return clone(next);
    },
    insertVariables: (vars: Record<string, unknown>, opt?: unknown) => {
      const next = deepMerge(JSON.parse(JSON.stringify(vars ?? {})), JSON.parse(JSON.stringify(getVars(opt))));
      setVars(next, opt);
      return clone(next);
    },
    deleteVariable: (path: string, opt?: unknown) => {
      const next = JSON.parse(JSON.stringify(getVars(opt)));
      const had = path in next;
      delete next[path];
      setVars(next, opt);
      return { variables: clone(next), delete_occurred: had };
    },
    getPreset,
    getPresetNames: () => [state.presetName],
    getLoadedPresetName: loadedName,
    loadPreset: (name: unknown) => isActiveName(name),
    updatePresetWith,
    setPreset,
    replacePreset: setPreset,
    getChatMessages,
    getTavernRegexes,
    replaceTavernRegexes,
    updateTavernRegexesWith: async (fn: (r: unknown[]) => unknown, opt?: unknown) => {
      const next = list(await fn(getTavernRegexes(opt)));
      await replaceTavernRegexes(next, opt);
      return clone(next);
    },
    isCharacterTavernRegexesEnabled: () => true,
    getCharWorldbookNames: charBooks,
    getCharLorebooks: (opt?: unknown) => charBooks(isPlainObject(opt) ? opt.name : undefined),
    getCurrentCharPrimaryLorebook: () => state.worldbooks.primary,
    getWorldbookNames: () => clone(state.worldbooks.all),
    getLorebooks: () => clone(state.worldbooks.all),
    getWorldbook: async (name: unknown) => clone((await entriesOf(name)).map(toWorldbookEntry)),
    replaceWorldbook: async (name: unknown, entries: unknown) => {
      await applyTo(name, planReplace(await entriesOf(name), list(entries)));
    },
    updateWorldbookWith: async (name: unknown, fn: (e: unknown[]) => unknown) => {
      const cur = await entriesOf(name);
      const next = await fn(clone(cur.map(toWorldbookEntry)));
      const r = await applyTo(name, planReplace(cur, list(next)));
      return clone(r.entries.map(toWorldbookEntry));
    },
    createWorldbookEntries: async (name: unknown, entries: unknown) => {
      const r = await applyTo(name, { create: list(entries).map(fromWorldbookEntry) });
      const all = r.entries.map(toWorldbookEntry);
      return clone({ worldbook: all, new_entries: all.filter((e) => r.created.includes(String(e.uid))) });
    },
    deleteWorldbookEntries: async (name: unknown, predicate: (e: unknown) => unknown) => {
      const cur = await entriesOf(name);
      const gone = cur.filter((e) => predicate(clone(toWorldbookEntry(e))));
      const r = await applyTo(name, { delete: gone.map((e) => e.id) });
      return clone({ worldbook: r.entries.map(toWorldbookEntry), deleted_entries: gone.map(toWorldbookEntry) });
    },
    getLorebookEntries: async (name: unknown) => clone((await entriesOf(name)).map(toLorebookEntry)),
    setLorebookEntries: async (name: unknown, entries: unknown) => {
      const cur = await entriesOf(name);
      const update = list(entries)
        .filter((e): e is Record<string, unknown> => isPlainObject(e) && hostIdOf(e.uid, cur) !== null)
        .map((e) => ({ id: hostIdOf(e.uid, cur) as string, patch: fromLorebookPatch(e) }));
      const r = await applyTo(name, { update });
      return clone(r.entries.map(toLorebookEntry));
    },
    createLorebookEntries: async (name: unknown, entries: unknown) => {
      const r = await applyTo(name, { create: list(entries).map(fromLorebookPatch) });
      return clone({ entries: r.entries.map(toLorebookEntry), new_uids: r.created });
    },
    deleteLorebookEntries: async (name: unknown, uids: unknown) => {
      const cur = await entriesOf(name);
      const gone = list(uids).map((u) => hostIdOf(u, cur)).filter((id): id is string => id !== null);
      const r = await applyTo(name, { delete: gone });
      return clone({ entries: r.entries.map(toLorebookEntry), delete_occurred: gone.length > 0 });
    },
    setChatMessages: async (msgs: unknown) => {
      if (!Array.isArray(msgs)) return;
      const chatId = ctx.getActiveChat().chatId;
      if (!chatId) return;
      const hide: string[] = [];
      const show: string[] = [];
      for (const m of msgs) {
        if (!isPlainObject(m)) continue;
        const target = state.messages[Number(m.message_id)];
        if (!target) continue;
        if (typeof m.is_hidden === 'boolean' && m.is_hidden !== (target.hidden === true)) (m.is_hidden ? hide : show).push(target.id);
        if (typeof m.message === 'string' && m.message !== target.content) await updateMessageContent(chatId, target.id, m.message);
      }
      if (hide.length) await presetRpc(ctx, 'set_hidden', { chatId, messageIds: hide, hidden: true });
      if (show.length) await presetRpc(ctx, 'set_hidden', { chatId, messageIds: show, hidden: false });
      await refreshMessages(state);
    },
    getLastMessageId: lastMessageId,
    retrieveDisplayedMessage: (id: unknown) => {
      const $ = (win as unknown as { $: (s: string) => unknown }).$;
      return $(`#chat > .mes[mesid="${Number(id)}"] .mes_text`);
    },
    getCharData: (name?: unknown) => {
      const c = state.character;
      if (!c || (name !== undefined && name !== 'current' && name !== c.name)) return null;
      return clone({ ...c, avatar: c.avatar ?? c.image_id ?? c.id, data: c });
    },
    getCurrentMessageId: lastMessageId,
    getScriptId: () => script.id,
    getButtonEvent: buttonEvent,
    getScriptButtons: () => clone(state.getButtons(script.id)),
    replaceScriptButtons: (a: unknown, b?: unknown) => state.setButtons(script.id, buttonsArg(a, b)),
    appendInexistentScriptButtons: (a: unknown, b?: unknown) => {
      const cur = state.getButtons(script.id);
      const add = buttonsArg(a, b).filter((x) => !cur.some((c) => c.name === x.name));
      state.setButtons(script.id, [...cur, ...add]);
    },
    updateScriptButtonsWith: (a: unknown, b?: unknown) => {
      const fn = (typeof a === 'function' ? a : b) as (x: ScriptButton[]) => unknown;
      const next = normButtons(fn(clone(state.getButtons(script.id))) ?? state.getButtons(script.id));
      state.setButtons(script.id, next);
      return clone(next);
    },
    triggerSlash,
    triggerSlashWithResult: triggerSlash,
    eventOn: (event: string, fn: Listener) => on(event, fn),
    eventOnce: (event: string, fn: Listener) => on(event, fn, true),
    eventMakeFirst: (event: string, fn: Listener) => on(event, fn),
    eventMakeLast: (event: string, fn: Listener) => on(event, fn),
    eventOnButton: (name: unknown, fn: Listener) => on(buttonEvent(name), fn),
    eventEmit: async (event: string, ...args: unknown[]) => emit(state, event, ...args),
    eventRemoveListener: (event: string, fn: Listener) => { state.listeners.get(event)?.delete(fn); },
    eventClearEvent: (event: string) => { state.listeners.delete(event); },
    tavern_events: { ...TAVERN_EVENTS },
    iframe_events: {},
    errorCatched: (fn: unknown) => fn,
    waitGlobalInitialized: async () => undefined,
    // JSR's version is synchronous, so only macros known locally resolve here.
    substitudeMacros: (text: unknown) => localMacros(String(text ?? ''))
      .replace(/\{\{char\}\}/gi, typeof state.character?.name === 'string' ? state.character.name : '{{char}}'),
    getTavernHelperVersion: () => '4.0.0',
    toastr: {
      success: toast('success'),
      info: toast('info'),
      warning: toast('warning'),
      error: toast('error'),
      clear: () => {},
      remove: () => {},
    },
  };

  // Model of the active connection, for scripts that pick modes by model.
  const activeModel = (): string => {
    try {
      const s = (ctx as unknown as { state?: { get(id: string): unknown } }).state;
      const a = s?.get('connections.active') as { model?: unknown } | undefined;
      return typeof a?.model === 'string' ? a.model : '';
    } catch {
      return '';
    }
  };

  const stContext = () => ({
    chatId: ctx.getActiveChat().chatId,
    characterId: undefined,
    characters: [],
    chat: [],
    chatCompletionSettings: undefined,
    mainApi: undefined,
    getPresetManager: () => undefined,
    saveSettingsDebounced: () => {},
    eventSource: { on: (e: string, fn: Listener) => on(e, fn), emit: async () => {} },
    event_types: { ...TAVERN_EVENTS },
  });

  api.SillyTavern = {
    getContext: stContext,
    characters: [],
    characterId: undefined,
    chatCompletionSettings: undefined,
    mainApi: undefined,
    getPresetManager: () => undefined,
    getChatCompletionModel: activeModel,
    isMobile: () => /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent),
    saveSettingsDebounced: () => {},
  };
  api.TavernHelper = { ...api };
  api.__vishrunMvuZod = { registerMvuSchema: setMvuSchema };
  return api;
}
