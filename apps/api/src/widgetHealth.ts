import type { SourceHealth } from '@defi/collector';

/**
 * Salud de las fuentes que se pintan solas en el navegador (TradingView).
 *
 * El servidor **no puede** medirlas: el widget lo carga el navegador contra un
 * tercero, y desde aqui no se ve si aparecio o si lo bloqueo una extension. Asi
 * que lo reporta el propio navegador al abrir la pestana, y el semaforo dice lo
 * que de verdad le paso al usuario, no lo que suponemos.
 *
 * Vive en memoria a proposito. "Cargo bien" es una afirmacion sobre hace un
 * rato, no un hecho permanente: si nadie abre la pestana, el dato caduca y la
 * fuente vuelve a amarillo — sin reportar — en vez de quedarse en verde para
 * siempre por un exito de la semana pasada.
 */

/** Pasado este tiempo sin reportar, el ultimo resultado deja de valer. */
export const WIDGET_REPORT_TTL_MS = 15 * 60 * 1000;

interface Reporte {
  readonly ok: boolean;
  readonly reason: string | null;
  readonly at: number;
  readonly loadMs: number | null;
}

export class WidgetHealth {
  readonly #permitidos: ReadonlySet<string>;
  readonly #reportes = new Map<string, Reporte>();

  /** Solo se admiten ids del catalogo: el endpoint no crea fuentes nuevas. */
  constructor(permitidos: Iterable<string>) {
    this.#permitidos = new Set(permitidos);
  }

  admite(id: string): boolean {
    return this.#permitidos.has(id);
  }

  report(id: string, r: { ok: boolean; reason?: string | null; loadMs?: number | null }): void {
    if (!this.admite(id)) throw new Error('unknown widget source');
    this.#reportes.set(id, {
      ok: r.ok,
      reason: r.reason ?? null,
      at: Date.now(),
      loadMs: r.loadMs ?? null,
    });
  }

  /**
   * Salud actual, o null si nadie ha reportado (o el reporte ya caduco). null
   * lo pinta Data Sources como amarillo "sin reportar", que es la verdad.
   */
  health(id: string, now: number = Date.now()): SourceHealth | null {
    const r = this.#reportes.get(id);
    if (r === undefined || now - r.at > WIDGET_REPORT_TTL_MS) return null;

    return {
      venue: id,
      status: r.ok ? 'ok' : 'down',
      reason: r.ok ? null : (r.reason ?? 'the widget did not load in the browser'),
      lastOkAt: r.ok ? r.at : null,
      lastErrorAt: r.ok ? null : r.at,
      lastError: r.ok ? null : (r.reason ?? 'the widget did not load in the browser'),
      consecutiveFailures: r.ok ? 0 : 1,
      // Un widget no trae simbolos: 0 seria una cobertura caida, y no lo es.
      symbolCount: 0,
      baselineSymbolCount: null,
      coverageRatio: null,
      // La unica latencia real que hay: lo que tardo en pintarse en el navegador.
      latencyP50Ms: r.loadMs,
      latencyP95Ms: null,
      errorRatePct: r.ok ? 0 : 100,
      cyclesTotal: 1,
      declaredRequestsPerMinute: 0,
    };
  }
}
