import type { MarketSnapshot, VenueMeta } from '@defi/core';
import { toHourly, precioDeReferencia, type ClaseActivo } from '@defi/core';
import { enlaceOficial } from '@defi/venues';

/**
 * Escaner de paridad: donde cotiza mas barato y mas caro cada activo AHORA.
 *
 * Lo que hace que esta lista no se llene de basura, que es lo que pasa si se
 * ordena sin mas por diferencia de precio:
 *
 * - **Ticker que es otro activo, fuera.** El mismo agrupamiento por precio que
 *   Open Interest y DEX Volume (1,5x). Sin el, CAT Caterpillar contra CAT
 *   memecoin seria una "diferencia" de cuatro millones por ciento.
 * - **Una fila por simbolo Y clase**, por lo mismo.
 * - **Precio viejo, fuera.** Un venue que dejo de responder conserva su ultimo
 *   precio, y contra el mercado en marcha parece un desajuste.
 * - **Sin volumen, fuera.** Por defecto cada pata tiene que mover algo al dia;
 *   un mercado muerto tiene el precio que sea y no se puede ejecutar.
 *
 * Usa el mid, no bid/ask: no incluye spread ni slippage. La pantalla lo marca
 * como estimado.
 */

export interface PataParidad {
  readonly venue: string;
  readonly mid: number;
  /**
   * Mejor precio de compra y de venta, si el venue los publica. Solo seis lo
   * hacen en su respuesta normal (Extended, Paradex, Perpl, QFEX, Variational
   * y el precio de impacto de Hyperliquid); el resto da el mark, que no es un
   * precio al que se pueda comprar. null cuando no hay cotizacion real.
   */
  readonly bid: number | null;
  readonly ask: number | null;
  readonly volume24hUsd: number | null;
  /** Funding por hora, en decimal. */
  readonly fundingHourly: number;
  /** Web oficial del venue, para ir a operar. null si no hay una comprobada. */
  readonly url: string | null;
  /** Comision taker de esta pata, en bps: la del usuario si la dio, si no la publicada. */
  readonly feeBps?: number | null;
}

export interface FilaParidad {
  readonly symbol: string;
  readonly assetClass: ClaseActivo;
  /** Venues que pasan los filtros para este simbolo. */
  readonly venues: number;
  /** Donde comprar (el mas barato) y donde vender (el mas caro). */
  readonly cheap: PataParidad;
  readonly rich: PataParidad;
  /** Cuanto mas caro esta `rich` que `cheap`, en %. */
  readonly gapPct: number;
  /** Comisiones taker de abrir y cerrar las dos patas, en %. null si falta alguna. */
  readonly feesPct: number | null;
  /**
   * Spread de las dos patas sumado, en %: se paga medio al entrar y medio al
   * salir en cada una. null si alguna pata no cotiza bid/ask.
   */
  readonly spreadPct: number | null;
  /**
   * Lo que queda si la diferencia vuelve a cero, en %: bruto menos comisiones
   * y menos spread. null si faltan las comisiones de alguna pata. Si falta el
   * spread de alguna, el neto se da sin el y `netIncludesSpread` es false.
   */
  readonly netAtZeroPct: number | null;
  readonly netIncludesSpread: boolean;
  /**
   * Funding de mantener la posicion un dia, en % del nocional: corto en el
   * caro (cobra su funding si es positivo) y largo en el barato (lo paga).
   * Positivo es a favor.
   */
  readonly carryPctPerDay: number;
}

export interface OpcionesParidad {
  readonly ahora: number;
  /** Volumen 24 h minimo de CADA pata. 0 acepta venues sin volumen publicado. */
  readonly minVolumeUsd: number;
  /** Antiguedad maxima del precio. */
  readonly maxAgeMs: number;
  readonly clase: ClaseActivo | null;
  /** Filtro de simbolo, contenido en el nombre. Vacio = todos. */
  readonly q: string;
  /** Solo venues de este tipo (las DOS patas). null = todos. */
  readonly tipoVenue?: 'dex' | 'cex' | null;
  /**
   * Comision taker de quien mira, por venue y en bps. Manda sobre la del
   * registro: la comision real depende del nivel y de los referidos, y ocho
   * venues no la publican.
   */
  readonly misComisionesBps?: ReadonlyMap<string, number>;
  /** Orden: por diferencia bruta o por lo que queda despues de costes. */
  readonly orden?: 'gap' | 'net';
}

