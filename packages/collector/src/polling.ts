import { DEFAULT_THRESHOLDS, SourceTracker } from './health.ts';
import type { HealthThresholds, SourceHealth } from './health.ts';

/**
 * Recolector generico para fuentes que NO son venues.
 *
 * DefiLlama, TradingView o un fichero de campanas verificadas a mano no encajan
 * en `VenueAdapter` y no producen `MarketSnapshot`, pero necesitan exactamente
 * lo mismo: refresco periodico, resiliencia, y salud medida igual para que Data
 * Sources las trate como a las demas. Sin esto, una fuente externa se quedaria
 * en amarillo para siempre aunque funcionase perfectamente.
 *
 * No importa nada de `@defi/venues` a proposito: es util para cualquier cosa
 * que se consulte cada cierto tiempo.
 */
export interface PollingSourceOptions<T> {
  readonly id: string;
  readonly intervalMs: number;
  /** Puede lanzar: la resiliencia vive aqui, igual que en el collector. */
  readonly fetch: () => Promise<T>;
  /** Cuantos elementos trae el resultado, para medir cobertura. */
  readonly count: (data: T) => number;
  readonly thresholds?: HealthThresholds;
  readonly clock?: () => number;
}

/**
 * Umbrales a la medida de la cadencia de la fuente.
 *
 * El umbral de frescura por defecto son 90 s, pensados para el collector, que
 * recoge cada 60. Aplicado tal cual a una fuente que se pide UNA VEZ POR HORA,
 * la marcaba degradada 58 minutos de cada 60: los dos DefiLlama salian siempre
 * en amarillo con el motivo "stale data: 181 s without a successful refresh", y
 * con ellos las pestanas Pools & Yields y Bridges. Un estado que esta siempre
 * encendido no informa de nada y ensena a ignorar la pantalla entera.
 *
 * Se declara caduca cuando ha perdido mas de dos ciclos SUYOS, con el suelo del
 * defecto para que una fuente muy rapida no se quede con un umbral nervioso.
 * Los fallos duros no pasan por aqui: los cuenta `downAfterFailures`.
 */
function umbralesPara(intervalMs: number): HealthThresholds {
  return {
    ...DEFAULT_THRESHOLDS,
    staleAfterMs: Math.max(DEFAULT_THRESHOLDS.staleAfterMs, intervalMs * 2.5),
  };
}

export class PollingSource<T> {
  readonly id: string;

  #intervalMs: number;
  #fetch: () => Promise<T>;
  #count: (data: T) => number;
  #clock: () => number;
  #tracker: SourceTracker;

  #data: T | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #running = false;
  /** Refresco en vuelo: evita dos peticiones simultaneas a la misma fuente. */
  #enVuelo: Promise<void> | null = null;

  constructor(options: PollingSourceOptions<T>) {
    this.id = options.id;
    this.#intervalMs = options.intervalMs;
    this.#fetch = options.fetch;
    this.#count = options.count;
    this.#clock = options.clock ?? Date.now;
    this.#tracker = new SourceTracker(options.id, 0, options.thresholds ?? umbralesPara(options.intervalMs));
  }

  /** Ultimo resultado correcto, o null si aun no ha habido ninguno. */
  get data(): T | null {
    return this.#data;
  }

  health(): SourceHealth {
    return this.#tracker.health(this.#clock());
  }

  /**
   * Refresca ahora. Si ya hay un refresco en vuelo, se espera a ese en vez de
   * lanzar otro: dos pantallas abiertas no deben duplicar la peticion.
   */
  async refreshNow(): Promise<void> {
    if (this.#enVuelo !== null) return this.#enVuelo;

    this.#enVuelo = (async () => {
      const t0 = this.#clock();
      try {
        const data = await this.#fetch();
        this.#data = data;
        this.#tracker.recordSuccess(this.#clock(), this.#clock() - t0, this.#count(data));
      } catch (err) {
        // El dato anterior se CONSERVA: una fuente que falla un ciclo sigue
        // teniendo su ultimo resultado bueno, y el control de frescura decide
        // si aun sirve. Borrarlo dejaria la pantalla en blanco por un timeout.
        this.#tracker.recordFailure(this.#clock(), err instanceof Error ? err.message : String(err));
      } finally {
        this.#enVuelo = null;
      }
    })();

    return this.#enVuelo;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    const tick = async () => {
      if (!this.#running) return;
      await this.refreshNow();
      if (this.#running) this.#timer = setTimeout(() => void tick(), this.#intervalMs);
    };
    void tick();
  }

  stop(): void {
    this.#running = false;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }
}
