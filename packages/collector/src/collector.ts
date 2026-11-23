import type { MarketSnapshot } from '@defi/core';
import { isFresh } from '@defi/core';
import type { ResourceBudget, VenueAdapter } from '@defi/venues';
import { planBudget } from '@defi/venues';
import { validateCycle, findingsByVenue, DEFAULT_THRESHOLDS as DEFAULT_VALIDATION } from '@defi/validation';
import type { Finding, ValidationThresholds } from '@defi/validation';
import { DEFAULT_THRESHOLDS, SourceTracker } from './health.ts';
import type { HealthThresholds, SourceHealth } from './health.ts';

export interface CollectorOptions {
  /** Adaptadores en orden de PRIORIDAD: el presupuesto admite de arriba abajo. */
  readonly adapters: readonly VenueAdapter[];
  readonly budget: ResourceBudget;
  /** Separacion entre ciclos de recogida. */
  readonly intervalMs: number;
  readonly thresholds?: HealthThresholds;
  /** Umbrales de plausibilidad de los datos. Ver @defi/validation. */
  readonly validationThresholds?: ValidationThresholds;
  /** Reloj inyectable: los tests no dependen del reloj real. */
  readonly clock?: () => number;
}

/** Venue que no cabe en el presupuesto, con el motivo para mostrarlo en la UI. */
export interface RejectedSource {
  readonly venue: string;
  readonly reason: string;
}

export interface CycleResult {
  readonly at: number;
  readonly durationMs: number;
  readonly ok: number;
  readonly failed: number;
  /** Simbolos frescos totales tras el ciclo. */
  readonly freshSymbols: number;
  /** Hallazgos de plausibilidad detectados en este ciclo. */
  readonly findings: number;
}

type CycleListener = (result: CycleResult) => void;

/**
 * Bucle de recogida.
 *
 * Es el unico sitio donde vive la resiliencia: los adaptadores lanzan y aqui se
 * capturan errores, se cronometra, se cuenta y se decide el estado de cada
 * fuente. Asi esa logica no se repite en veinte adaptadores y la seccion 6
 * tiene una unica fuente de verdad.
 *
 * Los venues se refrescan EN PARALELO: un venue lento no debe retrasar a los
 * demas, y con `allSettled` un fallo tampoco aborta el ciclo.
 */
export class Collector {
  #adapters: VenueAdapter[];
  #trackers = new Map<string, SourceTracker>();
  #rejected: RejectedSource[];
  #intervalMs: number;
  #clock: () => number;
  #thresholds: HealthThresholds;
  #validationThresholds: ValidationThresholds;
  #findings: Finding[] = [];

  #timer: ReturnType<typeof setTimeout> | null = null;
  #running = false;
  #listeners: CycleListener[] = [];
  #lastCycle: CycleResult | null = null;

  constructor(options: CollectorOptions) {
    this.#intervalMs = options.intervalMs;
    this.#clock = options.clock ?? Date.now;
    // La frescura acompana la cadencia: tolera dos ciclos y margen de red.
    // Un fallo de refresh se sigue senalando inmediatamente en health.
    this.#thresholds = options.thresholds ?? {
      ...DEFAULT_THRESHOLDS,
      staleAfterMs: Math.max(DEFAULT_THRESHOLDS.staleAfterMs, options.intervalMs * 2.5),
    };
    this.#validationThresholds = options.validationThresholds ?? DEFAULT_VALIDATION;

    const plan = planBudget(options.adapters, options.budget);
    this.#adapters = [...plan.admitted];
    // Los rechazados no desaparecen: se exponen con su motivo literal para que
    // la UI pueda decir por que falta un venue en vez de omitirlo en silencio.
    this.#rejected = plan.rejected.map((r) => ({ venue: r.adapter.meta.id, reason: r.reason }));

