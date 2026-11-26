// TS twin of the ES5 shim string below. Cards expect a SillyTavern-
// compatible Mvu surface synchronously: $(errorCatched(init)) calls init(),
// which awaits waitGlobalInitialized, then reads getAllVariables and
// registers eventOn(VARIABLE_UPDATE_ENDED).
//
// getAllVariables returns a baked snapshot (read at iframe build time).
// VARIABLE_UPDATE_ENDED registers but does not fire live — message
// re-renders (MESSAGE_EDITED/SWIPED) rebuild the iframe with a fresh
// snapshot, which is how the Status Bar gets updated values.

import type { MvuData } from '../backend/mvu-parser';
import { inlineJson } from './inline-json';
export type { MvuData };

export interface MvuConstants {
  variablesSnapshot: MvuData;
}

export const MVU_EVENTS = Object.freeze({
  VARIABLE_INITIALIZED: 'mag_variable_initiailized',
  VARIABLE_UPDATE_STARTED: 'mag_variable_update_started',
  COMMAND_PARSED: 'mag_command_parsed',
  VARIABLE_UPDATE_ENDED: 'mag_variable_update_ended',
  BEFORE_MESSAGE_UPDATE: 'mag_before_message_update',
});

export interface MvuHandle {
  Mvu: {
    events: typeof MVU_EVENTS;
    getMvuData(opts?: Record<string, unknown>): MvuData;
    replaceMvuData(data: MvuData, opts?: Record<string, unknown>): Promise<void>;
    parseMessage(message: string, oldData: MvuData): Promise<MvuData | undefined>;
    isDuringExtraAnalysis(): boolean;
  };
  getAllVariables(): MvuData;
  waitGlobalInitialized(name: string): Promise<void>;
  eventOn(event: string, listener: (...args: unknown[]) => unknown): void;
  eventOnce(event: string, listener: (...args: unknown[]) => unknown): void;
  eventEmit(event: string, ...args: unknown[]): void;
  eventRemoveListener(event: string, listener: (...args: unknown[]) => unknown): void;
  eventClearAll(): void;
  errorCatched<T extends unknown[], U>(fn: (...args: T) => U): (...args: T) => U;
}

export function createMvuHelpers(consts: MvuConstants): MvuHandle {
  type Listener = (...args: unknown[]) => unknown;
  const listeners = new Map<string, Set<Listener>>();

  function registerListener(event: string, listener: Listener, once: boolean): void {
    let set = listeners.get(event);
    if (!set) {
      set = new Set();
      listeners.set(event, set);
    }
    if (once) {
      const wrapper: Listener = (...args) => {
        set!.delete(wrapper);
        return listener(...args);
      };
      set.add(wrapper);
    } else {
      set.add(listener);
    }
  }

  return {
    Mvu: {
      events: MVU_EVENTS,
      getMvuData() {
        return consts.variablesSnapshot;
      },
      async replaceMvuData() {
        // Stub: no card in scope writes back via this API.
      },
      async parseMessage() {
        return undefined;
      },
      isDuringExtraAnalysis() {
        return false;
      },
    },
    getAllVariables() {
      return consts.variablesSnapshot;
    },
    async waitGlobalInitialized(name) {
      // Mvu is already populated synchronously when the shim ran.
      if (name === 'Mvu') return;
      // Other names: never resolves (no other globals shimmed).
      return new Promise<void>(() => {});
    },
    eventOn(event, listener) {
      registerListener(event, listener, false);
    },
    eventOnce(event, listener) {
      registerListener(event, listener, true);
    },
    eventEmit(event, ...args) {
      const set = listeners.get(event);
      if (!set) return;
      for (const l of [...set]) {
        try { l(...args); } catch (e) { console.warn('[vishrun:mvu] listener threw:', e); }
      }
    },
    eventRemoveListener(event, listener) {
      listeners.get(event)?.delete(listener);
    },
    eventClearAll() {
      listeners.clear();
    },
    errorCatched(fn) {
      return ((...args: unknown[]) => {
        try {
          return (fn as (...a: unknown[]) => unknown)(...args);
        } catch (e) {
          console.error('[vishrun:mvu] errorCatched:', e);
          throw e;
        }
      }) as typeof fn;
    },
  };
}

// ES5 shim string injected after lodash + th-helpers. Sets `window.Mvu`,
// `window.getAllVariables`, `window.waitGlobalInitialized`, `window.eventOn`
// and friends, `window.errorCatched`. The variables snapshot is baked in
// as a constant so getAllVariables returns synchronously per the JSR
// contract Queen Bee Status Bar depends on.
export function mvuShim(consts: MvuConstants): string {
  const constsJson = inlineJson({ variablesSnapshot: consts.variablesSnapshot });
  const eventsJson = JSON.stringify(MVU_EVENTS);
  return `<script>(function(){
var MVUC = ${constsJson};
var EVENTS = ${eventsJson};
var listeners = {};
function reg(event, listener, once){
  if (!listeners[event]) listeners[event] = [];
  var arr = listeners[event];
  if (once) {
    var wrap = function(){
      var i = arr.indexOf(wrap);
      if (i >= 0) arr.splice(i, 1);
      return listener.apply(null, arguments);
    };
    arr.push(wrap);
  } else {
    arr.push(listener);
  }
}
window.Mvu = {
  events: EVENTS,
  getMvuData: function(){ return MVUC.variablesSnapshot; },
  replaceMvuData: function(){ return Promise.resolve(); },
  parseMessage: function(){ return Promise.resolve(undefined); },
  isDuringExtraAnalysis: function(){ return false; }
};
window.getAllVariables = function(){ return MVUC.variablesSnapshot; };
window.waitGlobalInitialized = function(name){
  if (name === 'Mvu') return Promise.resolve();
  return new Promise(function(){});
};
window.eventOn = function(event, listener){ reg(event, listener, false); };
window.eventOnce = function(event, listener){ reg(event, listener, true); };
window.eventEmit = function(event){
  var arr = listeners[event];
  if (!arr) return;
  var args = Array.prototype.slice.call(arguments, 1);
  var copy = arr.slice();
  for (var i = 0; i < copy.length; i++) {
    try { copy[i].apply(null, args); } catch (e) { try { console.warn('[vishrun:mvu] listener threw:', e); } catch (_e) {} }
  }
};
window.eventRemoveListener = function(event, listener){
  var arr = listeners[event];
  if (!arr) return;
  var i = arr.indexOf(listener);
  if (i >= 0) arr.splice(i, 1);
};
window.eventClearAll = function(){ listeners = {}; };
window.errorCatched = function(fn){
  return function(){
    try { return fn.apply(this, arguments); }
    catch (e) { try { console.error('[vishrun:mvu] errorCatched:', e); } catch (_e) {} throw e; }
  };
};
})();</script>`;
}
