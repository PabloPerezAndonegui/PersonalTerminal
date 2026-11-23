import type { MarketSnapshot, VenueMeta } from '@defi/core';
import { now } from '@defi/core';
import { getJson, isRecord, num } from '../http.ts';
import { normalizeSymbol } from '../symbols.ts';
import { mapToUnitPrices, setSinPisar } from '../normalize.ts';
import type { AdapterCost, VenueAdapter } from '../types.ts';

const BASE = 'https://api.rise.trade/v1';

export const RISEX_META: VenueMeta = {
  id: 'risex',
  label: 'RISEx',
  kind: 'perp-dex',
  chain: 'RISE',
  collateral: 'USDC',
  fundingIntervalHours: 1,
  // No vienen en esta respuesta. En null antes que a ojo.
  fees: { makerBps: null, takerBps: null, freeClose: false },
  capabilities: { predictedFunding: true, orderBook: false, trading: false, publicPositions: false },
};

/** Nanosegundos por hora: sus tiempos van en nanos, no en milis. */
const NANOS_POR_MS = 1e6;

/**
 * RISEx. `/v1/markets` trae sus 36 mercados en una peticion.
 *
 * Dos trampas de unidades, las dos comprobadas contra la respuesta real el 25
 * de septiembre de 2026:
 *
 *  - **El tiempo va en NANOSEGUNDOS.** `funding_interval` vale
 *    3.600.000.000.000, que son 3.600 segundos, o sea una hora; y
 *    `next_funding_time` es un sello en nanos. Leerlos como milisegundos daria
 *    un intervalo de mil horas y una fecha del ano 58.000.
 *  - **`current_funding_rate` es por hora y en decimal.** Se confirma con
 *    `funding_rate_8h`, que es exactamente ocho veces: BTC daba -0,0000184 y
 *    -0,000147.
 *
 * `open_interest` va en unidades del subyacente. Los 36 mercados suman 56 M
 * multiplicando por el precio de marca, mientras DefiLlama publica 28 M para
 * este venue, o sea la mitad justa. Esa relacion apunta a que uno de los dos
 * cuenta las dos patas, pero **no se ha podido demostrar cual**, asi que el
 * numero se publica tal como lo da el venue y la pantalla lo marca.
 */
export class RisexAdapter implements VenueAdapter {
  readonly meta = RISEX_META;
  readonly cost: AdapterCost = { websockets: 0, requestsPerMinute: 2 };
  readonly noPositionsReason = 'no public endpoint for third party accounts';

  #snapshot = new Map<string, MarketSnapshot>();
  #colisiones: string[] = [];

  async refresh(): Promise<void> {
    const raw = await getJson(`${BASE}/markets`);
    const data = isRecord(raw) && isRecord(raw['data']) ? raw['data'] : null;
    if (data === null || !Array.isArray(data['markets'])) {
      throw new Error('v1/markets: unexpected shape');
    }

    const next = new Map<string, MarketSnapshot>();
    const colisiones: string[] = [];
    const at = now();

    for (const row of data['markets']) {
      if (!isRecord(row)) continue;
      if (row['active'] === false) continue;

      const nativeName = typeof row['display_name'] === 'string' ? row['display_name'] : null;
      if (nativeName === null) continue;

      const mark = num(row['mark_price']);
      const tasa = num(row['current_funding_rate']);
      if (mark === null || mark <= 0 || tasa === null) continue;

      // `BTC/USDC` -> `BTC`. El par entero como simbolo no cruzaria con ningun
      // otro venue y este venue quedaria aislado en la matriz.
      const baseCruda = nativeName.split('/')[0] ?? nativeName;
      const { symbol, contractMultiplier } = normalizeSymbol(baseCruda);

      const intervaloNanos = num(row['funding_interval']);
      const siguienteNanos = num(row['next_funding_time']);
      const oi = num(row['open_interest']);
      // `predicted_funding_rate` llega a cero en todos los mercados, asi que
      // no se publica como prediccion: un cero inventado es peor que un hueco.
      const prevista = num(row['predicted_funding_rate']);

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
          intervalHours: intervaloNanos !== null && intervaloNanos > 0
            ? intervaloNanos / NANOS_POR_MS / 3_600_000
            : this.meta.fundingIntervalHours,
          predicted: prevista === null || prevista === 0 ? null : prevista,
          nextFundingAt: siguienteNanos === null ? null : Math.round(siguienteNanos / NANOS_POR_MS),
          kind: 'current',
          sourceField: 'v1/markets -> current_funding_rate (hourly decimal)',
        },
        book: null,
        openInterestUsd: oi === null ? null : oi * mark,
        volume24hUsd: num(row['quote_volume_24h']),
        at,
        sourceAt: null,
      }, colisiones);
    }

    if (next.size === 0) throw new Error('v1/markets: 0 active markets');
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
