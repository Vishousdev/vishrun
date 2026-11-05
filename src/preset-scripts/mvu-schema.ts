import type { MvuData } from '../core/mvu-data';

// Stand-in for mvu_zod's registerMvuSchema. The zod schema a card script
// registers is applied to the MVU snapshot widgets read: like mvu_zod, the
// top-level object is loosened so unknown keys survive, and a failed parse
// leaves the data unchanged.

interface ZodLike {
  safeParse(v: unknown): { success: boolean; data?: unknown };
  loose?: () => ZodLike;
  passthrough?: () => ZodLike;
}

let current: (() => unknown) | null = null;

export function setMvuSchema(schema: unknown): void {
  current = typeof schema === 'function' ? (schema as () => unknown) : () => schema;
}

export function clearMvuSchema(): void {
  current = null;
}

export function applyMvuSchema(data: MvuData): MvuData {
  if (!current) return data;
  try {
    let schema = current() as ZodLike | null;
    if (!schema || typeof schema.safeParse !== 'function') return data;
    if (typeof schema.loose === 'function') schema = schema.loose();
    else if (typeof schema.passthrough === 'function') schema = schema.passthrough();
    const r = schema.safeParse(structuredClone(data.stat_data));
    if (!r.success || !r.data || typeof r.data !== 'object' || Array.isArray(r.data)) return data;
    return { ...data, stat_data: { ...data.stat_data, ...(r.data as Record<string, unknown>) } };
  } catch (e) {
    console.warn('[vishrun] mvu schema', e);
    return data;
  }
}
