import { describe, expect, test } from 'bun:test';
import {
  fromLorebookPatch, fromWorldbookEntry, planReplace, toLorebookEntry, toWorldbookEntry, type HostEntry,
} from './worldbook-format';

const entry = (over: Partial<HostEntry> = {}): HostEntry => ({
  id: 'e1', key: ['phone'], keysecondary: [], content: 'body', comment: 'Phone - Format',
  position: 1, depth: 4, role: null, order_value: 3333, selective: true, constant: true, disabled: false,
  group_name: '', group_override: false, group_weight: 100, probability: 100, scan_depth: null,
  case_sensitive: false, match_whole_words: false, automation_id: null, prevent_recursion: false,
  exclude_recursion: false, delay_until_recursion: false, sticky: 0, cooldown: 0, delay: 0,
  selective_logic: 0, use_probability: false, vectorized: false, ...over,
});

describe('worldbook format', () => {
  test('maps positions, roles and strategy like JSR', () => {
    const w = toWorldbookEntry(entry({ position: 4, role: 'user', depth: 2 })) as any;
    expect(w.uid).toBe('e1');
    expect(w.name).toBe('Phone - Format');
    expect(w.strategy.type).toBe('constant');
    expect(w.position).toEqual({ type: 'at_depth', role: 'user', depth: 2, order: 3333 });
    expect(w.strategy.scan_depth).toBe('same_as_global');
    expect(toWorldbookEntry(entry({ position: 5 })).position).toMatchObject({ type: 'before_example_messages' });
  });

  test('an entry created without a strategy is constant, as in JSR', () => {
    const e = fromWorldbookEntry({ name: '手机-角色', position: { type: 'after_character_definition' } });
    expect(e).toMatchObject({ comment: '手机-角色', constant: true, selective: false, disabled: false, position: 1, order_value: 100 });
  });

  test('replacing with the same entries changes nothing', () => {
    const cur = [entry(), entry({ id: 'e2', comment: 'x', position: 4, role: 'assistant', sticky: 2, delay_until_recursion: true })];
    expect(planReplace(cur, cur.map(toWorldbookEntry))).toEqual({ create: [], update: [], delete: [] });
  });

  test('replace updates changed fields, creates new entries and deletes left-out ones', () => {
    const cur = [entry(), entry({ id: 'e2', comment: '删除此项' })];
    const next = [
      { ...toWorldbookEntry(cur[0]), content: 'new body' },
      { name: '手机-格式', content: 'fmt', strategy: { type: 'constant' }, position: { type: 'at_depth', role: 'system', depth: 4, order: 3333 } },
    ];
    const plan = planReplace(cur, next);
    expect(plan.update).toEqual([{ id: 'e1', patch: { content: 'new body' } }]);
    expect(plan.create).toHaveLength(1);
    expect(plan.create[0]).toMatchObject({ comment: '手机-格式', position: 4, depth: 4, order_value: 3333, constant: true });
    expect(plan.delete).toEqual(['e2']);
  });
});

describe('lorebook format', () => {
  test('reads at-depth entries with their role', () => {
    const l = toLorebookEntry(entry({ position: 4, role: 'assistant', depth: 3 }), 0) as any;
    expect(l.position).toBe('at_depth_as_assistant');
    expect(l.depth).toBe(3);
    expect(toLorebookEntry(entry(), 0).depth).toBeNull();
  });

  test('a patch only carries the fields given', () => {
    expect(fromLorebookPatch({ uid: 'e1', content: 'c' })).toEqual({ content: 'c' });
    expect(fromLorebookPatch({ uid: 'e1', content: 'c', position: 'after_character_definition', order: 3333 }))
      .toEqual({ content: 'c', position: 1, order_value: 3333 });
    expect(fromLorebookPatch({ position: 'at_depth_as_user', enabled: false })).toEqual({ position: 4, role: 'user', disabled: true });
  });
});
