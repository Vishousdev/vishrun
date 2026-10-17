import { test, expect } from 'bun:test';
import { applyCommand, extractCommands, parseCommandValue, toPath } from './mvu-commands';

function run(stat: Record<string, unknown>, text: string) {
  const results = extractCommands(text).map((c) => applyCommand(stat, c));
  return { stat, results };
}

test('extraction needs ");", keeps order, reads reasons-free args, skips thinking', () => {
  const cmds = extractCommands("x _.set('a', 1, 2);//r\n_.set('b', 3)\n<thinking>_.add('c', 1);</thinking>_.add('d', 'x(1)');");
  expect(cmds.map((c) => [c.type, c.args])).toEqual([['set', ["'a'", '1', '2']], ['add', ["'d'", "'x(1)'"]]]);
});

test('aliases map to MVU command types; arg counts are validated', () => {
  expect(extractCommands("_.assign('a', 1);_.unset('b');_.delete('c');_.add('d', 1, 2);").map((c) => c.type)).toEqual(['insert', 'remove', 'remove']);
});

test('values: JSON, JSON5 literals, quoted strings, arithmetic, bare words', () => {
  expect(parseCommandValue('{"a": 1}')).toEqual({ a: 1 });
  expect(parseCommandValue("{a: 'x', b: [1, 2,],}")).toEqual({ a: 'x', b: [1, 2] });
  expect(parseCommandValue("'it''s'")).toBe("it's");
  expect(parseCommandValue('"quoted"')).toBe('quoted');
  expect(parseCommandValue('10 + 2 * 3')).toBe(16);
  expect(parseCommandValue('0.1 + 0.2')).toBe(0.3);
  expect(parseCommandValue('hello world')).toBe('hello world');
  expect(parseCommandValue('true')).toBe(true);
  expect(parseCommandValue('null')).toBe(null);
});

test('paths: dots, numeric and quoted brackets', () => {
  expect(toPath("'a.b[0][\"c d\"]'")).toEqual(['a', 'b', '0', 'c d']);
  expect(toPath('世界.当前地点')).toEqual(['世界', '当前地点']);
});

test('set: needs an existing path, keeps [value, desc], coerces to number', () => {
  const { stat, results } = run(
    { a: { n: 1, vwd: [5, 'favor 0-100'], num: 3 } },
    "_.set('a.n', 1, 2);_.set('a.vwd', 5, 9);_.set('a.num', 3, '7');_.set('a.missing', 0, 1);_.set('a[\"n\"]', 4);",
  );
  expect(stat).toEqual({ a: { n: 4, vwd: [9, 'favor 0-100'], num: 7 } });
  expect(results[3]).toEqual({ ok: false, reason: 'path-missing' });
});

test('set accepts objects and arrays as values', () => {
  const { stat } = run({ inv: [], who: {} }, "_.set('inv', [], ['sword', 'key']);_.set('who', {}, {name: 'Vera'});");
  expect(stat).toEqual({ inv: ['sword', 'key'], who: { name: 'Vera' } });
});

test('add: numbers, [value, desc] numbers, dates by milliseconds', () => {
  const { stat, results } = run(
    { n: 1.1, v: [10, 'd'], t: '2025-01-01T00:00:00.000Z', s: 'text' },
    "_.add('n', 0.2);_.add('v', -3);_.add('t', 60000);_.add('s', 1);_.add('nope', 1);",
  );
  expect(stat).toEqual({ n: 1.3, v: [7, 'd'], t: '2025-01-01T00:01:00.000Z', s: 'text' });
  expect(results.map((r) => r.ok)).toEqual([true, true, true, false, false]);
});

test('insert: push to array, merge into object, keyed and indexed forms', () => {
  const { stat } = run(
    { list: ['a'], obj: { x: 1, deep: { y: 1 } }, nested: {} },
    "_.insert('list', 'b');_.insert('list', 0, 'z');_.insert('list', '-', 'end');" +
    "_.assign('obj', {deep: {z: 2}});_.insert('obj', 'k', 'v');_.insert('nested.newList', ['first']);",
  );
  expect(stat).toEqual({
    list: ['z', 'a', 'b', 'end'],
    obj: { x: 1, deep: { y: 1, z: 2 }, k: 'v' },
    nested: { newList: [['first']] },
  });
});

test('insert refuses primitives and missing parents', () => {
  const { results } = run({ s: 'x' }, "_.insert('s', 1);_.insert('no.parent', 1);");
  expect(results).toEqual([{ ok: false, reason: 'primitive-target' }, { ok: false, reason: 'parent-missing' }]);
});

test('remove: whole path, array index in path, by index, by value, by key', () => {
  const { stat } = run(
    { gone: 1, arr: ['a', 'b', 'c', 'd'], obj: { k1: 1, k2: 2, k3: 3 } },
    "_.remove('gone');_.remove('arr[0]');_.remove('arr', 1);_.remove('arr', 'd');_.unset('obj', 'k2');_.delete('obj', 0);",
  );
  expect(stat).toEqual({ arr: ['b'], obj: { k3: 3 } });
});
