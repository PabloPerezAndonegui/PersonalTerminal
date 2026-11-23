import type { VenueId } from './venue.ts';

/**
 * Posiciones y saldos leidos de una direccion PUBLICA.
 *
 * Todo esto es de solo lectura y no requiere ninguna clave: se consulta una
 * direccion que cualquiera podria consultar. La custodia y la firma viven en
 * `apps/signer` y no tienen nada que ver con este modulo.
 */

export type PositionSide = 'long' | 'short';

export interface Position {
  readonly venue: VenueId;
  /** Simbolo normalizado, comparable entre venues. */
  readonly symbol: string;
  readonly symbolNative: string;
  readonly side: PositionSide;
  /** Tamano en unidades del activo NORMALIZADO, no del contrato del venue. */
  readonly sizeBase: number;
  readonly notionalUsd: number;
  readonly entryPrice: number | null;
  readonly markPrice: number | null;
  readonly unrealizedPnlUsd: number | null;
  readonly leverage: number | null;
  readonly liquidationPrice: number | null;
}

export interface AccountSnapshot {
  readonly venue: VenueId;
  readonly address: string;
  /** Valor total de la cuenta en USD. null si el venue no lo publica. */
  readonly equityUsd: number | null;
  /** Margen en uso. null si no se conoce. */
  readonly marginUsedUsd: number | null;
  readonly positions: readonly Position[];
  readonly at: number;
}

/** Formatos de direccion que sabemos distinguir. */
export type AddressKind = 'evm' | 'solana' | 'cosmos' | 'unknown';

const EVM = /^0x[0-9a-fA-F]{40}$/;
const SOLANA = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * dYdX v4 no es EVM: corre sobre Cosmos y sus cuentas son bech32 con prefijo
 * `dydx1`. Faltaba, y costaba caro por partida doble: la direccion de dydx no
 * se podia ni introducir (salia como formato desconocido), y el adaptador
 * declaraba aceptar EVM, con la que su indexer responde 404 — que el adaptador
 * traduce, correctamente, a "sin posiciones". El resultado era la wallet de
 * dydx apareciendo como que no opera alli.
 *
 * El juego de caracteres es el de bech32, que NO es base58: incluye `0` y `l`
 * y excluye `b`, `i` y `o`. Por eso se comprueba antes que Solana.
 */
const COSMOS = /^dydx1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{38}$/;

/**
 * Deduce el formato de una direccion.
 *
 * Importa porque consultar una direccion de Solana contra Hyperliquid no
 * devuelve "sin posiciones": devuelve un error o, peor, un resultado vacio que
 * se lee como "esta wallet no opera ahi". Cada venue declara que formato acepta
 * y los que no coinciden se omiten con motivo.
 */
export function addressKind(address: string): AddressKind {
  const a = address.trim();
  if (EVM.test(a)) return 'evm';
  if (COSMOS.test(a)) return 'cosmos';
  if (SOLANA.test(a)) return 'solana';
  return 'unknown';
}
