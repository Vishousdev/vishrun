import type { SpindleFrontendContext } from 'lumiverse-spindle-types';
import { fetchCharacter, extractRegexScripts } from './lumiverse/fetch-character';
import { setActiveCard, clearActiveCard, getActiveCard } from './state/active-card';
import { installMessageHooks } from './hooks/message-rendered';
import { rebuildCapturesFromContent } from './hooks/tag-interceptor';
import { registerMvuDisplayStrip } from './hooks/mvu-display-strip';
import { installStatusBarInjectHook } from './hooks/status-bar-inject';
import { destroyAllRegisteredWidgetsForMessage } from './render/widget-iframe';
import { shouldRescanForChangedFields } from './core/chat-changed-filter';
import { knownNativeKeys, requestRegexTakeover } from './core/regex-takeover-client';
import { getChatCharacterId, setHostContext } from './lumiverse/host-api';

interface ChatChangedPayload {
  chatId?: string | null;
  characterId?: string | null;
  changedFields?: string[];
}

interface MessageEventPayload {
  chatId?: string;
  message?: { id?: string; content?: string };
  action?: string;
  swipeId?: number;
  previousSwipeId?: number;
}

export function touchesActiveChat(payload: unknown): boolean {
  const p = (payload || {}) as { key?: unknown; keys?: unknown };
  const keys = Array.isArray(p.keys) ? p.keys : [p.key];
  return keys.some((k) => k === 'activeChatId' || k === 'activeCharacterId');
}

