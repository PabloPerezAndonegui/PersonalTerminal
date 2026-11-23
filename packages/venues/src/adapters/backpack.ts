import type { MarketSnapshot, OrderBook, VenueMeta } from '@defi/core';
import { now } from '@defi/core';
import { getJson, isRecord, num } from '../http.ts';
import { normalizeSymbol } from '../symbols.ts';
import { mapToUnitPrices, scaleBookToUnits, setSinPisar } from '../normalize.ts';
import type { AdapterCost, VenueAdapter } from '../types.ts';

const BASE = 'https://api.backpack.exchange/api/v1';

export const BACKPACK_META: VenueMeta = {
  id: 'backpack',
  label: 'Backpack',
  kind: 'perp-cex',
  chain: null,
  collateral: 'USDC',
  // Backpack liquida cada hora y `fundingRate` es la tasa de ese periodo.
  fundingIntervalHours: 1,
  // SIN CONTRASTAR: Backpack no publica sus tarifas por API y su tabla de
  // tramos esta en una imagen, asi que no hay forma automatica de comprobarlas.
  // El smoke lo dice en cada ejecucion en vez de darlas por buenas. Si alguna
  // vez se cambian a mano, apuntar aqui de donde salen.
  fees: { makerBps: 0, takerBps: 2.5, freeClose: false },
  capabilities: { predictedFunding: false, orderBook: true, trading: true, publicPositions: false },
};

/**
 * Backpack. Dos llamadas por ciclo: `/markPrices` trae funding y mark de todos
 * los perpetuos, y `/tickers` el volumen. Los simbolos nativos son del estilo
 * 'SOL_USDC_PERP'.
 */
export class BackpackAdapter implements VenueAdapter {
  readonly meta = BACKPACK_META;
  readonly cost: AdapterCost = { websockets: 0, requestsPerMinute: 8 };
  // Comprobado sobre varias rutas distintas (/position, /account, /capital):
  // todas 401, mientras /openInterest y /markets responden 200 en el mismo
  // host. No es un muro del host: los datos de cuenta son privados. Backpack
  // es un exchange centralizado, asi que no hay cadena donde mirarlos.
  readonly noPositionsReason = 'account data is private: Backpack is centralised and has no public account endpoint';

  #snapshot = new Map<string, MarketSnapshot>();
  #colisiones: string[] = [];
  #native = new Map<string, string>();
  /** Intervalo real por simbolo, leido de /markets. Ver #loadIntervals(). */
  #intervals = new Map<string, number>();

  /**
   * Backpack publica `fundingInterval` por mercado. Se lee de la API en vez de
   * confiar en la constante: si el venue cambia de 1h a 8h y nosotros seguimos
   * dividiendo por 1, su APR sale multiplicado por 8 y el scanner ve una
   * oportunidad enorme donde no hay ninguna. Es informacion casi estatica, asi
   * que se pide una sola vez.
   */
  async #loadIntervals(): Promise<void> {
    if (this.#intervals.size > 0) return;
    const raw = await getJson(`${BASE}/markets`).catch(() => null);
    if (!Array.isArray(raw)) return;
    for (const m of raw) {
      if (!isRecord(m) || typeof m['symbol'] !== 'string') continue;
      const ms = num(m['fundingInterval']);
      if (ms !== null && ms > 0) this.#intervals.set(m['symbol'], ms / 3_600_000);
    }
  }

