import type { DatabaseSync } from 'node:sqlite';
import { pairSustainability, type ParDeVenues, type SustainabilityWindow } from '@defi/storage';

/**
 * La nota de sostenibilidad que lleva cada oportunidad de la tabla.
 *
 * Dos numeros y una letra, a proposito. Un unico numero magico esconderia el
 * compromiso que hay detras: pagar mucho y pagar casi siempre no son lo mismo,
 * y la diferencia es justo lo que decide si puedes estar quieto o tienes que
 * entrar y salir.
 *
 *  - **holdApr**: lo que habrias cobrado aguantando el par sin tocarlo,
 *    anualizado. Cuenta tambien los ratos en contra, que es lo honesto si no
 *    piensas cerrar.
 *  - **uptime**: que parte del tiempo el diferencial estuvo a favor.
 *
 * La letra sale de las dos ventanas y **se queda con la peor**. "Casi siempre
 * merece la pena" no se le puede dar a algo que solo ha funcionado esta
 * semana, ni a algo que va de capa caida aunque el mes entero salga bien.
 *
 * Es BRUTO: sin comisiones, sin spread de ejecucion y sin el coste de entrar.
 */

export type Nota = 'A' | 'B' | 'C' | 'D';

export interface VentanaPublica {
  /** Horas de datos seguidos. Los huecos no cuentan. */
  readonly coveredHours: number;
  /** Fraccion del tiempo a favor, de 0 a 1. null sin datos suficientes. */
  readonly uptime: number | null;
  /** Anualizado y en porcentaje. null sin datos suficientes. */
  readonly holdApr: number | null;
  readonly samples: number;
}

export interface Sostenibilidad {
  readonly grade: Nota | null;
  readonly days7: VentanaPublica;
  readonly days14: VentanaPublica;
  /** El par medido. Si cambia el mejor cruce, esto lo delata. */
  readonly largo: string;
  readonly corto: string;
}

const HORA = 3_600_000;
const ANO_HORAS = 8_760;
/**
 * Sin al menos un dia de datos seguidos no se pone nota.
 *
 * Es el limite que de verdad manda hoy: con el collector arrancando y parando,
 * muchos simbolos no llegan. Preferimos un hueco a una letra que no se sostiene.
 */
const HORAS_MINIMAS = 24;

const publica = (v: SustainabilityWindow): VentanaPublica => {
  const horas = v.coveredMs / HORA;
  const bastante = horas >= HORAS_MINIMAS;
  return {
    coveredHours: horas,
    uptime: bastante && v.coveredMs > 0 ? v.favourableMs / v.coveredMs : null,
    holdApr: bastante && v.meanHourly !== null ? v.meanHourly * ANO_HORAS * 100 : null,
    samples: v.samples,
  };
};

/**
 * De dos numeros a una letra.
 *
 * Los cortes no salen de ninguna teoria: son lo que separa "esto se aguanta"
 * de "esto hay que vigilarlo". Se ensenan los numeros al lado para que la
 * letra nunca tenga que creerse a ciegas.
 */
function nota(v: VentanaPublica): Nota | null {
  if (v.uptime === null || v.holdApr === null) return null;
  if (v.uptime >= 0.85 && v.holdApr >= 15) return 'A';
  if (v.uptime >= 0.70 && v.holdApr >= 8) return 'B';
  if (v.uptime >= 0.55 && v.holdApr > 0) return 'C';
  return 'D';
}

const ORDEN: Record<Nota, number> = { A: 3, B: 2, C: 1, D: 0 };

/** La peor de las dos. Si una de las ventanas no tiene datos, manda la otra. */
export function peorNota(a: Nota | null, b: Nota | null): Nota | null {
  if (a === null) return b;
  if (b === null) return a;
  return ORDEN[a] <= ORDEN[b] ? a : b;
}

interface Entrada {
  readonly valor: Sostenibilidad;
  readonly at: number;
}

export interface SustainabilityIndexOptions {
  readonly db: DatabaseSync;
  /** Cuanto vale un calculo antes de repetirlo. */
  readonly ttlMs?: number;
  readonly clock?: () => number;
}

/**
 * Cuantos pares por tanda.
 *
 * Con el indice puesto, la consulta entera son unos 2 s para 985 pares, asi
 * que cien pares por tanda dejan bloqueos de unos 200 ms. Es el compromiso
 * entre no congelar la API y no pagar el coste fijo de la consulta mil veces.
 */
const TANDA = 100;

