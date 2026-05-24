import type { SnapshotMessage } from '../backend/th-helpers';

// TS twin of the ES5 shim string in thHelpersShim() below. The twin is
// testable with happy-dom; the string runs in the sandbox iframe.
// getChatMessages and the two id helpers are sync per the JSR contract;
// setChatMessage stays async via the backend round-trip.

export interface ThHelpersBridge {
  postRequest(kind: string, payload: Record<string, unknown>): Promise<unknown>;
}

export interface ThHelpersConstants {
  currentMessageIndex: number;
  currentMessageId: string;
  chatId: string;
  messagesSnapshot: SnapshotMessage[];
}

export interface ChatMessageNonSwiped {
  message_id: number;
  name: string;
  role: 'system' | 'user' | 'assistant';
  is_hidden: boolean;
  message: string;
  // swipe_id/swipes carried on the default shape too: cards read .swipes
  // without passing include_swipes (the strict JSR split is stricter than
  // the live ST runtime, where message objects carry swipes regardless).
  swipe_id: number;
  swipes: string[];
  data: Record<string, unknown>;
  extra: Record<string, unknown>;
}

export interface ChatMessageSwiped {
  message_id: number;
  name: string;
  role: 'system' | 'user' | 'assistant';
  is_hidden: boolean;
  swipe_id: number;
  swipes: string[];
  swipes_data: Record<string, unknown>[];
  swipes_info: Record<string, unknown>[];
}

export interface ThHelpersHandle {
  getCurrentMessageId(): number;
  getChatId(): string;
  getChatMessages(
    range: string | number,
    opts?: Record<string, unknown>,
  ): Array<ChatMessageNonSwiped | ChatMessageSwiped>;
  setChatMessage(
    fieldValues: string | Record<string, unknown>,
    messageId: number | string,
    opts?: Record<string, unknown>,
  ): Promise<void>;
}

function resolveRangeToIndex(
  range: unknown,
  total: number,
  currentMessageIndex: number,
): number | null {
  if (total === 0) return null;
  if (typeof range === 'number') {
    return range >= 0 ? range : total + range;
  }
  if (typeof range === 'string') {
    const trimmed = range.trim();
    if (trimmed === '' || trimmed === 'latest') return total - 1;
    if (trimmed === 'this') return currentMessageIndex;
    if (/^-?\d+$/.test(trimmed)) {
      const n = parseInt(trimmed, 10);
      return n >= 0 ? n : total + n;
    }
  }
  return null;
}

function shapeFromSnapshot(
  msg: SnapshotMessage,
  includeSwipes: boolean,
): ChatMessageNonSwiped | ChatMessageSwiped {
  if (includeSwipes) {
    const swipes = msg.swipes;
    return {
      message_id: msg.message_id,
      name: msg.name,
      role: msg.role,
      is_hidden: msg.is_hidden,
      swipe_id: msg.swipe_id,
      swipes,
      swipes_data: swipes.map(() => ({})),
      swipes_info: swipes.map(() => ({})),
    };
  }
  return {
    message_id: msg.message_id,
    name: msg.name,
    role: msg.role,
    is_hidden: msg.is_hidden,
    message: msg.message,
    swipe_id: msg.swipe_id,
    swipes: msg.swipes,
    data: msg.data,
    extra: msg.extra,
  };
}

export function createThHelpers(
  consts: ThHelpersConstants,
  bridge: ThHelpersBridge,
): ThHelpersHandle {
  return {
    getCurrentMessageId(): number {
      return consts.currentMessageIndex;
    },
    getChatId(): string {
      return consts.chatId;
    },
    getChatMessages(range, opts) {
      const snap = consts.messagesSnapshot;
      const idx = resolveRangeToIndex(range, snap.length, consts.currentMessageIndex);
      if (idx === null || idx < 0 || idx >= snap.length) return [];
      const includeSwipes =
        !!opts && (opts.include_swipe === true || opts.include_swipes === true);
      return [shapeFromSnapshot(snap[idx], includeSwipes)];
    },
    async setChatMessage(fieldValues, messageId, opts) {
      const normalized =
        typeof fieldValues === 'string' ? { message: fieldValues } : fieldValues;
      await bridge.postRequest('th-set-chat-message', {
        fieldValues: normalized,
        messageId,
        opts: opts ?? {},
      });
    },
  };
}

