import { test, expect } from 'bun:test';
import { formatVariable, getAtPath, toPath, toYaml } from './mvu-macros';

const data = { stat_data: { yan_favor: 5, 世界: { 时间: '08:00', $meta: { x: 1 } }, list: ['a', 'b'] } };

test('paths follow lodash dot and bracket forms', () => {
  expect(toPath("stat_data.世界['时间']")).toEqual(['stat_data', '世界', '时间']);
  expect(getAtPath(data, 'stat_data.list[1]')).toBe('b');
  expect(getAtPath(data, 'stat_data.nope.deeper')).toBe(null);
});

test('get_message_variable output: JSON, strings raw, $ keys dropped', () => {
  expect(formatVariable(data, 'stat_data.世界', 'json')).toBe('{"时间":"08:00"}');
  expect(formatVariable(data, 'stat_data.世界.时间', 'json')).toBe('08:00');
  expect(formatVariable(data, 'missing', 'json')).toBe('null');
});

test('format_message_variable output is YAML', () => {
  expect(formatVariable(data, 'stat_data', 'yaml')).toBe('yan_favor: 5\n世界:\n  时间: "08:00"\nlist:\n  - a\n  - b');
  expect(toYaml({ a: [{ b: 1, c: 'x y' }], d: '', e: true, f: 'line1\nline2' })).toBe('a:\n  - b: 1\n    c: x y\nd: ""\ne: true\nf: |-\n  line1\n  line2');
});
