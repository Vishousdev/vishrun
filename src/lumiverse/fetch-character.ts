/**
 * Lumiverse REST helper.
 *
 * The character JSON returned by GET /api/v1/characters/:id is FLAT
 * (Lumiverse stores `extensions` as a top-level column, not nested under `data`
 * like the SillyTavern V2 card spec). Verified against the live server
 * 2026-04-28: `character.extensions.regex_scripts` is the correct path.
 */

import { getCharacter } from './host-api';

export interface RawRegexScript {
  id?: string;
  scriptName?: string;
  findRegex?: string;
  replaceString?: string;
  trimStrings?: string[];
  placement?: number[];
  disabled?: boolean;
  markdownOnly?: boolean;
  promptOnly?: boolean;
  runOnEdit?: boolean;
  minDepth?: number | null;
  maxDepth?: number | null;
  [k: string]: unknown;
}

export interface LumiverseCharacter {
  id: string;
  name?: string;
  first_mes?: string;
  alternate_greetings?: string[];
  extensions?: {
    regex_scripts?: RawRegexScript[];
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

export async function fetchCharacter(characterId: string): Promise<LumiverseCharacter> {
  const char = await getCharacter(characterId);
  if (!char || typeof char !== 'object') throw new Error(`fetchCharacter ${characterId}: empty response`);
  return char as LumiverseCharacter;
}

export function extractRegexScripts(char: LumiverseCharacter): RawRegexScript[] {
  const scripts = char?.extensions?.regex_scripts;
  return Array.isArray(scripts) ? scripts : [];
}
