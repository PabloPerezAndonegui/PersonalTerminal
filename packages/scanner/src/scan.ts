import type { FundingProvenance, MarketSnapshot, Opportunity, VenueMeta } from '@defi/core';
import { YEAR_HOURS, now, toAprPct, toHourly } from '@defi/core';

export type FeeMode = 'taker' | 'maker';

export interface ScanOptions {
  /** Nocional por pata, en USD. El coste de cruzar el libro depende del tamano. */
  readonly notionalPerLegUsd: number;
  /** Horizonte en horas sobre el que se amortizan los costes de entrada y salida. */
  readonly holdHours: number;
  /**
   * `taker` es el modo conservador: asume que se cruza el spread en las cuatro
   * patas. `maker` asume que se entra y se sale con ordenes pasivas, lo que en
   * la practica no siempre se consigue.
   */
  readonly feeMode: FeeMode;
  /** Descarta oportunidades por debajo de este APR bruto antes de ordenar. */
  readonly minGrossAprPct?: number;
  readonly clock?: () => number;
}

/**
 * Coste en % del nocional de abrir y cerrar UNA pata en este venue.
 *
 * Devuelve null si la fee del modo pedido no se conoce: nunca se asume 0. Una
 * fee inventada convierte una oportunidad mala en una que parece buena, que es
 * exactamente el error que cuesta dinero.
 */
function legFeePct(meta: VenueMeta, mode: FeeMode): number | null {
  const bps = mode === 'taker' ? meta.fees.takerBps : meta.fees.makerBps;
  if (bps === null) return null;
  // bps -> % del nocional: 1 bps = 0.01 %.
  const abrir = bps / 100;
  const cerrar = meta.fees.freeClose ? 0 : bps / 100;
  return abrir + cerrar;
}

/**
 * Deja constancia de de donde sale el funding de una pata.
 *
 * Se guarda el numero NATIVO ademas del horario: sin el no se puede rehacer la
 * cuenta a mano, y toda la comparacion entre venues depende de esa division.
 */
function provenance(s: MarketSnapshot, hourly: number): FundingProvenance {
  return {
    venue: s.venue,
    kind: s.funding.kind,
    sourceField: s.funding.sourceField,
    nativeRate: s.funding.rate,
    intervalHours: s.funding.intervalHours,
    hourlyRate: hourly,
    observedAt: s.at,
    sourceAt: s.sourceAt,
    nextFundingAt: s.funding.nextFundingAt,
  };
}

/**
 * Compara dos venues para un simbolo y devuelve la oportunidad, o null si no
 * es evaluable.
 *
 * El corto es SIEMPRE la pata con el funding mas alto: es la que cobra. Con esa
 * convencion `fundingSpreadHourly` nunca es negativo y la UI no tiene que
 * razonar con signos.
 */
function pairOpportunity(
  a: MarketSnapshot,
  b: MarketSnapshot,
  metaA: VenueMeta,
  metaB: VenueMeta,
  options: ScanOptions,
  at: number,
): Opportunity | null {
  const fundingA = toHourly(a.funding);
  const fundingB = toHourly(b.funding);

  const [short, long, metaShort, metaLong, fundingShort, fundingLong] =
    fundingA >= fundingB
      ? ([a, b, metaA, metaB, fundingA, fundingB] as const)
      : ([b, a, metaB, metaA, fundingB, fundingA] as const);

  const spread = fundingShort - fundingLong;
  if (spread <= 0) return null;

  const grossAprPct = toAprPct(spread);
  if (options.minGrossAprPct !== undefined && grossAprPct < options.minGrossAprPct) return null;

  const feeShort = legFeePct(metaShort, options.feeMode);
  const feeLong = legFeePct(metaLong, options.feeMode);
  // Si cualquiera de las dos fees es desconocida, el coste total lo es, y el
  // APR neto tambien. Se propaga null hasta la UI, que pinta "—".
  const feesPct = feeShort === null || feeLong === null ? null : feeShort + feeLong;

  return {
    symbol: short.symbol,
    longVenue: long.venue,
    shortVenue: short.venue,
    longFundingHourly: fundingLong,
    shortFundingHourly: fundingShort,
    fundingSpreadHourly: spread,
    grossAprPct,
    // El slippage se rellena en la segunda fase, con los libros reales. Hasta
    // entonces el coste total y el neto se quedan sin calcular.
    slippagePct: null,
    feesPct,
    totalCostPct: null,
    netAprPct: null,
    breakevenHours: null,
    notionalPerLegUsd: options.notionalPerLegUsd,
    insufficientDepth: false,
    at,
    provenance: {
      long: provenance(long, fundingLong),
      short: provenance(short, fundingShort),
      // Los libros se piden en la segunda fase; hasta entonces no hay edad que
      // declarar.
      books: null,
    },
    // Sin coste calculado todavia no se puede decir si amortiza.
    amortizesWithinHold: null,
  };
}

