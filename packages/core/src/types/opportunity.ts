import type { VenueId } from './venue.ts';
import type { FundingKind } from './market.ts';

/** Coste estimado de cruzar el libro con un tamano dado. */
export interface ExecCost {
  /** Desviacion media respecto al mid, en bps. Incluye medio spread e impacto. */
  readonly slippageBps: number;
  /** true si el libro no cubre el tamano pedido: el par no es elegible asi. */
  readonly insufficientDepth: boolean;
}

/**
 * Un par delta-neutral candidato: largo en un venue, corto en otro.
 * Por construccion `fundingSpreadHourly >= 0` (el corto es siempre la pata que
 * cobra), asi no hay que razonar con signos en la UI.
 */
export interface Opportunity {
  readonly symbol: string;
  readonly longVenue: VenueId;
  readonly shortVenue: VenueId;

  /** Funding horario de cada pata, decimal. */
  readonly longFundingHourly: number;
  readonly shortFundingHourly: number;
  /** Diferencial horario, siempre >= 0. */
  readonly fundingSpreadHourly: number;

  /** APR bruto anualizado, en %, sin descontar nada. */
  readonly grossAprPct: number;
  /**
   * APR neto tras fees y slippage, amortizados en el horizonte elegido.
   * null si alguna fee del par es desconocida: no se estima a ojo.
   */
  readonly netAprPct: number | null;

  /** Coste total del round trip, en % del nocional. null si hay fees desconocidas. */
  readonly totalCostPct: number | null;
  readonly feesPct: number | null;
  readonly slippagePct: number | null;
  /** Horas de funding necesarias para cubrir el coste. null si no es calculable. */
  readonly breakevenHours: number | null;

  readonly notionalPerLegUsd: number;
  readonly insufficientDepth: boolean;
  readonly at: number;

  /**
   * De donde sale cada cifra de esta fila.
   *
   * Existe para poder abrir un resultado y llegar hasta la respuesta cruda del
   * venue sin leer el codigo: que campo se leyo, que representaba, cuando se
   * recibio y cuando lo sello el venue si es que lo sella.
   */
  readonly provenance: OpportunityProvenance;

  /**
   * Si el coste se recupera DENTRO del horizonte elegido, suponiendo que el
   * diferencial de funding se mantenga.
   *
   * null cuando no es calculable (fee desconocida o sin profundidad). false
   * significa que, con ese tamano y ese horizonte, la operacion no llega a
   * amortizar lo que cuesta abrirla y cerrarla.
   */
  readonly amortizesWithinHold: boolean | null;
}

/** Procedencia del funding de una pata. */
export interface FundingProvenance {
  readonly venue: VenueId;
  /** Que representaba el numero en origen: vigente, previsto o liquidado. */
  readonly kind: FundingKind;
  /** Endpoint y campo exactos de los que se leyo. */
  readonly sourceField: string;
  /** El numero tal cual lo publica el venue, sin normalizar. */
  readonly nativeRate: number;
  /** Horas que cubre `nativeRate` segun el venue. */
  readonly intervalHours: number;
  /** `nativeRate / intervalHours`: la base comparable entre venues. */
  readonly hourlyRate: number;
  /** Cuando lo recibimos nosotros. */
  readonly observedAt: number;
  /** Cuando lo sello el venue, o null si no sella nada. */
  readonly sourceAt: number | null;
  /** Proximo cobro segun el venue, o null si no lo publica. */
  readonly nextFundingAt: number | null;
}

export interface OpportunityProvenance {
  readonly long: FundingProvenance;
  readonly short: FundingProvenance;
  /**
   * Antiguedad de cada libro y el desfase entre ambos, en ms.
   *
   * Importa porque el slippage se calcula con dos libros que NO se piden a la
   * vez: si uno es de hace dos minutos y el otro de hace diez segundos, el
   * coste de cruzar que sale de ahi no corresponde a ningun instante real.
   * null cuando no se llego a usar libro.
   */
  readonly books: { readonly longAgeMs: number; readonly shortAgeMs: number; readonly skewMs: number } | null;
}