// ES5 shim string injected into the iframe srcdoc head. getChatMessages
// and the two id helpers resolve synchronously from a baked snapshot;
// setChatMessage goes through the postMessage bridge to backend
// (host-side dispatcher posts 'th-response' back keyed by requestId).
export function thHelpersShim(consts: ThHelpersConstants): string {
  const constsJson = JSON.stringify({
    currentMessageIndex: consts.currentMessageIndex,
    currentMessageId: consts.currentMessageId,
    chatId: consts.chatId,
    messagesSnapshot: consts.messagesSnapshot,
  });
  return `<script>(function(){
var THC = ${constsJson};
var pending = {};
var nextId = 0;
function makeRequestId(){ nextId = (nextId + 1) | 0; return 'th-' + Date.now().toString(36) + '-' + nextId.toString(36); }
function setup(){
  if (!window.spindleSandbox || typeof window.spindleSandbox.onMessage !== 'function') return;
  window.spindleSandbox.onMessage(function(payload){
    if (!payload || typeof payload !== 'object') return;
    if (payload.kind !== 'th-response') return;
    var rid = payload.requestId;
    var slot = pending[rid];
    if (!slot) return;
    delete pending[rid];
    if (payload.ok) slot.resolve(payload.result);
    else slot.reject(new Error(String(payload.error || 'th-helpers backend error')));
  });
}
setup();
function postRequest(kind, body){
  return new Promise(function(resolve, reject){
    if (!window.spindleSandbox || typeof window.spindleSandbox.postMessage !== 'function') {
      reject(new Error('spindleSandbox.postMessage unavailable'));
      return;
    }
    var rid = makeRequestId();
    pending[rid] = { resolve: resolve, reject: reject };
    try {
      window.spindleSandbox.postMessage({ kind: 'th-request', requestId: rid, op: kind, body: body });
    } catch (e) {
      delete pending[rid];
      reject(e);
    }
  });
}
function resolveIdx(range, total, cur){
  if (total === 0) return null;
  if (typeof range === 'number') return range >= 0 ? range : total + range;
  if (typeof range === 'string') {
    var t = range.trim();
    if (t === '' || t === 'latest') return total - 1;
    if (t === 'this') return cur;
    if (/^-?\\d+$/.test(t)) {
      var n = parseInt(t, 10);
      return n >= 0 ? n : total + n;
    }
  }
  return null;
}
function shape(m, withSwipes){
  if (withSwipes) {
    var sw = m.swipes;
    var blanks = [];
    for (var i = 0; i < sw.length; i++) blanks.push({});
    return {
      message_id: m.message_id, name: m.name, role: m.role, is_hidden: m.is_hidden,
      swipe_id: m.swipe_id, swipes: sw, swipes_data: blanks.slice(), swipes_info: blanks.slice()
    };
  }
  return {
    message_id: m.message_id, name: m.name, role: m.role, is_hidden: m.is_hidden,
    message: m.message, swipe_id: m.swipe_id, swipes: m.swipes, data: m.data, extra: m.extra
  };
}
window.getCurrentMessageId = function(){ return THC.currentMessageIndex; };
window.getChatId = function(){ return THC.chatId; };
window.getChatMessages = function(range, opts){
  var snap = THC.messagesSnapshot;
  var idx = resolveIdx(range, snap.length, THC.currentMessageIndex);
  if (idx === null || idx < 0 || idx >= snap.length) return [];
  var withSwipes = !!opts && (opts.include_swipe === true || opts.include_swipes === true);
  return [shape(snap[idx], withSwipes)];
};
window.setChatMessage = function(fieldValues, messageId, opts){
  var normalized = (typeof fieldValues === 'string') ? { message: fieldValues } : fieldValues;
  return postRequest('th-set-chat-message', { fieldValues: normalized, messageId: messageId, opts: opts || {} });
};
})();</script>`;
}
