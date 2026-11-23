import type { MarketSnapshot, OrderBook, VenueMeta } from '@defi/core';
import { now } from '@defi/core';
import { getJson, isRecord, num } from '../http.ts';
import { normalizeSymbol } from '../symbols.ts';
import { mapToUnitPrices, scaleBookToUnits, setSinPisar } from '../normalize.ts';
import type { VenueAdapter } from '../types.ts';

const BASE = 'https://perp-api.phoenix.trade';
export const PHOENIX_META: VenueMeta = {
  id: 'phoenix', label: 'Phoenix', kind: 'perp-dex', chain: 'Solana', collateral: 'USDC',
  fundingIntervalHours: 1,
  fees: { makerBps: null, takerBps: null, freeClose: false },
  capabilities: { predictedFunding: false, orderBook: true, trading: false, publicPositions: false },
};

/** Un lote agregado por ciclo. Cerrar el socket tras leerlo evita conexiones
 * zombis: cada refresco reabre una conexion, con plazo y cancelacion propios.
 * Esquema: Ellipsis-Labs/rise-public, ts/src/ws/adapters/market-stats-v2.
 */
export class PhoenixAdapter implements VenueAdapter {
  readonly meta = PHOENIX_META;
  readonly cost = { websockets: 1, requestsPerMinute: 1 };
  readonly noPositionsReason = 'Public positions not integrated';
  #snapshot = new Map<string, MarketSnapshot>();
  #colisiones: string[] = [];
  #pending: Promise<void> | null = null;
  #abort = new AbortController();

  get colisiones(): readonly string[] { return this.#colisiones; }
  snapshot(): ReadonlyMap<string, MarketSnapshot> { return this.#snapshot; }
  stop(): void { this.#abort.abort(); }

  refresh(): Promise<void> {
    if (this.#pending !== null) return this.#pending;
    this.#pending = this.#refresh().finally(() => { this.#pending = null; });
    return this.#pending;
  }

  async #refresh(): Promise<void> {
    const signal = this.#abort.signal;
    signal.throwIfAborted();
    // Una sola consulta de catalogo por ciclo permite detectar altas y bajas.
    const raw = await getJson(BASE + '/v1/view/markets', { signal });
    if (!isRecord(raw) || !Array.isArray(raw['markets'])) throw new Error('Phoenix: invalid catalog');
    const active = new Set<string>();
    for (const row of raw['markets']) {
      if (!isRecord(row) || row['marketStatus'] !== 'active' || typeof row['symbol'] !== 'string') continue;
      // El nombre legacy dice Slots; el detalle REST declara Seconds (smoke).
      if (num(row['fundingIntervalInSlots']) !== 3600) throw new Error('Phoenix: unsupported funding interval');
      active.add(row['symbol']);
    }
    if (active.size === 0) throw new Error('Phoenix: no active markets');
    signal.throwIfAborted();
    const next = await new Promise<Map<string, MarketSnapshot>>((resolve, reject) => {
      const ws = new WebSocket(BASE.replace('https:', 'wss:') + '/v1/ws');
      let done = false;
      const finish = (error: Error | null, result?: Map<string, MarketSnapshot>) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        ws.close();
        if (error !== null) reject(error);
        else if (result !== undefined) resolve(result);
      };
      const cancel = () => finish(new Error('Phoenix: stopped'));
      const timer = setTimeout(() => finish(new Error('Phoenix: marketStatsV2 timeout')), 20_000);
      signal.addEventListener('abort', cancel, { once: true });
      ws.onopen = () => ws.send(JSON.stringify({ type: 'subscribe', subscription: { channel: 'marketStatsV2' } }));
      ws.onerror = () => finish(new Error('Phoenix: WebSocket error'));
      ws.onclose = () => finish(new Error('Phoenix: WebSocket closed before snapshot'));
      ws.onmessage = (event) => {
        if (done) return;
        try {
          const msg: unknown = JSON.parse(String(event.data));
          if (!isRecord(msg) || msg['channel'] !== 'marketStatsV2' || !Array.isArray(msg['stats'])) return;
          const at = now();
          const rows = new Map<string, MarketSnapshot>();
          const collisions: string[] = [];
          const covered = new Set<string>();
          for (const row of msg['stats']) {
            const market = phoenixMarket(row, at);
            if (market === null || !active.has(market.symbolNative)) continue;
            covered.add(market.symbolNative);
            setSinPisar(rows, market, collisions);
          }
          // No publicar cobertura parcial silenciosamente ni mezclar lotes viejos.
          if (covered.size !== active.size) return;
          this.#colisiones = collisions;
          finish(null, mapToUnitPrices(rows));
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      };
    });
    signal.throwIfAborted();
    this.#snapshot = next;
  }

  async fetchBook(symbol: string): Promise<OrderBook | null> {
    const market = this.#snapshot.get(symbol);
    if (market === undefined) return null;
    const raw = await getJson(BASE + '/v1/view/market/' + encodeURIComponent(market.symbolNative), { signal: this.#abort.signal });
    if (!isRecord(raw) || !isRecord(raw['market']) || !isRecord(raw['market']['l2Orderbook'])) return null;
    const book = raw['market']['l2Orderbook'];
    const side = (levels: unknown): { price: number; size: number }[] => {
      if (!Array.isArray(levels)) return [];
      return levels.flatMap((level: unknown) => {
        if (!Array.isArray(level)) return [];
        const price = num(level[0]), size = num(level[1]);
        return price !== null && price > 0 && size !== null && size > 0 ? [{ price, size }] : [];
      });
    };
    const bids = side(book['bids']).sort((a, b) => b.price - a.price);
    const asks = side(book['asks']).sort((a, b) => a.price - b.price);
    if (bids.length === 0 || asks.length === 0) return null;
    return scaleBookToUnits({ bids, asks }, market.contractMultiplier);
  }
}

/** Las tasas de Phoenix son PORCENTAJES horarios; OI esta en activo base.
 * Rechazamos fuentes atrasadas y relaciones de unidades incompatibles.
 */
export function phoenixMarket(row: unknown, at: number): MarketSnapshot | null {
  if (!isRecord(row) || typeof row['symbol'] !== 'string' || row['symbol'] === '') return null;
  const mark = num(row['markPrice']);
  const mid = num(row['midPrice']) ?? mark;
  const ratePct = num(row['currentFundingRate']);
  const annual = num(row['annualizedFundingRate']);
  const timestamp = num(row['timestamp']);
  if (mark === null || mark <= 0 || mid === null || mid <= 0 || ratePct === null || timestamp === null) return null;
  const sourceAt = timestamp * 1000;
  if (at - sourceAt > 90_000 || sourceAt - at > 30_000) return null;
  if (annual === null || Math.abs(annual - ratePct * 8760) > Math.max(1e-7, Math.abs(annual) * 1e-6)) return null;
  const oi = num(row['openInterest']);
  const volume = num(row['dayVolumeUsd']);
  return {
    venue: 'phoenix', ...normalizeSymbol(row['symbol']), symbolNative: row['symbol'],
    // Sin bid/ask en este canal: el coste ejecutable procede de fetchBook.
    mid, bid: mid, ask: mid,
    funding: { rate: ratePct / 100, intervalHours: 1, predicted: null, nextFundingAt: null,
      kind: 'current', sourceField: 'marketStatsV2.currentFundingRate / 100' },
    book: null, openInterestUsd: oi !== null && oi >= 0 ? oi * mark : null,
    volume24hUsd: volume !== null && volume >= 0 ? volume : null,
    at, sourceAt,
  };
}
