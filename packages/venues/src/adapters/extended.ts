import type { MarketSnapshot, VenueMeta } from '@defi/core';
import { now } from '@defi/core';
import { getJson, isRecord, num } from '../http.ts';
import { normalizeSymbol } from '../symbols.ts';
import { mapToUnitPrices, setSinPisar } from '../normalize.ts';
import type { AdapterCost, VenueAdapter } from '../types.ts';

const BASE = 'https://api.starknet.extended.exchange/api/v1';

export const EXTENDED_META: VenueMeta = {
  id: 'extended',
  label: 'Extended',
  kind: 'perp-dex',
  chain: 'Starknet',
  // La API lo llama "USD"; el colateral real es USDC en Starknet.
  collateral: 'USDC',
  // Liquida cada hora. No lo decimos de memoria: cada mercado publica un
  // `hourlyFundingRateCap` en su configuracion, que es el tope POR HORA, asi
  // que la tasa que hay al lado esta denominada en la misma ventana.
  fundingIntervalHours: 1,
  // DESCONOCIDAS: no vienen en /info/markets y no se han contrastado contra
  // ninguna fuente del propio venue. Van a null, que es lo que hace que el APR
  // neto salga "—" en vez de salir bonito y equivocado.
  fees: { makerBps: null, takerBps: null, freeClose: false },
  capabilities: { predictedFunding: false, orderBook: false, trading: true, publicPositions: false },
};

/**
 * Extended (antes X10). Una sola llamada publica sin clave devuelve los 400
 * mercados con precio, libro en la cima, funding, volumen e interes abierto.
 *
 * Dos filtros que no son opcionales:
 *
 *  - **`type` distinto de PERPETUAL.** Lista tres mercados SPOT (BTCSPOT-USD,
 *    ETHSPOT-USD, USDTSPOT-USD) que normalizan al mismo nombre que su perpetuo.
 *    Es el mismo accidente que ya costo caro en Pacifica: el spot no tiene
 *    funding, asi que de colarse dejaria a BTC con una tasa de cero.
 *  - **`status` distinto de ACTIVE.** De 397 perpetuos, 61 estan DELISTED, 9
 *    PRELISTED y 1 en REDUCE_ONLY.
 *
 * El nombre del activo se toma de `assetName` y no de `name`: ahi viene ya
 * separado del par y conserva el prefijo del multiplicador (kPEPE, 1000SHIB),
 * que es justo lo que `normalizeSymbol` necesita.
 */
export class ExtendedAdapter implements VenueAdapter {
  readonly meta = EXTENDED_META;
  readonly cost: AdapterCost = { websockets: 0, requestsPerMinute: 2 };
  readonly noPositionsReason = 'account endpoints need an API key';

  #snapshot = new Map<string, MarketSnapshot>();
  #colisiones: string[] = [];

  async refresh(): Promise<void> {
    const raw = await getJson(`${BASE}/info/markets`);
    const filas = isRecord(raw) && Array.isArray(raw['data'])
      ? raw['data']
      : Array.isArray(raw) ? raw : null;
    if (filas === null) throw new Error('info/markets: unexpected shape');

    const next = new Map<string, MarketSnapshot>();
    const colisiones: string[] = [];
    const at = now();

    for (const row of filas) {
      if (!isRecord(row)) continue;
      if (row['type'] !== 'PERPETUAL' || row['status'] !== 'ACTIVE') continue;

      const nativeName = row['name'];
      const asset = row['assetName'];
      const stats = isRecord(row['marketStats']) ? row['marketStats'] : null;
      if (typeof nativeName !== 'string' || typeof asset !== 'string' || stats === null) continue;

      const mark = num(stats['markPrice']);
      const tasa = num(stats['fundingRate']);
      if (mark === null || tasa === null || mark <= 0) continue;

      const { symbol, contractMultiplier } = normalizeSymbol(asset);
      const bid = num(stats['bidPrice']);
      const ask = num(stats['askPrice']);

      setSinPisar(next, {
        venue: this.meta.id,
        symbol,
        symbolNative: nativeName,
        contractMultiplier,
        mid: mark,
        bid: bid ?? mark,
        ask: ask ?? mark,
        funding: {
          rate: tasa,
          intervalHours: this.meta.fundingIntervalHours,
          predicted: null,
          // OJO con el nombre: `nextFundingRate` no es una tasa, es el sello de
          // CUANDO toca el proximo cobro. Leerlo como tasa daria un funding de
          // mil setecientos millones.
          nextFundingAt: num(stats['nextFundingRate']),
          kind: 'current',
          sourceField: 'info/markets -> marketStats.fundingRate',
        },
        book: null,
        // Los dos vienen ya en USD; el equivalente en unidades del activo va
        // aparte, en `openInterestBase` y `dailyVolumeBase`.
        openInterestUsd: num(stats['openInterest']),
        volume24hUsd: num(stats['dailyVolume']),
        at,
        sourceAt: null,
      }, colisiones);
    }

    if (next.size === 0) throw new Error('info/markets: 0 active perpetuals');
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
