import { api } from './common';
import { referencesUnknownIds, type BlockLike } from '../preset-scripts/st-ids';

// Backend side of the preset script runtime (src/preset-scripts). The
// frontend has no preset, variable or storage API, so it calls these ops.

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
const stIdsPath = (presetId: string) => `preset-st-ids-${presetId.replace(/[^\w-]/g, '')}.json`;

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

// Flattens tavern_helper folders into the enabled scripts, in order.
export function enabledScripts(metadata: unknown): PresetScript[] {
  const th = (metadata as { tavern_helper?: { scripts?: unknown } } | null)?.tavern_helper;
  const out: PresetScript[] = [];
  const walk = (list: unknown): void => {
    if (!Array.isArray(list)) return;
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue;
      const s = raw as Record<string, unknown>;
      if (s.enabled === false) continue;
      if (s.type === 'folder') { walk(s.scripts); continue; }
      if (typeof s.content !== 'string' || !s.content.trim()) continue;
      const buttons = (s.button as { enabled?: boolean; buttons?: unknown } | undefined);
      out.push({
        id: String(s.id ?? s.name ?? out.length),
        name: String(s.name ?? ''),
        content: s.content,
        data: s.data && typeof s.data === 'object' ? s.data as Record<string, unknown> : {},
        buttons: buttons?.enabled === false || !Array.isArray(buttons?.buttons)
          ? []
          : (buttons.buttons as { name?: unknown; visible?: unknown }[])
            .filter((b) => typeof b?.name === 'string')
            .map((b) => ({ name: String(b.name), visible: b.visible !== false })),
      });
    }
  };
  walk(th?.scripts);
  return out;
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

type VarScope = 'global' | 'chat';

async function readVars(scope: VarScope, chatId: string | null, userId: string): Promise<Record<string, unknown>> {
  const raw = scope === 'global'
    ? await api.variables.global.list(userId)
    : chatId ? await api.variables.chat.list(chatId) : {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) out[k] = parseValue(v);
  return out;
}

async function writeVars(scope: VarScope, chatId: string | null, next: Record<string, unknown>, userId: string): Promise<void> {
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
      const found = await activePreset(chatId, userId);
      if (!found) return null;
      const { preset } = found;
      const consent = await readConsent(userId);
      const stIds = await readStIds(preset.id, userId);
      const blocks = (Array.isArray(preset.prompt_order) ? preset.prompt_order : []) as unknown as BlockLike[];
      return {
        presetId: preset.id,
        presetName: preset.name,
        consent: consent[preset.id] ?? null,
        scripts: enabledScripts(preset.metadata),
        stIds: stIds?.map ?? {},
        stIdsNeeded: !stIds && referencesUnknownIds(preset.metadata ?? {}, blocks),
      };
    }
    case 'set_consent': {
      const consent = await readConsent(userId);
      consent[String(args.presetId)] = args.allowed === true;
      await api.userStorage.write(CONSENT_PATH, JSON.stringify(consent), userId);
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
      return readVars(args.scope === 'chat' ? 'chat' : 'global', chatId, userId);
    case 'vars_replace':
      await writeVars(args.scope === 'chat' ? 'chat' : 'global', chatId, (args.vars ?? {}) as Record<string, unknown>, userId);
      return true;
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
