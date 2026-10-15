import type { RawRegexScript } from '../lumiverse/fetch-character';
import { compileScripts } from './parse-regex-script';
import { hasMacros } from './macro-detection';

// Since mid-2026 Lumiverse imports a card's regex_scripts as its own character
// regex rows and renders them first, with scripts stripped. Vishrun takes a row
// back only when the replacement needs something the native renderer drops.

export type TakeoverReason = 'script' | 'event-handler' | 'js-url' | 'blocked-tag' | 'macro' | 'dollar-zero';

const SCRIPT_RE = /<script\b/i;
const EVENT_HANDLER_RE = /\son[a-z]+\s*=/i;
const JS_URL_RE = /javascript\s*:/i;
// Tags the host sanitizer forbids in message HTML.
const BLOCKED_TAG_RE = /<(?:iframe|frame|object|embed|meta|base|link|form|math)\b|\ssrcdoc\s*=/i;
// Native replacement only knows $1..$99, $& and named groups.
const DOLLAR_ZERO_RE = /\$0(?!\d)/;

export function takeoverReasons(replaceString: string): TakeoverReason[] {
  const r: TakeoverReason[] = [];
  if (SCRIPT_RE.test(replaceString)) r.push('script');
  if (EVENT_HANDLER_RE.test(replaceString)) r.push('event-handler');
  if (JS_URL_RE.test(replaceString)) r.push('js-url');
  if (BLOCKED_TAG_RE.test(replaceString)) r.push('blocked-tag');
  // Imported rows get no replacement-macro substitution, unlike SillyTavern.
  if (hasMacros(replaceString)) r.push('macro');
  if (DOLLAR_ZERO_RE.test(replaceString)) r.push('dollar-zero');
  return r;
}

export interface TakeoverCandidate {
  name: string;
  findRegex: string;
  replaceString: string;
  reasons: TakeoverReason[];
}

// Card scripts Vishrun renders itself and the native renderer would break.
export function selectTakeoverCandidates(scripts: RawRegexScript[]): TakeoverCandidate[] {
  const renderable = new Set(
    compileScripts(scripts).filter((c) => c.kind !== 'unknown').map((c) => c.sourceIndex),
  );
  const out: TakeoverCandidate[] = [];
  scripts.forEach((s, i) => {
    if (!renderable.has(i)) return;
    if (typeof s.findRegex !== 'string' || typeof s.replaceString !== 'string') return;
    const reasons = takeoverReasons(s.replaceString);
    if (reasons.length === 0) return;
    out.push({ name: s.scriptName ?? '', findRegex: s.findRegex, replaceString: s.replaceString, reasons });
  });
  return out;
}

// Mirrors the host importer's `/pattern/flags` parsing so stored rows compare equal.
export function hostPatternOf(findRegex: string): string {
  const m = findRegex.match(/^\/(.+)\/([dgimsuvy]*)$/s);
  return m ? m[1] : findRegex;
}
