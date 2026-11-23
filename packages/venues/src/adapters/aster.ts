import type { MarketSnapshot, OrderBook, VenueMeta } from '@defi/core';
import { now } from '@defi/core';
import { getJson, isRecord, num } from '../http.ts';
import { normalizeSymbol } from '../symbols.ts';
import { mapToUnitPrices, scaleBookToUnits, setSinPisar } from '../normalize.ts';
import type { AdapterCost, VenueAdapter } from '../types.ts';

const BASE = 'https://fapi.asterdex.com/fapi/v1';

export const ASTER_META: VenueMeta = {
  id: 'aster',
  label: 'Aster',
  kind: 'perp-dex',
  chain: 'BNB Chain',
  collateral: 'USDT',
  // Por defecto 8 h, que es lo que liquidan casi todos sus mercados. El
  // intervalo REAL de cada simbolo se lee de /fundingInfo y manda sobre este.
  // 8 h, MEDIDO el 9 de octubre de 2026 contra su propio historico de
  // liquidaciones: `/fapi/v1/fundingRate` en BTCUSDT, ETHUSDT y SOLUSDT da
  // once huecos seguidos de 8,000 h exactas en los tres.
  //
  // Se deja escrito porque el smoke lo marca como sospechoso cuando su
  // funding esta plano: ese dia salia a 0,12x la mediana de los demas
  // venues, que habria cuadrado con 1 h. Era divergencia de mercado, no un
  // intervalo mal declarado, y se nota en que las sondas iban dispersas.
  fundingIntervalHours: 8,
  // DESCONOCIDAS: no publica su tabla de comisiones por API y no se han
  // contrastado. Van a null y no a un numero a ojo: con null el APR neto sale
  // "—", mientras que una fee inventada convierte una oportunidad mala en una
  // que parece buena. Cuando se comprueben, apuntar aqui de donde salen.
  fees: { makerBps: null, takerBps: null, freeClose: false },
  capabilities: { predictedFunding: false, orderBook: true, trading: true, publicPositions: false },
};

/**
 * Preferencia de moneda de cotizacion cuando un mismo activo tiene varios
 * mercados vivos a la vez.
 *
 * Aster lista BTC tres veces: BTCUSDT, BTCUSD1 y BTCU. Son mercados distintos,
 * con funding distinto (0.0001 / 0.00007235 / 0.00008076 el 19 de septiembre de
 * 2026), asi que hay que elegir uno y que sea SIEMPRE el mismo: eligiendo por
 * volumen, el dia que USD1 adelantase a USDT el historico de 'BTC' juntaria dos
 * mercados diferentes y el salto pareceria un movimiento de mercado. Se queda el
 * de USDT, que es donde esta la liquidez: 568 de 581 mercados.
 */
const QUOTES_PREFERIDAS: readonly string[] = ['USDT', 'USDC', 'USD', 'USD1', 'U'];

/** Lo que /exchangeInfo dice de un mercado. Es la autoridad sobre que existe. */
interface AsterInfo {
  readonly base: string;
  readonly quote: string;
  readonly rank: number;
}

/** Los metadatos cambian poco; se releen cada media hora, no en cada ciclo. */
const META_TTL_MS = 30 * 60_000;

/**
 * Aster. API al estilo de Binance: `/premiumIndex` devuelve todos los mercados
 * en una llamada con su tasa de funding, y `/ticker/24hr` el volumen.
 *
 * `lastFundingRate` es la tasa VIGENTE del periodo en curso, no la ya
 * liquidada, pese al nombre. Comprobado contra /fundingRate en el mismo
 * instante: en TRUTHUSDT daba 0.00010941 vigente contra 0.00019260 liquidada.
 * Con el mercado plano las dos coinciden, asi que la comprobacion solo vale en
 * simbolos con prima.
 *
 * **`/premiumIndex` no se puede usar solo.** Devuelve 752 filas, 151 de las
 * cuales ya no existen en /exchangeInfo: restos de mercados retirados que
 * siguen publicando precio, 76 de ellos con funding exactamente 0. BTCUSD es
 * uno. Tomando /premiumIndex a secas, esos restos competian con el mercado vivo
 * al normalizar el nombre y podian ganarlo, publicando un funding de 0 que
 * nadie puede cobrar. Asi que la lista de mercados la manda /exchangeInfo, que
 * ademas da `baseAsset` y `quoteAsset` y ahorra adivinar la moneda recortando
 * el nombre: 'VUSDT' es la base V, no la base VUSDT.
 *
 * De 752 filas en crudo a los simbolos que se publican:
 *
 *     752   /premiumIndex
 *    -151   no estan en /exchangeInfo: retirados, pero aun cotizan
 *     -16   status SETTLING: en liquidacion
 *      -5   status PENDING_TRADING: anunciados, sin abrir
 *    ----
 *     581   mercados vivos, todos PERPETUAL
 *     -11   el mismo activo cotizado tambien en USD1 o en U (9 activos)
 *    ----
 *     570   simbolos publicados
 *
 * Medido el 19 de septiembre de 2026. Los numeros se mueven con cada listado
 * nuevo; lo que no debe moverse es que la resta cuadre.
 */
