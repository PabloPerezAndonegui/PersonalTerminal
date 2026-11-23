import type { AccountSnapshot, MarketSnapshot, OrderBook, Position, VenueMeta } from '@defi/core';
import { now } from '@defi/core';
import { getJson, isRecord, num, HttpError } from '../http.ts';
import { normalizeSymbol } from '../symbols.ts';
import { mapToUnitPrices, scaleBookToUnits, setSinPisar } from '../normalize.ts';
import type { AdapterCost, VenueAdapter } from '../types.ts';

const BASE = 'https://indexer.dydx.trade/v4';

export const DYDX_META: VenueMeta = {
  id: 'dydx',
  label: 'dYdX',
  kind: 'perp-dex',
  chain: 'dYdX Chain',
  collateral: 'USDC',
  // dYdX v4 liquida cada hora. OJO con el campo que leemos: `nextFundingRate`
  // es la tasa de la PROXIMA hora, no la de la que esta corriendo ni la ya
  // liquidada. Contrastado contra /v4/historicalFunding en el mismo instante:
  // 3.45e-7 frente a 1.375e-6 por hora, un factor 4. Por eso su snapshot va
  // marcado como `predicted` y no como `current`.
  fundingIntervalHours: 1,
  // Tramo base segun los parametros de la propia cadena
  // (/dydxprotocol/v4/feetiers/perpetual_fee_params): maker 100 ppm y taker
  // 500 ppm. Estaba declarado un maker de 0.5 bps, que es el tramo 3 y pide
  // volumen para llegar: en modo maker el scanner daba a dydx la mitad de su
  // coste real, que es la direccion peligrosa del error.
  fees: { makerBps: 1.0, takerBps: 5.0, freeClose: false },
  capabilities: { predictedFunding: false, orderBook: true, trading: true, publicPositions: true },
};

/**
 * dYdX v4. `/perpetualMarkets` devuelve todos los mercados en una llamada, con
 * precio de oraculo, interes abierto y funding. No incluye bid/ask, asi que la
 * profundidad se pide bajo demanda.
 */
export class DydxAdapter implements VenueAdapter {
  readonly meta = DYDX_META;
  readonly cost: AdapterCost = { websockets: 0, requestsPerMinute: 4 };
  // dYdX v4 corre sobre Cosmos: sus cuentas son bech32 con prefijo dydx1, no
  // 0x. Con una direccion EVM el indexer devuelve 404, y el adaptador traduce
  // ese 404 a un snapshot vacio, asi que la wallet salia como que no opera aqui.
  readonly addressKinds = ['cosmos'] as const;

  #snapshot = new Map<string, MarketSnapshot>();
  #colisiones: string[] = [];
  #native = new Map<string, string>();

