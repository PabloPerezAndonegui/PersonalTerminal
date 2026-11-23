import { postJson, isRecord, num } from '../http.ts';
import { normalizeSymbol } from '../symbols.ts';
import type { OrderBook } from '@defi/core';

/**
 * Todos los mercados de Hyperliquid, tal como los ensena su web.
 *
 * El adaptador de Hyperliquid solo trae los perps del core y los normaliza
 * para cruzarlos con otros venues. El Terminal quiere lo contrario: el
 * catalogo entero y con los nombres de Hyperliquid, para que lo que opera una
 * wallet seguida (`xyz:NVDA`, `@107`) se lea igual que en su pantalla.
 *
 * Tres partes, todas de la API publica `info` (comprobado el 17 nov 2026):
 *
 * - **Perps del core**: `metaAndAssetCtxs`. 235 mercados, 56 retirados que no
 *   se ensenan (`isDelisted`), igual que en su web.
 * - **Perps HIP-3**: `perpDexs` da los dexes (xyz, flx, vntl, hyna, km...) y
 *   `metaAndAssetCtxs` con `dex` los de cada uno. El nombre visible y la
 *   categoria (stocks, indices, commodities...) salen de
 *   `perpConciseAnnotations`: `xyz:SKHX` se ensena como SKHYNIX.
 * - **Spot**: `spotMetaAndAssetCtxs`. El par `@107` es HYPE/USDC; el nombre se
 *   arma con los dos tokens.
 *
 * Coste: una peticion por parte (core, spot y una por dex, hoy 12), de peso 20
 * cada una. Quien llama las cachea; ver el servicio en la API.
 */

const URL_HL = 'https://api.hyperliquid.xyz/info';

export interface MercadoHl {
  /** Lo que entiende la API: `BTC`, `xyz:XYZ100`, `@107`, `PURR/USDC`. */
  readonly coin: string;
  /**
   * El simbolo comun de la app (`NVDA`, `PEPE`, `US500`...), para cruzar con
   * las wallets seguidas y el resto de pantallas. No es unico: el NVDA de xyz
   * y el de io comparten este nombre; `coin` no.
   */
  readonly symbol: string;
  /** Como lo ensena Hyperliquid: `BTC-USDC`, `S&P500-USDC`, `HYPE/USDC`. */
  readonly name: string;
  readonly base: string;
  readonly quote: string;
  readonly kind: 'perp' | 'spot';
  /** Dex HIP-3 (`xyz`), o null en el core y en spot. */
  readonly dex: string | null;
  /** Nombre largo del dex (`XYZ`, `Felix Exchange`). */
  readonly dexName: string | null;
  /** Su categoria: crypto, stocks, indices, commodities, fx, rates, preipo, spot. */
  readonly category: string;
  /** Otras palabras con las que su buscador lo encuentra (`nasdaq`, `qqq`). */
  readonly keywords: readonly string[];
  readonly maxLeverage: number | null;
  readonly szDecimals: number;
  readonly onlyIsolated: boolean;
  readonly mark: number | null;
  readonly mid: number | null;
  /** Precio del oraculo. Solo perps. */
  readonly oracle: number | null;
  readonly prevDayPx: number | null;
  readonly change24hPct: number | null;
  /** Volumen nocional del dia, en la moneda de cotizacion (USDC o similar). */
  readonly volume24hUsd: number | null;
  /** Interes abierto por el mark, como lo da su web. Solo perps. */
  readonly openInterestUsd: number | null;
  /** Funding por hora, que es como liquida Hyperliquid. Solo perps. */
  readonly fundingHourly: number | null;
}

export interface CatalogoHl {
  readonly mercados: readonly MercadoHl[];
  /** Dexes HIP-3 que no respondieron: su ausencia se dice, no se calla. */
  readonly dexesFallidos: readonly string[];
}

const pedir = (body: unknown) => postJson(URL_HL, body, { timeoutMs: 12_000, retries: 1 });

interface Anotacion { readonly category: string; readonly displayName: string | null; readonly keywords: readonly string[] }

/** `perpConciseAnnotations`: coin -> categoria, nombre visible y palabras. */
export async function fetchAnotacionesHl(): Promise<Map<string, Anotacion>> {
  const raw = await pedir({ type: 'perpConciseAnnotations' });
  const out = new Map<string, Anotacion>();
  if (!Array.isArray(raw)) return out;
  for (const fila of raw) {
    if (!Array.isArray(fila) || typeof fila[0] !== 'string' || !isRecord(fila[1])) continue;
    const a = fila[1];
    out.set(fila[0], {
      // Su lista mezcla `FX` y `fx`, `stock` y `stocks`.
      category: typeof a['category'] === 'string' ? a['category'].toLowerCase().replace(/^stock$/, 'stocks') : 'crypto',
      displayName: typeof a['displayName'] === 'string' ? a['displayName'] : null,
      keywords: Array.isArray(a['keywords']) ? a['keywords'].filter((k): k is string => typeof k === 'string') : [],
    });
  }
  return out;
}