  async refresh(): Promise<void> {
    const [marks, tickers, oiRaw] = await Promise.all([
      getJson(`${BASE}/markPrices`),
      // El volumen es accesorio: si /tickers falla, queda null y el resto del
      // snapshot sigue siendo valido en vez de perderse el ciclo entero.
      getJson(`${BASE}/tickers`).catch(() => null),
      // Backpack publica el interes abierto en su propio endpoint, y sin pedirlo
      // devuelve los 99 mercados de una vez. Se daba por desconocido, asi que el
      // OI agregado de la app iba sin uno de los cinco venues.
      getJson(`${BASE}/openInterest`).catch(() => null),
      this.#loadIntervals(),
    ]);
    if (!Array.isArray(marks)) throw new Error('markPrices: unexpected shape');

    const volume = new Map<string, number | null>();
    if (Array.isArray(tickers)) {
      for (const t of tickers) {
        if (!isRecord(t) || typeof t['symbol'] !== 'string') continue;
        volume.set(t['symbol'], num(t['quoteVolume']));
      }
    }

    // Viene en unidades del activo; a USD se pasa con el mark de cada mercado.
    const oiBase = new Map<string, number | null>();
    if (Array.isArray(oiRaw)) {
      for (const o of oiRaw) {
        if (!isRecord(o) || typeof o['symbol'] !== 'string') continue;
        oiBase.set(o['symbol'], num(o['openInterest']));
      }
    }

    const next = new Map<string, MarketSnapshot>();
    const colisiones: string[] = [];
    const at = now();

    for (const row of marks) {
      if (!isRecord(row)) continue;
      const nativeName = row['symbol'];
      if (typeof nativeName !== 'string' || !nativeName.endsWith('_PERP')) continue;

      const mark = num(row['markPrice']);
      const funding = num(row['fundingRate']);
      if (mark === null || funding === null) continue;

      // 'SOL_USDC_PERP' -> 'SOL'
      const base = nativeName.split('_')[0] ?? nativeName;
      const { symbol, contractMultiplier } = normalizeSymbol(base);

      setSinPisar(next, {
        venue: this.meta.id,
        symbol,
        symbolNative: nativeName,
        contractMultiplier,
        mid: mark,
        bid: mark,
        ask: mark,
        funding: {
          rate: funding,
          intervalHours: this.#intervals.get(nativeName) ?? this.meta.fundingIntervalHours,
          predicted: null,
          nextFundingAt: num(row['nextFundingTimestamp']),
          kind: 'current',
          sourceField: 'markPrices -> fundingRate',
        },
        book: null,
        // null si el endpoint no respondio: desconocido no es cero, y un cero
        // aqui restaria de verdad en el agregado.
        openInterestUsd: (() => {
          const base = oiBase.get(nativeName);
          return base === null || base === undefined ? null : base * mark;
        })(),
        volume24hUsd: volume.get(nativeName) ?? null,
        at,
        // markPrices no sella el dato; solo dice cuando toca el proximo cobro.
        sourceAt: null,
      }, colisiones);
    }

    if (next.size === 0) throw new Error('markPrices: 0 valid perpetuals');
    this.#snapshot = mapToUnitPrices(next);
    // Se deriva del mapa ya resuelto: si una colision cambio al ganador, el
    // nativo que usa fetchBook tiene que cambiar con el.
    this.#native = new Map([...this.#snapshot].map(([sym, m]) => [sym, m.symbolNative]));
    this.#colisiones = colisiones;
  }

  /** Simbolos que chocaron en el ultimo refresco. Vacio es lo normal. */
  get colisiones(): readonly string[] {
    return this.#colisiones;
  }

  snapshot(): ReadonlyMap<string, MarketSnapshot> {
    return this.#snapshot;
  }

  async fetchBook(symbol: string): Promise<OrderBook | null> {
    const nativeName = this.#native.get(symbol);
    if (nativeName === undefined) return null;

    const raw = await getJson(`${BASE}/depth?symbol=${encodeURIComponent(nativeName)}`);
    if (!isRecord(raw)) return null;

    const side = (levels: unknown, descending: boolean) => {
      if (!Array.isArray(levels)) return [];
      const out: { price: number; size: number }[] = [];
      for (const lvl of levels) {
        if (!Array.isArray(lvl)) continue;
        const price = num(lvl[0]);
        const size = num(lvl[1]);
        if (price === null || size === null || size <= 0) continue;
        out.push({ price, size });
      }
      // Backpack devuelve los dos lados en orden ascendente de precio: los bids
      // hay que invertirlos para que el mejor quede el primero.
      out.sort((a, b) => (descending ? b.price - a.price : a.price - b.price));
      return out;
    };

    return scaleBookToUnits({ bids: side(raw['bids'], true), asks: side(raw['asks'], false) }, this.#snapshot.get(symbol)?.contractMultiplier ?? 1);
  }
}
