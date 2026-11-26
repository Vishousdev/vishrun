import { presetRpc } from './rpc';
import { callGenericPopup, POPUP_RESULT, POPUP_TYPE } from './dialogs';
import { addListener, deleteMessages, emit, refreshMessages, TAVERN_EVENTS, writeVars, type Listener, type RuntimeState } from './th-api';
import { updateMessageContent, type HostMessage } from '../lumiverse/host-api';
import { resolveMacrosBatch } from '../core/macro-resolver';
import { cardGreetings, greetingSwipes } from '../core/greetings';
import { getActiveCard } from '../state/active-card';

// SillyTavern's global (`SillyTavern` / getContext()) for scripts and, on the
// page, for widgets that read window.parent.SillyTavern. Arrays and objects
// are live: scripts mutate chat[] or chatMetadata and then save.

export interface StMessage {
  name: string;
  is_user: boolean;
  is_system: boolean;
  mes: string;
  swipe_id: number;
  swipes: string[];
  extra: Record<string, unknown>;
}

// Lumiverse shows a greeting by rewriting message 0, so its swipes are the
// card greetings and swipe_id is the one whose text is shown.
export function toStChat(messages: HostMessage[], greetings: string[]): StMessage[] {
  return messages.map((m, i) => ({
    name: m.name ?? '',
    is_user: m.is_user,
    is_system: m.role === 'system' || m.hidden === true,
    mes: m.content,
    ...greetingSwipes(i, m.is_user, m.content, greetings),
    extra: m.stExtra ? JSON.parse(JSON.stringify(m.stExtra)) : {},
  }));
}

const CARD_FIELDS = ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'creator_notes',
  'system_prompt', 'post_history_instructions', 'alternate_greetings', 'tags', 'creator'] as const;

// Character in SillyTavern's shape (top-level fields plus the V2 `data`).
export function toStCharacter(c: Record<string, unknown>): Record<string, unknown> {
  const data: Record<string, unknown> = { extensions: c.extensions ?? {} };
  for (const k of CARD_FIELDS) data[k] = c[k] ?? (k === 'alternate_greetings' || k === 'tags' ? [] : '');
  return {
    name: c.name ?? '', avatar: c.avatar ?? c.image_id ?? c.id, description: data.description, personality: data.personality,
    scenario: data.scenario, first_mes: data.first_mes, mes_example: data.mes_example, creatorcomment: data.creator_notes,
    tags: data.tags, data,
  };
}

// chat_metadata; `variables` is the chat variable scope, not stored with it.
function makeMeta(state: RuntimeState, stored: Record<string, unknown>): Record<string, unknown> {
  const meta = { ...stored };
  Object.defineProperty(meta, 'variables', {
    enumerable: false, configurable: true,
    get: () => state.vars.chat,
    set: (v) => { if (v && typeof v === 'object') state.vars.chat = v as Record<string, unknown>; },
  });
  return meta;
}

export async function refreshStMeta(state: RuntimeState): Promise<void> {
  const { chatId, characterId } = state.ctx.getActiveChat();
  const [stored, names] = await Promise.all([
    chatId ? presetRpc<Record<string, unknown>>(state.ctx, 'st_meta_get', { chatId }) : Promise.resolve({}),
    chatId ? resolveMacrosBatch(state.ctx, chatId, characterId ?? null, ['{{user}}']).catch(() => ['']) : Promise.resolve(['']),
  ]);
  state.stMeta = makeMeta(state, stored ?? {});
  state.userName = names[0] && names[0] !== '{{user}}' ? names[0] : '';
}

type ChatMsg = { role: 'system' | 'user' | 'assistant'; content: string };
const GENERATE_MS = 180_000;

// Message content as text: ST allows an array of parts.
const textOf = (c: unknown): string => (Array.isArray(c) ? c.map((x) => (x && typeof x === 'object' ? String((x as { text?: unknown }).text ?? '') : '')).join('') : String(c ?? ''));
const toMessages = (list: unknown): ChatMsg[] => (Array.isArray(list) ? list : []).map((m) => ({
  role: m?.role === 'user' || m?.role === 'assistant' ? m.role : 'system', content: textOf(m?.content),
}));