/**
 * Los dexes HIP-3 que tienen algun mercado vivo.
 *
 * `perpDexs` los da todos (10 el 17 nov 2026), pero seis solo tienen mercados
 * retirados. `allPerpMetas` trae el universo de cada uno en el mismo orden
 * (la entrada 0 es el core) en una sola peticion, y con el se descartan los
 * vacios: el catalogo pasa de 12 peticiones a 6, y las posiciones de cada
 * wallet de 11 a 5.
 */
export async function fetchDexesHl(): Promise<{ name: string; fullName: string | null }[]> {
  const [raw, metas] = await Promise.all([pedir({ type: 'perpDexs' }), pedir({ type: 'allPerpMetas' })]);
  if (!Array.isArray(raw)) throw new Error('perpDexs: unexpected shape');
  const vivos = (i: number): boolean | null => {
    if (!Array.isArray(metas)) return null;
    const m = metas[i];
    if (!isRecord(m) || !Array.isArray(m['universe'])) return null;
    return m['universe'].some((u) => isRecord(u) && u['isDelisted'] !== true);
  };
  const out: { name: string; fullName: string | null }[] = [];
  raw.forEach((d, i) => {
    if (!isRecord(d) || typeof d['name'] !== 'string' || d['name'] === '') return;
    // Si `allPerpMetas` no cuadra, se pregunta a todos: mejor una peticion de
    // mas que un dex que desaparece.
    if (vivos(i) === false) return;
    out.push({ name: d['name'], fullName: typeof d['fullName'] === 'string' ? d['fullName'] : null });
  });
  return out;
}

const cambio = (mark: number | null, previo: number | null) =>
  mark === null || previo === null || previo <= 0 ? null : ((mark - previo) / previo) * 100;

/** Perps de un dex (o del core, con `dex` null). */
function perpsDe(
  raw: unknown,
  dex: { name: string; fullName: string | null } | null,
  tokens: ReadonlyMap<number, string>,
  anotaciones: ReadonlyMap<string, Anotacion>,
): MercadoHl[] {
  if (!Array.isArray(raw) || !isRecord(raw[0]) || !Array.isArray(raw[0]['universe']) || !Array.isArray(raw[1])) {
    throw new Error(`metaAndAssetCtxs${dex === null ? '' : ` ${dex.name}`}: unexpected shape`);
  }
  const meta = raw[0];
  const universo = meta['universe'] as unknown[];
  const ctxs = raw[1] as unknown[];
  // La moneda en que liquida el dex: USDC en el core y en casi todos.
  const quote = tokens.get(num(meta['collateralToken']) ?? 0) ?? 'USDC';
  const out: MercadoHl[] = [];
  universo.forEach((u, i) => {
    const c = ctxs[i];
    if (!isRecord(u) || !isRecord(c) || typeof u['name'] !== 'string') return;
    if (u['isDelisted'] === true) return;
    const coin = u['name'];
    const nota = anotaciones.get(coin);
    const base = nota?.displayName ?? coin.replace(/^[^:]+:/, '');
    const mark = num(c['markPx']);
    const oi = num(c['openInterest']);
    const prev = num(c['prevDayPx']);
    out.push({
      coin,
      symbol: normalizeSymbol(coin).symbol,
      name: `${base}-${quote}`,
      base,
      quote,
      kind: 'perp',
      dex: dex?.name ?? null,
      dexName: dex?.fullName ?? null,
      category: nota?.category ?? 'crypto',
      keywords: nota?.keywords ?? [],
      maxLeverage: num(u['maxLeverage']),
      szDecimals: num(u['szDecimals']) ?? 0,
      onlyIsolated: u['onlyIsolated'] === true || u['marginMode'] === 'strictIsolated',
      mark,
      mid: num(c['midPx']),
      oracle: num(c['oraclePx']),
      prevDayPx: prev,
      change24hPct: cambio(mark, prev),
      volume24hUsd: num(c['dayNtlVlm']),
      openInterestUsd: oi === null || mark === null ? null : oi * mark,
      fundingHourly: num(c['funding']),
    });
  });
  return out;
}

