import type { AccountSnapshot, MarketSnapshot, OrderBook, Position, VenueMeta } from '@defi/core';
import { now } from '@defi/core';
import { getJson, isRecord, num } from '../http.ts';
import { normalizeSymbol } from '../symbols.ts';
import { mapToUnitPrices, scaleBookToUnits, setSinPisar } from '../normalize.ts';
import type { AdapterCost, VenueAdapter } from '../types.ts';

const BASE = 'https://api.pacifica.fi/api/v1';

export const PACIFICA_META: VenueMeta = {
  id: 'pacifica',
  label: 'Pacifica',
  kind: 'perp-dex',
  chain: 'Solana',
  collateral: 'USDC',
  // /info/prices devuelve `funding` ya en tasa HORARIA.
  fundingIntervalHours: 1,
  fees: { makerBps: 1.5, takerBps: 4.0, freeClose: false },
  capabilities: { predictedFunding: true, orderBook: true, trading: true, publicPositions: true },
};

/**
 * Pacifica. `/info/prices` da en UNA llamada funding actual y previsto, mark,
 * mid, oraculo, interes abierto y volumen de todos los simbolos. El libro va
 * aparte, por simbolo, asi que se pide bajo demanda.
 */
export class PacificaAdapter implements VenueAdapter {
  readonly meta = PACIFICA_META;
  readonly cost: AdapterCost = { websockets: 0, requestsPerMinute: 4 };
  readonly addressKinds = ['solana'] as const;

  #snapshot = new Map<string, MarketSnapshot>();
  #colisiones: string[] = [];
  #native = new Map<string, string>();