  async refresh(): Promise<void> {
    const raw = await getJson(`${BASE}/perpetualMarkets`);
    if (!isRecord(raw) || !isRecord(raw['markets'])) throw new Error('perpetualMarkets: unexpected shape');

    const next = new Map<string, MarketSnapshot>();
    const colisiones: string[] = [];
    const at = now();

    for (const row of Object.values(raw['markets'])) {
      if (!isRecord(row)) continue;
      // Los mercados en preparacion o retirados devuelven precios sin liquidez
      // detras: se excluyen en vez de contaminar el scanner.
      if (row['status'] !== 'ACTIVE') continue;

      const nativeName = row['ticker'];
      if (typeof nativeName !== 'string' || nativeName === '') continue;

      const oracle = num(row['oraclePrice']);
      const funding = num(row['nextFundingRate']);
      if (oracle === null || funding === null) continue;

      const oi = num(row['openInterest']);
      const { symbol, contractMultiplier } = normalizeSymbol(nativeName);

      setSinPisar(next, {
        venue: this.meta.id,
        symbol,
        symbolNative: nativeName,
        contractMultiplier,
        mid: oracle,
        bid: oracle,
        ask: oracle,
        funding: {
          rate: funding,
          intervalHours: this.meta.fundingIntervalHours,
          predicted: null,
          nextFundingAt: null,
          // OJO: aqui `rate` NO es la tasa del periodo en curso, es la que dydx
          // anuncia para el SIGUIENTE. Difiere de verdad de lo liquidado:
          // medido, 3.45e-7 frente a 1.375e-6 por hora en el mismo instante.
          kind: 'predicted',
          sourceField: 'perpetualMarkets -> nextFundingRate',
        },
        book: null,
        openInterestUsd: oi !== null ? oi * oracle : null,
        volume24hUsd: num(row['volume24H']),
        at,
        // El indexer de dydx no sella los mercados.
        sourceAt: null,
      }, colisiones);
    }

    if (next.size === 0) throw new Error('perpetualMarkets: 0 active markets');
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

  /**
   * Posiciones de una direccion publica.
   *
   * dYdX devuelve 404 cuando la direccion no tiene subcuentas, que es el caso
   * normal de "esta wallet no ha operado aqui". Se traduce a un snapshot vacio
   * en vez de propagarlo como error: no es un fallo de la fuente.
   */
  async fetchPositions(address: string): Promise<AccountSnapshot | null> {
    const raw = await getJson(`${BASE}/addresses/${encodeURIComponent(address)}`).catch(
      (err: unknown) => {
        if (err instanceof HttpError && err.status === 404) return null;
        throw err;
      },
    );

    const vacio: AccountSnapshot = {
      venue: this.meta.id,
      address,
      equityUsd: null,
      marginUsedUsd: null,
      positions: [],
      at: now(),
    };
    if (raw === null) return vacio;
    if (!isRecord(raw) || !Array.isArray(raw['subaccounts'])) return vacio;

    const posiciones: Position[] = [];
    let equity: number | null = null;

    for (const sub of raw['subaccounts']) {
      if (!isRecord(sub)) continue;
      const valor = num(sub['equity']);
      if (valor !== null) equity = (equity ?? 0) + valor;

      const abiertas = sub['openPerpetualPositions'];
      if (!isRecord(abiertas)) continue;

      for (const row of Object.values(abiertas)) {
        if (!isRecord(row)) continue;
        const nativeName = row['market'];
        if (typeof nativeName !== 'string') continue;

        const size = num(row['size']);
        if (size === null || size === 0) continue;

        const { symbol, contractMultiplier } = normalizeSymbol(nativeName);
        const entry = num(row['entryPrice']);
        const tamano = Math.abs(size) * contractMultiplier;
        const mid = this.#snapshot.get(symbol)?.mid ?? null;

        posiciones.push({
          venue: this.meta.id,
          symbol,
          symbolNative: nativeName,
          side: row['side'] === 'SHORT' || size < 0 ? 'short' : 'long',
          sizeBase: tamano,
          notionalUsd: mid === null ? 0 : tamano * mid,
          entryPrice: entry === null ? null : entry / contractMultiplier,
          markPrice: mid,
          unrealizedPnlUsd: num(row['unrealizedPnl']),
          leverage: null,
          liquidationPrice: null,
        });
      }
    }

    return { ...vacio, equityUsd: equity, positions: posiciones };
  }

  async fetchBook(symbol: string): Promise<OrderBook | null> {
    const nativeName = this.#native.get(symbol);
    if (nativeName === undefined) return null;

    const raw = await getJson(`${BASE}/orderbooks/perpetualMarket/${encodeURIComponent(nativeName)}`);
    if (!isRecord(raw)) return null;

    const side = (levels: unknown, descending: boolean) => {
      if (!Array.isArray(levels)) return [];
      const out: { price: number; size: number }[] = [];
      for (const lvl of levels) {
        if (!isRecord(lvl)) continue;
        const price = num(lvl['price']);
        const size = num(lvl['size']);
        if (price === null || size === null || size <= 0) continue;
        out.push({ price, size });
      }
      out.sort((a, b) => (descending ? b.price - a.price : a.price - b.price));
      return out;
    };

    return scaleBookToUnits({ bids: side(raw['bids'], true), asks: side(raw['asks'], false) }, this.#snapshot.get(symbol)?.contractMultiplier ?? 1);
  }
}
