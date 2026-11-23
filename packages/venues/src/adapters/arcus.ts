import type { MarketSnapshot, VenueMeta } from '@defi/core';
import { now } from '@defi/core';
import { getJson, isRecord, num } from '../http.ts';
import { normalizeSymbol } from '../symbols.ts';
import { mapToUnitPrices, setSinPisar } from '../normalize.ts';
import type { AdapterCost, VenueAdapter } from '../types.ts';

const BASE = 'https://api.arcus.xyz/v1';

export const ARCUS_META: VenueMeta = {
  id: 'arcus',
  label: 'Arcus',
  kind: 'perp-dex',
  chain: 'Robinhood Chain',
  collateral: 'USD',
  fundingIntervalHours: 1,
  // No las publica en esta respuesta y no se han encontrado en documentacion
  // abierta. Declararlas a ojo saldria en el APR neto del scanner como si
  // fuesen medidas, asi que van en null y el smoke lo dice.
  fees: { makerBps: null, takerBps: null, freeClose: false },
  capabilities: { predictedFunding: true, orderBook: false, trading: false, publicPositions: false },
};

/**
 * Arcus. `/v1/markets` devuelve los 66 mercados en una sola peticion.
 *
 * Lo trae todo junto y ya normalizado: `fundingRate` es la tasa vigente y
 * `nextFundingRate` la del periodo siguiente, las dos por HORA y en decimal.
 * Medido el 25 de septiembre de 2026: BTC-USD daba 0,0000125, que anualizado
 * son 10,95 %, el suelo tipico de un perp tranquilo. `nextFundingAt` viene en
 * segundos, no en milisegundos.
 *
 * `openInterest` va en unidades del subyacente y hay que multiplicarlo por
 * `markPrice`. Los 66 mercados sumaban 18,6 M, que cuadra con los 19,0 M que
 * publica DefiLlama; no es prueba de la convencion de patas, pero si de que la
 * conversion de unidades es la correcta.
 *
 * Solo entran los `ONLINE`: los demas estan listados pero no operan, y su
 * funding es el ultimo que hubo, no uno vigente.
 */
export class ArcusAdapter implements VenueAdapter {
  readonly meta = ARCUS_META;
  readonly cost: AdapterCost = { websockets: 0, requestsPerMinute: 2 };
  readonly noPositionsReason = 'no public endpoint for third party accounts';

  #snapshot = new Map<string, MarketSnapshot>();
  #colisiones: string[] = [];

  async refresh(): Promise<void> {
    const raw = await getJson(`${BASE}/markets`);
    if (!isRecord(raw) || !Array.isArray(raw['markets'])) {
      throw new Error('v1/markets: unexpected shape');
    }

    const next = new Map<string, MarketSnapshot>();
    const colisiones: string[] = [];
    const at = now();

    for (const row of raw['markets']) {
      if (!isRecord(row)) continue;
      if (row['status'] !== 'ONLINE') continue;

      const nativeName = typeof row['marketDisplayName'] === 'string' ? row['marketDisplayName'] : null;
      const base = typeof row['baseAsset'] === 'string' ? row['baseAsset'] : null;
      if (nativeName === null || base === null) continue;

      const mark = num(row['markPrice']);
      const tasa = num(row['fundingRate']);
      if (mark === null || mark <= 0 || tasa === null) continue;

      const { symbol, contractMultiplier } = normalizeSymbol(base);
      const oi = num(row['openInterest']);
      const nextAt = num(row['nextFundingAt']);

      setSinPisar(next, {
        venue: this.meta.id,
        symbol,
        symbolNative: nativeName,
        contractMultiplier,
        mid: mark,
        bid: mark,
        ask: mark,
        funding: {
          rate: tasa,
          intervalHours: this.meta.fundingIntervalHours,
          predicted: num(row['nextFundingRate']),
          // Viene en SEGUNDOS. Pasarlo tal cual daria una fecha de 1970 y la
          // cuenta atras del screener quedaria en cero para siempre.
          nextFundingAt: nextAt === null ? null : nextAt * 1000,
          kind: 'current',
          sourceField: 'v1/markets -> fundingRate (hourly decimal)',
        },
        book: null,
        openInterestUsd: oi === null ? null : oi * mark,
        // `volume24hNotional` ya viene en dolares; `volume24h` va en unidades
        // del activo. Confundirlos daria un volumen mil veces menor en BTC.
        volume24hUsd: num(row['volume24hNotional']),
        at,
        sourceAt: null,
      }, colisiones);
    }

    if (next.size === 0) throw new Error('v1/markets: 0 online markets');
    this.#snapshot = mapToUnitPrices(next);
    this.#colisiones = colisiones;
  }

  get colisiones(): readonly string[] {
    return this.#colisiones;
  }

  snapshot(): ReadonlyMap<string, MarketSnapshot> {
    return this.#snapshot;
  }
}
