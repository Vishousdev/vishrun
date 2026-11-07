import { COMPOSER_SELECTOR, setComposerText } from './slash-runner';

// SillyTavern's message box is #send_textarea, and widgets reach it through
// window.parent. Lumiverse's composer is a React textarea that ignores direct
// value writes, so a hidden stand-in with that id reads and writes it instead.

const ID = 'send_textarea';

export function installComposerAlias(doc: Document = document): () => void {
  if (!doc.body || doc.getElementById(ID)) return () => {};
  const el = doc.createElement('textarea');
  el.id = ID;
  el.hidden = true;
  el.tabIndex = -1;
  el.setAttribute('data-vishrun-st-alias', '');
  Object.defineProperty(el, 'value', {
    configurable: true,
    get: () => doc.querySelector<HTMLTextAreaElement>(COMPOSER_SELECTOR)?.value ?? '',
    set: (v: unknown) => { setComposerText(String(v ?? ''), doc); },
  });
  doc.body.appendChild(el);
  return () => el.remove();
}
