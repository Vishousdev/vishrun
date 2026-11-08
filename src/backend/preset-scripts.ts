import { api } from './common';
import { referencesUnknownIds, type BlockLike } from '../preset-scripts/st-ids';
import { entryFieldPatch, resolveStUid, stUidMap, type EntryLike } from '../core/st-entry-field';

// Backend side of the script runtime (src/preset-scripts) for preset and
// character scripts. The frontend has no preset, variable or storage API, so
// it calls these ops.

export interface PresetScript {
  id: string;
  name: string;
  content: string;
  buttons: { name: string; visible: boolean }[];
  data: Record<string, unknown>;
}

interface Block {
  id: string;
  name?: string;
  enabled?: boolean;
  [k: string]: unknown;
}

interface PresetRpcRequest {
  type: 'vr_preset';
  requestId: string;
  op: string;
  args: Record<string, unknown>;
}

const CONSENT_PATH = 'preset-scripts-consent.json';
const SWITCHES_PATH = 'script-switches.json';
const stIdsPath = (presetId: string) => `preset-st-ids-${presetId.replace(/[^\w-]/g, '')}.json`;
const charVarsPath = (characterId: string) => `character-vars-${characterId.replace(/[^\w-]/g, '')}.json`;
const charConsentKey = (characterId: string) => `character:${characterId}`;

interface StIdsFile { map: Record<string, string>; declined?: boolean }

