import type { MarketSnapshot, VenueMeta } from '@defi/core';
import { now } from '@defi/core';
import { getJson, isRecord, num } from '../http.ts';
import { normalizeSymbol } from '../symbols.ts';
import { mapToUnitPrices, setSinPisar } from '../normalize.ts';
import type { AdapterCost, VenueAdapter } from '../types.ts';

const BASE = 'https://api.orderly.org/v1/public';

export const ORDERLY_META: VenueMeta = {
  id: 'orderly',
  label: 'Orderly',
  kind: 'perp-dex',
  chain: 'Orderly',
  collateral: 'USDC',
  // Solo el respaldo: el intervalo REAL de cada mercado se lee de
  // `funding_period`. No son todos iguales, ver la clase.
  fundingIntervalHours: 8,
  // DESCONOCIDAS: sus endpoints publicos no traen la tarifa de negociacion.
  // `std_liquidation_fee` y `liquidator_fee` son de liquidacion, que es otra
  // cosa, y confundirlas seria meter un 60 bps donde van unos pocos.
  fees: { makerBps: null, takerBps: null, freeClose: false },
  capabilities: { predictedFunding: false, orderBook: false, trading: true, publicPositions: false },
};

/** Los metadatos cambian poco; se releen cada media hora, no en cada ciclo. */
const META_TTL_MS = 30 * 60_000;

/**
 * Orderly. `/public/futures` devuelve los 139 mercados en una llamada con
 * precio, funding, volumen e interes abierto.
 *
 * **Su intervalo de funding NO es uno solo.** Medido contra su propio
 * `/public/funding_rates`, 80 mercados liquidan cada 8 horas y 59 cada 4. El
 * dato lo publica `funding_period` en `/public/info`, y se lee de ahi: tomar
 * 8 h para todos multiplicaria por dos el APR de esos 59, que es exactamente
 * el error que mas caro sale en esta aplicacion.
 *
 * `open_interest` y `24h_volume` vienen en unidades del ACTIVO, no en dolares.
 * El que ya viene en dolares es `24h_amount`. Para BTC eran 24,7 contra casi
 * dos millones, asi que confundirlos no pasa desapercibido, pero en un token
 * de precio cercano a uno si pasaria.
 */
export class OrderlyAdapter implements VenueAdapter {
  readonly meta = ORDERLY_META;
  // Una peticion por ciclo, mas otra de metadatos cada media hora.
  readonly cost: AdapterCost = { websockets: 0, requestsPerMinute: 2 };
  readonly noPositionsReason = 'account endpoints need a signed request';

  #snapshot = new Map<string, MarketSnapshot>();
  #colisiones: string[] = [];
  /** Intervalo de funding por simbolo nativo, de `funding_period`. */
  #periodos = new Map<string, number>();
  #metaAt = 0;

  async #loadPeriodos(): Promise<void> {
    if (this.#periodos.size > 0 && Date.now() - this.#metaAt < META_TTL_MS) return;

    const raw = await getJson(`${BASE}/info`).catch(() => null);
    const filas = isRecord(raw) && isRecord(raw['data']) && Array.isArray(raw['data']['rows'])
      ? raw['data']['rows']
      : null;
    if (filas === null) return;

    const periodos = new Map<string, number>();
    for (const row of filas) {
      if (!isRecord(row) || typeof row['symbol'] !== 'string') continue;
      const h = num(row['funding_period']);
      if (h !== null && h > 0) periodos.set(row['symbol'], h);
    }
    if (periodos.size === 0) return;

    this.#periodos = periodos;
    this.#metaAt = Date.now();
  }

  async refresh(): Promise<void> {
    await this.#loadPeriodos();

    const raw = await getJson(`${BASE}/futures`);
    const filas = isRecord(raw) && isRecord(raw['data']) && Array.isArray(raw['data']['rows'])
      ? raw['data']['rows']
      : null;
    if (filas === null) throw new Error('public/futures: unexpected shape');

    const next = new Map<string, MarketSnapshot>();
    const colisiones: string[] = [];
    const at = now();

    for (const row of filas) {
      if (!isRecord(row)) continue;
      if (row['status'] !== 'ACTIVE') continue;

      const nativeName = row['symbol'];
      const etiqueta = row['display_symbol_name'];
      if (typeof nativeName !== 'string' || typeof etiqueta !== 'string') continue;

      const mark = num(row['mark_price']);
      const tasa = num(row['est_funding_rate']);
      if (mark === null || tasa === null || mark <= 0) continue;

      // `display_symbol_name` ya viene sin el par y con el prefijo del
      // multiplicador ('1000PEPE'), que es lo que normalizeSymbol necesita.
      const { symbol, contractMultiplier } = normalizeSymbol(etiqueta);
      const oi = num(row['open_interest']);

      setSinPisar(next, {
        venue: this.meta.id,
        symbol,
        symbolNative: nativeName,
        contractMultiplier,
        // No publica bid ni ask en esta llamada, solo marca e indice.
        mid: mark,
        bid: mark,
        ask: mark,
        funding: {
          // `est_funding_rate` es la tasa que se esta acumulando en el periodo
          // EN CURSO y que se cobrara en `next_funding_time`, no la del
          // periodo siguiente. Se mueve hasta el cobro, como la de
          // Hyperliquid, asi que es `current` y no `predicted`. La ya liquidada
          // va aparte, en `last_funding_rate`.
          rate: tasa,
          intervalHours: this.#periodos.get(nativeName) ?? this.meta.fundingIntervalHours,
          predicted: null,
          nextFundingAt: num(row['next_funding_time']),
          kind: 'current',
          sourceField: 'public/futures -> est_funding_rate',
        },
        book: null,
        // En unidades del activo: hay que pasarlo a dolares.
        openInterestUsd: oi === null ? null : oi * mark,
        // Este si viene en dolares, a diferencia de `24h_volume`.
        volume24hUsd: num(row['24h_amount']),
        at,
        sourceAt: null,
      }, colisiones);
    }

    if (next.size === 0) throw new Error('public/futures: 0 active markets');
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
