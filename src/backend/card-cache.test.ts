import { expect, test } from 'bun:test';
import { cachedCard } from './card-cache';

test('a card is read once while fresh, per characters API', async () => {
  let reads = 0;
  const characters = { get: async (id: string) => { reads++; return { id } as never; } };
  await Promise.all([cachedCard('a', 'u', characters), cachedCard('a', 'u', characters)]);
  await cachedCard('a', 'u', characters);
  expect(reads).toBe(1);
  await cachedCard('b', 'u', characters);
  expect(reads).toBe(2);
});

test('a failed read gives null', async () => {
  const characters = { get: async () => { throw new Error('x'); } };
  expect(await cachedCard('a', 'u', characters)).toBeNull();
});
