import { expect, test } from 'bun:test';
import { keyMatches, needsSt, stDecisions, type StEntry } from './st-lorebook';

const entry = (over: Partial<StEntry>): StEntry => ({
  id: 'e', disabled: false, constant: false, key: [], keysecondary: [], selective: true, selective_logic: 0,
  case_sensitive: false, match_whole_words: false, scan_depth: null, extensions: {}, ...over,
});

test('slash keys are regexes, other keys plain text', () => {
  const e = entry({});
  expect(keyMatches('/^/', 'anything', e)).toBe(true);
  expect(keyMatches('/狗(?!路)/', '小狗', e)).toBe(true);
  expect(keyMatches('/狗(?!路)/', '狗路', e)).toBe(false);
  expect(keyMatches('〔Era·College〕', 'x 〔era·college〕 y', e)).toBe(true);
  expect(keyMatches('cat', 'concatenate', entry({ match_whole_words: true }))).toBe(false);
  expect(keyMatches('cat', 'a cat.', entry({ match_whole_words: true }))).toBe(true);
});

test('only entries with slash keys or Match options are decided', () => {
  expect(needsSt(entry({ key: ['plain'] }))).toBe(false);
  expect(needsSt(entry({ key: ['/^/'] }))).toBe(true);
  expect(needsSt(entry({ key: ['a'], extensions: { match_character_depth_prompt: true } }))).toBe(true);
  expect(needsSt(entry({ key: ['/^/'], constant: true }))).toBe(false);
  expect(needsSt(entry({ key: ['cat'], use_regex: true, match_whole_words: true }))).toBe(true);
  expect(needsSt(entry({ key: ['cat'], use_regex: true }))).toBe(false);
});

test('world tags in the Character\'s Note select entries; NOT ANY excludes other worlds', () => {
  const m = { match_character_depth_prompt: true };
  const entries = [
    entry({ id: 'modern', key: ['/^/'], keysecondary: ['〔World·Hogwarts〕'], selective_logic: 2, scan_depth: 1, extensions: m }),
    entry({ id: 'college', key: ['〔Era·College〕'], scan_depth: 1, extensions: m }),
    entry({ id: 'married', key: ['〔Era·Married〕'], scan_depth: 1, extensions: m }),
    entry({ id: 'chatOnly', key: ['〔Era·College〕'], scan_depth: 1 , extensions: {}}),
  ];
  const note = '〔This Chat〕〔World·Modern Main〕〔Era·College〕';
  expect(stDecisions(entries, ['hi', 'hello'], { depthPrompt: note }, null)).toEqual({ forced: ['modern', 'college'], disabled: ['married'] });
  const hog = stDecisions(entries, ['hi'], { depthPrompt: '〔World·Hogwarts〕' }, null);
  expect(hog.disabled).toContain('modern');
});

test('scan depth limits the chat part only', () => {
  const e = entry({ id: 'x', key: ['/apple/'], scan_depth: 1 });
  expect(stDecisions([e], ['apple', 'pear'], {}, null).disabled).toEqual(['x']);
  expect(stDecisions([e], ['pear', 'apple'], {}, null).forced).toEqual(['x']);
});
