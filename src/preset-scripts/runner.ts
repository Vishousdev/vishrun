import type { SpindleFrontendContext, SpindleInputBarActionHandle } from 'lumiverse-spindle-types';
import JQUERY_SOURCE from '../vendor/jquery-3.5.1.min.js' with { type: 'text' };
import LODASH_SOURCE from '../vendor/lodash-4.18.1.min.js' with { type: 'text' };
import ZOD_SOURCE from '../vendor/cdn/zod-3.25.76-v4.min.js.txt';
import { presetRpc } from './rpc';
import { watchStAlias } from './st-dom-alias';
import { matchStIds } from './st-ids';
import { trackPageNodes } from './page-nodes';
import { installStandIns } from './st-stand-ins';
import {
  buildThApi, emit, refreshCharacter, refreshMessages, refreshPreset, refreshVars, TAVERN_EVENTS,
  type RuntimeState, type ScriptButton,
} from './th-api';

// Runs the active preset's JS-Slash-Runner scripts (metadata.tavern_helper)
// after per-preset consent. Each script gets a hidden same-origin frame with
// the JSR globals; like in SillyTavern, `$` works on the main page.

interface ActiveScripts {
  presetId: string;
  presetName: string;
  consent: boolean | null;
  stIds: Record<string, string>;
  stIdsNeeded: boolean;
  scripts: { id: string; name: string; content: string; buttons: ScriptButton[]; data: Record<string, unknown> }[];
}

interface Running {
  presetId: string;
  state: RuntimeState;
  frames: HTMLIFrameElement[];
  actions: Map<string, SpindleInputBarActionHandle>;
  stopAlias: () => void;
  stopNodes: () => void;
  stopStandIns: () => void;
}

const FRAME_ATTR = 'data-vishrun-preset-script';

// jQuery bound to the main page, as in SillyTavern where scripts share the
// page's `$`. Built with `window` shadowed to the parent, then moved off the
// parent's globals so Lumiverse is not left with a `$`.
function jqueryForParent(source: string): string {
  return `(function(){var p=window.parent;var had$=Object.prototype.hasOwnProperty.call(p,'$'),old$=p.$;` +
    `var hadJ=Object.prototype.hasOwnProperty.call(p,'jQuery'),oldJ=p.jQuery;` +
    `(function(window){${source}\n}).call(p,p);` +
    `var jq=p.jQuery;` +
    `if(had$)p.$=old$;else delete p.$;if(hadJ)p.jQuery=oldJ;else delete p.jQuery;` +
    `window.$=window.jQuery=jq;})();`;
}

function addScript(doc: Document, code: string, module = false): void {
  const el = doc.createElement('script');
  if (module) el.type = 'module';
  el.textContent = code;
  doc.head.appendChild(el);
}

const FA_URL = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css';

