import type { AccountSnapshot, MarketSnapshot, OrderBook, Position, VenueMeta } from '@defi/core';
import { now } from '@defi/core';
import { isRecord, num, postJson } from '../http.ts';
import { normalizeSymbol } from '../symbols.ts';
import { fetchDexesHl } from '../sources/hyperliquidMercados.ts';
import { mapToUnitPrices, scaleBookToUnits, setSinPisar } from '../normalize.ts';
import type { AdapterCost, VenueAdapter } from '../types.ts';

const API = 'https://api.hyperliquid.xyz/info';

export const HYPERLIQUID_META: VenueMeta = {
  id: 'hyperliquid',
  label: 'Hyperliquid',
  kind: 'perp-dex',
  chain: 'Hyperliquid L1',
  collateral: 'USDC',
  // Liquida funding cada hora, y el campo `funding` ya viene en tasa horaria.
  fundingIntervalHours: 1,
  fees: {
    // Tarifa del primer tramo. Hyperliquid escala por volumen de 14 dias, asi
    // que la seccion 2 aplicara el tramo real del usuario sobre estos valores.
    makerBps: 1.5,
    takerBps: 4.5,
    freeClose: false,
  },
  capabilities: {
    // El endpoint agregado no publica la tasa prevista, solo la vigente.
    predictedFunding: false,
    // Hay libro, pero por simbolo: se pide bajo demanda con fetchBook().
    orderBook: true,
    trading: true,
    publicPositions: true,
  },
};

/**
 * Adaptador de Hyperliquid.
 *
 * `metaAndAssetCtxs` devuelve los ~233 perpetuos en UNA sola peticion, con
 * funding, precios, interes abierto y volumen. Es el caso ideal para la Pi:
 * cobertura completa a coste constante.
 */
export class HyperliquidAdapter implements VenueAdapter {
  readonly meta = HYPERLIQUID_META;
  readonly cost: AdapterCost = { websockets: 0, requestsPerMinute: 4 };
  readonly addressKinds = ['evm'] as const;

  #snapshot = new Map<string, MarketSnapshot>();
  #colisiones: string[] = [];
  /** symbol normalizado -> nombre nativo, para pedir el libro despues. */
  #native = new Map<string, string>();

