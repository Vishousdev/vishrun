import type { SpindleFrontendContext } from 'lumiverse-spindle-types';
import { handleClipboardWriteText } from './clipboard-shim';

// Host side of the in-frame `triggerSlash` shim (JS-Slash-Runner API).
// Composer and no-op commands are handled here; everything else keeps the
// previous clipboard path, which already dispatches /setvar-style commands.

const COMPOSER_SELECTOR = '[data-component="InputArea"] textarea';

export function setComposerText(text: string, doc: Document = document): boolean {
  const ta = doc.querySelector<HTMLTextAreaElement>(COMPOSER_SELECTOR);
  if (!ta) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  if (setter) setter.call(ta, text); else ta.value = text;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.focus();
  return true;
}

export function parseSlash(command: string): { name: string; rest: string } | null {
  const m = /^\s*\/([A-Za-z][\w-]*)\b\s?([\s\S]*)$/.exec(command);
  return m ? { name: m[1].toLowerCase(), rest: m[2] } : null;
}

export async function handleTriggerSlash(
  payload: unknown,
  ctx: SpindleFrontendContext,
  deps: { setComposer?: (text: string) => boolean; fallback?: typeof handleClipboardWriteText } = {},
): Promise<void> {
  const command = payload && typeof payload === 'object'
    ? (payload as { command?: unknown }).command
    : undefined;
  if (typeof command !== 'string') return;
  const parsed = parseSlash(command);
  const setComposer = deps.setComposer ?? setComposerText;

  if (parsed && (parsed.name === 'setinput' || parsed.name === 'input')) {
    if (!setComposer(parsed.rest)) console.warn('[vishrun] triggerSlash: composer not found');
    return;
  }
  if (parsed && parsed.name === 'echo') {
    console.info('[vishrun] /echo', parsed.rest);
    return;
  }
  await (deps.fallback ?? handleClipboardWriteText)({ text: command }, ctx);
}

export function triggerSlashShim(): string {
  return `<script>(function(){` +
    `if(typeof window.triggerSlash==='function')return;` +
    `window.triggerSlash=function(cmd){` +
    `try{window.spindleSandbox.postMessage({kind:'trigger-slash',payload:{command:String(cmd)}});}catch(e){}` +
    `return Promise.resolve('');` +
    `};` +
    `})();</script>`;
}
