import type { SpindleFrontendContext } from 'lumiverse-spindle-types';
import { presetRpc } from './rpc';
import { inputDialog, popupDialog, splitNamedArgs } from './dialogs';
import { clickSend, parseSlash, setComposerText, splitPipeline } from '../render/slash-runner';
import { getCharacter, getChatMessages as hostChatMessages, updateMessageContent, type HostMessage } from '../lumiverse/host-api';
import { stIdOf } from './st-ids';

// JS-Slash-Runner globals for preset scripts. Sync getters (getVariables,
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
  parameters: Record<string, unknown>;
  metadata: Record<string, unknown>;
  blocks: PresetBlock[];
}

type Listener = (...args: unknown[]) => unknown;

export interface ScriptButton { name: string; visible: boolean }

export interface RuntimeState {
  ctx: SpindleFrontendContext;
  presetId: string;
  presetName: string;
  preset: PresetSnapshot | null;
  /** Lumiverse block id → SillyTavern identifier, when known. */
  stIds: Record<string, string>;
  vars: { global: Record<string, unknown>; chat: Record<string, unknown> };
  messages: HostMessage[];
  character: Record<string, unknown> | null;
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
  const [global, chat] = await Promise.all([
    presetRpc<Record<string, unknown>>(state.ctx, 'vars_get', { scope: 'global' }),
    chatId ? presetRpc<Record<string, unknown>>(state.ctx, 'vars_get', { scope: 'chat', chatId }) : Promise.resolve({}),
  ]);
  state.vars = { global, chat };
}

export async function refreshCharacter(state: RuntimeState): Promise<void> {
  const id = state.ctx.getActiveChat().characterId;
  state.character = id ? ((await getCharacter(id).catch(() => null)) as Record<string, unknown> | null) : null;
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

export function buildThApi(state: RuntimeState, script: { id: string; data: Record<string, unknown> }, win: Window) {
  const ctx = state.ctx;
  const clone = <T>(v: T): T => (v === undefined ? v : (win as unknown as { JSON: JSON }).JSON.parse(JSON.stringify(v)));
  const scriptVarsKey = `vishrun:preset-script-vars:${state.presetId}:${script.id}`;

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
    return {};
  };

  const setVars = (vars: Record<string, unknown>, opt?: unknown): void => {
    const type = scopeOf(opt);
    const copy = JSON.parse(JSON.stringify(vars ?? {}));
    if (type === 'script') {
      try { localStorage.setItem(scriptVarsKey, JSON.stringify(copy)); } catch { /* quota */ }
      return;
    }
    if (type !== 'global' && type !== 'chat') return;
    state.vars[type] = copy;
    const chatId = ctx.getActiveChat().chatId;
    void presetRpc(ctx, 'vars_replace', { scope: type, chatId, vars: copy })
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
    const out = [];
    for (let i = a; i <= b && i < state.messages.length; i++) {
      const m = state.messages[i];
      if (!m) continue;
      const r = m.is_user ? 'user' : m.role === 'system' ? 'system' : 'assistant';
      if (role !== 'all' && role !== r) continue;
      out.push({ message_id: i, name: m.name ?? '', role: r, is_hidden: m.hidden === true, message: m.content, data: {}, extra: {} });
    }
    return clone(out);
  };

  const triggerSlash = async (command: unknown): Promise<string> => {
    let pipe = '';
    for (const step of splitPipeline(String(command ?? ''))) {
      const parsed = parseSlash(step);
      if (!parsed) continue;
      const rest = parsed.rest.replace(/\{\{pipe\}\}/g, pipe);
      switch (parsed.name) {
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
        case 'echo':
          void presetRpc(ctx, 'toast', { kind: 'info', message: rest });
          pipe = rest;
          break;
        default:
          console.warn('[vishrun] preset script: unsupported slash command', parsed.name);
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
    getAllVariables: () => clone({ ...state.vars.global, ...state.vars.chat }),
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
    substitudeMacros: (text: unknown) => String(text ?? ''),
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
    getChatCompletionModel: () => '',
    saveSettingsDebounced: () => {},
  };
  api.TavernHelper = { ...api };
  return api;
}
