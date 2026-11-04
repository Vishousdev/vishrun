import type { SpindleFrontendContext } from 'lumiverse-spindle-types';
import { buildWidgetIframe, destroyWidgetIframe } from '../render/widget-iframe';
import { resolveMacrosBatch } from '../core/macro-resolver';

// JS-Slash-Runner renders a code block that holds an HTML page as a frame;
// Lumiverse shows it as code (e.g. display regex rows imported with presets).
// Vishrun swaps such blocks for widget frames. The host's block is only
// hidden, never removed, so React keeps owning it.

const ROW = '[data-message-id]';
const CODEBLOCK = '[class*="_codeBlock_"]';
const WRAP_ATTR = 'data-vishrun-codeblock';
const SOURCE_ATTR = 'data-vishrun-codeblock-source';

// Same test JS-Slash-Runner uses to call code "frontend".
export function isFrontendCode(text: string): boolean {
  return /html>|<head>|<body/i.test(text);
}

function hashText(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36) + ':' + s.length;
}

function blockOf(code: Element): HTMLElement {
  return (code.closest(CODEBLOCK) ?? code.closest('pre') ?? code) as HTMLElement;
}

export function installHtmlCodeblocks(ctx: SpindleFrontendContext): () => void {
  const frames = new Map<HTMLElement, { wrap: HTMLElement; key: string }>();
  const pending = new Set<HTMLElement>();
  let generating = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const restore = (block: HTMLElement) => {
    const entry = frames.get(block);
    if (!entry) return;
    frames.delete(block);
    const iframe = entry.wrap.querySelector('iframe');
    if (iframe) destroyWidgetIframe(iframe as HTMLIFrameElement, 'codeblock-replaced');
    entry.wrap.remove();
    block.style.removeProperty('display');
    block.removeAttribute(SOURCE_ATTR);
  };

  const render = async (block: HTMLElement, row: Element, text: string, key: string, index: number) => {
    pending.add(block);
    try {
      const { chatId, characterId } = ctx.getActiveChat();
      let html = text;
      if (chatId && /\{\{[^}]+\}\}/.test(html)) {
        html = (await resolveMacrosBatch(ctx, chatId, characterId ?? null, [html]).catch(() => [html]))[0] ?? html;
      }
      const messageId = row.getAttribute('data-message-id') ?? '';
      const iframe = await buildWidgetIframe(html, 'html code block', `codeblock-${index}`, messageId, ctx);
      if (!block.isConnected || frames.has(block)) { destroyWidgetIframe(iframe, 'codeblock-stale'); return; }
      const wrap = document.createElement('div');
      wrap.setAttribute(WRAP_ATTR, '');
      wrap.appendChild(iframe);
      block.before(wrap);
      block.style.display = 'none';
      block.setAttribute(SOURCE_ATTR, key);
      frames.set(block, { wrap, key });
    } catch (e) {
      console.warn('[vishrun] html code block render failed', e);
    } finally {
      pending.delete(block);
    }
  };

  const scan = () => {
    timer = null;
    for (const [block] of frames) if (!block.isConnected) restore(block);
    for (const wrap of document.querySelectorAll(`[${WRAP_ATTR}]`)) {
      const next = wrap.nextElementSibling as HTMLElement | null;
      if (!next || !frames.has(next)) wrap.remove();
    }
    const rows = [...document.querySelectorAll(ROW)].filter((r) => !r.parentElement?.closest(ROW));
    const last = rows[rows.length - 1];
    for (const row of rows) {
      if (generating && row === last) continue;
      row.querySelectorAll('pre > code').forEach((code, index) => {
        const block = blockOf(code);
        if (pending.has(block)) return;
        const text = code.textContent ?? '';
        if (!isFrontendCode(text)) { restore(block); return; }
        const key = hashText(text);
        if (frames.get(block)?.key === key) return;
        restore(block);
        void render(block, row, text, key, index);
      });
    }
  };

  const schedule = () => {
    if (timer) return;
    timer = setTimeout(scan, 150);
  };

  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  const unsubs = [
    ctx.events.on('GENERATION_STARTED', () => { generating = true; }),
    ctx.events.on('GENERATION_ENDED', () => { generating = false; schedule(); }),
    ctx.events.on('GENERATION_STOPPED', () => { generating = false; schedule(); }),
  ];
  schedule();

  return () => {
    observer.disconnect();
    if (timer) clearTimeout(timer);
    for (const u of unsubs) u();
    for (const block of [...frames.keys()]) restore(block);
  };
}
