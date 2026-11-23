/**
 * Seguimiento de salud por fuente de datos.
 *
 * Aqui NO se mide disponibilidad. El fallo que importa no es que una API se
 * caiga (eso se ve al instante), sino que responda 200 OK con datos viejos o
 * con la mitad de los simbolos. Es silencioso y envenena el scanner y, mas
 * abajo, al bot. Ver "Observabilidad de fuentes de datos" en ARCHITECTURE.md.
 */

export type SourceStatus = 'ok' | 'degraded' | 'down';

export interface SourceHealth {
  readonly venue: string;
  readonly status: SourceStatus;
  /** Por que no esta `ok`. null cuando lo esta. */
  readonly reason: string | null;
  readonly lastOkAt: number | null;
  readonly lastErrorAt: number | null;
  readonly lastError: string | null;
  readonly consecutiveFailures: number;
  /** Simbolos del ultimo ciclo correcto. */
  readonly symbolCount: number;
  /** Media de simbolos de los ciclos correctos previos, para detectar caidas. */
  readonly baselineSymbolCount: number | null;
  /** symbolCount / baseline. Por debajo del umbral, la fuente esta degradada. */
  readonly coverageRatio: number | null;
  readonly latencyP50Ms: number | null;
  readonly latencyP95Ms: number | null;
  readonly errorRatePct: number;
  readonly cyclesTotal: number;
  readonly declaredRequestsPerMinute: number;
}

export interface HealthThresholds {
  /** Antiguedad a partir de la cual un dato deja de servir. */
  readonly staleAfterMs: number;
  /** Fallos seguidos para considerar la fuente caida. */
  readonly downAfterFailures: number;
  /** Cobertura minima frente a la media antes de marcar degradada. */
  readonly coverageDegradedBelow: number;
  /** Ciclos que se conservan para latencias y tasa de error. */
  readonly windowSize: number;
}

export const DEFAULT_THRESHOLDS: HealthThresholds = {
  staleAfterMs: 90_000,
  downAfterFailures: 3,
  coverageDegradedBelow: 0.8,
  windowSize: 50,
};

/** Percentil por interpolacion nula (el elemento en la posicion redondeada). */
function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? null;
}

/**
 * Acumula el resultado de cada ciclo de una fuente y deriva su estado.
 * Una instancia por venue, propiedad del collector.
 */
export class SourceTracker {
  readonly venue: string;
  readonly declaredRequestsPerMinute: number;

  #thresholds: HealthThresholds;
  /** Latencias de los ciclos correctos, ventana movil. */
  #latencies: number[] = [];
  /** true = ciclo fallido. Ventana movil, para la tasa de error. */
  #failures: boolean[] = [];
  /** Numero de simbolos de los ciclos correctos, ventana movil. */
  #counts: number[] = [];

  #lastOkAt: number | null = null;
  #lastErrorAt: number | null = null;
  #lastError: string | null = null;
  #consecutiveFailures = 0;
  #symbolCount = 0;
  #cyclesTotal = 0;
  /** Motivo del ultimo fallo de plausibilidad, o null si los datos cuadran. */
  #dataIssue: string | null = null;
  #dataIssueCount = 0;
  /** A cuantos simbolos afecta, de cuantos. Distingue un simbolo del venue. */
  #dataIssueScope: { symbols: number; worstSymbol: string | null; total: number } | null = null;

  constructor(venue: string, declaredRequestsPerMinute: number, thresholds: HealthThresholds = DEFAULT_THRESHOLDS) {
    this.venue = venue;
    this.declaredRequestsPerMinute = declaredRequestsPerMinute;
    this.#thresholds = thresholds;
  }

  #push<T>(arr: T[], value: T): void {
    arr.push(value);
    if (arr.length > this.#thresholds.windowSize) arr.shift();
  }

  recordSuccess(at: number, latencyMs: number, symbolCount: number): void {
    this.#cyclesTotal++;
    this.#consecutiveFailures = 0;
    this.#lastOkAt = at;
    this.#symbolCount = symbolCount;
    this.#push(this.#latencies, latencyMs);
    this.#push(this.#failures, false);
    this.#push(this.#counts, symbolCount);
  }

  recordFailure(at: number, error: string): void {
    this.#cyclesTotal++;
    this.#consecutiveFailures++;
    this.#lastErrorAt = at;
    this.#lastError = error;
    this.#push(this.#failures, true);
    // Deliberadamente NO se toca #symbolCount ni #counts: la cobertura debe
    // reflejar el ultimo ciclo bueno, no caer a cero por un fallo puntual de
    // red. El fallo ya se refleja en el estado y en la tasa de error.
  }

