import { api } from './common';
import { hostPatternOf } from '../core/takeover-policy';

// Disables the host's imported copies of card scripts that Vishrun renders.
// Only touches character-scoped rows for the given character that equal one of
// the card's own scripts, never prompt-target rows, and never a row the user
// re-enabled after a previous takeover (tracked in metadata.vishrun).

export interface TakeoverRequest {
  type: 'regex_takeover';
  requestId: string;
  characterId: string;
  scripts: Array<{ findRegex: string; replaceString: string }>;
}

export interface TakeoverResponse {
  type: 'regex_takeover_response';
  requestId: string;
  disabled: number;
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
  update(scriptId: string, input: { disabled?: boolean; metadata?: Record<string, unknown> }, userId?: string): Promise<unknown>;
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

export async function takeoverCharacterRows(
  regex: RegexApi,
  characterId: string,
  scripts: TakeoverRequest['scripts'],
  userId: string,
  now: () => number = Date.now,
): Promise<number> {
  const wanted = new Set(scripts.map((s) => hostPatternOf(s.findRegex) + '\u0000' + s.replaceString));
  if (wanted.size === 0) return 0;

  const rows: HostRegexRow[] = [];
  for (let offset = 0; ; offset += 200) {
    const page = await regex.list({ scope: 'character', scopeId: characterId, limit: 200, offset, userId });
    rows.push(...page.data);
    if (page.data.length < 200 || rows.length >= page.total) break;
  }

  let disabled = 0;
  for (const row of rows) {
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

let warnedMissing = false;

export function installRegexTakeoverHandler(): void {
  api.onFrontendMessage((payload, userId) => {
    if (!isTakeoverRequest(payload)) return;
    const { requestId, characterId, scripts } = payload;
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
        }
      } catch (err) {
        response.error = err instanceof Error ? err.message : String(err);
        console.warn('[vishrun] regex takeover failed:', response.error);
      }
      api.sendToFrontend(response, userId);
    })();
  });
}
