// SillyTavern shows script-free regex HTML in the message itself, where card
// scripts can find it. Markup that can run code, or that frames already handle
// (full documents, fenced HTML), keeps the frame.

// Tags that run code, load documents or change the page.
const FRAMED_TAGS = 'script,iframe,frame,object,embed,meta,base,link,form,math,noscript,portal';
const DOCUMENT_RE = /<(?:!doctype|html|head|body)\b/i;
const HTML_FENCE_RE = /```(?:html)?[ \t]*\r?\n\s*</i;
// The parser has already decoded entities in attribute values.
const UNSAFE_URL_RE = /^(?:javascript|vbscript|data:text\/html)/i;

// ST prefixes message CSS with `.mes_text`, so card styles reach message
// content only. @scope does the same; `body` or `:root` rules match nothing.
const SCOPE = '@scope ([data-component="MessageContent"], [data-vishrun-widget])';

declare const CSSScopeRule: unknown;

// Parsed, style-scoped content for inline rendering, or null to use a frame.
export function inlineBlock(html: string): DocumentFragment | null {
  if (typeof CSSScopeRule === 'undefined') return null;
  if (DOCUMENT_RE.test(html) || HTML_FENCE_RE.test(html)) return null;
  const t = document.createElement('template');
  t.innerHTML = html;
  const els = t.content.querySelectorAll('*');
  for (const el of els) {
    if (el.matches(FRAMED_TAGS)) return null;
    for (const a of el.attributes) {
      if (a.name.startsWith('on') || a.name === 'srcdoc') return null;
      if (UNSAFE_URL_RE.test(a.value.replace(/[\s\u0000-\u001f]/g, ''))) return null;
    }
  }
  for (const s of t.content.querySelectorAll('style')) s.textContent = `${SCOPE} {\n${s.textContent}\n}`;
  return t.content;
}