const DESAJUSTE_TICKER = 1.5;

/**
 * Comision de abrir y cerrar una pata, en % del nocional. La que da quien mira
 * manda sobre la del registro.
 */
export function comisionPataPct(meta: VenueMeta | undefined, propiaBps?: number): number | null {
  const bps = propiaBps ?? meta?.fees.takerBps ?? null;
  if (bps === null) return null;
  return bps / 100 + (propiaBps === undefined && meta?.fees.freeClose === true ? 0 : bps / 100);
}

/** Spread de una pata en %, o null si no cotiza bid/ask de verdad. */
function spreadDe(p: PataParidad): number | null {
  if (p.bid === null || p.ask === null) return null;
  return ((p.ask - p.bid) / ((p.ask + p.bid) / 2)) * 100;
}

export function escanearParidad(
  snapshots: ReadonlyMap<string, ReadonlyMap<string, MarketSnapshot>>,
  metas: ReadonlyMap<string, VenueMeta>,
  clases: ReadonlyMap<string, ReadonlyMap<string, ClaseActivo>>,
  o: OpcionesParidad,
): FilaParidad[] {
  const grupos = new Map<string, { symbol: string; clase: ClaseActivo; patas: PataParidad[] }>();
  for (const [venue, porSimbolo] of snapshots) {
    if (o.tipoVenue != null) {
      const esCex = metas.get(venue)?.kind === 'perp-cex';
      if ((o.tipoVenue === 'cex') !== esCex) continue;
    }
    for (const s of porSimbolo.values()) {
      if (!Number.isFinite(s.mid) || s.mid <= 0) continue;
      if (o.ahora - s.at > o.maxAgeMs) continue;
      if (o.minVolumeUsd > 0 && (s.volume24hUsd === null || s.volume24hUsd < o.minVolumeUsd)) continue;
      if (o.q !== '' && !s.symbol.includes(o.q)) continue;
      const clase = clases.get(venue)?.get(s.symbol) ?? 'crypto';
      if (o.clase !== null && clase !== o.clase) continue;
      const clave = `${s.symbol}|${clase}`;
      const g = grupos.get(clave) ?? { symbol: s.symbol, clase, patas: [] };
      // Cotizacion real solo si el venue da dos precios distintos y en orden:
      // los que copian el mark en bid y ask no tienen spread que medir.
      const cotiza = Number.isFinite(s.bid) && Number.isFinite(s.ask) && s.bid > 0 && s.ask > s.bid;
      g.patas.push({
        venue, mid: s.mid,
        bid: cotiza ? s.bid : null, ask: cotiza ? s.ask : null,
        volume24hUsd: s.volume24hUsd, fundingHourly: toHourly(s.funding),
        url: enlaceOficial(venue),
      });
      grupos.set(clave, g);
    }
  }

  const filas: FilaParidad[] = [];
  for (const g of grupos.values()) {
    if (g.patas.length < 2) continue;
    // Sin mayoria clara no se sabe cual es el activo: la fila no sale.
    const ref = precioDeReferencia(g.patas.map((p) => p.mid), DESAJUSTE_TICKER);
    if (ref === null) continue;
    const mismas = g.patas.filter((p) => {
      const f = p.mid / ref.precio;
      return f <= DESAJUSTE_TICKER && f >= 1 / DESAJUSTE_TICKER;
    });
    if (mismas.length < 2) continue;

    let cheap = mismas[0];
    let rich = mismas[0];
    for (const p of mismas) {
      if (cheap === undefined || p.mid < cheap.mid) cheap = p;
      if (rich === undefined || p.mid > rich.mid) rich = p;
    }
    if (cheap === undefined || rich === undefined || cheap.venue === rich.venue) continue;

    const gapPct = ((rich.mid - cheap.mid) / cheap.mid) * 100;
    const fc = comisionPataPct(metas.get(cheap.venue), o.misComisionesBps?.get(cheap.venue));
    const fr = comisionPataPct(metas.get(rich.venue), o.misComisionesBps?.get(rich.venue));
    const feesPct = fc === null || fr === null ? null : fc + fr;
    const sc = spreadDe(cheap);
    const sr = spreadDe(rich);
    const spreadPct = sc === null || sr === null ? null : sc + sr;
    const bps = (v: string) => o.misComisionesBps?.get(v) ?? metas.get(v)?.fees.takerBps ?? null;
    filas.push({
      symbol: g.symbol,
      assetClass: g.clase,
      venues: mismas.length,
      cheap: { ...cheap, feeBps: bps(cheap.venue) },
      rich: { ...rich, feeBps: bps(rich.venue) },
      gapPct,
      feesPct,
      spreadPct,
      netAtZeroPct: feesPct === null ? null : gapPct - feesPct - (spreadPct ?? 0),
      netIncludesSpread: spreadPct !== null,
      carryPctPerDay: (rich.fundingHourly - cheap.fundingHourly) * 24 * 100,
    });
  }
  // Por neto, lo que no tiene neto va al final: un hueco no es ni el mejor ni
  // el peor.
  return o.orden === 'net'
    ? filas.sort((a, b) => (b.netAtZeroPct ?? -Infinity) - (a.netAtZeroPct ?? -Infinity))
    : filas.sort((a, b) => b.gapPct - a.gapPct);
}

