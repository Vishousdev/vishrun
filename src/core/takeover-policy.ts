import type { RawRegexScript } from '../lumiverse/fetch-character';
import { compileScripts } from './parse-regex-script';
import { hasMacros } from './macro-detection';

// Since mid-2026 Lumiverse imports a card's regex_scripts as its own character
// regex rows and renders them first, with scripts stripped. Vishrun takes a row
// back only when the replacement needs something the native renderer drops.

export type TakeoverReason = 'script' | 'event-handler' | 'js-url' | 'blocked-tag' | 'macro' | 'dollar-zero' | 'html-fence';

const SCRIPT_RE = /<script\b/i;
const EVENT_HANDLER_RE = /\son[a-z]+\s*=/i;
const JS_URL_RE = /javascript\s*:/i;
// Tags the host sanitizer forbids in message HTML.
const BLOCKED_TAG_RE = /<(?:iframe|frame|object|embed|meta|base|link|form|math)\b|\ssrcdoc\s*=/i;
// Native replacement only knows $1..$99, $& and named groups.
const DOLLAR_ZERO_RE = /\$0(?!\d)/;
const DOLLAR_ZERO_ALL_RE = /\$0(?!\d)/g;
// Fenced HTML renders as a code block natively, as a frame in SillyTavern.
const HTML_FENCE_RE = /```(?:html)?[ \t]*\r?\n\s*</i;

export function takeoverReasons(replaceString: string): TakeoverReason[] {
  const r: TakeoverReason[] = [];
  if (SCRIPT_RE.test(replaceString)) r.push('script');
  if (EVENT_HANDLER_RE.test(replaceString)) r.push('event-handler');
  if (JS_URL_RE.test(replaceString)) r.push('js-url');
  if (BLOCKED_TAG_RE.test(replaceString)) r.push('blocked-tag');
  // Imported rows get no replacement-macro substitution, unlike SillyTavern.
  if (hasMacros(replaceString)) r.push('macro');
  if (DOLLAR_ZERO_RE.test(replaceString)) r.push('dollar-zero');
  if (HTML_FENCE_RE.test(replaceString)) r.push('html-fence');
  return r;
}

export interface TakeoverCandidate {
  name: string;
  findRegex: string;
  replaceString: string;
  reasons: TakeoverReason[];
}

// SillyTavern's $0 is the whole match, which is $& in JavaScript.
export function rewriteDollarZero(replaceString: string): string {
  return replaceString.replace(DOLLAR_ZERO_ALL_RE, '$$&');
}

// $0 alone is fixed in the host's row (see rewriteDollarZero), so it is not
// a reason to take the row over.
function needsTakeover(reasons: TakeoverReason[]): boolean {
  return reasons.some((r) => r !== 'dollar-zero');
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
    if (!needsTakeover(reasons)) return;
    out.push({ name: s.scriptName ?? '', findRegex: s.findRegex, replaceString: s.replaceString, reasons });
  });
  return out;
}

// Card scripts the host keeps rendering whose $0 it would print as text.
export function selectDollarZeroRows(scripts: RawRegexScript[]): Array<{ findRegex: string; replaceString: string }> {
  const taken = new Set(selectTakeoverCandidates(scripts).map((c) => c.findRegex + '\u0000' + c.replaceString));
  const out: Array<{ findRegex: string; replaceString: string }> = [];
  for (const s of scripts) {
    if (typeof s.findRegex !== 'string' || typeof s.replaceString !== 'string') continue;
    if (!DOLLAR_ZERO_RE.test(s.replaceString)) continue;
    if (taken.has(s.findRegex + '\u0000' + s.replaceString)) continue;
    out.push({ findRegex: s.findRegex, replaceString: s.replaceString });
  }
  return out;
}

// Mirrors the host importer's `/pattern/flags` parsing so stored rows compare equal.
export function hostPatternOf(findRegex: string): string {
  const m = findRegex.match(/^\/(.+)\/([dgimsuvy]*)$/s);
  return m ? m[1] : findRegex;
}
