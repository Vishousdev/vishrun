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

const SEND_BUTTON_SELECTOR = '[data-component="InputArea"] button[class*="sendBtn"]:not([class*="sendBtnStop"])';

// Clicks the host send button once React has taken the new composer value.
export function clickSend(doc: Document = document, delayMs = 60): Promise<boolean> {
  return new Promise((resolve) => {
    setTimeout(() => {
      const btn = doc.querySelector<HTMLButtonElement>(SEND_BUTTON_SELECTOR);
      if (!btn || btn.disabled) return resolve(false);
      btn.click();
      resolve(true);
    }, delayMs);
  });
}

// Splits an STscript pipeline on `|` that starts a new command.
export function splitPipeline(command: string): string[] {
  return command.split(/\|(?=\s*\/[A-Za-z])/).map((c) => c.trim()).filter(Boolean);
}

export function parseSlash(command: string): { name: string; rest: string } | null {
  const m = /^\s*\/([A-Za-z][\w-]*)\b\s?([\s\S]*)$/.exec(command);
  return m ? { name: m[1].toLowerCase(), rest: m[2] } : null;
}

export async function handleTriggerSlash(
  payload: unknown,
  ctx: SpindleFrontendContext,
  deps: {
    setComposer?: (text: string) => boolean;
    send?: () => Promise<boolean>;
    fallback?: typeof handleClipboardWriteText;
  } = {},
): Promise<void> {
  const command = payload && typeof payload === 'object'
    ? (payload as { command?: unknown }).command
    : undefined;
  if (typeof command !== 'string') return;
  const setComposer = deps.setComposer ?? setComposerText;
  const steps = splitPipeline(command).map(parseSlash);

  // `/send <text>` with optional `/trigger`: the user turn goes through the host composer.
  const [first, second] = steps;
  if (first?.name === 'send' && steps.length <= 2 && (!second || second.name === 'trigger')) {
    if (!setComposer(first.rest)) {
      console.warn('[vishrun] triggerSlash: composer not found');
      return;
    }
    if (second && !(await (deps.send ?? clickSend)())) console.warn('[vishrun] triggerSlash: send button unavailable');
    return;
  }

  const parsed = parseSlash(command);

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