const debounce = (fn: () => unknown, ms: number) => {
  let t: ReturnType<typeof setTimeout> | null = null;
  return () => { if (t) clearTimeout(t); t = setTimeout(() => { t = null; void fn(); }, ms); };
};

export function createSillyTavern(state: RuntimeState): Record<string, unknown> {
  const ctx = state.ctx;
  const chatId = () => ctx.getActiveChat().chatId;

  // Rebuilt when the message list is reloaded; kept otherwise so in-place
  // edits survive until saveChat.
  let chatFor: HostMessage[] | null = null;
  let cardFor: unknown = null;
  let chat: StMessage[] = [];
  let base: { swipe_id: number; mes: string; is_system: boolean; extra: string }[] = [];
  const snap = (m: StMessage) => ({ swipe_id: m.swipe_id, mes: m.mes, is_system: m.is_system, extra: JSON.stringify(m.extra ?? {}) });
  const stChat = () => {
    const card = getActiveCard();
    if (chatFor !== state.messages || cardFor !== card) {
      chatFor = state.messages;
      cardFor = card;
      chat = toStChat(state.messages, cardGreetings(card));
      base = chat.map(snap);
    }
    return chat;
  };

  let charFor: unknown = null;
  let characters: Record<string, unknown>[] = [];
  const stCharacters = () => {
    if (charFor !== state.character) {
      charFor = state.character;
      characters = state.character ? [toStCharacter(state.character)] : [];
    }
    return characters;
  };

  const saveChat = async () => {
    const id = chatId();
    const list = stChat();
    if (!id) return;
    // is_system hides a message from the prompt, which is Lumiverse's hidden flag.
    const hide: string[] = [], show: string[] = [], extras: { id: string; extra: unknown }[] = [];
    for (let i = 0; i < list.length; i++) {
      const m = list[i], b = base[i], host = state.messages[i];
      if (!m || !b || !host) continue;
      let text: string | null = null;
      if (m.swipe_id !== b.swipe_id && typeof m.swipes[m.swipe_id] === 'string') text = m.swipes[m.swipe_id];
      else if (m.mes !== b.mes) text = m.mes;
      if (text !== null && text !== host.content) await updateMessageContent(id, host.id, text);
      if (m.is_system !== b.is_system && host.role !== 'system') (m.is_system ? hide : show).push(host.id);
      const extra = JSON.stringify(m.extra ?? {});
      if (extra !== b.extra) extras.push({ id: host.id, extra: JSON.parse(extra) });
      base[i] = snap(m);
    }
    if (hide.length) await presetRpc(ctx, 'set_hidden', { chatId: id, messageIds: hide, hidden: true });
    if (show.length) await presetRpc(ctx, 'set_hidden', { chatId: id, messageIds: show, hidden: false });
    if (extras.length) await presetRpc(ctx, 'msg_extra', { chatId: id, items: extras });
    await refreshMessages(state);
  };

  const saveMetadata = async () => {
    const id = chatId();
    if (!id) return;
    const meta = JSON.parse(JSON.stringify(state.stMeta));
    await Promise.all([
      presetRpc(ctx, 'st_meta_set', { chatId: id, meta }),
      writeVars(state, 'chat', JSON.parse(JSON.stringify(state.vars.chat))),
    ]);
  };

  // ST's variables.local / global. add() sums numbers and appends text.
  const varScope = (scope: 'chat' | 'global') => {
    const isNum = (v: unknown) => v === undefined || v === '' || Number.isFinite(Number(v));
    const set = (name: string, value: unknown) => { void writeVars(state, scope, { ...state.vars[scope], [name]: value }); return value; };
    return {
      get: (name: string) => state.vars[scope][name] ?? '',
      set,
      has: (name: string) => name in state.vars[scope],
      del: (name: string) => { const next = { ...state.vars[scope] }; delete next[name]; void writeVars(state, scope, next); },
      add: (name: string, value: unknown) => {
        const cur = state.vars[scope][name];
        return set(name, isNum(cur) && isNum(value) ? Number(cur ?? 0) + Number(value) : String(cur ?? '') + String(value));
      },
      inc: (name: string) => set(name, (Number(state.vars[scope][name]) || 0) + 1),
      dec: (name: string) => set(name, (Number(state.vars[scope][name]) || 0) - 1),
    };
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

  const generate = (messages: ChatMsg[], maxTokens?: unknown) =>
    presetRpc<{ content: string; reasoning: string }>(ctx, 'generate', { messages, max_tokens: maxTokens }, GENERATE_MS);

  // ST: generateRaw({ prompt, systemPrompt }) or generateRaw(prompt, api, instruct, quietToLoud, systemPrompt).
  const generateRaw = async (a: unknown, ...rest: unknown[]): Promise<string> => {
    const o = (a && typeof a === 'object' && !Array.isArray(a) ? a : { prompt: a, systemPrompt: rest[3] }) as { prompt?: unknown; systemPrompt?: unknown; responseLength?: unknown };
    const messages = Array.isArray(o.prompt) ? toMessages(o.prompt) : [{ role: 'user' as const, content: String(o.prompt ?? '') }];
    if (typeof o.systemPrompt === 'string' && o.systemPrompt) messages.unshift({ role: 'system', content: o.systemPrompt });
    return (await generate(messages, o.responseLength)).content;
  };

  // Only the last value per key is sent; scripts call this on many events.
  const sentPrompts = new Map<string, string>();
  const setExtensionPrompt = (key: unknown, value: unknown, position: unknown = 1, depth: unknown = 0, _scan?: unknown, role: unknown = 0) => {
    const id = chatId();
    if (!id) return;
    const args = { chatId: id, key: String(key), value: String(value ?? ''), position: Number(position), depth: Number(depth), role: Number(role) };
    const sig = JSON.stringify(args);
    if (sentPrompts.get(args.key) === sig) return;
    sentPrompts.set(args.key, sig);
    void presetRpc(ctx, 'ext_prompt', args).catch((e) => console.warn('[vishrun] setExtensionPrompt', e));
  };

  const charName = () => (typeof state.character?.name === 'string' ? state.character.name : '');
  const st: Record<string, unknown> = {
    getCurrentChatId: () => chatId(),
    get chatId() { return chatId(); },
    get chat() { return stChat(); },
    get characters() { return stCharacters(); },
    get characterId() { return state.character ? 0 : undefined; },
    get this_chid() { return state.character ? 0 : undefined; },
    groupId: null,
    get name1() { return state.userName; },
    get name2() { return charName(); },
    get chatMetadata() { return state.stMeta; },
    saveMetadata,
    saveMetadataDebounced: debounce(() => saveMetadata().catch((e) => console.warn('[vishrun] saveMetadata', e)), 300),
    saveChat,
    saveChatConditional: saveChat,
    saveChatDebounced: debounce(() => saveChat().catch((e) => console.warn('[vishrun] saveChat', e)), 300),
    // The host renders message changes itself.
    reloadCurrentChat: () => refreshMessages(state),
    addOneMessage: () => {},
    updateMessageBlock: () => {},
    deleteMessage: (i: unknown) => deleteMessages(state, [Number(i)]),
    deleteLastMessage: () => deleteMessages(state, [state.messages.length - 1]),
    variables: { local: varScope('chat'), global: varScope('global') },
    callGenericPopup,
    POPUP_TYPE,
    POPUP_RESULT,
    substituteParams: (text: unknown) => String(text ?? '')
      .replace(/\{\{char\}\}/gi, charName() || '{{char}}')
      .replace(/\{\{user\}\}/gi, state.userName || '{{user}}'),
    eventSource: {
      on: (e: string, fn: Listener) => addListener(state, e, fn),
      once: (e: string, fn: Listener) => addListener(state, e, fn, true),
      removeListener: (e: string, fn: Listener) => { state.listeners.get(e)?.delete(fn); },
      emit: async (e: string, ...args: unknown[]) => emit(state, e, ...args),
    },
    event_types: { ...TAVERN_EVENTS },
    chatCompletionSettings: undefined,
    // Lumiverse generates with chat completion, ST's 'openai' API.
    mainApi: 'openai',
    generateRaw,
    setExtensionPrompt,
    ChatCompletionService: {
      processRequest: async (req: { messages?: unknown; max_tokens?: unknown }) => generate(toMessages(req?.messages), req?.max_tokens),
    },
    getPresetManager: () => undefined,
    getChatCompletionModel: activeModel,
    isMobile: () => /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent),
    saveSettingsDebounced: () => {},
  };
  st.getContext = () => st;
  return st;
}