function spotDe(raw: unknown): { mercados: MercadoHl[]; tokens: Map<number, string> } {
  if (!Array.isArray(raw) || !isRecord(raw[0]) || !Array.isArray(raw[1])) throw new Error('spotMetaAndAssetCtxs: unexpected shape');
  const meta = raw[0];
  const tokens = new Map<number, string>();
  for (const t of Array.isArray(meta['tokens']) ? meta['tokens'] : []) {
    if (isRecord(t) && typeof t['name'] === 'string') {
      const i = num(t['index']);
      if (i !== null) tokens.set(i, t['name']);
    }
  }
  const ctxPorCoin = new Map<string, Record<string, unknown>>();
  for (const c of raw[1]) if (isRecord(c) && typeof c['coin'] === 'string') ctxPorCoin.set(c['coin'], c);

  const mercados: MercadoHl[] = [];
  for (const u of Array.isArray(meta['universe']) ? meta['universe'] : []) {
    if (!isRecord(u) || typeof u['name'] !== 'string' || !Array.isArray(u['tokens'])) continue;
    const base = tokens.get(num(u['tokens'][0]) ?? -1);
    const quote = tokens.get(num(u['tokens'][1]) ?? -1);
    const c = ctxPorCoin.get(u['name']);
    if (base === undefined || quote === undefined || c === undefined) continue;
    const mark = num(c['markPx']);
    // Pares sin precio: listados pero muertos. Su web tampoco los ensena.
    if (mark === null || mark <= 0) continue;
    const prev = num(c['prevDayPx']);
    mercados.push({
      coin: u['name'],
      symbol: normalizeSymbol(base).symbol,
      name: `${base}/${quote}`,
      base,
      quote,
      kind: 'spot',
      dex: null,
      dexName: null,
      category: 'spot',
      keywords: [],
      maxLeverage: null,
      szDecimals: 0,
      onlyIsolated: false,
      mark,
      mid: num(c['midPx']),
      oracle: null,
      prevDayPx: prev,
      change24hPct: cambio(mark, prev),
      volume24hUsd: num(c['dayNtlVlm']),
      openInterestUsd: null,
      fundingHourly: null,
    });
  }
  return { mercados, tokens };
}

/**
 * El catalogo completo. Los dexes y las anotaciones cambian poco y se pasan
 * ya leidos; aqui solo van las peticiones con precios.
 */
export async function fetchCatalogoHl(
  dexes: readonly { name: string; fullName: string | null }[],
  anotaciones: ReadonlyMap<string, Anotacion>,
): Promise<CatalogoHl> {
  const [core, spotRaw, ...porDex] = await Promise.allSettled([
    pedir({ type: 'metaAndAssetCtxs' }),
    pedir({ type: 'spotMetaAndAssetCtxs' }),
    ...dexes.map((d) => pedir({ type: 'metaAndAssetCtxs', dex: d.name })),
  ]);
  // Sin el core no hay terminal: eso si es un fallo de todo.
  if (core?.status !== 'fulfilled') throw core?.reason instanceof Error ? core.reason : new Error('metaAndAssetCtxs failed');
  const spot = spotRaw?.status === 'fulfilled' ? spotDe(spotRaw.value) : { mercados: [], tokens: new Map<number, string>() };
  const tokens = spot.tokens.size > 0 ? spot.tokens : new Map([[0, 'USDC']]);

  const mercados: MercadoHl[] = [...perpsDe(core.value, null, tokens, anotaciones)];
  const dexesFallidos: string[] = [];
  porDex.forEach((r, i) => {
    const dex = dexes[i];
    if (dex === undefined) return;
    if (r.status !== 'fulfilled') { dexesFallidos.push(dex.name); return; }
    try {
      mercados.push(...perpsDe(r.value, dex, tokens, anotaciones));
    } catch {
      dexesFallidos.push(dex.name);
    }
  });
  if (spotRaw?.status !== 'fulfilled') dexesFallidos.push('spot');
  mercados.push(...spot.mercados);
  return { mercados, dexesFallidos };
}

/** Libro L2 de cualquier mercado, por su `coin`. Peso 2. */
export async function fetchLibroHl(coin: string): Promise<OrderBook | null> {
  const raw = await pedir({ type: 'l2Book', coin });
  if (!isRecord(raw) || !Array.isArray(raw['levels'])) return null;
  const lado = (x: unknown) => (Array.isArray(x) ? x : [])
    .filter(isRecord)
    .map((n) => ({ price: num(n['px']), size: num(n['sz']) }))
    .filter((n): n is { price: number; size: number } => n.price !== null && n.size !== null && n.size > 0);
  return { bids: lado(raw['levels'][0]), asks: lado(raw['levels'][1]) };
}

export interface TradeHl {
  readonly ts: number;
  readonly side: 'buy' | 'sell';
  readonly px: number;
  readonly sz: number;
  readonly tid: string;
}

/** Ultimas operaciones de un mercado, la cinta de su web. */
export async function fetchTradesHl(coin: string): Promise<TradeHl[]> {
  const raw = await pedir({ type: 'recentTrades', coin });
  if (!Array.isArray(raw)) return [];
  const out: TradeHl[] = [];
  for (const t of raw) {
    if (!isRecord(t)) continue;
    const ts = num(t['time']);
    const px = num(t['px']);
    const sz = num(t['sz']);
    if (ts === null || px === null || sz === null) continue;
    // `B` es que el agresor compro; `A`, que vendio.
    out.push({ ts, side: t['side'] === 'B' ? 'buy' : 'sell', px, sz, tid: String(t['tid'] ?? `${ts}-${px}`) });
  }
  return out.sort((a, b) => b.ts - a.ts);
}
