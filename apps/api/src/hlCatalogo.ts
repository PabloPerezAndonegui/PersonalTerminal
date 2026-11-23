import {
  fetchCatalogoHl, fetchAnotacionesHl, fetchDexesHl, fetchTradesHl,
  type MercadoHl, type TradeHl,
} from '@defi/venues';

/**
 * El catalogo de Hyperliquid para el Terminal, con su cache.
 *
 * Se pide SOLO cuando alguien mira el Terminal, nunca en el ciclo de
 * recogida. Con el Terminal abierto cuesta una vuelta cada 90 s: core, spot y
 * un dex HIP-3 por peticion (12 hoy, peso 20 cada una), unas 160 unidades de
 * peso por minuto de las 1.200 que Hyperliquid da por IP. Los dexes y las
 * anotaciones (nombres y categorias) cambian poco y van aparte, cada hora.
 *
 * Dos pantallas abiertas no son dos vueltas: la peticion en curso se comparte.
 */

const TTL_CATALOGO_MS = 90_000;
const TTL_META_MS = 3_600_000;
const TTL_TRADES_MS = 5_000;

type Dex = { name: string; fullName: string | null };
type Anotaciones = Awaited<ReturnType<typeof fetchAnotacionesHl>>;

export interface CatalogoServido {
  readonly at: number;
  readonly mercados: readonly MercadoHl[];
  readonly fallidos: readonly string[];
}

export class CatalogoHyperliquid {
  #catalogo: CatalogoServido | null = null;
  #enCurso: Promise<CatalogoServido> | null = null;
  #dexes: { at: number; v: Dex[] } | null = null;
  #anotaciones: { at: number; v: Anotaciones } | null = null;
  readonly #trades = new Map<string, { at: number; v: TradeHl[] }>();
  readonly #clock: () => number;

  constructor(clock: () => number = Date.now) {
    this.#clock = clock;
  }

  async get(): Promise<CatalogoServido> {
    const ahora = this.#clock();
    if (this.#catalogo !== null && ahora - this.#catalogo.at < TTL_CATALOGO_MS) return this.#catalogo;
    if (this.#enCurso !== null) return this.#enCurso;
    this.#enCurso = this.#cargar().finally(() => { this.#enCurso = null; });
    return this.#enCurso;
  }

  async #cargar(): Promise<CatalogoServido> {
    const ahora = this.#clock();
    // Si los dexes o las anotaciones fallan, se sigue con lo ultimo que hubo;
    // sin anotaciones los HIP-3 salen con su nombre de API, no desaparecen.
    if (this.#dexes === null || ahora - this.#dexes.at > TTL_META_MS) {
      try { this.#dexes = { at: ahora, v: await fetchDexesHl() }; } catch { /* se queda lo anterior */ }
    }
    if (this.#anotaciones === null || ahora - this.#anotaciones.at > TTL_META_MS) {
      try { this.#anotaciones = { at: ahora, v: await fetchAnotacionesHl() }; } catch { /* idem */ }
    }
    const r = await fetchCatalogoHl(this.#dexes?.v ?? [], this.#anotaciones?.v ?? new Map());
    this.#catalogo = { at: this.#clock(), mercados: r.mercados, fallidos: r.dexesFallidos };
    return this.#catalogo;
  }

  /** Si `coin` es un mercado que existe. Ninguna peticion sale con otro. */
  async existe(coin: string): Promise<MercadoHl | null> {
    const c = await this.get();
    return c.mercados.find((m) => m.coin === coin) ?? null;
  }

  async trades(coin: string): Promise<{ at: number; trades: TradeHl[] }> {
    const ahora = this.#clock();
    const hit = this.#trades.get(coin);
    if (hit !== undefined && ahora - hit.at < TTL_TRADES_MS) return { at: hit.at, trades: hit.v };
    const v = await fetchTradesHl(coin);
    // Como mucho unos pocos mercados mirados a la vez: se limpia lo viejo.
    for (const [k, e] of this.#trades) if (ahora - e.at > 60_000) this.#trades.delete(k);
    this.#trades.set(coin, { at: ahora, v });
    return { at: ahora, trades: v };
  }
}