async function readStIds(presetId: string, userId: string): Promise<StIdsFile | null> {
  try {
    const parsed = JSON.parse(await api.userStorage.read(stIdsPath(presetId), userId));
    return parsed && typeof parsed === 'object' && parsed.map && typeof parsed.map === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function isRequest(p: unknown): p is PresetRpcRequest {
  if (!p || typeof p !== 'object') return false;
  const r = p as Record<string, unknown>;
  return r.type === 'vr_preset' && typeof r.requestId === 'string' && typeof r.op === 'string';
}

export interface ListedScript extends PresetScript {
  /** Author notes (`info`). */
  info: string;
  /** On/off as the card or preset ships it; a disabled folder turns its scripts off. */
  defaultEnabled: boolean;
}

/** Vishrun-side per-script switches: owner (preset id or `character:<id>`) -> script id -> on. */
export type ScriptSwitches = Record<string, Record<string, boolean>>;

// Flattens tavern_helper folders into every script with code, in order.
export function listScripts(metadata: unknown): ListedScript[] {
  const th = (metadata as { tavern_helper?: { scripts?: unknown } } | null)?.tavern_helper;
  const out: ListedScript[] = [];
  const walk = (list: unknown, folderOn: boolean): void => {
    if (!Array.isArray(list)) return;
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue;
      const s = raw as Record<string, unknown>;
      if (s.type === 'folder') { walk(s.scripts, folderOn && s.enabled !== false); continue; }
      if (typeof s.content !== 'string' || !s.content.trim()) continue;
      const buttons = (s.button as { enabled?: boolean; buttons?: unknown } | undefined);
      out.push({
        id: String(s.id ?? s.name ?? out.length),
        name: String(s.name ?? ''),
        content: s.content,
        info: typeof s.info === 'string' ? s.info : '',
        defaultEnabled: folderOn && s.enabled !== false,
        data: s.data && typeof s.data === 'object' ? s.data as Record<string, unknown> : {},
        buttons: buttons?.enabled === false || !Array.isArray(buttons?.buttons)
          ? []
          : (buttons.buttons as { name?: unknown; visible?: unknown }[])
            .filter((b) => typeof b?.name === 'string')
            .map((b) => ({ name: String(b.name), visible: b.visible !== false })),
      });
    }
  };
  walk(th?.scripts, true);
  return out;
}

// The scripts that run: a Vishrun switch wins over how the script ships.
export function enabledScripts(metadata: unknown, switches: Record<string, boolean> = {}): PresetScript[] {
  return listScripts(metadata)
    .filter((s) => switches[s.id] ?? s.defaultEnabled)
    .map(({ id, name, content, buttons, data }) => ({ id, name, content, buttons, data }));
}

// Every script with its effective switch, for the settings page.
function scriptsForPage(metadata: unknown, switches: Record<string, boolean> = {}) {
  return listScripts(metadata).map(({ id, name, content, info, buttons, defaultEnabled }) => ({
    id, name, content, info, buttons, enabled: switches[id] ?? defaultEnabled,
  }));
}

async function readSwitches(userId: string): Promise<ScriptSwitches> {
  try {
    const parsed = JSON.parse(await api.userStorage.read(SWITCHES_PATH, userId));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function readConsent(userId: string): Promise<Record<string, boolean>> {
  try {
    const raw = await api.userStorage.read(CONSENT_PATH, userId);
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function parseValue(v: string): unknown {
  try { return JSON.parse(v); } catch { return v; }
}

type VarScope = 'global' | 'chat' | 'character';

async function cardOf(characterId: string, userId: string): Promise<{ id: string; name: string; extensions?: unknown } | null> {
  const c = await api.characters.get(characterId, userId).catch(() => null);
  return (c as { id: string; name: string; extensions?: unknown } | null) ?? null;
}

async function chatCharacterId(chatId: string | null, userId: string): Promise<string | null> {
  if (!chatId) return null;
  const chat = await api.chats.get(chatId, userId).catch(() => null);
  const id = (chat as { character_id?: unknown } | null)?.character_id;
  return typeof id === 'string' && id ? id : null;
}

// Character variables start from the card's tavern_helper.variables. Writes
// are kept in user storage so the card itself is never changed.
async function readCharacterVars(characterId: string, userId: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await api.userStorage.read(charVarsPath(characterId), userId));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch { /* not written yet */ }
  const card = await cardOf(characterId, userId);
  const vars = (card?.extensions as { tavern_helper?: { variables?: unknown } } | undefined)?.tavern_helper?.variables;
  return vars && typeof vars === 'object' && !Array.isArray(vars) ? vars as Record<string, unknown> : {};
}

async function readVars(scope: VarScope, chatId: string | null, userId: string, characterId: string | null = null): Promise<Record<string, unknown>> {
  if (scope === 'character') return characterId ? readCharacterVars(characterId, userId) : {};
  const raw = scope === 'global'
    ? await api.variables.global.list(userId)
    : chatId ? await api.variables.chat.list(chatId) : {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) out[k] = parseValue(v);
  return out;
}

async function writeVars(scope: VarScope, chatId: string | null, next: Record<string, unknown>, userId: string, characterId: string | null = null): Promise<void> {
  if (scope === 'character') {
    if (characterId) await api.userStorage.write(charVarsPath(characterId), JSON.stringify(next), userId);
    return;
  }
  const prev = await readVars(scope, chatId, userId);
  for (const [k, v] of Object.entries(next)) {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    if (scope === 'global') await api.variables.global.set(k, s, userId);
    else if (chatId) await api.variables.chat.set(chatId, k, s);
  }
  for (const k of Object.keys(prev)) {
    if (k in next) continue;
    if (scope === 'global') await api.variables.global.delete(k, userId);
    else if (chatId) await api.variables.chat.delete(chatId, k);
  }
}

// ── lorebooks for scripts (JSR worldbook/lorebook API) ──────────────────────

interface WbBook { id: string; name: string }
interface WbApi {
  list(o: { limit?: number; offset?: number; userId?: string }): Promise<{ data: WbBook[]; total: number }>;
  get(id: string, userId?: string): Promise<WbBook | null>;
  entries: {
    list(id: string, o: { limit?: number; offset?: number; userId?: string }): Promise<{ data: unknown[]; total: number }>;
    create(bookId: string, input: Record<string, unknown>, userId?: string): Promise<{ id: string }>;
    update(entryId: string, input: Record<string, unknown>, userId?: string): Promise<unknown>;
    delete(entryId: string, userId?: string): Promise<boolean>;
  };
}
const wb = () => (api as unknown as { world_books: WbApi }).world_books;

async function characterBookIds(chatId: string | null, userId: string): Promise<string[]> {
  const characterId = await chatCharacterId(chatId, userId);
  const card = characterId ? await api.characters.get(characterId, userId).catch(() => null) : null;
  const ids = (card as { world_book_ids?: unknown } | null)?.world_book_ids;
  return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [];
}

async function allBooks(userId: string): Promise<WbBook[]> {
  const out: WbBook[] = [];
  for (let offset = 0; ; offset += 200) {
    const page = await wb().list({ limit: 200, offset, userId });
    out.push(...page.data);
    if (page.data.length < 200 || out.length >= page.total) break;
  }
  return out;
}

// Book names are not unique in Lumiverse; the character's own books win.
async function bookIdByName(name: string, chatId: string | null, userId: string): Promise<string> {
  const books = await allBooks(userId);
  const own = new Set(await characterBookIds(chatId, userId));
  const hit = books.find((b) => b.name === name && own.has(b.id)) ?? books.find((b) => b.name === name);
  if (!hit) throw new Error(`Lorebook '${name}' not found`);
  return hit.id;
}

// Cards refer to entries by ST uid; Lumiverse's import gave them new ids. For
// the chat character's own books, tag entries with the uid from the card.
async function withStUids(entries: unknown[], bookId: string, chatId: string | null, userId: string): Promise<unknown[]> {
  if (!(await characterBookIds(chatId, userId)).includes(bookId)) return entries;
  const characterId = await chatCharacterId(chatId, userId);
  const card = characterId ? await api.characters.get(characterId, userId).catch(() => null) : null;
  const ext = (card as { extensions?: { character_book?: { entries?: unknown } } } | null)?.extensions;
  const map = stUidMap(records(entries) as unknown as EntryLike[], records(ext?.character_book?.entries));
  return records(entries).map((e) => (map.has(String(e.id)) ? { ...e, st_uid: map.get(String(e.id)) } : e));
}

async function bookEntries(bookId: string, userId: string): Promise<unknown[]> {
  const out: unknown[] = [];
  for (let offset = 0; ; offset += 200) {
    const page = await wb().entries.list(bookId, { limit: 200, offset, userId });
    out.push(...page.data);
    if (page.data.length < 200 || out.length >= page.total) break;
  }
  return out;
}

// ── regexes for scripts (JSR TavernRegex API) ───────────────────────────────

interface RxApi {
  list(o: { scope?: string; scopeId?: string; limit?: number; offset?: number; userId?: string }): Promise<{ data: unknown[]; total: number }>;
  create(input: Record<string, unknown>, userId?: string): Promise<unknown>;
  update(id: string, input: Record<string, unknown>, userId?: string): Promise<unknown>;
}
const rx = () => (api as unknown as { regex_scripts: RxApi }).regex_scripts;

async function regexRows(scope: 'global' | 'character', scopeId: string | undefined, userId: string): Promise<unknown[]> {
  const out: unknown[] = [];
  for (let offset = 0; ; offset += 200) {
    const page = await rx().list({ scope, ...(scopeId ? { scopeId } : {}), limit: 200, offset, userId });
    out.push(...page.data);
    if (page.data.length < 200 || out.length >= page.total) break;
  }
  return out;
}

const records = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)) : [];

const scopeArg = (s: unknown): VarScope => (s === 'chat' || s === 'character' ? s : 'global');

async function activePreset(chatId: string | null, userId: string) {
  const active = await api.presets.getActive(chatId ?? undefined, userId);
  if (!active.preset_id) return null;
  const preset = await api.presets.get(active.preset_id, userId);
  if (!preset) return null;
  return { active, preset };
}

async function handle(op: string, args: Record<string, unknown>, userId: string): Promise<unknown> {
  const chatId = typeof args.chatId === 'string' ? args.chatId : null;
  switch (op) {
    case 'active_scripts': {
      const [consent, switches] = await Promise.all([readConsent(userId), readSwitches(userId)]);
      const found = await activePreset(chatId, userId);
      let preset = null;
      if (found) {
        const p = found.preset;
        const stIds = await readStIds(p.id, userId);
        const blocks = (Array.isArray(p.prompt_order) ? p.prompt_order : []) as unknown as BlockLike[];
        preset = {
          id: p.id,
          name: p.name,
          consent: consent[p.id] ?? null,
          scripts: enabledScripts(p.metadata, switches[p.id]),
          all: scriptsForPage(p.metadata, switches[p.id]),
          stIds: stIds?.map ?? {},
          stIdsNeeded: !stIds && referencesUnknownIds(p.metadata ?? {}, blocks),
        };
      }
      const characterId = await chatCharacterId(chatId, userId);
      const card = characterId ? await cardOf(characterId, userId) : null;
      const character = card
        ? {
          id: card.id,
          name: card.name,
          consent: consent[charConsentKey(card.id)] ?? null,
          scripts: enabledScripts(card.extensions, switches[charConsentKey(card.id)]),
          all: scriptsForPage(card.extensions, switches[charConsentKey(card.id)]),
        }
        : null;
      return { preset, character };
    }
    case 'set_consent': {
      const consent = await readConsent(userId);
      const key = typeof args.characterId === 'string' ? charConsentKey(args.characterId) : String(args.presetId);
      consent[key] = args.allowed === true;
      await api.userStorage.write(CONSENT_PATH, JSON.stringify(consent), userId);
      return true;
    }
    case 'set_script_enabled': {
      const owner = typeof args.characterId === 'string' ? charConsentKey(args.characterId) : String(args.presetId ?? '');
      if (!owner || typeof args.scriptId !== 'string') return false;
      const switches = await readSwitches(userId);
      switches[owner] = { ...(switches[owner] ?? {}), [args.scriptId]: args.enabled === true };
      await api.userStorage.write(SWITCHES_PATH, JSON.stringify(switches), userId);
      return true;
    }
    case 'set_st_ids': {
      const map: Record<string, string> = {};
      for (const [k, v] of Object.entries((args.map ?? {}) as Record<string, unknown>)) if (typeof v === 'string') map[k] = v;
      const file: StIdsFile = args.declined === true ? { map: {}, declined: true } : { map };
      await api.userStorage.write(stIdsPath(String(args.presetId)), JSON.stringify(file), userId);
      return true;
    }
    case 'get_preset': {
      const found = await activePreset(chatId, userId);
      if (!found || found.preset.id !== args.presetId) return null;
      const { preset, active } = found;
      const blocks = (Array.isArray(preset.prompt_order) ? preset.prompt_order : []) as unknown as Block[];
      const completion = (preset.prompts as { completionSettings?: { assistantPrefill?: unknown } } | undefined)?.completionSettings;
      return {
        name: preset.name,
        prefill: typeof completion?.assistantPrefill === 'string' ? completion.assistantPrefill : '',
        parameters: preset.parameters ?? {},
        metadata: preset.metadata ?? {},
        blocks: blocks.map((b) => ({ ...b, enabled: active.block_states[b.id] ?? b.enabled !== false })),
      };
    }
    case 'set_prefill': {
      const preset = await api.presets.get(String(args.presetId), userId);
      if (!preset) return false;
      const prompts = (preset.prompts ?? {}) as Record<string, unknown>;
      const completion = (prompts.completionSettings ?? {}) as Record<string, unknown>;
      await api.presets.update(preset.id, {
        prompts: { ...prompts, completionSettings: { ...completion, assistantPrefill: String(args.value ?? '') } },
        expected_cache_revision: preset.cache_revision,
      }, userId);
      return true;
    }
    case 'set_block_states': {
      const presetId = String(args.presetId);
      const states = (args.states ?? {}) as Record<string, boolean>;
      for (const [blockId, enabled] of Object.entries(states)) {
        await api.presets.blocks.update(presetId, blockId, { enabled: enabled === true }, userId);
      }
      return true;
    }
    case 'set_hidden': {
      if (!chatId) return false;
      const ids = Array.isArray(args.messageIds) ? args.messageIds.filter((x): x is string => typeof x === 'string') : [];
      for (let i = 0; i < ids.length; i += 500) {
        await api.chat.setMessagesHidden(chatId, ids.slice(i, i + 500), args.hidden === true);
      }
      return true;
    }
    case 'vars_get':
      return readVars(scopeArg(args.scope), chatId, userId, typeof args.characterId === 'string' ? args.characterId : null);
    case 'vars_replace':
      await writeVars(scopeArg(args.scope), chatId, (args.vars ?? {}) as Record<string, unknown>, userId,
        typeof args.characterId === 'string' ? args.characterId : null);
      return true;
    case 'wb_char_names': {
      const books = await Promise.all((await characterBookIds(chatId, userId)).map((id) => wb().get(id, userId).catch(() => null)));
      const names = books.filter((b): b is WbBook => !!b).map((b) => b.name);
      return { primary: names[0] ?? null, additional: names.slice(1) };
    }
    case 'wb_all_names':
      return [...new Set((await allBooks(userId)).map((b) => b.name))];
    case 'wb_entries': {
      const bookId = await bookIdByName(String(args.name ?? ''), chatId, userId);
      return withStUids(await bookEntries(bookId, userId), bookId, chatId, userId);
    }
    case 'wb_apply': {
      const bookId = await bookIdByName(String(args.name ?? ''), chatId, userId);
      // Only entries of this book, whatever ids the script passes.
      const own = new Set((await bookEntries(bookId, userId)).map((e) => (e as { id?: unknown }).id));
      const created: string[] = [];
      for (const id of Array.isArray(args.delete) ? args.delete : []) {
        if (own.has(id)) await wb().entries.delete(String(id), userId);
      }
      for (const u of records(args.update)) {
        if (own.has(u.id) && u.patch && typeof u.patch === 'object') await wb().entries.update(String(u.id), u.patch as Record<string, unknown>, userId);
      }
      for (const input of records(args.create)) created.push((await wb().entries.create(bookId, input, userId)).id);
      return { entries: await withStUids(await bookEntries(bookId, userId), bookId, chatId, userId), created };
    }
    case 'wb_set_field': {
      const bookId = await bookIdByName(String(args.file ?? ''), chatId, userId);
      const patch = entryFieldPatch(String(args.field ?? 'content'), String(args.value ?? ''));
      if (!patch) throw new Error(`setentryfield: field '${String(args.field)}' is not supported`);
      const characterId = await chatCharacterId(chatId, userId);
      const card = characterId ? await api.characters.get(characterId, userId).catch(() => null) : null;
      const ext = (card as { extensions?: { character_book?: { entries?: unknown } } } | null)?.extensions;
      const cardBook = records(ext?.character_book?.entries);
      const entries = records(await bookEntries(bookId, userId)) as unknown as EntryLike[];
      const entry = resolveStUid(String(args.uid ?? ''), entries, cardBook);
      if (!entry) throw new Error(`setentryfield: entry ${String(args.uid)} not found`);
      await wb().entries.update(entry.id, patch, userId);
      return true;
    }
    case 'regex_rows': {
      const characterId = await chatCharacterId(chatId, userId);
      const [character, global] = await Promise.all([
        characterId ? regexRows('character', characterId, userId) : Promise.resolve([]),
        regexRows('global', undefined, userId),
      ]);
      return { character, global };
    }
    case 'regex_apply': {
      // The character always comes from the chat, never from the script.
      const scope = args.scope === 'global' ? 'global' : 'character';
      const characterId = scope === 'character' ? await chatCharacterId(chatId, userId) : null;
      if (scope === 'character' && !characterId) return false;
      const own = new Set((await regexRows(scope, characterId ?? undefined, userId)).map((r) => (r as { id?: unknown }).id));
      for (const u of records(args.update)) {
        if (own.has(u.id) && u.patch && typeof u.patch === 'object') await rx().update(String(u.id), u.patch as Record<string, unknown>, userId);
      }
      for (const input of records(args.create)) {
        await rx().create({ ...input, scope, ...(characterId ? { scope_id: characterId } : {}) }, userId);
      }
      return true;
    }
    case 'toast': {
      const kind = ['success', 'warning', 'error', 'info'].includes(String(args.kind)) ? String(args.kind) as 'info' : 'info';
      api.toast[kind](String(args.message ?? ''), typeof args.title === 'string' ? { title: args.title } : undefined);
      return true;
    }
    default:
      throw new Error(`unknown op ${op}`);
  }
}

export function installPresetScriptsHandler(): void {
  api.onFrontendMessage((payload, userId) => {
    if (!isRequest(payload)) return;
    const { requestId, op, args } = payload;
    void (async () => {
      try {
        const result = await handle(op, args ?? {}, userId);
        api.sendToFrontend({ type: 'vr_preset_response', requestId, result }, userId);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        api.sendToFrontend({ type: 'vr_preset_response', requestId, error }, userId);
      }
    })();
  });
}