  async refresh(): Promise<void> {
    const raw = await getJson(`${BASE}/info/prices`);
    if (!isRecord(raw) || !Array.isArray(raw['data'])) throw new Error('info/prices: unexpected shape');

    const next = new Map<string, MarketSnapshot>();
    const colisiones: string[] = [];
    const at = now();

    for (const row of raw['data']) {
      if (!isRecord(row)) continue;
      const nativeName = row['symbol'];
      if (typeof nativeName !== 'string' || nativeName === '') continue;

      // `/info/prices` mezcla perpetuos y SPOT en la misma lista, y no trae
      // ningun campo que los distinga. Los perps de Pacifica son el ticker
      // pelado (`SOL`) y el spot lleva la moneda de cotizacion (`SOL-USDC`).
      //
      // Sin este filtro, `SOL-USDC` normalizaba tambien a `SOL` y, por llegar
      // despues, PISABA al perpetuo: la SOL de Pacifica aparecia con funding 0
      // (el spot no tiene) y 130k de volumen en vez de 62 millones. El scanner
      // cruzaba ese cero contra el funding real de los demas venues.
      if (nativeName.includes('-')) continue;

      const mid = num(row['mid']);
      const mark = num(row['mark']);
      const funding = num(row['funding']);
      if (mid === null || funding === null) continue;

      const oi = num(row['open_interest']);
      const { symbol, contractMultiplier } = normalizeSymbol(nativeName);

      setSinPisar(next, {
        venue: this.meta.id,
        symbol,
        symbolNative: nativeName,
        contractMultiplier,
        mid,
        // /info/prices no da bid/ask. Se rellenan con el mid y el coste real de
        // ejecucion se obtiene de fetchBook(): inventar aqui un spread seria
        // peor que declarar que no se conoce.
        bid: mid,
        ask: mid,
        funding: {
          rate: funding,
          intervalHours: this.meta.fundingIntervalHours,
          // Pacifica es el unico que publica la tasa del proximo periodo junto
          // a la del actual, en el mismo objeto.
          predicted: num(row['next_funding']),
          nextFundingAt: null,
          kind: 'current',
          sourceField: 'info/prices -> funding',
        },
        book: null,
        openInterestUsd: oi !== null && mark !== null ? oi * mark : null,
        volume24hUsd: num(row['volume_24h']),
        at,
        // Pacifica si sella el dato en origen.
        sourceAt: num(row['timestamp']),
      }, colisiones);
    }

    if (next.size === 0) throw new Error('info/prices: 0 valid symbols');
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
   * Posiciones de una cuenta publica de Solana. Sin credenciales: es lo mismo
   * que cualquiera puede consultar.
   */
  async fetchPositions(address: string): Promise<AccountSnapshot | null> {
    const cuenta = encodeURIComponent(address);
    // El saldo va en otro endpoint, igual de publico. Se piden a la vez: son
    // dos viajes de todas formas, y en serie el Tracker tardaria el doble.
    // Si el del saldo falla, las posiciones siguen siendo utiles y el saldo se
    // queda en null, que es lo que de verdad se sabe entonces.
    const [raw, saldo] = await Promise.all([
      getJson(`${BASE}/positions?account=${cuenta}`),
      getJson(`${BASE}/account?account=${cuenta}`).catch(() => null),
    ]);
    if (!isRecord(raw) || !Array.isArray(raw['data'])) return null;

    const posiciones: Position[] = [];
    for (const row of raw['data']) {
      if (!isRecord(row)) continue;
      const nativeName = row['symbol'];
      if (typeof nativeName !== 'string') continue;

      const cantidad = num(row['amount']);
      if (cantidad === null || cantidad === 0) continue;

      const { symbol, contractMultiplier } = normalizeSymbol(nativeName);
      const entry = num(row['entry_price']);
      const mid = this.#snapshot.get(symbol)?.mid ?? null;
      // `side` viene como texto; si faltara, el signo de la cantidad decide.
      const lado = row['side'] === 'ask' || row['side'] === 'short' || cantidad < 0 ? 'short' : 'long';
      const tamano = Math.abs(cantidad) * contractMultiplier;

      posiciones.push({
        venue: this.meta.id,
        symbol,
        symbolNative: nativeName,
        side: lado,
        sizeBase: tamano,
        // Pacifica no da el nocional: se calcula con el mid ya normalizado que
        // tenemos del ciclo, y si no lo hay se queda en 0 en vez de inventarlo.
        notionalUsd: mid === null ? 0 : tamano * mid,
        entryPrice: entry === null ? null : entry / contractMultiplier,
        markPrice: mid,
        unrealizedPnlUsd: num(row['unrealized_pnl']),
        leverage: num(row['leverage']),
        liquidationPrice: (() => {
          const l = num(row['liquidation_price']);
          return l === null ? null : l / contractMultiplier;
        })(),
      });
    }

    const datos = isRecord(saldo) && isRecord(saldo['data']) ? saldo['data'] : null;

    return {
      venue: this.meta.id,
      address,
      equityUsd: datos === null ? null : num(datos['account_equity']),
      marginUsedUsd: datos === null ? null : num(datos['total_margin_used']),
      positions: posiciones,
      at: now(),
    };
  }

  async fetchBook(symbol: string): Promise<OrderBook | null> {
    const nativeName = this.#native.get(symbol);
    if (nativeName === undefined) return null;

    const raw = await getJson(`${BASE}/book?symbol=${encodeURIComponent(nativeName)}`);
    if (!isRecord(raw) || !isRecord(raw['data']) || !Array.isArray(raw['data']['l'])) return null;
    const [bidsRaw, asksRaw] = raw['data']['l'];

    const side = (levels: unknown) => {
      if (!Array.isArray(levels)) return [];
      const out: { price: number; size: number }[] = [];
      for (const lvl of levels) {
        if (!isRecord(lvl)) continue;
        const price = num(lvl['p']);
        const size = num(lvl['a']);
        if (price === null || size === null || size <= 0) continue;
        out.push({ price, size });
      }
      return out;
    };

    return scaleBookToUnits({ bids: side(bidsRaw), asks: side(asksRaw) }, this.#snapshot.get(symbol)?.contractMultiplier ?? 1);
  }
}
