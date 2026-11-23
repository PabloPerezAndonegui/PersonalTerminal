import type { MarketSnapshot, VenueMeta } from '@defi/core';
import { now, YEAR_HOURS } from '@defi/core';
import { getJson, isRecord, num } from '../http.ts';
import { normalizeSymbol } from '../symbols.ts';
import { mapToUnitPrices, setSinPisar } from '../normalize.ts';
import type { AdapterCost, VenueAdapter } from '../types.ts';

const BASE = 'https://omni-client-api.prod.ap-northeast-1.variational.io';

export const VARIATIONAL_META: VenueMeta = {
  id: 'variational',
  label: 'Variational',
  kind: 'perp-dex',
  chain: 'Arbitrum',
  collateral: 'USDC',
  // Ver el comentario de `intervalHours` en refresh(): su tasa viene
  // ANUALIZADA, asi que la ventana que cubre es un ano, no el periodo de
  // liquidacion. La cadencia de cobro real va en `funding_interval_s` y es de
  // 4 u 8 horas segun el mercado.
  fundingIntervalHours: YEAR_HOURS,
  // SIN CONTRASTAR: no publica comisiones en /metadata/stats. Lo que si
  // publica es `base_spread_bps` por mercado, que es otra cosa.
  fees: { makerBps: null, takerBps: null, freeClose: false },
  capabilities: { predictedFunding: false, orderBook: false, trading: true, publicPositions: false },
};

/**
 * Tickers de Variational que no son lo que parecen. Su `US500` NO es el
 * indice: es el ETF de State Street (SPY), a una decima del S&P (732 $ contra
 * los 7.326 de su propio swap `US500S`, 17 nov 2026). Se renombra solo si el
 * nombre que publica lo confirma: si un dia cambian el listado, vuelve a su
 * ticker en vez de quedarse con un nombre equivocado.
 */
const RENOMBRES: readonly { readonly ticker: string; readonly nombre: RegExp; readonly symbol: string }[] = [
  { ticker: 'US500', nombre: /S&P 500 ETF/i, symbol: 'SPY' },
  // BlackBerry: `BB` en Extended, QFEX y Lighter. No va en el alias comun
  // porque el `BB` de Aster es otro activo (ver symbols.ts).
  { ticker: 'BBX', nombre: /BlackBerry/i, symbol: 'BB' },
];

/**
 * Sus swaps ("Swap on Gold Spot") con el nombre del activo que siguen. Los
 * de `US500S`, `XAUS` y compania ya estan en el ALIAS comun; estos solo los
 * lista Variational con este nombre.
 */
const ACTIVO_DEL_SWAP: Readonly<Record<string, string>> = {
  USOILP: 'WTI', UKOILP: 'BRENT', COPPP: 'COPPER', DXIP: 'DXY', VXIP: 'VIX',
};

const esSwap = (nombre: unknown, intervalo: number | null): boolean =>
  typeof nombre === 'string' && /^Swap on /i.test(nombre) && intervalo === 0;

/**
 * Variational Omni. Una sola llamada publica sin clave devuelve los 552
 * mercados con precio, volumen, interes abierto y funding.
 *
 * **Su `funding_rate` es el APR en decimal, no la tasa del periodo.** 0.1095 no
 * es un 10,95 % cada 8 horas, es un 10,95 % anual. Comprobado contra
 * Hyperliquid en seis simbolos el 19 de septiembre de 2026: coincidian al
 * decimal. Leerlo como tasa del intervalo daria un 12.000 % anual.
 *
 * Su limite es de 10 peticiones cada 10 segundos por IP: con una por ciclo
 * sobra de largo.
 */
export class VariationalAdapter implements VenueAdapter {
  readonly meta = VARIATIONAL_META;
  readonly cost: AdapterCost = { websockets: 0, requestsPerMinute: 2 };
  readonly noPositionsReason = 'no public endpoint for account positions';

  #snapshot = new Map<string, MarketSnapshot>();
  #otros: MarketSnapshot[] = [];
  #colisiones: string[] = [];

