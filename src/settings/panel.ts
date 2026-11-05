import type { SpindleFrontendContext } from 'lumiverse-spindle-types';
import { presetRpc } from '../preset-scripts/rpc';
import { resyncScripts, type ActiveScripts, type PageScript } from '../preset-scripts/runner';
import { isMvuLoader } from '../preset-scripts/script-imports';
import { fetchVariablesSnapshot } from '../render/th-helpers-bridge';
import { getChatMessages } from '../lumiverse/host-api';
import { renderTree } from './tree';
import { widgetStatus, type WidgetState } from './widget-status';
import { getActiveCard } from '../state/active-card';

// Vishrun's section in Settings > Extensions, opened from the settings button
// on Vishrun's card in the Extensions panel. Shows the open chat's character
// scripts, the chat's variables (read-only) and the active preset's scripts.
// Switches only change Vishrun's own storage, never the card or preset.

const README_URL = 'https://github.com/Vishousdev/vishrun#readme';

const STYLE = `
.vr-settings { display: flex; flex-direction: column; gap: 12px; color: var(--lumiverse-text); font-size: 14px; }
.vr-settings[hidden], .vr-settings [hidden] { display: none !important; }
.vr-settings .vr-header { display: flex; flex-direction: column; gap: 4px; }
.vr-settings .vr-title { font-weight: 600; }
.vr-settings .vr-dim { color: var(--lumiverse-text-muted, var(--lumiverse-text-dim)); font-size: 13px; }
.vr-settings a { color: var(--lumiverse-primary); }
.vr-settings .vr-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 6px 0; }
.vr-settings .vr-row-main { display: flex; flex-direction: column; min-width: 0; }
.vr-settings .vr-row-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.vr-settings .vr-allow { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; border: 1px solid var(--lumiverse-border); border-radius: var(--lumiverse-radius, 8px); background: var(--lumiverse-fill-subtle); }
.vr-settings .vr-subhead { margin-top: 8px; font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--lumiverse-text-muted, var(--lumiverse-text-dim)); }
.vr-settings .vr-list { margin-left: 4px; padding-left: 12px; border-left: 2px solid var(--lumiverse-border); }
.vr-settings .vr-list.vr-off { opacity: .55; }
.vr-settings .vr-script + .vr-script { border-top: 1px solid var(--lumiverse-border); }
.vr-settings .vr-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vr-settings button.vr-link { background: none; border: 1px solid var(--lumiverse-border); border-radius: var(--lumiverse-radius, 6px); color: var(--lumiverse-text); padding: 2px 10px; cursor: pointer; font-size: 12px; }
.vr-settings button.vr-link:hover { background: var(--lumiverse-fill-subtle); }
.vr-settings .vr-view { display: flex; flex-direction: column; gap: 8px; padding: 4px 0 10px; }
.vr-settings .vr-label { font-size: 12px; font-weight: 600; color: var(--lumiverse-text-muted, var(--lumiverse-text-dim)); }
.vr-settings .vr-notes { white-space: pre-wrap; word-break: break-word; }
.vr-settings pre.vr-code { margin: 0; max-height: 320px; overflow: auto; padding: 8px; border-radius: var(--lumiverse-radius, 6px); background: var(--lumiverse-fill-subtle); font-size: 12px; white-space: pre-wrap; word-break: break-word; }
.vr-settings .vr-tree { font-family: ui-monospace, monospace; font-size: 12px; }
.vr-settings .vr-tree details > summary { cursor: pointer; padding: 1px 0; }
.vr-settings .vr-tree .vr-tree-children { padding-left: 14px; border-left: 1px solid var(--lumiverse-border); margin-left: 4px; }
.vr-settings .vr-tree .vr-key { color: var(--lumiverse-text-muted, var(--lumiverse-text-dim)); }
.vr-settings .vr-tree .vr-leaf { padding: 1px 0; word-break: break-word; }
`;

