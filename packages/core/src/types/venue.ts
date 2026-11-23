/**
 * Identidad y metadatos de un venue.
 *
 * `VenueId` es el id canonico en minusculas ('hyperliquid', 'paradex', ...).
 * La lista real de venues vive en `packages/venues/registry.ts`, que es la
 * unica fuente de verdad; core se mantiene generico a proposito para no
 * obligar a recompilar el dominio cada vez que se anade un venue.
 */
export type VenueId = string;

/** Naturaleza del venue: determina que datos tiene sentido pedirle. */
export type VenueKind =
  | 'perp-dex'   // perpetuos on-chain / orderbook descentralizado
  | 'perp-cex'   // perpetuos en exchange centralizado
  | 'spot-dex'
  | 'spot-cex';

/**
 * Comisiones en basis points (1 bps = 0.01%).
 * `null` = no se conoce. Nunca se asume 0: una fee desconocida se propaga
 * como null hasta la UI, que la pinta como "—".
 */
export interface FeeSchedule {
  readonly makerBps: number | null;
  readonly takerBps: number | null;
  /**
   * Algunos venues no cobran al cerrar. Cuando es true, el coste de un round
   * trip es una pata, no dos.
   */
  readonly freeClose: boolean;
}

/** Que sabe hacer un venue. El scanner consulta esto antes de pedir datos. */
export interface VenueCapabilities {
  /** Publica la tasa del proximo intervalo, no solo la actual. */
  readonly predictedFunding: boolean;
  /** Expone libro L2 con profundidad suficiente para estimar slippage. */
  readonly orderBook: boolean;
  /** Tiene API de trading utilizable (si no, es solo feed de lectura). */
  readonly trading: boolean;
  /** Permite consultar posiciones de una direccion arbitraria. */
  readonly publicPositions: boolean;
}

export interface VenueMeta {
  readonly id: VenueId;
  /** Nombre para la UI, en ingles. */
  readonly label: string;
  readonly kind: VenueKind;
  /** Cadena donde liquida, o null si es centralizado. */
  readonly chain: string | null;
  /** Activo de colateral: 'USDC', 'USDT', 'AUSD'... */
  readonly collateral: string;
  /** Cada cuantas horas liquida el funding. */
  readonly fundingIntervalHours: number;
  readonly fees: FeeSchedule;
  readonly capabilities: VenueCapabilities;
}