// SillyTavern ships Font Awesome 6; scripts use its icon classes.
function ensureFontAwesome(): void {
  if (document.querySelector('link[href*="fontawesome"], link[href*="font-awesome"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = FA_URL;
  document.head.appendChild(link);
}

function startFrame(state: RuntimeState, script: ActiveScripts['scripts'][number]): Promise<HTMLIFrameElement> {
  return new Promise((resolve) => {
    const frame = document.createElement('iframe');
    frame.setAttribute(FRAME_ATTR, script.name);
    frame.style.cssText = 'display:none';
    frame.srcdoc = '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>';
    frame.addEventListener('load', () => {
      const win = frame.contentWindow;
      const doc = frame.contentDocument;
      if (!win || !doc) return resolve(frame);
      addScript(doc, jqueryForParent(JQUERY_SOURCE));
      addScript(doc, LODASH_SOURCE);
      if (/(?<![\w$.])z(?![\w$])/.test(script.content)) addScript(doc, ZOD_SOURCE);
      const api = buildThApi(state, script, win);
      for (const [k, v] of Object.entries(api)) (win as unknown as Record<string, unknown>)[k] = v;
      // Resolves once the script body has run (modules run after their imports).
      const timer = setTimeout(() => resolve(frame), 5000);
      (win as unknown as Record<string, unknown>).__vishrunScriptDone = () => { clearTimeout(timer); resolve(frame); };
      addScript(doc, `${script.content}\n;window.__vishrunScriptDone?.();`, /\bimport\b|\bexport\b/.test(script.content));
    }, { once: true });
    document.body.appendChild(frame);
  });
}

export function installPresetScripts(ctx: SpindleFrontendContext): () => void {
  let running: Running | null = null;
  let syncing: Promise<void> | null = null;
  let again = false;
  let lastChatId = ctx.getActiveChat().chatId;
  const declined = new Set<string>();

  const stop = () => {
    if (!running) return;
    for (const f of running.frames) f.remove();
    running.stopNodes();
    running.stopStandIns();
    for (const a of running.actions.values()) a.destroy();
    running.stopAlias();
    running.state.listeners.clear();
    running = null;
  };

  const makeState = (info: ActiveScripts): { state: RuntimeState; actions: Map<string, SpindleInputBarActionHandle> } => {
    const buttons = new Map<string, ScriptButton[]>();
    const actions = new Map<string, SpindleInputBarActionHandle>();
    const state: RuntimeState = {
      ctx,
      presetId: info.presetId,
      presetName: info.presetName,
      preset: null,
      stIds: info.stIds ?? {},
      vars: { global: {}, chat: {} },
      messages: [],
      character: null,
      listeners: new Map(),
      getButtons: (id) => buttons.get(id) ?? [],
      setButtons: (scriptId, list) => {
        buttons.set(scriptId, list);
        const wanted = new Set(list.filter((b) => b.visible).map((b) => `${scriptId}:${b.name}`));
        for (const [key, handle] of actions) {
          if (key.startsWith(`${scriptId}:`) && !wanted.has(key)) { handle.destroy(); actions.delete(key); }
        }
        for (const b of list) {
          const key = `${scriptId}:${b.name}`;
          if (!b.visible || actions.has(key)) continue;
          const handle = ctx.ui.registerInputBarAction({ id: `ps-${actions.size}-${Date.now()}`, label: b.name });
          handle.onClick(() => emit(state, `vishrun_button:${scriptId}:${b.name}`));
          actions.set(key, handle);
        }
      },
    };
    for (const s of info.scripts) state.setButtons(s.id, s.buttons);
    return { state, actions };
  };

  // One-time link to the original SillyTavern file, so scripts see the
  // prompt identifiers their data refers to.
  const linkStIds = async (info: ActiveScripts, state: RuntimeState): Promise<void> => {
    const res = await ctx.ui.showConfirm({
      title: 'Link the original preset file?',
      message: `Some scripts in "${info.presetName}" refer to entries by their SillyTavern IDs, which Lumiverse does not keep on import. ` +
        'Pick the original SillyTavern preset file (.json) once so quick switches can find their entries.',
      confirmLabel: 'Pick file',
      cancelLabel: 'Skip',
    });
    if (!res.confirmed) {
      await presetRpc(ctx, 'set_st_ids', { presetId: info.presetId, declined: true }).catch(() => {});
      return;
    }
    const toast = (kind: string, message: string) => void presetRpc(ctx, 'toast', { kind, message }).catch(() => {});
    try {
      const [file] = await ctx.uploads.pickFile({ accept: ['.json', 'application/json'], multiple: false });
      if (!file || !state.preset) return;
      const json = JSON.parse(new TextDecoder().decode(file.bytes));
      const result = matchStIds(json, state.preset.blocks);
      const matched = Object.keys(result.map).length;
      if (matched < Math.ceil(state.preset.blocks.length / 2)) {
        toast('error', `This file does not look like the same preset (${matched} of ${state.preset.blocks.length} entries matched).`);
        return;
      }
      await presetRpc(ctx, 'set_st_ids', { presetId: info.presetId, map: result.map });
      state.stIds = result.map;
      toast('success', `Linked ${matched} of ${state.preset.blocks.length} entries to the original file.`);
    } catch (e) {
      toast('error', `Could not read the preset file: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const syncOnce = async () => {
    const chatId = ctx.getActiveChat().chatId;
    const info = await presetRpc<ActiveScripts | null>(ctx, 'active_scripts', { chatId }).catch((e) => {
      console.warn('[vishrun] preset scripts:', e);
      return undefined;
    });
    if (info === undefined) return;
    const chatChanged = chatId !== lastChatId;
    lastChatId = chatId;

    if (running && info && running.presetId === info.presetId) {
      if (chatChanged) {
        await Promise.all([refreshVars(running.state), refreshMessages(running.state), refreshPreset(running.state), refreshCharacter(running.state)]).catch(() => {});
        emit(running.state, TAVERN_EVENTS.CHAT_CHANGED, chatId);
      }
      return;
    }
    stop();
    if (!info || info.scripts.length === 0 || declined.has(info.presetId)) return;

    let allowed = info.consent;
    if (allowed === null) {
      const names = info.scripts.map((s) => `• ${s.name}`).join('\n');
      const res = await ctx.ui.showConfirm({
        title: 'Run preset scripts?',
        message: `The preset "${info.presetName}" includes scripts:\n${names}\n\nThey can change this preset and the page. Run them?`,
        confirmLabel: 'Run',
        cancelLabel: 'Not now',
      });
      allowed = res.confirmed;
      if (allowed) await presetRpc(ctx, 'set_consent', { presetId: info.presetId, allowed: true }).catch(() => {});
    }
    if (!allowed) { declined.add(info.presetId); return; }

    const { state, actions } = makeState(info);
    await Promise.all([refreshPreset(state), refreshVars(state), refreshMessages(state), refreshCharacter(state)]).catch((e) => {
      console.warn('[vishrun] preset scripts: initial load', e);
    });
    if (info.stIdsNeeded) await linkStIds(info, state);
    ensureFontAwesome();
    const frames: HTMLIFrameElement[] = [];
    // SillyTavern emits *_MESSAGE_RENDERED when a message is drawn; Lumiverse's
    // virtual list mounts rows on scroll, so a new row or new text re-emits.
    const seen = new WeakMap<Element, string>();
    const onRows = (rows: Element[]) => {
      const fresh: Element[] = [];
      for (const row of rows) {
        const idx = Number(row.getAttribute('data-message-index'));
        const msg = state.messages[idx];
        const key = `${row.getAttribute('data-message-id')}:${msg?.content.length ?? -1}`;
        if (seen.get(row) === key) continue;
        seen.set(row, key);
        fresh.push(row);
      }
      if (fresh.length === 0) return;
      const needsRefresh = fresh.some((r) => !state.messages[Number(r.getAttribute('data-message-index'))]);
      void (needsRefresh ? refreshMessages(state) : Promise.resolve()).then(() => {
        for (const row of fresh) {
          const idx = Number(row.getAttribute('data-message-index'));
          const msg = state.messages[idx];
          if (!msg) continue;
          seen.set(row, `${row.getAttribute('data-message-id')}:${msg.content.length}`);
          emit(state, msg.is_user ? TAVERN_EVENTS.USER_MESSAGE_RENDERED : TAVERN_EVENTS.CHARACTER_MESSAGE_RENDERED, idx);
        }
      });
    };
    running = { presetId: info.presetId, state, frames, actions, stopAlias: () => {}, stopNodes: trackPageNodes(), stopStandIns: () => {} };
    const presetId = info.presetId;
    running.stopStandIns = installStandIns(state.preset?.prefill ?? '', (value) => {
      void presetRpc(ctx, 'set_prefill', { presetId, value })
        .then(() => refreshPreset(state))
        .catch((e) => console.warn('[vishrun] preset scripts: prefill', e));
    });
    for (const s of info.scripts) frames.push(await startFrame(state, s));
    running.stopAlias = watchStAlias(document, onRows);
    return;
  };

  const sync = (): void => {
    if (syncing) { again = true; return; }
    syncing = syncOnce().finally(() => {
      syncing = null;
      if (again) { again = false; sync(); }
    });
  };

  const forward = (lumiEvent: string, stEvent: string, refresh: boolean) =>
    ctx.events.on(lumiEvent, (payload) => {
      if (!running) return;
      const st = running.state;
      void (refresh ? refreshMessages(st) : Promise.resolve()).then(() => {
        const id = (payload as { message?: { index_in_chat?: number } } | null)?.message?.index_in_chat;
        emit(st, stEvent, typeof id === 'number' ? id : st.messages.length - 1);
      });
    });

  const unsubs = [
    ctx.events.on('SETTINGS_UPDATED', (payload) => {
      const p = (payload || {}) as { key?: unknown; keys?: unknown };
      const keys = Array.isArray(p.keys) ? p.keys : [p.key];
      if (keys.some((k) => k === 'activeChatId' || k === 'activeLoomPresetId' || k === 'activeCharacterId')) sync();
      if (running) emit(running.state, TAVERN_EVENTS.SETTINGS_UPDATED);
    }),
    // Lumiverse fires this for any preset edit, including the scripts' own
    // toggles; SillyTavern's PRESET_CHANGED only means another preset was
    // selected, which restarts the scripts through sync().
    ctx.events.on('PRESET_CHANGED', () => {
      if (running) void refreshPreset(running.state).catch(() => {});
      sync();
    }),
    ctx.events.on('CHAT_SWITCHED', () => sync()),
    watchActiveConnection(),
    forward('MESSAGE_SENT', TAVERN_EVENTS.MESSAGE_SENT, true),
    forward('MESSAGE_EDITED', TAVERN_EVENTS.MESSAGE_EDITED, true),
    forward('MESSAGE_EDITED', TAVERN_EVENTS.MESSAGE_UPDATED, false),
    forward('MESSAGE_DELETED', TAVERN_EVENTS.MESSAGE_DELETED, true),
    forward('MESSAGE_SWIPED', TAVERN_EVENTS.MESSAGE_SWIPED, true),
    forward('GENERATION_ENDED', TAVERN_EVENTS.MESSAGE_RECEIVED, true),
    forward('GENERATION_STARTED', TAVERN_EVENTS.GENERATION_STARTED, false),
    forward('GENERATION_ENDED', TAVERN_EVENTS.GENERATION_ENDED, false),
    forward('GENERATION_STOPPED', TAVERN_EVENTS.GENERATION_STOPPED, true),
  ];

  // SillyTavern fires these when the model or connection profile changes.
  function watchActiveConnection(): () => void {
    const s = (ctx as unknown as { state?: { subscribe(id: string, fn: (v: unknown) => void): () => void } }).state;
    if (!s?.subscribe) return () => {};
    try {
      return s.subscribe('connections.active', () => {
        if (!running) return;
        emit(running.state, TAVERN_EVENTS.CONNECTION_PROFILE_LOADED);
        emit(running.state, TAVERN_EVENTS.CHATCOMPLETION_MODEL_CHANGED);
      });
    } catch {
      return () => {};
    }
  }

  sync();
  return () => {
    for (const u of unsubs) u();
    stop();
  };
}
