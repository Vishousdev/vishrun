// Shared MVU state shape; kept dependency-free so the frontend bundle stays small.
export interface MvuData {
  stat_data: Record<string, unknown>;
  [key: string]: unknown;
}

export function emptyMvuData(): MvuData {
  return { stat_data: {} };
}
