import type { MarketSnapshot, OrderBook, VenueMeta } from '@defi/core';
import { now } from '@defi/core';
import { getJson, isRecord, num } from '../http.ts';
import { normalizeSymbol } from '../symbols.ts';
import { mapToUnitPrices, scaleBookToUnits, setSinPisar } from '../normalize.ts';
import type { AdapterCost, VenueAdapter } from '../types.ts';

const BASE = 'https://api.prod.paradex.trade/v1';

export const PARADEX_META: VenueMeta = {
  id: 'paradex',
  label: 'Paradex',
  kind: 'perp-dex',
  chain: 'Starknet',
  collateral: 'USDC',
  // Paradex denomina `funding_rate` en ventana de 8 horas, no horaria. Se
  // declara aqui y se verifica cruzando el APR de BTC contra los venues
  // horarios: un error de intervalo aparece como una diferencia de 8x.
  fundingIntervalHours: 8,
  // Publicadas por el propio venue en GET /v1/markets, campo
  // `fee_config.api_fee`: maker 0 y taker 0.0002 en los 63 perps, sin
  // excepciones. Estaba declarado 3.0 bps, un 50 % de mas, lo que penalizaba a
  // Paradex en el ranking de APR neto del scanner sin motivo. El smoke lo
  // contrasta contra la API en cada ejecucion para que no vuelva a desfasarse.
  fees: { makerBps: 0, takerBps: 2.0, freeClose: false },
  capabilities: { predictedFunding: false, orderBook: true, trading: true, publicPositions: false },
};

/**
 * Paradex. `/markets/summary?market=ALL` devuelve casi 3000 instrumentos, pero
 * la inmensa mayoria son opciones: solo se conservan los que acaban en -PERP.
 * A cambio trae bid y ask reales, cosa que la mayoria de agregados no dan.
 */
export class ParadexAdapter implements VenueAdapter {
  readonly meta = PARADEX_META;
  readonly cost: AdapterCost = { websockets: 0, requestsPerMinute: 4 };
  // Comprobado sobre /positions, /account/info, /balance y /account/summary:
  // todas 401, mientras /system/config y /markets responden 200. Su API REST
  // exige JWT. Ojo: las cuentas de Paradex son estado de Starknet, asi que las
  // posiciones SI son publicas en la cadena — lo que falta es leerlas por RPC,
  // no que sean secretas.
  readonly noPositionsReason = 'their REST API needs a JWT; the positions are public Starknet state and could be read over RPC instead';

  #snapshot = new Map<string, MarketSnapshot>();
  #colisiones: string[] = [];
  #native = new Map<string, string>();
  /** Intervalo real por mercado, leido de /markets. Ver #loadIntervals(). */
  #intervals = new Map<string, number>();

  /**
   * Paradex publica `funding_period_hours` por mercado. Se lee de la API en vez
   * de confiar en la constante: si cambiara de 8h a 4h y nosotros siguieramos
   * dividiendo por 8, su APR saldria a la mitad y el scanner descartaria
   * oportunidades reales. Es casi estatico, asi que se pide una sola vez.
   */
  async #loadIntervals(): Promise<void> {
    if (this.#intervals.size > 0) return;
    const raw = await getJson(`${BASE}/markets`).catch(() => null);
    if (!isRecord(raw) || !Array.isArray(raw['results'])) return;
    for (const m of raw['results']) {
      if (!isRecord(m) || typeof m['symbol'] !== 'string') continue;
      const hours = num(m['funding_period_hours']);
      if (hours !== null && hours > 0) this.#intervals.set(m['symbol'], hours);
    }
  }

  async refresh(): Promise<void> {
    await this.#loadIntervals();
    const raw = await getJson(`${BASE}/markets/summary?market=ALL`);
    if (!isRecord(raw) || !Array.isArray(raw['results'])) throw new Error('markets/summary: unexpected shape');

    const next = new Map<string, MarketSnapshot>();
    const colisiones: string[] = [];
    const at = now();

    for (const row of raw['results']) {
      if (!isRecord(row)) continue;
      const nativeName = row['symbol'];
      if (typeof nativeName !== 'string' || !nativeName.endsWith('-PERP')) continue;

      const mark = num(row['mark_price']);
      const funding = num(row['funding_rate']);
      if (mark === null || funding === null) continue;

      const bid = num(row['bid']);
      const ask = num(row['ask']);
      const oi = num(row['open_interest']);
      const { symbol, contractMultiplier } = normalizeSymbol(nativeName);

      setSinPisar(next, {
        venue: this.meta.id,
        symbol,
        symbolNative: nativeName,
        contractMultiplier,
        // Se usa SIEMPRE el mark price, nunca el punto medio de bid y ask.
        // En los mercados ilíquidos de Paradex el libro es absurdamente ancho
        // (DOGE con bid 0,071 y ask 0,36: un spread del 400 %), y su punto
        // medio daba 0,2157 cuando el activo valia 0,0908 segun los otros
        // cuatro venues. En BTC no se notaba porque el libro es estrecho.
        mid: mark,
        bid: bid ?? mark,
        ask: ask ?? mark,
        funding: {
          rate: funding,
          intervalHours: this.#intervals.get(nativeName) ?? this.meta.fundingIntervalHours,
          predicted: null,
          nextFundingAt: null,
          // Paradex denomina esta tasa en la ventana de 8 h que declara en
          // `funding_period_hours`, y es la vigente, no la liquidada.
          kind: 'current',
          sourceField: 'markets/summary -> funding_rate (8h window)',
        },
        book: null,
        openInterestUsd: oi !== null ? oi * mark : null,
        // OJO: en el mismo objeto conviven dos convenciones. `open_interest`
        // va en unidades del subyacente (hay que multiplicar por el precio),
        // pero `volume_24h` YA viene en USD. Multiplicarlo daba 290.000
        // millones de volumen diario en BTC, mas que todo el mercado cripto:
        // serian 3,7 millones de bitcoins, el 17 % de los que existen.
        volume24hUsd: num(row['volume_24h']),
        at,
        // Paradex si sella el dato en origen, en `created_at`.
        sourceAt: num(row['created_at']),
      }, colisiones);
    }

    if (next.size === 0) throw new Error('markets/summary: 0 valid perpetuals');
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

    const raw = await getJson(`${BASE}/orderbook/${encodeURIComponent(nativeName)}?depth=20`);
    if (!isRecord(raw)) return null;

    const side = (levels: unknown) => {
      if (!Array.isArray(levels)) return [];
      const out: { price: number; size: number }[] = [];
      for (const lvl of levels) {
        if (!Array.isArray(lvl)) continue;
        const price = num(lvl[0]);
        const size = num(lvl[1]);
        if (price === null || size === null || size <= 0) continue;
        out.push({ price, size });
      }
      return out;
    };

    return scaleBookToUnits({ bids: side(raw['bids']), asks: side(raw['asks']) }, this.#snapshot.get(symbol)?.contractMultiplier ?? 1);
  }
}