/** Estadisticas de la diferencia entre dos venues a lo largo del tiempo. */
export interface HistoriaParidad {
  readonly samples: number;
  readonly meanPct: number | null;
  readonly medianPct: number | null;
  readonly p10Pct: number | null;
  readonly p90Pct: number | null;
  readonly maxPct: number | null;
  /**
   * Que parte del tiempo la diferencia supero el coste de ida y vuelta, en %.
   * Es la pregunta de fondo: si alguna vez fue rentable montarlo. null si no
   * se paso coste.
   */
  readonly aboveCostPct: number | null;
  /** La serie, para el grafico: instante en ms y diferencia en %. */
  readonly points: readonly { readonly t: number; readonly gapPct: number }[];
}

/**
 * La diferencia de `rich` sobre `cheap` en cada instante en que los dos
 * guardaron precio. Se cruza por instante EXACTO: el persister guarda todos los
 * venues con el mismo sello, e interpolar inventaria precios que nadie midio.
 */
export function historiaParidad(
  puntos: readonly { ts: number; venue: string; mid: number }[],
  cheap: string,
  rich: string,
  costePct: number | null = null,
): HistoriaParidad {
  const barato = new Map<number, number>();
  for (const p of puntos) if (p.venue === cheap && p.mid > 0) barato.set(p.ts, p.mid);
  const serie: { t: number; gapPct: number }[] = [];
  for (const p of puntos) {
    if (p.venue !== rich || p.mid <= 0) continue;
    const c = barato.get(p.ts);
    if (c !== undefined) serie.push({ t: p.ts, gapPct: ((p.mid - c) / c) * 100 });
  }
  serie.sort((a, b) => a.t - b.t);
  const orden = serie.map((s) => s.gapPct).sort((a, b) => a - b);
  const q = (x: number): number | null => {
    if (orden.length === 0) return null;
    return orden[Math.min(orden.length - 1, Math.floor(x * orden.length))] ?? null;
  };
  return {
    samples: serie.length,
    meanPct: orden.length === 0 ? null : orden.reduce((a, b) => a + b, 0) / orden.length,
    medianPct: q(0.5),
    p10Pct: q(0.1),
    p90Pct: q(0.9),
    maxPct: orden.length === 0 ? null : orden[orden.length - 1] ?? null,
    aboveCostPct: costePct === null || orden.length === 0
      ? null
      : (orden.filter((g) => g > costePct).length / orden.length) * 100,
    points: serie,
  };
}
