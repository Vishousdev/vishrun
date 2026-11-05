import { describe, expect, test } from 'bun:test';
import { fromTavernRegex, planRegexReplace, splitRegexLiteral, toTavernRegex, type HostRegexRow } from './regex-format';

const row = (over: Partial<HostRegexRow> = {}): HostRegexRow => ({
  id: 'r1', name: 'Hide Phone Thought Chain', find_regex: '<PhoneAnalysis>[\\s\\S]+?<\\/PhoneAnalysis>', flags: 'g',
  replace_string: '', placement: ['user_input', 'ai_output'], target: ['display', 'prompt'], min_depth: null,
  max_depth: null, trim_strings: [], run_on_edit: true, disabled: false, metadata: { source: 'card_bundle' }, ...over,
});

// As the phone pushes it when missing.
const phoneBubble = {
  id: 'd3d73027-2924-4951-ae16-4b7061dfd96f', script_name: '气泡正则1 - 添加代码块', enabled: true, run_on_edit: true,
  scope: 'character', find_regex: '/(?:<msg>|<rednote>)([\\s\\S]+?)(?:<\\/msg>|<\\/rednote>)/g', replace_string: '```\n$0\n```',
  source: { user_input: true, ai_output: true, slash_command: false, world_info: false }, destination: { display: true, prompt: false },
  min_depth: null, max_depth: null,
};

describe('regex format', () => {
  test('a row reads back with its SillyTavern /pattern/flags text', () => {
    const t = toTavernRegex(row()) as any;
    expect(t.find_regex).toBe('/<PhoneAnalysis>[\\s\\S]+?<\\/PhoneAnalysis>/g');
    expect(t.source).toMatchObject({ user_input: true, ai_output: true, world_info: false });
    expect(t.destination).toEqual({ display: true, prompt: true });
  });

  test('rows Vishrun changed read back as the card wrote them', () => {
    expect((toTavernRegex(row({ disabled: true, metadata: { vishrun: { takeover: true } } })) as any).enabled).toBe(true);
    expect((toTavernRegex(row({ replace_string: '[$&]', metadata: { vishrun: { dollarZero: true, original: '[$0]' } } })) as any).replace_string).toBe('[$0]');
  });

  test('a new regex gets the host shape, with $0 fixed', () => {
    expect(fromTavernRegex(phoneBubble)).toMatchObject({
      name: '气泡正则1 - 添加代码块', find_regex: '(?:<msg>|<rednote>)([\\s\\S]+?)(?:<\\/msg>|<\\/rednote>)', flags: 'g',
      replace_string: '```\n$&\n```', placement: ['user_input', 'ai_output'], target: ['display'], disabled: false,
      metadata: { vishrun: { dollarZero: true, original: '```\n$0\n```' } },
    });
    expect(fromTavernRegex({ find_regex: 'x', destination: {} })).toMatchObject({ target: ['response'], flags: 'gi' });
    expect(splitRegexLiteral('/a\\/b/gi')).toEqual({ pattern: 'a\\/b', flags: 'gi' });
  });

  test('replace adds missing regexes, updates changes, never deletes', () => {
    const cur = [row(), row({ id: 'r2', name: 'old phone', find_regex: '<phone>[\\s\\S]+?<\\/phone>' })];
    const next = cur.map(toTavernRegex) as any[];
    next[1].enabled = false;
    next.splice(0, 1);
    next.push(phoneBubble);
    const plan = planRegexReplace(cur, next);
    expect(plan.update).toEqual([{ id: 'r2', patch: { disabled: true } }]);
    expect(plan.create.map((c) => c.name)).toEqual(['气泡正则1 - 添加代码块']);
  });

  test('unchanged lists plan nothing, and locked rows are skipped', () => {
    const cur = [row(), row({ id: 'r3', can_mutate: false }), row({ id: 'r4', disabled: true, metadata: { vishrun: { takeover: true } } })];
    expect(planRegexReplace(cur, cur.map(toTavernRegex))).toEqual({ create: [], update: [] });
    const changed = cur.map(toTavernRegex) as any[];
    changed[1].replace_string = 'x';
    expect(planRegexReplace(cur, changed)).toEqual({ create: [], update: [] });
  });
});