/**
 * Primera fase: todas las oportunidades a partir de los snapshots, sin libros.
 *
 * Es O(n^2) por simbolo sobre el numero de venues que lo listan. Con 20 venues
 * son 190 pares por simbolo; con varios cientos de simbolos, decenas de miles
 * de comparaciones por ciclo. Se hace sobre datos ya en memoria y sin crear
 * objetos salvo para las que superan el umbral, que es lo que lo mantiene en
 * milisegundos en una Raspberry.
 *
 * No se busca solo el par de funding maximo y minimo: seria O(n) pero
 * incorrecto, porque las fees difieren por venue y el mejor par en bruto no
 * tiene por que ser el mejor una vez descontados los costes.
 */
export function scanGross(
  snapshots: ReadonlyMap<string, ReadonlyMap<string, MarketSnapshot>>,
  metas: ReadonlyMap<string, VenueMeta>,
  options: ScanOptions,
): Opportunity[] {
  const at = (options.clock ?? now)();

  // Reagrupar por simbolo: los snapshots llegan por venue.
  const bySymbol = new Map<string, MarketSnapshot[]>();
  for (const [venue, porSimbolo] of snapshots) {
    if (!metas.has(venue)) continue;
    for (const [symbol, snapshot] of porSimbolo) {
      // Un swap no tiene funding: su 0 no es una tasa medida y cruzarlo contra
      // un perpetuo daria un diferencial que no se cobra.
      if (snapshot.instrument === 'swap') continue;
      const lista = bySymbol.get(symbol);
      if (lista === undefined) bySymbol.set(symbol, [snapshot]);
      else lista.push(snapshot);
    }
  }

  const out: Opportunity[] = [];
  for (const listados of bySymbol.values()) {
    if (listados.length < 2) continue;
    for (let i = 0; i < listados.length; i++) {
      for (let j = i + 1; j < listados.length; j++) {
        const a = listados[i];
        const b = listados[j];
        if (a === undefined || b === undefined) continue;
        const metaA = metas.get(a.venue);
        const metaB = metas.get(b.venue);
        if (metaA === undefined || metaB === undefined) continue;
        const op = pairOpportunity(a, b, metaA, metaB, options, at);
        if (op !== null) out.push(op);
      }
    }
  }

  out.sort((x, y) => y.grossAprPct - x.grossAprPct);
  return out;
}

/**
 * Completa una oportunidad con el coste real de cruzar el libro.
 *
 * `slippageOpenPct` es lo que cuesta abrir las dos patas, medido paseando los
 * libros con el nocional configurado. Se asume que cerrar cuesta lo mismo, que
 * es una aproximacion razonable y conservadora en libros estables; en un
 * mercado que se mueve, cerrar suele costar mas.
 *
 * Dos avisos sobre `insufficientDepth`:
 *
 *  - Se juzga con los niveles que devuelve la API, que en la mayoria de venues
 *    son los 20 mejores. Es por tanto una COTA INFERIOR de la profundidad real:
 *    puede marcar como insuficiente un libro que si aguantaria el tamano con
 *    niveles mas profundos. Peca de conservador a proposito.
 *  - Cuando se marca, el neto se deja en null en vez de calcularlo con un
 *    slippage inventado. Una oportunidad que no se puede ejecutar al tamano
 *    pedido no es una oportunidad.
 */
export function withDepth(
  opportunity: Opportunity,
  slippageOpenPct: number,
  insufficientDepth: boolean,
  options: ScanOptions,
  books: Opportunity['provenance']['books'] = null,
): Opportunity {
  const conLibros: Opportunity = books === null
    ? opportunity
    : { ...opportunity, provenance: { ...opportunity.provenance, books } };

  if (insufficientDepth) {
    return { ...conLibros, insufficientDepth: true, slippagePct: null };
  }

  const slippagePct = slippageOpenPct * 2;
  const feesPct = opportunity.feesPct;
  if (feesPct === null) {
    // Sin fees no hay coste total, aunque el slippage si se conozca.
    return { ...conLibros, slippagePct, insufficientDepth: false };
  }

  const totalCostPct = feesPct + slippagePct;
  const spreadPctPorHora = opportunity.fundingSpreadHourly * 100;
  const breakevenHours = spreadPctPorHora > 0 ? totalCostPct / spreadPctPorHora : null;

  // El coste es de una sola vez; para expresarlo como APR se reparte en el
  // horizonte elegido y se anualiza. Con horizontes cortos el coste pesa
  // muchisimo, que es justo lo que la pantalla debe dejar ver.
  const costeAnualizadoPct =
    options.holdHours > 0 ? totalCostPct * (YEAR_HOURS / options.holdHours) : totalCostPct;

  return {
    ...conLibros,
    slippagePct,
    totalCostPct,
    breakevenHours,
    netAprPct: opportunity.grossAprPct - costeAnualizadoPct,
    insufficientDepth: false,
    // Con ESTE tamano y ESTE horizonte, y suponiendo que el diferencial
    // aguante, ¿se llega a recuperar lo que cuesta abrir y cerrar?
    amortizesWithinHold: breakevenHours === null ? null : breakevenHours <= options.holdHours,
  };
}
