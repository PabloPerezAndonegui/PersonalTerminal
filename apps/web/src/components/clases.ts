import type { AssetClass } from '../api.ts';

/**
 * Nombre y orden de las clases de activo. Una sola lista para DEX Volume y
 * Explorer: si cada pantalla tuviera la suya, acabarian llamando "Indices" a
 * lo mismo en una y "Index" en otra.
 */
export const CLASS_LABELS: Readonly<Record<AssetClass, string>> = {
  crypto: 'Crypto',
  equity: 'Equities',
  index: 'Indices',
  commodity: 'Commodities',
  fx: 'FX',
  etf: 'ETFs',
};

export const CLASS_ORDER: readonly AssetClass[] = ['crypto', 'equity', 'index', 'commodity', 'fx', 'etf'];
