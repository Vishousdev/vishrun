import type { RawRegexScript } from '../lumiverse/fetch-character';
import { compileScripts } from '../core/parse-regex-script';
import { hostPatternOf } from '../core/takeover-policy';

// Who draws each of a card's widgets, for the settings page. A widget is a
// display regex whose replacement has real HTML elements; regexes that only
// hide or clean up text (custom tags included) are left out.

export type WidgetState = 'vishrun' | 'lumiverse' | 'unsupported' | 'off';

export interface WidgetInfo {
  name: string;
  state: WidgetState;
}

const HTML_RE = /<(?:!doctype|html|head|body|div|span|p|a|img|style|script|link|table|tr|td|ul|ol|li|button|input|select|textarea|label|form|section|article|header|footer|nav|main|aside|details|summary|svg|canvas|audio|video|iframe|br|hr|b|i|u|s|em|strong|small|font|center|h[1-6]|pre|code|blockquote)\b/i;

function isWidget(s: RawRegexScript): boolean {
  return s.promptOnly !== true && typeof s.findRegex === 'string' && HTML_RE.test(s.replaceString ?? '');
}

/** `nativeKeys`: rows Lumiverse draws itself (pattern + NUL + replacement). */
export function widgetStatus(scripts: RawRegexScript[], nativeKeys?: Set<string>): WidgetInfo[] {
  const compiled = new Map(compileScripts(scripts).map((c) => [c.sourceIndex, c]));
  const out: WidgetInfo[] = [];
  scripts.forEach((s, i) => {
    if (!isWidget(s)) return;
    const name = s.scriptName || '(unnamed)';
    let state: WidgetState;
    if (s.disabled) state = 'off';
    else if (nativeKeys?.has(hostPatternOf(s.findRegex ?? '') + '\u0000' + (s.replaceString ?? ''))) state = 'lumiverse';
    else if (compiled.get(i) && compiled.get(i)!.kind !== 'unknown') state = 'vishrun';
    else state = 'unsupported';
    out.push({ name, state });
  });
  return out;
}