type Handle = { destroy(): void };
type SourceKind = 'character' | 'preset';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function installSettingsPanel(ctx: SpindleFrontendContext): () => void {
  const root = ctx.ui.mount('settings_extensions') as HTMLElement;
  root.classList.add('vr-settings');
  const style = el('style');
  style.textContent = STYLE;
  let content = el('div', 'vr-settings');
  content.append(el('div', 'vr-dim', 'Loading…'));
  root.append(style, content);

  let handles: Handle[] = [];
  const expanded = new Map<string, boolean>();
  const openViews = new Set<string>();
  const openTree = new Set<string>();
  let rendering: Promise<void> | null = null;
  let again = false;
  let stale = true;

  const comp = ctx.components;
  const track = <T extends Handle>(h: T): T => { handles.push(h); return h; };

  const section = (parent: HTMLElement, key: string, title: string, badge?: string | number): HTMLElement => {
    const host = el('div');
    parent.append(host);
    const h = track(comp.mountCollapsibleSection(host, {
      title,
      ...(badge !== undefined ? { badge } : {}),
      defaultExpanded: expanded.get(key) ?? false,
      // Lumiverse draws components only while they are on the page, so an
      // opened section is drawn again with its switches inside.
      onToggle: (open) => {
        expanded.set(key, open);
        if (open) refresh();
      },
    }));
    return h.body;
  };

  const ids = (kind: SourceKind, id: string) => (kind === 'preset' ? { presetId: id } : { characterId: id });

  const scriptRow = (parent: HTMLElement, kind: SourceKind, ownerId: string, consent: boolean | null, s: PageScript) => {
    const row = el('div', 'vr-script');
    const line = el('div', 'vr-row');
    const main = el('div', 'vr-row-main');
    main.append(el('span', 'vr-name', s.name || '(unnamed)'));
    const actions = el('div', 'vr-row-actions');
    const viewKey = `${kind}:${ownerId}:${s.id}`;
    const viewBtn = el('button', 'vr-link', openViews.has(viewKey) ? 'Hide' : 'View');
    viewBtn.type = 'button';
    actions.append(viewBtn);
    const switchHost = el('span');
    actions.append(switchHost);
    if (isMvuLoader(s.content)) {
      track(comp.mountBadge(switchHost, { text: 'Handled by Vishrun', color: 'info', size: 'sm' }));
    } else {
      track(comp.mountSwitch(switchHost, {
        checked: s.enabled,
        size: 'sm',
        ariaLabel: `Run ${s.name}`,
        onChange: (on) => {
          void presetRpc(ctx, 'set_script_enabled', { ...ids(kind, ownerId), scriptId: s.id, enabled: on })
            .then(() => { if (consent === true) resyncScripts(); refresh(); })
            .catch((e) => console.warn('[vishrun] settings: script switch', e));
        },
      }));
    }
    line.append(main, actions);
    row.append(line);

    const view = el('div', 'vr-view');
    view.hidden = !openViews.has(viewKey);
    if (s.info.trim()) view.append(el('div', 'vr-label', 'Author notes'), el('div', 'vr-notes', s.info));
    const buttons = s.buttons.filter((b) => b.visible).map((b) => b.name);
    if (buttons.length) view.append(el('div', 'vr-label', 'Buttons (Extras menu)'), el('div', 'vr-notes', buttons.join(', ')));
    view.append(el('div', 'vr-label', 'Code'), el('pre', 'vr-code', s.content));
    row.append(view);
    viewBtn.addEventListener('click', () => {
      view.hidden = !view.hidden;
      if (view.hidden) openViews.delete(viewKey); else openViews.add(viewKey);
      viewBtn.textContent = view.hidden ? 'View' : 'Hide';
    });
    parent.append(row);
  };

  const sourceBlock = (parent: HTMLElement, kind: SourceKind, src: { id: string; name: string; consent: boolean | null; all?: PageScript[] }) => {
    const all = src.all ?? [];
    if (all.length === 0) {
      parent.append(el('div', 'vr-dim', kind === 'character' ? 'This character has no scripts.' : 'This preset has no scripts.'));
      return;
    }
    // The permission, kept apart from the script list it controls.
    const allow = el('div', 'vr-allow');
    const main = el('div', 'vr-row-main');
    const label = kind === 'character' ? "Allow this character's scripts" : "Allow this preset's scripts";
    main.append(el('span', 'vr-title', label));
    main.append(el('span', 'vr-dim', src.consent === null
      ? 'Not decided yet. You will be asked when they first run.'
      : kind === 'character' ? 'Scripts only run while this chat is open.' : 'Scripts run while this preset is active.'));
    const switchHost = el('span');
    allow.append(main, switchHost);
    parent.append(allow);
    track(comp.mountSwitch(switchHost, {
      checked: src.consent === true,
      ariaLabel: label,
      onChange: (on) => {
        void presetRpc(ctx, 'set_consent', { ...ids(kind, src.id), allowed: on })
          .then(() => { resyncScripts(); refresh(); })
          .catch((e) => console.warn('[vishrun] settings: consent switch', e));
      },
    }));
    parent.append(el('div', 'vr-subhead', `Scripts · ${all.length}`));
    const list = el('div', src.consent === true ? 'vr-list' : 'vr-list vr-off');
    parent.append(list);
    for (const s of all) scriptRow(list, kind, src.id, src.consent, s);
  };

  const WIDGET_LABEL: Record<WidgetState, [string, 'primary' | 'info' | 'danger' | 'neutral']> = {
    vishrun: ['Vishrun', 'primary'],
    lumiverse: ['Lumiverse', 'info'],
    unsupported: ['Not supported', 'danger'],
    off: ['Off', 'neutral'],
  };

  const widgetsBlock = (parent: HTMLElement, characterId: string) => {
    const card = getActiveCard();
    if (!card || card.characterId !== characterId) {
      parent.append(el('div', 'vr-dim', 'Not loaded yet. Try again in a moment.'));
      return;
    }
    const widgets = widgetStatus(card.scripts, card.nativeKeys);
    if (widgets.length === 0) {
      parent.append(el('div', 'vr-dim', 'This character has no widgets.'));
      return;
    }
    parent.append(el('div', 'vr-dim', 'Who draws each widget in messages. "Not supported" widgets do not show.'));
    const list = el('div', 'vr-list');
    for (const w of widgets) {
      const row = el('div', 'vr-row vr-script');
      row.append(el('span', 'vr-name', w.name));
      const badgeHost = el('span');
      row.append(badgeHost);
      const [text, color] = WIDGET_LABEL[w.state];
      track(comp.mountBadge(badgeHost, { text, color, size: 'sm' }));
      list.append(row);
    }
    parent.append(list);
  };

  const variablesBlock = async (parent: HTMLElement, chatId: string, characterId: string | null) => {
    const refreshBtn = el('button', 'vr-link', 'Refresh');
    refreshBtn.type = 'button';
    refreshBtn.addEventListener('click', () => refresh());
    const top = el('div', 'vr-row');
    top.append(el('span', 'vr-dim', 'Read-only. Updates as the chat changes.'), refreshBtn);
    parent.append(top);

    const messages = await getChatMessages(chatId).catch(() => []);
    const last = messages[messages.length - 1];
    const [mvu, chat, character, global] = await Promise.all([
      last
        ? fetchVariablesSnapshot({ chatId, currentMessageId: last.id, currentMessageIndex: messages.length - 1 }, ctx)
        : Promise.resolve({ stat_data: {} }),
      presetRpc<Record<string, unknown>>(ctx, 'vars_get', { scope: 'chat', chatId }).catch(() => ({})),
      characterId
        ? presetRpc<Record<string, unknown>>(ctx, 'vars_get', { scope: 'character', characterId }).catch(() => ({}))
        : Promise.resolve({}),
      presetRpc<Record<string, unknown>>(ctx, 'vars_get', { scope: 'global' }).catch(() => ({})),
    ]);
    const blocks: [string, string, unknown][] = [
      ['mvu', 'MVU values', mvu.stat_data],
      ['chat', 'Chat variables', chat],
      ['character', 'Character variables', character],
      ['global', 'Global variables', global],
    ];
    for (const [key, title, value] of blocks) {
      const count = value && typeof value === 'object' ? Object.keys(value).length : 0;
      const body = section(parent, `vars:${key}`, title, count);
      body.append(count === 0 ? el('div', 'vr-dim', 'Empty.') : renderTree(value, key, openTree));
    }
  };

  const render = async () => {
    const { chatId } = ctx.getActiveChat();
    const info = await presetRpc<ActiveScripts | null>(ctx, 'active_scripts', { chatId }).catch(() => null);
    // Built attached but hidden: Lumiverse only draws its components inside
    // the extension's own mount, so the new tree has to be in place already.
    const next = el('div', 'vr-settings');
    next.hidden = true;
    root.append(next);
    const old = handles;
    handles = [];

    const header = el('div', 'vr-header');
    header.append(el('span', 'vr-title', `Vishrun v${ctx.manifest?.version ?? ''}`));
    const warn = el('span', 'vr-dim', 'Card and preset scripts run with full access to Lumiverse while they are active. Only allow ones you trust. ');
    const more = el('a', undefined, 'Read more');
    more.href = README_URL;
    more.target = '_blank';
    more.rel = 'noopener noreferrer';
    warn.append(more);
    header.append(warn);
    next.append(header);

    const charTitle = chatId && info?.character ? `Character scripts · ${info.character.name}` : 'Character scripts';
    const charBody = section(next, 'character', charTitle, info?.character?.all?.length || undefined);
    if (!chatId) charBody.append(el('div', 'vr-dim', "Open a chat to see its character's scripts and variables."));
    else if (!info?.character) charBody.append(el('div', 'vr-dim', 'This chat has no character.'));
    else sourceBlock(charBody, 'character', info.character);

    const charId = chatId && info?.character ? info.character.id : null;
    if (charId) {
      const card = getActiveCard();
      const count = card && card.characterId === charId ? widgetStatus(card.scripts, card.nativeKeys).length : undefined;
      const widgetsBody = section(next, 'widgets', 'Widgets', count || undefined);
      if (expanded.get('widgets')) widgetsBlock(widgetsBody, charId);
    }

    // Values load only while the section is open: replaying MVU can be slow.
    if (chatId) {
      const varsBody = section(next, 'variables', 'Variables');
      if (expanded.get('variables')) await variablesBlock(varsBody, chatId, info?.character?.id ?? null);
    }

    const presetTitle = info?.preset ? `Preset scripts · ${info.preset.name}` : 'Preset scripts';
    const presetBody = section(next, 'preset', presetTitle, info?.preset?.all?.length || undefined);
    if (!info?.preset) presetBody.append(el('div', 'vr-dim', 'No active preset.'));
    else sourceBlock(presetBody, 'preset', info.preset);

    for (const h of old) { try { h.destroy(); } catch { /* already gone */ } }
    content.remove();
    next.hidden = false;
    content = next;
  };

  // Only renders while the section is on screen; otherwise it waits.
  const visible = () => root.isConnected && root.getClientRects().length > 0;
  function refresh(): void {
    if (!visible()) { stale = true; return; }
    stale = false;
    if (rendering) { again = true; return; }
    rendering = render().catch((e) => console.warn('[vishrun] settings: render', e)).finally(() => {
      rendering = null;
      if (again) { again = false; refresh(); }
    });
  }

  const io = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting) && stale) refresh();
  });
  io.observe(root);
  // Browsers pause observers in background tabs; a slow check covers that.
  const poll = setInterval(() => { if (stale && visible()) refresh(); }, 1000);

  const events = ['CHAT_SWITCHED', 'PRESET_CHANGED', 'MESSAGE_SENT', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'GENERATION_ENDED'];
  const unsubs = events.map((name) => ctx.events.on(name, () => refresh()));
  unsubs.push(ctx.events.on('SETTINGS_UPDATED', (payload) => {
    const p = (payload || {}) as { key?: unknown; keys?: unknown };
    const keys = Array.isArray(p.keys) ? p.keys : [p.key];
    if (keys.some((k) => k === 'activeChatId' || k === 'activeLoomPresetId' || k === 'activeCharacterId')) refresh();
  }));
  refresh();

  return () => {
    clearInterval(poll);
    io.disconnect();
    for (const u of unsubs) u();
    for (const h of handles) { try { h.destroy(); } catch { /* already gone */ } }
    root.remove();
  };
}
