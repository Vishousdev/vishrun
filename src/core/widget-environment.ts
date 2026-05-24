// Classify a widget's <script> body into one of 5 tiers. Decides which
// shim layer widget-iframe.ts injects into the iframe head. Detection
// runs over concatenated <script> bodies; HTML around them is ignored
// to avoid false positives from comment/attribute text.

export type WidgetEnvironment =
  | 'static'
  | 'tavern-helpers-light'
  | 'tavern-jq'
  | 'tavern-mvu'
  | 'tavern-slash';

const SCRIPT_BODY_RE = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;

const MVU_TOKENS: readonly RegExp[] = [
  /\bMvu\b/,
  /\bstat_data\b/,
  /\ball_variables\b/,
  /\bwaitGlobalInitialized\s*\(/,
  /\bgetAllVariables\s*\(/,
  /\berrorCatched\s*\(/,
  /\beventOn(?:ce)?\s*\(/,
  /\beventEmit\s*\(/,
];

const LODASH_TOKEN = /(?:^|[^a-zA-Z_$.\w])_\s*\.[a-zA-Z]/;
const JQUERY_TOKEN = /(?:^|[^a-zA-Z_$.\w])\$\s*\(/;
const JQUERY_NAMED_TOKEN = /\bjQuery\s*[(.]/;

const HELPERS_LIGHT_TOKENS: readonly RegExp[] = [
  /\bgetChatMessages\s*\(/,
  /\bsetChatMessage\s*\(/,
  /\bgetCurrentMessageId\s*\(/,
  /\bgetChatId\s*\(/,
];

const SLASH_TOKEN = /\btriggerSlash\s*\(/;

export function extractScriptBodies(html: string): string {
  if (!html) return '';
  let combined = '';
  SCRIPT_BODY_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SCRIPT_BODY_RE.exec(html)) !== null) {
    combined += m[1] + '\n';
  }
  return combined;
}

const cache = new WeakMap<object, WidgetEnvironment>();
const stringCache = new Map<string, WidgetEnvironment>();
const STRING_CACHE_MAX = 256;

export function classifyWidgetEnvironment(html: string): WidgetEnvironment {
  if (!html) return 'static';
  const cached = stringCache.get(html);
  if (cached !== undefined) return cached;
  const result = classifyImpl(html);
  if (stringCache.size >= STRING_CACHE_MAX) stringCache.clear();
  stringCache.set(html, result);
  return result;
}

export function classifyWidgetEnvironmentKeyed(
  key: object,
  html: string,
): WidgetEnvironment {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const result = classifyImpl(html);
  cache.set(key, result);
  return result;
}

function classifyImpl(html: string): WidgetEnvironment {
  const body = extractScriptBodies(html);
  if (!body) return 'static';

  const hasMvu = MVU_TOKENS.some((re) => re.test(body));
  const hasLodash = LODASH_TOKEN.test(body);
  if (hasMvu || hasLodash) return 'tavern-mvu';

  const hasJq = JQUERY_TOKEN.test(body) || JQUERY_NAMED_TOKEN.test(body);
  if (hasJq) return 'tavern-jq';

  // Helpers-light tested before slash so a card with both a JSR-helpers
  // primary path and a triggerSlash fallback still gets the helpers shim
  // and runs the primary path instead of dropping to the slash fallback.
  const hasHelpers = HELPERS_LIGHT_TOKENS.some((re) => re.test(body));
  if (hasHelpers) return 'tavern-helpers-light';

  const hasSlash = SLASH_TOKEN.test(body);
  if (hasSlash) return 'tavern-slash';

  return 'static';
}

export function shouldInjectThHelpersShim(env: WidgetEnvironment): boolean {
  return (
    env === 'tavern-helpers-light' ||
    env === 'tavern-jq' ||
    env === 'tavern-mvu'
  );
}

export function shouldInjectJQuery(env: WidgetEnvironment): boolean {
  return env === 'tavern-jq' || env === 'tavern-mvu';
}

export function shouldInjectLodash(env: WidgetEnvironment): boolean {
  return env === 'tavern-mvu';
}

export function shouldInjectMvuShim(env: WidgetEnvironment): boolean {
  return env === 'tavern-mvu';
}

export function __resetWidgetEnvironmentCacheForTests(): void {
  stringCache.clear();
}
