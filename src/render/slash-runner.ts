import type { SpindleFrontendContext } from 'lumiverse-spindle-types';
import { handleClipboardWriteText } from './clipboard-shim';
import { presetRpc } from '../preset-scripts/rpc';
import { splitNamedArgs } from '../preset-scripts/dialogs';
import { unescapeSlashArg } from '../core/st-entry-field';

export type SlashRpc = (op: string, args: Record<string, unknown>) => Promise<unknown>;

const SEVERITIES = new Set(['info', 'success', 'warning', 'error']);

// ST commands Vishrun runs itself. Returns false for any other command.
export async function runStSlashCommand(name: string, rest: string, chatId: string | null, rpc: SlashRpc): Promise<boolean> {
  if (name === 'setentryfield') {
    const { named, text } = splitNamedArgs(rest);
    await rpc('wb_set_field', {
      chatId,
      file: unescapeSlashArg(named.file ?? ''),
      uid: named.uid ?? '',
      field: named.field ?? 'content',
      value: unescapeSlashArg(text),
    }).catch((e) => console.warn('[vishrun] /setentryfield:', e instanceof Error ? e.message : e));
    return true;
  }
  if (name === 'echo') {
    const { named, text } = splitNamedArgs(rest);
    const kind = SEVERITIES.has(named.severity ?? '') ? named.severity : 'info';
    void rpc('toast', { kind, message: unescapeSlashArg(text) }).catch(() => {});
    return true;
  }
  return false;
}

const RUNNABLE = new Set(['setentryfield', 'echo']);

// Host side of the in-frame `triggerSlash` shim (JS-Slash-Runner API).
// Composer and no-op commands are handled here; everything else keeps the
// previous clipboard path, which already dispatches /setvar-style commands.

export const COMPOSER_SELECTOR = '[data-component="InputArea"] textarea';

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
  return command.split(/(?<!\\)\|(?=\s*\/[A-Za-z])/).map((c) => c.trim()).filter(Boolean);
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
    rpc?: SlashRpc;
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

  if (steps.length > 0 && steps.every((s) => s && RUNNABLE.has(s.name))) {
    const rpc = deps.rpc ?? ((op: string, args: Record<string, unknown>) => presetRpc(ctx, op, args));
    const chatId = ctx.getActiveChat?.().chatId ?? null;
    for (const s of steps) await runStSlashCommand(s!.name, s!.rest, chatId, rpc);
    return;
  }

  const parsed = parseSlash(command);

  if (parsed && (parsed.name === 'setinput' || parsed.name === 'input')) {
    if (!setComposer(parsed.rest)) console.warn('[vishrun] triggerSlash: composer not found');
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