/** Diez minutos: el historico se mueve despacio y la consulta no es gratis. */
const TTL = 10 * 60_000;

/**
 * Indice con cache.
 *
 * El calculo entero tarda cerca de un segundo con mil pares, asi que **no se
 * hace dentro de la peticion**: la tabla se sirve con lo que haya calculado y
 * lo que falte sale como hueco, que es "todavia no", no "no hay". El primer
 * refresco se lanza solo al pedir la tabla por primera vez.
 */
export class SustainabilityIndex {
  readonly #db: DatabaseSync;
  readonly #ttlMs: number;
  readonly #clock: () => number;
  #cache = new Map<string, Entrada>();
  #calculando = false;

  constructor(options: SustainabilityIndexOptions) {
    this.#db = options.db;
    this.#ttlMs = options.ttlMs ?? TTL;
    this.#clock = options.clock ?? Date.now;
  }

  get busy(): boolean {
    return this.#calculando;
  }

  static clave(p: ParDeVenues): string {
    return `${p.symbol}|${p.largo}|${p.corto}`;
  }

  get(p: ParDeVenues): Sostenibilidad | null {
    return this.#cache.get(SustainabilityIndex.clave(p))?.valor ?? null;
  }

  /**
   * Apunta que pares hacen falta y recalcula los que esten viejos.
   *
   * No devuelve nada y no se espera: quien pide la tabla no puede quedarse
   * esperando a que termine una consulta de un segundo.
   */
  observe(pares: readonly ParDeVenues[]): void {
    if (this.#calculando) return;
    const ahora = this.#clock();
    const faltan = pares.filter((p) => {
      const e = this.#cache.get(SustainabilityIndex.clave(p));
      return e === undefined || ahora - e.at > this.#ttlMs;
    });
    if (faltan.length === 0) return;

    this.#calculando = true;
    void this.#calcularPorTandas(faltan);
  }

  /**
   * Por tandas, cediendo el hilo entre una y otra.
   *
   * Aqui estaba el fallo que congelaba la aplicacion entera. `setTimeout(0)`
   * aplaza el trabajo, pero NO lo saca del hilo: la consulta de SQLite es
   * sincrona, asi que mientras corre no se atiende ni una peticion. Medido el
   * 25 de septiembre de 2026, antes del indice que faltaba: abrir el screener
   * dejaba la API muerta **48,9 segundos**, y cualquier otra pestana esperaba
   * todo ese rato.
   *
   * Con el indice la consulta entera baja a 2 segundos, pero dos segundos
   * seguidos de bloqueo tampoco son aceptables en un servidor que ademas lleva
   * temporizadores y un flujo de eventos. Troceando en tandas, cada bloqueo
   * dura una fraccion y entre tanda y tanda el servidor respira.
   */
  async #calcularPorTandas(pares: readonly ParDeVenues[]): Promise<void> {
    try {
      for (let i = 0; i < pares.length; i += TANDA) {
        this.#calcular(pares.slice(i, i + TANDA));
        // Cola de macrotareas: deja pasar peticiones, temporizadores y SSE.
        await new Promise((r) => { setTimeout(r, 0); });
      }
    } catch {
      // Un fallo aqui deja la columna vacia, que es exactamente lo que debe
      // pasar: un hueco, no una nota inventada.
    } finally {
      this.#calculando = false;
    }
  }

  #calcular(pares: readonly ParDeVenues[]): void {
    const ahora = this.#clock();
    for (const r of pairSustainability(this.#db, pares, { now: ahora })) {
      const days7 = publica(r.short);
      const days14 = publica(r.long);
      this.#cache.set(SustainabilityIndex.clave(r), {
        at: ahora,
        valor: {
          grade: peorNota(nota(days7), nota(days14)),
          days7, days14, largo: r.largo, corto: r.corto,
        },
      });
    }
    // Un par sin ninguna muestra cruzada no vuelve de la consulta. Se anota
    // igualmente para no repetir el calculo en cada peticion.
    for (const p of pares) {
      const k = SustainabilityIndex.clave(p);
      if (this.#cache.has(k) && ahora - (this.#cache.get(k)?.at ?? 0) <= this.#ttlMs) continue;
      this.#cache.set(k, {
        at: ahora,
        valor: {
          grade: null, largo: p.largo, corto: p.corto,
          days7: { coveredHours: 0, uptime: null, holdApr: null, samples: 0 },
          days14: { coveredHours: 0, uptime: null, holdApr: null, samples: 0 },
        },
      });
    }
  }
}