  async refresh(): Promise<void> {
    const raw = await postJson(API, { type: 'metaAndAssetCtxs' });
    if (!Array.isArray(raw) || raw.length < 2) {
      throw new Error('metaAndAssetCtxs: unexpected shape');
    }
    const [metaRaw, ctxsRaw] = raw;
    if (!isRecord(metaRaw) || !Array.isArray(metaRaw['universe']) || !Array.isArray(ctxsRaw)) {
      throw new Error('metaAndAssetCtxs: universe o contexts ausentes');
    }
    const universe = metaRaw['universe'];

    const next = new Map<string, MarketSnapshot>();
    const colisiones: string[] = [];
    const at = now();

    for (let i = 0; i < universe.length; i++) {
      const asset = universe[i];
      const ctx = ctxsRaw[i];
      if (!isRecord(asset) || !isRecord(ctx)) continue;
      if (asset['isDelisted'] === true) continue;

      const nativeName = asset['name'];
      if (typeof nativeName !== 'string' || nativeName === '') continue;

      const mid = num(ctx['midPx']);
      const mark = num(ctx['markPx']);
      const funding = num(ctx['funding']);
      // Sin precio o sin funding el simbolo no sirve para nada aguas abajo:
      // se descarta en vez de participar con un hueco.
      if (mid === null || funding === null) continue;

      // impactPxs son los precios de impacto que usa el propio venue para el
      // oraculo: aproximan bid/ask mejor que el mid, pero NO son top of book.
      // El coste real de ejecucion se calcula con fetchBook().
      const impact = ctx['impactPxs'];
      const impactBid = Array.isArray(impact) ? num(impact[0]) : null;
      const impactAsk = Array.isArray(impact) ? num(impact[1]) : null;

      const oi = num(ctx['openInterest']);
      const { symbol, contractMultiplier } = normalizeSymbol(nativeName);

      setSinPisar(next, {
        venue: this.meta.id,
        symbol,
        symbolNative: nativeName,
        contractMultiplier,
        mid,
        bid: impactBid ?? mid,
        ask: impactAsk ?? mid,
        funding: {
          rate: funding,
          intervalHours: this.meta.fundingIntervalHours,
          predicted: null,
          nextFundingAt: nextHourBoundary(at),
          // `funding` del assetCtx es la tasa VIGENTE de la hora en curso, no
          // la ya liquidada: puede moverse hasta que se cobre.
          kind: 'current',
          sourceField: 'info:metaAndAssetCtxs -> assetCtx.funding',
        },
        book: null,
        // openInterest viene en unidades del subyacente, no en USD.
        openInterestUsd: oi !== null && mark !== null ? oi * mark : null,
        volume24hUsd: num(ctx['dayNtlVlm']),
        prevDayPrice: num(ctx['prevDayPx']),
        at,
        // El assetCtx de Hyperliquid no trae ningun sello de tiempo.
        sourceAt: null,
      }, colisiones);
    }

    if (next.size === 0) throw new Error('metaAndAssetCtxs: 0 valid symbols');

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

  fetchPositions(address: string): Promise<AccountSnapshot | null> {
    return posicionesHyperliquid(address, dexesConMercados);
  }

  async fetchBook(symbol: string): Promise<OrderBook | null> {
    const nativeName = this.#native.get(symbol);
    if (nativeName === undefined) return null;

    const raw = await postJson(API, { type: 'l2Book', coin: nativeName });
    if (!isRecord(raw) || !Array.isArray(raw['levels'])) return null;
    const [bidsRaw, asksRaw] = raw['levels'];

    const side = (levels: unknown) => {
      if (!Array.isArray(levels)) return [];
      const out: { price: number; size: number }[] = [];
      for (const lvl of levels) {
        if (!isRecord(lvl)) continue;
        const price = num(lvl['px']);
        const size = num(lvl['sz']);
        if (price === null || size === null || size <= 0) continue;
        out.push({ price, size });
      }
      return out;
    };

    return scaleBookToUnits({ bids: side(bidsRaw), asks: side(asksRaw) }, this.#snapshot.get(symbol)?.contractMultiplier ?? 1);
  }
}

/**
 * Posiciones de una direccion publica.
 *
 * `clearinghouseState` devuelve el estado completo de la cuenta sin ninguna
 * credencial: es informacion on-chain que cualquiera puede consultar. No hay
 * ninguna clave involucrada.
 */
/**
 * Los dexes HIP-3 con mercados vivos, cacheados una hora: cambian poco y cada
 * wallet los necesita en cada lectura.
 */
let dexesCache: { at: number; v: string[] } | null = null;
async function dexesConMercados(): Promise<string[]> {
  if (dexesCache !== null && now() - dexesCache.at < 3_600_000) return dexesCache.v;
  try {
    dexesCache = { at: now(), v: (await fetchDexesHl()).map((d) => d.name) };
  } catch {
    // Sin la lista se sigue con la ultima; sin ninguna, solo el core. Que
    // falte la lista no puede tumbar las posiciones del core.
    if (dexesCache === null) return [];
  }
  return dexesCache.v;
}

/**
 * Posiciones de una direccion: las del core y las de cada dex HIP-3.
 *
 * `clearinghouseState` sin `dex` SOLO devuelve el core. Hasta el 17 nov 2026
 * se pedia asi, y una wallet con NVDA en xyz o con el S&P 500 salia sin esas
 * posiciones. Cada dex tiene su propio margen, asi que se pide uno a uno (peso
 * 2 cada uno) y el valor de la cuenta es la suma.
 *
 * Si falla uno, falla la lectura entera: devolver las demas haria que las de
 * ese dex pareciesen cerradas, y eso dispara avisos de cierre que no son.
 */
async function posicionesHyperliquid(address: string, dexes: () => Promise<string[]>): Promise<AccountSnapshot | null> {
  const lista = await dexes();
  const respuestas = await Promise.all([
    postJson(API, { type: 'clearinghouseState', user: address }),
    ...lista.map((dex) => postJson(API, { type: 'clearinghouseState', user: address, dex })),
  ]);
  const raw = respuestas[0];
  if (!isRecord(raw)) return null;

  const resumen = isRecord(raw['marginSummary']) ? raw['marginSummary'] : null;
  const posiciones: Position[] = [];
  let equity = resumen === null ? null : num(resumen['accountValue']);
  let margen = resumen === null ? null : num(resumen['totalMarginUsed']);

  for (const r of respuestas) {
    if (!isRecord(r)) continue;
    if (r !== raw) {
      const res = isRecord(r['marginSummary']) ? r['marginSummary'] : null;
      const v = res === null ? null : num(res['accountValue']);
      const m = res === null ? null : num(res['totalMarginUsed']);
      if (equity !== null && v !== null) equity += v;
      if (margen !== null && m !== null) margen += m;
    }
    posiciones.push(...posicionesDe(r));
  }

  return {
    venue: HYPERLIQUID_META.id,
    address,
    equityUsd: equity,
    marginUsedUsd: margen,
    positions: posiciones,
    at: now(),
  };
}

/** Las posiciones abiertas de una respuesta de `clearinghouseState`. */
function posicionesDe(raw: Record<string, unknown>): Position[] {
  const posiciones: Position[] = [];
  if (Array.isArray(raw['assetPositions'])) {
    for (const entrada of raw['assetPositions']) {
      if (!isRecord(entrada) || !isRecord(entrada['position'])) continue;
      const p = entrada['position'];

      const nativeName = p['coin'];
      if (typeof nativeName !== 'string') continue;

      // `szi` es el tamano CON SIGNO: negativo es corto. Es la unica fuente de
      // la direccion, no hay un campo aparte que la diga.
      const szi = num(p['szi']);
      if (szi === null || szi === 0) continue;

      const { symbol, contractMultiplier } = normalizeSymbol(nativeName);
      const entry = num(p['entryPx']);
      const notional = num(p['positionValue']);
      const apalancamiento = isRecord(p['leverage']) ? num(p['leverage']['value']) : null;

      posiciones.push({
        venue: HYPERLIQUID_META.id,
        symbol,
        symbolNative: nativeName,
        side: szi > 0 ? 'long' : 'short',
        // El tamano se lleva a unidades del activo normalizado, igual que los
        // precios: si no, un kPEPE saldria mil veces mas pequeno de lo que es.
        sizeBase: Math.abs(szi) * contractMultiplier,
        notionalUsd: notional ?? 0,
        entryPrice: entry === null ? null : entry / contractMultiplier,
        markPrice: null,
        unrealizedPnlUsd: num(p['unrealizedPnl']),
        leverage: apalancamiento,
        liquidationPrice: (() => {
          const l = num(p['liquidationPx']);
          return l === null ? null : l / contractMultiplier;
        })(),
      });
    }
  }
  return posiciones;
}

/** Hyperliquid cobra funding en punto de hora. */
function nextHourBoundary(at: number): number {
  const HOUR_MS = 3_600_000;
  return Math.floor(at / HOUR_MS) * HOUR_MS + HOUR_MS;
}
