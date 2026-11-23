export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const YEAR_HOURS = 24 * 365;

/** Indirecto a proposito: permite congelar el tiempo en los tests. */
export const now = (): number => Date.now();

/** true si `at` (epoch ms) es mas reciente que `maxAgeMs`. */
export function isFresh(at: number, maxAgeMs: number, reference: number = now()): boolean {
  return reference - at < maxAgeMs;
}
