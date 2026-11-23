import type { FundingRate } from '../types/market.ts';
import { YEAR_HOURS } from './time.ts';

/**
 * Normaliza a tasa horaria. Cada venue liquida en intervalos distintos (1h, 4h,
 * 8h), asi que comparar `rate` en crudo entre venues es un error clasico.
 */
export function toHourly(f: FundingRate): number {
  if (f.intervalHours <= 0) return 0;
  return f.rate / f.intervalHours;
}

/** APR anualizado en %, sin capitalizar. */
export function toAprPct(hourlyRate: number): number {
  return hourlyRate * YEAR_HOURS * 100;
}

/** Atajo: de FundingRate directo a APR en %. */
export function fundingAprPct(f: FundingRate): number {
  return toAprPct(toHourly(f));
}
