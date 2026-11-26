// Minimal /input and /popup dialogs for preset scripts.

function overlay(doc: Document): { root: HTMLDivElement; box: HTMLDivElement; close: () => void } {
  const root = doc.createElement('div');
  root.setAttribute('data-vishrun-dialog', '');
  root.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;padding:16px';
  const box = doc.createElement('div');
  box.style.cssText = 'background:var(--lumiverse-bg-elevated,#1e1b26);color:var(--lumiverse-text,#eee);border:1px solid rgba(255,255,255,.15);border-radius:12px;padding:16px;max-width:min(640px,100%);max-height:80vh;overflow:auto;width:100%;box-sizing:border-box;font:14px/1.5 system-ui,sans-serif';
  root.appendChild(box);
  doc.body.appendChild(root);
  return { root, box, close: () => root.remove() };
}

function button(doc: Document, label: string, primary: boolean): HTMLButtonElement {
  const b = doc.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.style.cssText = `padding:6px 14px;border-radius:8px;border:1px solid rgba(255,255,255,.2);cursor:pointer;color:inherit;background:${primary ? 'rgba(140,110,220,.6)' : 'transparent'}`;
  return b;
}

export function inputDialog(prompt: string, ok = 'OK', cancel = 'Cancel', doc: Document = document): Promise<string> {
  return new Promise((resolve) => {
    const { box, close } = overlay(doc);
    const p = doc.createElement('div');
    p.style.whiteSpace = 'pre-wrap';
    p.textContent = prompt;
    const ta = doc.createElement('textarea');
    ta.rows = 4;
    ta.style.cssText = 'width:100%;box-sizing:border-box;margin:10px 0;background:rgba(0,0,0,.3);color:inherit;border:1px solid rgba(255,255,255,.2);border-radius:8px;padding:8px';
    const row = doc.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';
    const bOk = button(doc, ok, true);
    const bCancel = button(doc, cancel, false);
    row.append(bCancel, bOk);
    box.append(p, ta, row);
    const done = (v: string) => { close(); resolve(v); };
    bOk.onclick = () => done(ta.value);
    bCancel.onclick = () => done('');
    ta.focus();
  });
}

export function popupDialog(text: string, doc: Document = document): Promise<string> {
  return new Promise((resolve) => {
    const { box, close } = overlay(doc);
    const p = doc.createElement('div');
    p.style.whiteSpace = 'pre-wrap';
    p.textContent = text;
    const row = doc.createElement('div');
    row.style.cssText = 'display:flex;justify-content:flex-end;margin-top:12px';
    const bOk = button(doc, 'OK', true);
    row.append(bOk);
    box.append(p, row);
    bOk.onclick = () => { close(); resolve(''); };
  });
}

export interface PopupButton { text: string; result: unknown; action?: () => void }

// HTML popup with buttons. Resolves with the clicked button's result and the
// input text (when `input` is given); closing outside resolves with null.
export function htmlPopup(content: unknown, buttons: PopupButton[], input: string | null = null, doc: Document = document): Promise<{ result: unknown; value: string }> {
  return new Promise((resolve) => {
    const { root, box, close } = overlay(doc);
    const body = doc.createElement('div');
    if (content instanceof Node) body.appendChild(content); else body.innerHTML = String(content ?? '');
    box.appendChild(body);
    let ta: HTMLTextAreaElement | null = null;
    if (input !== null) {
      ta = doc.createElement('textarea');
      ta.rows = 4;
      ta.value = input;
      ta.style.cssText = 'width:100%;box-sizing:border-box;margin:10px 0 0;background:rgba(0,0,0,.3);color:inherit;border:1px solid rgba(255,255,255,.2);border-radius:8px;padding:8px';
      box.appendChild(ta);
    }
    const row = doc.createElement('div');
    row.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;margin-top:12px';
    const done = (result: unknown) => { close(); resolve({ result, value: ta?.value ?? '' }); };
    buttons.forEach((b, i) => {
      const el = button(doc, b.text, i === buttons.length - 1);
      el.onclick = () => { try { b.action?.(); } catch (e) { console.warn('[vishrun] popup button', e); } done(b.result); };
      row.appendChild(el);
    });
    box.appendChild(row);
    root.addEventListener('click', (e) => { if (e.target === root) done(null); });
  });
}

export const POPUP_TYPE = { TEXT: 1, CONFIRM: 2, INPUT: 3, DISPLAY: 4, CROP: 5 };
export const POPUP_RESULT = { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null };

// ST's callGenericPopup: content plus custom, cancel and OK buttons. INPUT
// returns the text on OK and false on Cancel; otherwise the clicked result.
export async function callGenericPopup(content: unknown, type: unknown, inputValue: unknown = '', options: unknown = {}): Promise<unknown> {
  const o = (options ?? {}) as { okButton?: unknown; cancelButton?: unknown; customButtons?: unknown };
  const asks = type === POPUP_TYPE.CONFIRM || type === POPUP_TYPE.INPUT;
  const label = (v: unknown, fallback: string | null) => (v === false ? null : typeof v === 'string' ? v : fallback);
  const ok = label(o.okButton, type === POPUP_TYPE.DISPLAY ? null : 'OK');
  const cancel = label(o.cancelButton, asks ? 'Cancel' : null);
  const buttons: PopupButton[] = (Array.isArray(o.customButtons) ? o.customButtons : []).map((b) =>
    typeof b === 'string' ? { text: b, result: b } : { text: String(b?.text ?? ''), result: b?.result, action: typeof b?.action === 'function' ? b.action : undefined });
  if (cancel) buttons.push({ text: cancel, result: POPUP_RESULT.NEGATIVE });
  if (ok) buttons.push({ text: ok, result: POPUP_RESULT.AFFIRMATIVE });
  const r = await htmlPopup(content, buttons, type === POPUP_TYPE.INPUT ? String(inputValue ?? '') : null);
  if (type !== POPUP_TYPE.INPUT) return r.result;
  return r.result === POPUP_RESULT.AFFIRMATIVE ? r.value : r.result === POPUP_RESULT.NEGATIVE ? false : r.result;
}

// Parses `key=value` / `key="quoted value"` named args before the free text.
export function splitNamedArgs(rest: string): { named: Record<string, string>; text: string } {
  const named: Record<string, string> = {};
  let s = rest;
  for (;;) {
    const m = /^\s*([A-Za-z_][\w]*)=(?:"((?:[^"\\]|\\.)*)"|(\S+))/.exec(s);
    if (!m) break;
    named[m[1]] = m[2] !== undefined ? m[2].replace(/\\"/g, '"') : m[3];
    s = s.slice(m[0].length);
  }
  return { named, text: s.trim() };
}
