import type { MarketSnapshot, VenueMeta } from '@defi/core';
import { now } from '@defi/core';
import { postJson, isRecord, num } from '../http.ts';
import { normalizeSymbol } from '../symbols.ts';
import { mapToUnitPrices, setSinPisar } from '../normalize.ts';
import type { AdapterCost, VenueAdapter } from '../types.ts';

const API = 'https://api.hyperliquid.xyz/info';

/** El nombre corto con el que Hyperliquid identifica a este perp desplegado. */
const DEX = 'io';

export const ENTROPY_META: VenueMeta = {
  id: 'entropy',
  label: 'entropy.io',
  kind: 'perp-dex',
  chain: 'Hyperliquid L1',
  collateral: 'USDC',
  fundingIntervalHours: 1,
  // Hereda la mecanica de Hyperliquid, pero sus comisiones las fija quien lo
  // despliega y no se publican en esta respuesta.
  fees: { makerBps: null, takerBps: null, freeClose: false },
  capabilities: { predictedFunding: false, orderBook: false, trading: false, publicPositions: false },
};

/**
 * entropy.io, uno de los perps desplegados sobre Hyperliquid (HIP-3).
 *
 * **Como se encontro.** Hyperliquid declara once perp DEX en `perpDexs`, y
 * `metaAndAssetCtxs` sin parametros solo devuelve el principal. Pidiendolo con
 * `dex: "io"` salen sus 10 mercados con 54 M de interes abierto, que es
 * exactamente lo que DefiLlama publica para entropy.io. Ese cuadre es lo que
 * identifica al dex `io` como este venue.
 *
 * La respuesta tiene la misma forma que la de Hyperliquid, asi que el funding
 * es por hora y en decimal, y `openInterest` va en unidades del subyacente.
 *
 * Que comparta motor con Hyperliquid **no lo hace el mismo venue**: tiene su
 * propio libro, su propio funding y sus propias comisiones, asi que en la
 * matriz es una columna aparte y puede cruzarse contra Hyperliquid.
 */
export class EntropyAdapter implements VenueAdapter {
  readonly meta = ENTROPY_META;
  readonly cost: AdapterCost = { websockets: 0, requestsPerMinute: 2 };
  readonly noPositionsReason = 'positions are read from the main Hyperliquid venue';

  #snapshot = new Map<string, MarketSnapshot>();
  #colisiones: string[] = [];

  async refresh(): Promise<void> {
    const raw = await postJson(API, { type: 'metaAndAssetCtxs', dex: DEX });
    if (!Array.isArray(raw) || raw.length < 2) {
      throw new Error(`metaAndAssetCtxs(${DEX}): unexpected shape`);
    }
    const [metaRaw, ctxsRaw] = raw;
    if (!isRecord(metaRaw) || !Array.isArray(metaRaw['universe']) || !Array.isArray(ctxsRaw)) {
      throw new Error(`metaAndAssetCtxs(${DEX}): universe o contexts ausentes`);
    }

    const next = new Map<string, MarketSnapshot>();
    const colisiones: string[] = [];
    const at = now();

    for (let i = 0; i < metaRaw['universe'].length; i++) {
      const asset = metaRaw['universe'][i];
      const ctx = ctxsRaw[i];
      if (!isRecord(asset) || !isRecord(ctx)) continue;
      if (asset['isDelisted'] === true) continue;

      const nativeName = asset['name'];
      if (typeof nativeName !== 'string' || nativeName === '') continue;

      const mid = num(ctx['midPx']);
      const mark = num(ctx['markPx']);
      const funding = num(ctx['funding']);
      if (mid === null || funding === null) continue;

      const oi = num(ctx['openInterest']);
      const { symbol, contractMultiplier } = normalizeSymbol(nativeName);
      const precio = mark ?? mid;

      setSinPisar(next, {
        venue: this.meta.id,
        symbol,
        symbolNative: nativeName,
        contractMultiplier,
        mid,
        bid: mid,
        ask: mid,
        funding: {
          rate: funding,
          intervalHours: this.meta.fundingIntervalHours,
          predicted: null,
          nextFundingAt: null,
          kind: 'current',
          sourceField: `metaAndAssetCtxs(dex=${DEX}) -> funding (hourly decimal)`,
        },
        book: null,
        // `openInterest` va en unidades del subyacente, no en dolares.
        openInterestUsd: oi === null || precio === null ? null : oi * precio,
        volume24hUsd: num(ctx['dayNtlVlm']),
        at,
        sourceAt: null,
      }, colisiones);
    }

    if (next.size === 0) throw new Error(`metaAndAssetCtxs(${DEX}): 0 markets`);
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