export function setup(ctx: SpindleFrontendContext) {
  setHostContext(ctx);
  const hooks = installMessageHooks(ctx);
  // System-wide: hide <UpdateVariable> blocks from the chat UI without
  // mutating the stored content. The backend MVU replay needs the blocks
  // in the DB row.
  const unsubMvuDisplayStrip = registerMvuDisplayStrip(ctx);
  // System-wide: append <StatusPlaceHolderImpl/> to LLM responses that
  // lack the trigger so the Status Bar widget mounts on assistant
  // messages too (greeting already carries the placeholder in the card).
  const unsubStatusBarInject = installStatusBarInjectHook(ctx);
  // Per-character debounce: avoid duplicate fetches when CHAT_CHANGED fires
  // with the same characterId (e.g. swipe edits, transient state).
  let inflightCharacterId: string | null = null;
  let lastLoadedCharacterId: string | null = null;

  async function loadFor(characterId: string | null) {
    if (!characterId) {
      clearActiveCard();
      lastLoadedCharacterId = null;
      hooks.rescanAll(); // detaches the observer when there's no active card
      return;
    }
    if (inflightCharacterId === characterId) return;
    if (lastLoadedCharacterId === characterId && getActiveCard()?.characterId === characterId) {
      // Same character as before — cache is valid. Still rescan because the
      // chat itself may have changed (different chat, same character).
      hooks.rescanAll();
      return;
    }
    inflightCharacterId = characterId;
    try {
      const char = await fetchCharacter(characterId);
      const scripts = extractRegexScripts(char);
      const name = (char.name as string | undefined) ?? null;

      if (scripts.length === 0) {
        clearActiveCard();
        lastLoadedCharacterId = characterId;
        hooks.rescanAll(); // detaches the observer for cards without scripts
        return;
      }

      const firstMes = typeof char.first_mes === 'string' ? char.first_mes : null;
      const alternateGreetings = Array.isArray(char.alternate_greetings)
        ? char.alternate_greetings.filter((g): g is string => typeof g === 'string')
        : [];
      const nativeNow = knownNativeKeys(characterId);
      setActiveCard({
        characterId, characterName: name, scripts, firstMes, alternateGreetings,
        ...(nativeNow ? { nativeKeys: new Set(nativeNow) } : {}),
      });
      lastLoadedCharacterId = characterId;
      hooks.rescanAll();
      void requestRegexTakeover(ctx, characterId, scripts).then(({ disabled, native }) => {
        const card = getActiveCard();
        if (!card || card.characterId !== characterId) return;
        const prev = card.nativeKeys ?? new Set<string>();
        const next = new Set(native);
        const changed = prev.size !== next.size || [...next].some((k) => !prev.has(k));
        card.nativeKeys = next;
        if (disabled === 0 && !changed) return;
        (ctx as { display?: { invalidate?: (vars: string[]) => void } }).display?.invalidate?.(['*']);
        hooks.rescanAll();
      });
    } catch (err) {
      console.debug('[vishrun] fetchCharacter failed:', err);
    } finally {
      if (inflightCharacterId === characterId) inflightCharacterId = null;
    }
  }

  // The host sets activeChatId before activeCharacterId when a chat is opened
  // without a navigation snapshot, so SETTINGS_UPDATED can arrive while the
  // character is still unknown. Resolve it from the chat record in that case.
  async function resolveActiveCharacterId(): Promise<string | null> {
    const active = ctx.getActiveChat();
    if (active.characterId || !active.chatId) return active.characterId ?? null;
    try {
      const characterId = await getChatCharacterId(active.chatId);
      const now = ctx.getActiveChat();
      if (now.chatId !== active.chatId) return now.characterId ?? null;
      return now.characterId ?? characterId ?? null;
    } catch {
      return null;
    }
  }

  const unsubChatChanged = ctx.events.on('CHAT_CHANGED', (payload: unknown) => {
    const p = (payload || {}) as ChatChangedPayload;
    if (!shouldRescanForChangedFields(p.changedFields)) return;
    void loadFor(p.characterId ?? ctx.getActiveChat().characterId ?? null);
  });

  // Workaround for upstream issue: the host's `delivered` Set in
  // Lumiverse/frontend/src/lib/spindle/message-interceptors.ts:21 dedupes
  // tag intercept dispatches by (extensionId, messageId, isStreaming,
  // tagName, fullMatch) and never clears. Swiping back to a previously-
  // seen swipe doesn't re-fire the interceptor, so capturesByMessage
  // holds stale captures and the widget shows content from another swipe
  // (the last unique fullMatch the handler did fire for).
  //
  // We compute captures locally from the event payload to bypass the
  // host pipeline entirely. MESSAGE_SWIPED + MESSAGE_EDITED both ship
  // the new message body in `message.content` (chats.service.ts:982-989
  // for swipe, similar for edit), so re-running each paired-tag script's
  // findRe against that string lets us reconstruct what the captures
  // *should* be without depending on the interceptor firing.
  function handleMessageMutation(eventName: 'MESSAGE_EDITED' | 'MESSAGE_SWIPED', payload: unknown): void {
    const p = (payload || {}) as MessageEventPayload;
    const msg = p.message;
    if (!msg || typeof msg.id !== 'string' || typeof msg.content !== 'string') return;
    const active = ctx.getActiveChat();
    if (active.chatId && p.chatId && active.chatId !== p.chatId) return;

    // Force-rebuild every widget iframe in the affected message. The
    // iframe registry keys on (messageId, scriptId, fullMatchHash); for
    // static paired tags like <StatusPlaceHolderImpl> the fullMatch is
    // identical across alternate greetings, so the idempotency check in
    // renderPairedTagCaptures would reuse the existing iframe with its
    // STALE baked-in variables snapshot. Wiping the registry here forces
    // the next processNode pass to rebuild with a fresh snapshot.
    const destroyReason = eventName === 'MESSAGE_EDITED' ? 'message-edited' : 'message-swiped';
    destroyAllRegisteredWidgetsForMessage(msg.id, destroyReason);

    const compiled = hooks.compiledForActiveCard();
    if (!compiled) return;
    // rebuildCapturesFromContent updates capturesByMessage so phase-1
    // cleanup in renderPairedTagCaptures has a fresh capture list to
    // compare against. processMessageById then forces processNode to run
    // even if rebuildCapturesFromContent reported no semantic change
    // (which happens when the paired-tag content didn't change across
    // greetings — the case that motivated the destroyAll above).
    rebuildCapturesFromContent(msg.id, msg.content, compiled, eventName);
    hooks.processMessageById(msg.id);
  }

  const unsubMessageSwiped = ctx.events.on('MESSAGE_SWIPED', (p) => handleMessageMutation('MESSAGE_SWIPED', p));
  const unsubMessageEdited = ctx.events.on('MESSAGE_EDITED', (p) => handleMessageMutation('MESSAGE_EDITED', p));

  // Cold-load from /characters: Lumiverse's SPA hydrates activeChatId /
  // activeCharacterId AFTER spindle setup() runs. CHAT_CHANGED only fires
  // on subsequent intra-app navigation, not on this initial hydration.
  // SETTINGS_UPDATED with key 'activeChatId' or 'activeCharacterId' is the
  // wakeup. Watch-item: depends on those literal key strings; if Lumiverse
  // renames either, the cold-load path silently breaks until something
  // else (CHAT_CHANGED) wakes the extension.
  // Single updates carry `key`, batched ones `keys`.
  const unsubSettingsUpdated = ctx.events.on('SETTINGS_UPDATED', (payload: unknown) => {
    if (!touchesActiveChat(payload)) return;
    void resolveActiveCharacterId().then(loadFor);
  });

  // Safety net for a hydration that no event reports: check the active chat
  // once a second until a card is loaded, for the first 20 seconds.
  let coldTries = 0;
  const coldTimer = setInterval(() => {
    if (++coldTries > 20 || lastLoadedCharacterId !== null) {
      clearInterval(coldTimer);
      return;
    }
    const now = ctx.getActiveChat();
    if (!now.characterId && !now.chatId) return;
    void resolveActiveCharacterId().then((id) => { if (id && lastLoadedCharacterId === null) void loadFor(id); });
  }, 1000);

  // If Lumiverse already hydrated by the time setup() runs, kick the load
  // synchronously. Otherwise wait for SETTINGS_UPDATED. We deliberately do
  // NOT call loadFor(null) here: that would render the "no character"
  // branch (observer detached) which is correct as a runtime cleanup but
  // wrong as a setup-time default.
  const active = ctx.getActiveChat();
  if (active.characterId || active.chatId) {
    void resolveActiveCharacterId().then((id) => { if (id) void loadFor(id); });
  }

  return () => {
    clearInterval(coldTimer);
    unsubChatChanged();
    unsubSettingsUpdated();
    unsubMessageSwiped();
    unsubMessageEdited();
    unsubMvuDisplayStrip();
    unsubStatusBarInject();
    hooks.dispose();
    ctx.dom.cleanup();
    clearActiveCard();
    setHostContext(null);
  };
}
