import type { CharacterDTO, SpindleAPI } from 'lumiverse-spindle-types';
import { api } from './common';

// Cards can be several MB: read each at most once per 30s. One cache per
// characters API, so tests with their own fake start empty.
type CharactersApi = Pick<SpindleAPI['characters'], 'get'>;
const caches = new WeakMap<object, Map<string, { at: number; card: Promise<CharacterDTO | null> }>>();

export function cachedCard(characterId: string, userId?: string, characters: CharactersApi = api.characters): Promise<CharacterDTO | null> {
  let cache = caches.get(characters);
  if (!cache) caches.set(characters, (cache = new Map()));
  const hit = cache.get(characterId);
  if (hit && Date.now() - hit.at < 30_000) return hit.card;
  const card = characters.get(characterId, userId).then((c) => c ?? null, () => null);
  cache.set(characterId, { at: Date.now(), card });
  return card;
}