  async refresh(): Promise<void> {
    const raw = await getJson(`${BASE}/metadata/stats`);
    if (!isRecord(raw) || !Array.isArray(raw['listings'])) {
      throw new Error('metadata/stats: unexpected shape');
    }

    const perps = new Map<string, MarketSnapshot>();
    const swaps = new Map<string, MarketSnapshot>();
    const colisiones: string[] = [];
    const at = now();

    for (const row of raw['listings']) {
      if (!isRecord(row)) continue;
      const nativeName = row['ticker'];
      if (typeof nativeName !== 'string' || nativeName === '') continue;

      const mark = num(row['mark_price']);
      const apr = num(row['funding_rate']);
      if (mark === null || apr === null || mark <= 0) continue;

      const swap = esSwap(row['name'], num(row['funding_interval_s']));
      const renombre = RENOMBRES.find((r) => r.ticker === nativeName && typeof row['name'] === 'string' && r.nombre.test(row['name']));
      const { symbol, contractMultiplier } = normalizeSymbol(
        renombre?.symbol ?? (swap ? ACTIVO_DEL_SWAP[nativeName] ?? nativeName : nativeName),
      );

      // El interes abierto viene partido en largos y cortos, y ya en USD.
      const oi = isRecord(row['open_interest'])
        ? (num(row['open_interest']['long_open_interest']) ?? 0) +
          (num(row['open_interest']['short_open_interest']) ?? 0)
        : null;

      const quotes = isRecord(row['quotes']) && isRecord(row['quotes']['base'])
        ? row['quotes']['base']
        : null;
      const bid = quotes === null ? null : num(quotes['bid']);
      const ask = quotes === null ? null : num(quotes['ask']);

      setSinPisar(swap ? swaps : perps, {
        venue: this.meta.id,
        symbol,
        symbolNative: nativeName,
        contractMultiplier,
        ...(swap ? { instrument: 'swap' as const } : {}),
        mid: mark,
        bid: bid ?? mark,
        ask: ask ?? mark,
        funding: {
          // La tasa se guarda TAL CUAL la publica el venue, y la ventana que
          // declara cubrir es el ano. Asi `toHourly` la divide por 8760 y sale
          // la horaria correcta, sin convertir nada aqui y sin perder el
          // numero original para la procedencia.
          rate: apr,
          intervalHours: YEAR_HOURS,
          predicted: null,
          // Publica cada cuanto liquida (`funding_interval_s`) pero no cuando
          // toca la proxima, y sin un ancla no se puede calcular.
          nextFundingAt: null,
          kind: 'current',
          sourceField: 'metadata/stats -> funding_rate (APR en decimal)',
        },
        book: null,
        openInterestUsd: oi,
        volume24hUsd: num(row['volume_24h']),
        at,
        // `quotes.updated_at` sella las cotizaciones, no la fila entera.
        sourceAt: null,
      }, colisiones);
    }

    // Un swap y un perp del mismo activo NO chocan: son dos productos. El perp
    // se queda el nombre, porque es el que tiene funding y lo que cruzan
    // Funding Arb y Parity; el swap va aparte y lo ensena el Explorer. Antes
    // ganaba el de mas volumen, y el oro de Variational salia con el funding
    // cero del swap, el mismo error que el spot de SOL en Pacifica.
    const next = new Map(perps);
    const otros: MarketSnapshot[] = [];
    for (const [symbol, s] of swaps) {
      if (next.has(symbol)) otros.push(s);
      else next.set(symbol, s);
    }

    if (next.size === 0) throw new Error('metadata/stats: 0 valid listings');
    this.#snapshot = mapToUnitPrices(next);
    this.#otros = otros;
    this.#colisiones = colisiones;
  }

  get colisiones(): readonly string[] {
    return this.#colisiones;
  }

  otrosInstrumentos(): readonly MarketSnapshot[] {
    return this.#otros;
  }

  snapshot(): ReadonlyMap<string, MarketSnapshot> {
    return this.#snapshot;
  }
}
