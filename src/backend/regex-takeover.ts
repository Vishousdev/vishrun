import { api } from './common';
import { hostPatternOf, rewriteDollarZero } from '../core/takeover-policy';

// Disables the host's imported copies of card scripts that Vishrun renders,
// and fixes SillyTavern's $0 in the copies the host keeps rendering. Only
// touches character-scoped rows for the given character that equal one of the
// card's own scripts, and never a row Vishrun changed before (tracked in
// metadata.vishrun), so a user's later edit or re-enable stands.

export interface TakeoverRequest {
  type: 'regex_takeover';
  requestId: string;
  characterId: string;
  scripts: Array<{ findRegex: string; replaceString: string }>;
  dollarZero?: Array<{ findRegex: string; replaceString: string }>;
}

export interface TakeoverResponse {
  type: 'regex_takeover_response';
  requestId: string;
  disabled: number;
  rewritten?: number;
  /** pattern + NUL + replacement of the character's rows the host still renders. */
  native?: string[];
  missingPermissions?: string[];
  error?: string;
}

interface HostRegexRow {
  id: string;
  find_regex: string;
  replace_string: string;
  target: string | string[];
  disabled: boolean;
  can_mutate?: boolean;
  metadata?: Record<string, unknown>;
}

export interface RegexApi {
  list(options: { scope?: string; scopeId?: string; limit?: number; offset?: number; userId?: string }): Promise<{ data: HostRegexRow[]; total: number }>;
  update(scriptId: string, input: { disabled?: boolean; replace_string?: string; metadata?: Record<string, unknown> }, userId?: string): Promise<unknown>;
}

const REQUIRED = ['regex_scripts', 'regex_scripts_unrestricted'];

function isTakeoverRequest(p: unknown): p is TakeoverRequest {
  if (!p || typeof p !== 'object') return false;
  const r = p as Record<string, unknown>;
  return r.type === 'regex_takeover' && typeof r.requestId === 'string'
    && typeof r.characterId === 'string' && Array.isArray(r.scripts);
}

function targetsOf(t: string | string[]): string[] {
  return Array.isArray(t) ? t : [t];
}

async function listRows(regex: RegexApi, characterId: string, userId: string): Promise<HostRegexRow[]> {
  const rows: HostRegexRow[] = [];
  for (let offset = 0; ; offset += 200) {
    const page = await regex.list({ scope: 'character', scopeId: characterId, limit: 200, offset, userId });
    rows.push(...page.data);
    if (page.data.length < 200 || rows.length >= page.total) break;
  }
  return rows;
}

const keyOf = (s: { findRegex: string; replaceString: string }) => hostPatternOf(s.findRegex) + '\u0000' + s.replaceString;

// Rewrites $0 to $& in the host's copies of these scripts. Applies to prompt
// rows too, since the host's prompt pass has the same gap.
export async function rewriteDollarZeroRows(
  regex: RegexApi,
  characterId: string,
  scripts: Array<{ findRegex: string; replaceString: string }>,
  userId: string,
  now: () => number = Date.now,
): Promise<number> {
  const wanted = new Set(scripts.map(keyOf));
  if (wanted.size === 0) return 0;
  let rewritten = 0;
  for (const row of await listRows(regex, characterId, userId)) {
    if (row.can_mutate === false) continue;
    if (!wanted.has(row.find_regex + '\u0000' + row.replace_string)) continue;
    const meta = row.metadata ?? {};
    if (meta.vishrun && typeof meta.vishrun === 'object') continue;
    await regex.update(row.id, {
      replace_string: rewriteDollarZero(row.replace_string),
      metadata: { ...meta, vishrun: { dollarZero: true, original: row.replace_string, at: now() } },
    }, userId);
    rewritten++;
  }
  return rewritten;
}

export async function takeoverCharacterRows(
  regex: RegexApi,
  characterId: string,
  scripts: TakeoverRequest['scripts'],
  userId: string,
  now: () => number = Date.now,
): Promise<number> {
  const wanted = new Set(scripts.map(keyOf));
  if (wanted.size === 0) return 0;

  let disabled = 0;
  for (const row of await listRows(regex, characterId, userId)) {
    if (row.disabled || row.can_mutate === false) continue;
    if (!wanted.has(row.find_regex + '\u0000' + row.replace_string)) continue;
    if (targetsOf(row.target).includes('prompt')) continue;
    const meta = row.metadata ?? {};
    if (meta.vishrun && typeof meta.vishrun === 'object') continue;
    await regex.update(row.id, {
      disabled: true,
      metadata: { ...meta, vishrun: { takeover: true, at: now() } },
    }, userId);
    disabled++;
  }
  return disabled;
}

// Enabled display rows for the character, after any takeover: the host renders
// these itself, so Vishrun leaves them alone at the top level. Rows with a
// rewritten $0 are reported with the card's original text, which is what the
// frontend compares against.
export async function nativeDisplayKeys(regex: RegexApi, characterId: string, userId: string): Promise<string[]> {
  const out: string[] = [];
  for (const row of await listRows(regex, characterId, userId)) {
    if (row.disabled || !targetsOf(row.target).includes('display')) continue;
    const v = row.metadata?.vishrun as { dollarZero?: unknown; original?: unknown } | undefined;
    const fixed = v?.dollarZero === true && typeof v.original === 'string'
      && rewriteDollarZero(v.original) === row.replace_string;
    out.push(row.find_regex + '\u0000' + (fixed ? v!.original as string : row.replace_string));
  }
  return out;
}

let warnedMissing = false;

export function installRegexTakeoverHandler(): void {
  api.onFrontendMessage((payload, userId) => {
    if (!isTakeoverRequest(payload)) return;
    const { requestId, characterId, scripts } = payload;
    const dollarZero = Array.isArray(payload.dollarZero) ? payload.dollarZero : [];
    void (async () => {
      const response: TakeoverResponse = { type: 'regex_takeover_response', requestId, disabled: 0 };
      try {
        const granted = await api.permissions.getGranted();
        const missing = REQUIRED.filter((p) => !granted.includes(p));
        if (missing.length > 0) {
          response.missingPermissions = missing;
          if (!warnedMissing) {
            warnedMissing = true;
            console.warn(`[vishrun] grant ${missing.join(' + ')} so imported card scripts do not override Vishrun widgets`);
          }
        } else {
          const regex = (api as unknown as { regex_scripts: RegexApi }).regex_scripts;
          response.disabled = await takeoverCharacterRows(regex, characterId, scripts, userId);
          response.rewritten = await rewriteDollarZeroRows(regex, characterId, dollarZero, userId);
          response.native = await nativeDisplayKeys(regex, characterId, userId);
        }
      } catch (err) {
        response.error = err instanceof Error ? err.message : String(err);
        console.warn('[vishrun] regex takeover failed:', response.error);
      }
      api.sendToFrontend(response, userId);
    })();
  });
}
