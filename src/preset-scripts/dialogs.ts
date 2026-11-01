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