    for (const adapter of this.#adapters) {
      this.#trackers.set(
        adapter.meta.id,
        new SourceTracker(adapter.meta.id, adapter.cost.requestsPerMinute, this.#thresholds),
      );
    }
  }

  /** Venues admitidos por el presupuesto. */
  get venues(): string[] {
    return this.#adapters.map((a) => a.meta.id);
  }

  get rejected(): readonly RejectedSource[] {
    return this.#rejected;
  }

  get lastCycle(): CycleResult | null {
    return this.#lastCycle;
  }

  /** Hallazgos de plausibilidad del ultimo ciclo, para Data Sources. */
  get findings(): readonly Finding[] {
    return this.#findings;
  }

  onCycle(listener: CycleListener): () => void {
    this.#listeners.push(listener);
    return () => {
      this.#listeners = this.#listeners.filter((l) => l !== listener);
    };
  }

  /** Un ciclo completo. Publico para poder ejecutarlo suelto en tests y scripts. */
  async runCycle(): Promise<CycleResult> {
    const started = this.#clock();

    const results = await Promise.allSettled(
      this.#adapters.map(async (adapter) => {
        const t0 = this.#clock();
        await adapter.refresh();
        return { adapter, latencyMs: this.#clock() - t0 };
      }),
    );

    let ok = 0;
    let failed = 0;
    const at = this.#clock();

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const adapter = this.#adapters[i];
      if (result === undefined || adapter === undefined) continue;
      const tracker = this.#trackers.get(adapter.meta.id);
      if (tracker === undefined) continue;

      if (result.status === 'fulfilled') {
        ok++;
        tracker.recordSuccess(at, result.value.latencyMs, adapter.snapshot().size);
      } else {
        failed++;
        const err: unknown = result.reason;
        tracker.recordFailure(at, err instanceof Error ? err.message : String(err));
      }
    }

    // Validacion de plausibilidad sobre lo que acaba de entrar. Un venue que
    // responde perfecto pero publica valores imposibles queda degradado aqui,
    // sin que nadie tenga que mirar los numeros a mano.
    const findings = validateCycle(this.snapshots(), this.#validationThresholds);
    const porVenue = findingsByVenue(findings);
    for (const [venue, tracker] of this.#trackers) {
      const propios = porVenue.get(venue) ?? [];
      // Solo los ERRORES cambian el semaforo. Los avisos se siguen contando y
      // se ven en Data Sources, pero no ponen el venue en amarillo: desde que
      // conviven venues de acciones y de cripto, el mismo ticker significa
      // cosas distintas a menudo (PURR, BB, CAT, B) y eso no es un fallo de
      // nadie. Con los avisos encendiendo la luz, cuatro de once fuentes
      // estaban en amarillo permanente y la pantalla dejaba de informar.
      const errores = propios.filter((f) => f.severity === 'error');
      // Un simbolo roto de 178 no es lo mismo que el venue entero roto, y hasta
      // ahora el motivo no dejaba distinguirlo: ni decia que simbolo era.
      const afectados = new Set(
        errores.map((f) => f.symbol).filter((s): s is string => s !== null),
      );
      // Los hallazgos vienen con los errores primero, asi que el peor es el [0].
      tracker.recordDataIssues(errores.length, errores[0]?.message ?? null, {
        symbols: afectados.size,
        worstSymbol: errores[0]?.symbol ?? null,
        total: this.snapshots().get(venue)?.size ?? 0,
      });
    }
    this.#findings = findings;

    const cycle: CycleResult = {
      at,
      durationMs: at - started,
      ok,
      failed,
      freshSymbols: this.#countFresh(),
      findings: findings.length,
    };
    this.#lastCycle = cycle;
    for (const listener of this.#listeners) listener(cycle);
    return cycle;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    const tick = async () => {
      if (!this.#running) return;
      try {
        await this.runCycle();
      } catch {
        // runCycle no deberia lanzar (usa allSettled), pero si lo hiciera, el
        // bucle no puede morir en silencio: se reprograma igualmente.
      }
      if (this.#running) this.#timer = setTimeout(() => void tick(), this.#intervalMs);
    };
    void tick();
  }

  stop(): void {
    this.#running = false;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    for (const adapter of this.#adapters) adapter.stop?.();
  }

  #countFresh(): number {
    let total = 0;
    for (const snapshot of this.snapshots().values()) total += snapshot.size;
    return total;
  }

  /**
   * Datos por venue, **solo los frescos**.
   *
   * Un venue caido conserva su ultimo snapshot en memoria; si se dejara pasar,
   * el scanner compararia un funding de hace media hora contra uno de ahora y
   * veria un diferencial que no existe. Por eso el filtro de frescura esta
   * aqui, en la frontera, y no en cada consumidor.
   */
  snapshots(): Map<string, Map<string, MarketSnapshot>> {
    const at = this.#clock();
    const out = new Map<string, Map<string, MarketSnapshot>>();
    for (const adapter of this.#adapters) {
      const fresh = new Map<string, MarketSnapshot>();
      for (const [symbol, snapshot] of adapter.snapshot()) {
        if (isFresh(snapshot.at, this.#thresholds.staleAfterMs, at)) fresh.set(symbol, snapshot);
      }
      if (fresh.size > 0) out.set(adapter.meta.id, fresh);
    }
    return out;
  }

  health(): SourceHealth[] {
    const at = this.#clock();
    return [...this.#trackers.values()].map((t) => t.health(at));
  }
}
