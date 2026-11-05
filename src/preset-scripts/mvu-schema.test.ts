import { afterEach, describe, expect, test } from 'bun:test';
import { applyMvuSchema, clearMvuSchema, setMvuSchema } from './mvu-schema';

const clampSchema = {
  safeParse: (v: unknown) => {
    const o = v as { hp?: unknown };
    if (typeof o.hp !== 'number') return { success: false };
    return { success: true, data: { hp: Math.min(100, o.hp) } };
  },
};

afterEach(() => clearMvuSchema());

describe('applyMvuSchema', () => {
  test('no schema leaves data as is', () => {
    const d = { stat_data: { hp: 150 } };
    expect(applyMvuSchema(d)).toBe(d);
  });
  test('merges parsed data and keeps other keys', () => {
    setMvuSchema(clampSchema);
    expect(applyMvuSchema({ stat_data: { hp: 150, extra: 1 } }).stat_data).toEqual({ hp: 100, extra: 1 });
  });
  test('accepts a schema factory', () => {
    setMvuSchema(() => clampSchema);
    expect(applyMvuSchema({ stat_data: { hp: 120 } }).stat_data).toEqual({ hp: 100 });
  });
  test('failed parse leaves data unchanged', () => {
    setMvuSchema(clampSchema);
    const d = { stat_data: { hp: 'x' } };
    expect(applyMvuSchema(d)).toBe(d);
  });
});