export class AsterAdapter implements VenueAdapter {
  readonly meta = ASTER_META;
  // Dos peticiones por ciclo, mas dos de metadatos cada media hora.
  readonly cost: AdapterCost = { websockets: 0, requestsPerMinute: 4 };
  // Sus cuentas son EVM, pero no expone posiciones sin firma.
  readonly noPositionsReason = 'account endpoints need a signed request';

  #snapshot = new Map<string, MarketSnapshot>();
  #colisiones: string[] = [];
  #native = new Map<string, string>();
  /** Mercados vivos por nombre nativo. Vacio = aun no se ha leido. */
  #info = new Map<string, AsterInfo>();
  /** Intervalo por simbolo. Solo trae los que se salen del defecto. */
  #intervals = new Map<string, number>();
  #metaAt = 0;

  /**
   * Mercados vivos e intervalos reales de funding.
   *
   * Un intervalo mal supuesto multiplica el APR por el cociente de horas, que
   * es el error caro de este proyecto. Son datos casi estaticos, pero no del
   * todo: se releen cada media hora para que un listado nuevo aparezca sin
   * reiniciar el proceso.
   */
  async #loadMeta(): Promise<void> {
    if (this.#info.size > 0 && Date.now() - this.#metaAt < META_TTL_MS) return;

    const [exchange, funding] = await Promise.all([
      getJson(`${BASE}/exchangeInfo`),
      getJson(`${BASE}/fundingInfo`).catch(() => null),
    ]);

    const info = new Map<string, AsterInfo>();
    if (isRecord(exchange) && Array.isArray(exchange['symbols'])) {
      for (const s of exchange['symbols']) {
        if (!isRecord(s)) continue;
        const nativeName = s['symbol'];
        const base = s['baseAsset'];
        const quote = s['quoteAsset'];
        if (typeof nativeName !== 'string' || typeof base !== 'string' || typeof quote !== 'string') {
          continue;
        }
        // Solo lo que se puede operar ahora mismo.
        if (s['status'] !== 'TRADING') continue;
        const rank = QUOTES_PREFERIDAS.indexOf(quote);
        info.set(nativeName, {
          base,
          quote,
          // Una moneda que no conocemos va al final, nunca delante de USDT.
          rank: rank === -1 ? QUOTES_PREFERIDAS.length : rank,
        });
      }
    }

    // Si /exchangeInfo falla se conserva la lista anterior: quedarse sin ella
    // significaria publicar los restos retirados, que es peor que ir viejo.
    if (info.size === 0) {
      if (this.#info.size === 0) throw new Error('exchangeInfo: 0 tradable markets');
      return;
    }

    this.#info = info;
    this.#metaAt = Date.now();

    if (Array.isArray(funding)) {
      const intervals = new Map<string, number>();
      for (const m of funding) {
        if (!isRecord(m) || typeof m['symbol'] !== 'string') continue;
        const h = num(m['fundingIntervalHours']);
        if (h !== null && h > 0) intervals.set(m['symbol'], h);
      }
      if (intervals.size > 0) this.#intervals = intervals;
    }
  }

  async refresh(): Promise<void> {
    await this.#loadMeta();

    const [prem, tickers] = await Promise.all([
      getJson(`${BASE}/premiumIndex`),
      // El volumen es accesorio: si falla, queda null y el ciclo sigue valiendo.
      getJson(`${BASE}/ticker/24hr`).catch(() => null),
    ]);
    if (!Array.isArray(prem)) throw new Error('premiumIndex: unexpected shape');

    const volumen = new Map<string, number | null>();
    if (Array.isArray(tickers)) {
      for (const t of tickers) {
        if (!isRecord(t) || typeof t['symbol'] !== 'string') continue;
        // `quoteVolume` ya viene en la moneda de cotizacion, o sea en USD.
        volumen.set(t['symbol'], num(t['quoteVolume']));
      }
    }

    // Primera pasada: se quedan las filas de mercados vivos y se apunta, para
    // cada simbolo normalizado, la mejor moneda de cotizacion que aparece.
    interface Fila {
      readonly nativeName: string;
      readonly rank: number;
      readonly symbol: string;
      readonly multiplier: number;
      readonly mark: number;
      readonly rate: number;
      readonly row: Record<string, unknown>;
    }
    const filas: Fila[] = [];
    const mejorRank = new Map<string, number>();

    for (const row of prem) {
      if (!isRecord(row)) continue;
      const nativeName = row['symbol'];
      if (typeof nativeName !== 'string' || nativeName === '') continue;

      const info = this.#info.get(nativeName);
      // No esta en /exchangeInfo o no se opera: es un resto, no un mercado.
      if (info === undefined) continue;

      const mark = num(row['markPrice']);
      const rate = num(row['lastFundingRate']);
      if (mark === null || rate === null || mark <= 0) continue;

      // El propio venue ya separa la base ('1000SHIB' de '1000SHIBUSDT'), asi
      // que normalizeSymbol solo tiene que resolver el multiplicador.
      const { symbol, contractMultiplier } = normalizeSymbol(info.base);
      filas.push({ nativeName, rank: info.rank, symbol, multiplier: contractMultiplier, mark, rate, row });

      const previo = mejorRank.get(symbol);
      if (previo === undefined || info.rank < previo) mejorRank.set(symbol, info.rank);
    }

    const next = new Map<string, MarketSnapshot>();
    const colisiones: string[] = [];
    const at = now();

    for (const fila of filas) {
      // El mismo activo en otra moneda es un mercado distinto, no una colision:
      // se descarta sin ruido y se queda el de la moneda preferida.
      if (fila.rank > (mejorRank.get(fila.symbol) ?? fila.rank)) continue;

      setSinPisar(next, {
        venue: this.meta.id,
        symbol: fila.symbol,
        symbolNative: fila.nativeName,
        contractMultiplier: fila.multiplier,
        mid: fila.mark,
        // /premiumIndex no da libro. El coste real se saca de fetchBook().
        bid: fila.mark,
        ask: fila.mark,
        funding: {
          rate: fila.rate,
          intervalHours: this.#intervals.get(fila.nativeName) ?? this.meta.fundingIntervalHours,
          predicted: null,
          nextFundingAt: num(fila.row['nextFundingTime']),
          kind: 'current',
          sourceField: 'premiumIndex -> lastFundingRate',
        },
        book: null,
        // El interes abierto va en /openInterest, una peticion POR SIMBOLO. Con
        // 570 mercados serian 570 peticiones por ciclo desde una IP que se
        // comparte con otros bots: no se pide, y queda declarado desconocido.
        openInterestUsd: null,
        volume24hUsd: volumen.get(fila.nativeName) ?? null,
        at,
        // `time` es el sello del propio venue para esa fila.
        sourceAt: num(fila.row['time']),
      }, colisiones);
    }

    if (next.size === 0) throw new Error('premiumIndex: 0 valid markets');
    this.#snapshot = mapToUnitPrices(next);
    this.#native = new Map([...this.#snapshot].map(([sym, m]) => [sym, m.symbolNative]));
    this.#colisiones = colisiones;
  }

  get colisiones(): readonly string[] {
    return this.#colisiones;
  }

  snapshot(): ReadonlyMap<string, MarketSnapshot> {
    return this.#snapshot;
  }

  async fetchBook(symbol: string): Promise<OrderBook | null> {
    const nativeName = this.#native.get(symbol);
    if (nativeName === undefined) return null;

    const raw = await getJson(`${BASE}/depth?symbol=${encodeURIComponent(nativeName)}&limit=20`);
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

    return scaleBookToUnits(
      { bids: side(raw['bids']), asks: side(raw['asks']) },
      this.#snapshot.get(symbol)?.contractMultiplier ?? 1,
    );
  }
}