  /**
   * Registra el resultado de la validacion de plausibilidad de este ciclo.
   *
   * Un venue que responde 200 OK pero publica un volumen de 290.000 millones en
   * BTC esta ROTO, aunque su HTTP sea perfecto. Se marca degradado, no caido:
   * la API funciona, lo que no es de fiar es el dato.
   */
  recordDataIssues(
    count: number,
    worst: string | null,
    alcance: { symbols: number; worstSymbol: string | null; total: number } = {
      symbols: 0, worstSymbol: null, total: 0,
    },
  ): void {
    this.#dataIssueCount = count;
    this.#dataIssue = count > 0 ? worst : null;
    this.#dataIssueScope = count > 0 ? alcance : null;
  }

  /**
   * Media de simbolos de los ciclos correctos ANTERIORES al ultimo, que es
   * contra lo que se compara la cobertura actual. Necesita al menos tres
   * muestras: con menos, cualquier variacion normal parece una caida.
   */
  #baseline(): number | null {
    if (this.#counts.length < 4) return null;
    const previos = this.#counts.slice(0, -1);
    const suma = previos.reduce((a, b) => a + b, 0);
    return suma / previos.length;
  }

  health(at: number): SourceHealth {
    const t = this.#thresholds;
    const baseline = this.#baseline();
    const coverageRatio = baseline !== null && baseline > 0 ? this.#symbolCount / baseline : null;

    const sorted = [...this.#latencies].sort((a, b) => a - b);
    const errores = this.#failures.filter(Boolean).length;
    const errorRatePct = this.#failures.length === 0 ? 0 : (errores / this.#failures.length) * 100;

    let status: SourceStatus = 'ok';
    let reason: string | null = null;

    if (this.#lastOkAt === null) {
      status = 'down';
      reason = this.#lastError ?? 'no successful cycle yet';
    } else if (this.#consecutiveFailures >= t.downAfterFailures) {
      status = 'down';
      reason = `${this.#consecutiveFailures} consecutive failures: ${this.#lastError ?? 'no detail'}`;
    } else if (at - this.#lastOkAt > t.staleAfterMs) {
      // Responde, pero lo que devuelve ya no sirve. Este es el caso silencioso.
      status = 'degraded';
      reason = `stale data: ${Math.round((at - this.#lastOkAt) / 1000)} s without a successful refresh`;
    } else if (this.#dataIssue !== null) {
      // Va ANTES que la cobertura: si el venue publica datos imposibles, ese es
      // el motivo que hay que enseñar, no un porcentaje de simbolos.
      status = 'degraded';
      // El alcance va DELANTE del detalle: lo primero que hace falta saber es
      // si esta roto un simbolo o el venue entero.
      const s = this.#dataIssueScope;
      const alcance =
        s === null || s.symbols === 0
          ? 'venue-wide'
          : s.total > 0 && s.symbols >= s.total
            ? `all ${s.total} symbols`
            : s.symbols === 1
              ? `1 symbol (${s.worstSymbol ?? '?'})`
              : `${s.symbols} of ${s.total} symbols`;
      const cuantos = this.#dataIssueCount > 1 ? ` (${this.#dataIssueCount} findings)` : '';
      reason = `implausible data on ${alcance}${cuantos}: ${this.#dataIssue}`;
    } else if (coverageRatio !== null && coverageRatio < t.coverageDegradedBelow) {
      status = 'degraded';
      reason = `coverage at ${Math.round(coverageRatio * 100)}% of usual (${this.#symbolCount} of ~${Math.round(baseline ?? 0)} symbols)`;
    } else if (this.#consecutiveFailures > 0) {
      status = 'degraded';
      reason = `last cycle failed: ${this.#lastError ?? 'no detail'}`;
    }

    return {
      venue: this.venue,
      status,
      reason,
      lastOkAt: this.#lastOkAt,
      lastErrorAt: this.#lastErrorAt,
      lastError: this.#lastError,
      consecutiveFailures: this.#consecutiveFailures,
      symbolCount: this.#symbolCount,
      baselineSymbolCount: baseline,
      coverageRatio,
      latencyP50Ms: percentile(sorted, 50),
      latencyP95Ms: percentile(sorted, 95),
      errorRatePct,
      cyclesTotal: this.#cyclesTotal,
      declaredRequestsPerMinute: this.declaredRequestsPerMinute,
    };
  }
}
