import type { MarketSnapshot, VenueMeta } from '@defi/core';
import { now } from '@defi/core';
import { getJson, isRecord, num } from '../http.ts';
import { normalizeSymbol } from '../symbols.ts';
import { mapToUnitPrices, setSinPisar } from '../normalize.ts';
import type { AdapterCost, VenueAdapter } from '../types.ts';

const BASE = 'https://mainnet.zklighter.elliot.ai/api/v1';

export const LIGHTER_META: VenueMeta = {
  id: 'lighter',
  label: 'Lighter',
  kind: 'perp-dex',
  chain: 'Ethereum L2 (zk)',
  collateral: 'USDC',
  // Cobra cada hora. La tasa que publica va a 8 h y se pasa a horaria al leerla.
  fundingIntervalHours: 1,
  // `taker_fee` y `maker_fee` de `orderBookDetails` son "0.0000" en los 210
  // mercados activos, comprobado el 17 nov 2026. Es la cuenta estandar; la
  // premium paga, pero esa no es la que tiene quien entra sin mas.
  fees: { makerBps: 0, takerBps: 0, freeClose: false },
  capabilities: { predictedFunding: false, orderBook: false, trading: false, publicPositions: false },
};

/**
 * Lighter. Dos peticiones por ciclo y ninguna clave.
 *
 * `orderBookDetails` trae los 245 mercados (210 activos) con mark, volumen
 * diario en dolares e interes abierto. `funding-rates` trae la tasa vigente.
 *
 * **La tasa esta a 8 horas, no por hora.** Ese endpoint publica tambien las
 * de Binance, Bybit y Hyperliquid, y la de Hyperliquid es exactamente ocho
 * veces la horaria que leemos de su propia API (BTC: 0,0001 contra 0,0000125;
 * SOL y ETH igual). Se divide entre 8. Sin esa comprobacion, el funding de
 * Lighter habria entrado ocho veces mayor en Funding Arb.
 *
 * **El interes abierto en dolares cuenta las dos patas.** `open_interest_usd`
 * suma 769,9 M y `open_interest` por el mark, 385,0 M: el doble clavado. Y
 * DefiLlama, que normaliza a una pata, publica 391 M. Se usa unidades por mark,
 * a una pata, como en Variational (ver `FICHA_DEX`).
 */
export class LighterAdapter implements VenueAdapter {
  readonly meta = LIGHTER_META;
  readonly cost: AdapterCost = { websockets: 0, requestsPerMinute: 2 };
  readonly noPositionsReason = 'not read: positions need an account index lookup';

  #snapshot = new Map<string, MarketSnapshot>();
  #colisiones: string[] = [];

  async refresh(): Promise<void> {
    const [libros, tasas] = await Promise.all([
      getJson(`${BASE}/orderBookDetails`),
      getJson(`${BASE}/funding-rates`),
    ]);
    if (!isRecord(libros) || !Array.isArray(libros['order_book_details'])) {
      throw new Error('orderBookDetails: unexpected shape');
    }
    if (!isRecord(tasas) || !Array.isArray(tasas['funding_rates'])) {
      throw new Error('funding-rates: unexpected shape');
    }

    // Solo las de Lighter: el mismo endpoint trae las de otros exchanges.
    const tasa8h = new Map<number, number>();
    for (const f of tasas['funding_rates']) {
      if (!isRecord(f) || f['exchange'] !== 'lighter') continue;
      const id = num(f['market_id']);
      const r = num(f['rate']);
      if (id !== null && r !== null) tasa8h.set(id, r);
    }

    const next = new Map<string, MarketSnapshot>();
    const colisiones: string[] = [];
    const at = now();

    for (const m of libros['order_book_details']) {
      if (!isRecord(m) || m['status'] !== 'active' || m['market_type'] !== 'perp') continue;
      const nativo = typeof m['symbol'] === 'string' ? m['symbol'] : null;
      const id = num(m['market_id']);
      const mark = num(m['mark_price']);
      if (nativo === null || id === null || mark === null || mark <= 0) continue;
      // Sin tasa no hay fila: un mercado sin funding no se puede cruzar, y un
      // cero inventado pareceria un funding neutro.
      const r8 = tasa8h.get(id);
      if (r8 === undefined) continue;

      const { symbol, contractMultiplier } = normalizeSymbol(nativo);
      const unidades = num(m['open_interest']);

      setSinPisar(next, {
        venue: this.meta.id,
        symbol,
        symbolNative: nativo,
        contractMultiplier,
        mid: mark,
        bid: mark,
        ask: mark,
        funding: {
          rate: r8 / 8,
          intervalHours: this.meta.fundingIntervalHours,
          predicted: null,
          nextFundingAt: null,
          kind: 'current',
          sourceField: 'funding-rates -> rate (8h) / 8',
        },
        book: null,
        openInterestUsd: unidades === null ? null : unidades * mark,
        volume24hUsd: num(m['daily_quote_token_volume']),
        at,
        sourceAt: null,
      }, colisiones);
    }

    if (next.size === 0) throw new Error('orderBookDetails: 0 active perps with funding');
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
