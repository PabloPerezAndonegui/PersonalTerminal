import type { DatabaseSync } from 'node:sqlite';
import type { AccountSnapshot } from '@defi/core';
import { listTraders, type Trader } from '@defi/storage';

/**
 * Seguimiento de posiciones de los traders activos.
 *
 * **Por que sondeo y no WebSocket.** Medido contra la API real el 23 de
 * septiembre de 2026: de las suscripciones de usuario que Hyperliquid acepta
 * para direcciones ajenas (`userFills`, `userEvents`, `userFundings`,
 * `userNonFundingLedgerUpdates`, `activeAssetData`), NINGUNA empuja las
 * posiciones abiertas; `webData2`, que seria la candidata, la rechaza. Ademas
 * el socket tiene un tope duro de **15 usuarios seguidos y es POR IP, no por
 * conexion**: abrir un segundo socket desde la misma IP no da 15 mas, da cero.
 * Las posiciones, por tanto, se leen con `clearinghouseState`, que no tiene
 * ese tope y tardo 0,6 s por peticion en la medicion.
 *
 * Tres cosas que este servicio tiene que hacer bien:
 *
 *  1. **Repartir.** No se piden todos los traders a la vez. Cada tick consulta
 *     a UNO, y el tick se calcula para que la vuelta entera quepa en el
 *     intervalo. Con 10 traders y 60 s, sale una peticion cada 6 s.
 *  2. **Esperar mas tras un fallo.** Cada fallo dobla la espera de ESE trader,
 *     hasta un tope. Un venue caido no se convierte en una tormenta de
 *     reintentos desde una IP que se comparte con otros bots.
 *  3. **Que pausar pare de verdad.** No basta con dejar de pedir: una
 *     respuesta que ya venia en camino no puede resucitar a un pausado. Por
 *     eso cada peticion lleva un testigo y al volver se comprueba que el
 *     trader sigue activo y que el testigo no ha caducado.
 *
 * Lo que NUNCA hace: convertir un fallo en "sin posiciones". Son cosas
 * distintas y se distinguen en el estado.
 */

/** Lectura mas reciente de un trader, con su historia de fallos. */
export interface TraderState {
  /** Ultima foto BUENA. Se conserva aunque despues falle. */
  readonly account: AccountSnapshot | null;
  /** Cuando se tomo esa foto buena. */
  readonly updatedAt: number | null;
  readonly error: string | null;
  readonly errorAt: number | null;
  /** Fallos seguidos. Cero tras un acierto. */
  readonly failures: number;
  /** Antes de este instante no se vuelve a intentar. */
  readonly nextAttemptAt: number;
  readonly lastAttemptAt: number | null;
}

export interface TraderTrackerOptions {
  readonly db: DatabaseSync;
  /** Lee posiciones de una direccion publica. Es el adaptador del venue. */
  readonly fetchPositions: (address: string) => Promise<AccountSnapshot | null>;
  /** Vuelta completa a todos los traders activos. */
  readonly intervalMs?: number;
  /** Tope de la espera progresiva. */
  readonly maxBackoffMs?: number;
  readonly clock?: () => number;
  /**
   * Se llama con cada lectura BUENA, con la anterior al lado.
   *
   * De aqui salen los avisos de cambio de posicion. Va aqui y no en quien
   * consume el estado porque el seguidor es el unico que ve las dos fotos
   * seguidas: quien mira `state()` solo ve la ultima. No puede lanzar, y si lo
   * hace no arrastra la vuelta de lectura.
   */
  readonly onRead?: (trader: Trader, prev: AccountSnapshot | null, next: AccountSnapshot) => void;
  /**
   * Recoger las EJECUCIONES de esa wallet, tras leer sus posiciones.
   *
   * Va aqui y no en un servicio aparte para heredar lo que ya resuelve este:
   * el reparto de peticiones dentro del intervalo, la espera progresiva tras
   * un fallo y el testigo que descarta respuestas de una wallet ya retirada.
   * Dos bucles pidiendo a la vez al mismo venue serian el doble de peticiones
   * desde una IP compartida, sin coordinarse entre ellos.
   *
   * Recibe el equity de la misma lectura de posiciones, asi que saber que
   * parte de la cuenta movia cada operacion no cuesta ni una peticion mas.
   */
  readonly onFills?: (trader: Trader, equityUsd: number | null) => Promise<void>;
}

const INTERVALO_POR_DEFECTO = 60_000;
const BACKOFF_MAXIMO = 15 * 60_000;
/** Ni con un solo trader se pide mas de una vez por segundo. */
const TICK_MINIMO = 1_000;

export class TraderTracker {
  readonly #db: DatabaseSync;
  readonly #fetchPositions: (address: string) => Promise<AccountSnapshot | null>;
  readonly #intervalMs: number;
  readonly #maxBackoffMs: number;
  readonly #clock: () => number;
  readonly #onFills: TraderTrackerOptions['onFills'];
  readonly #onRead: TraderTrackerOptions['onRead'];

  #estado = new Map<string, TraderState>();
  /**
   * Testigo por trader. Cambia al pausar, reanudar o borrar, y la respuesta
   * que traiga un testigo viejo se tira.
   */
  #testigos = new Map<string, number>();
  #siguienteTestigo = 1;
  #activos = new Set<string>();
  #enVuelo = new Set<string>();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #running = false;

  constructor(options: TraderTrackerOptions) {
    this.#db = options.db;
    this.#fetchPositions = options.fetchPositions;
    this.#intervalMs = options.intervalMs ?? INTERVALO_POR_DEFECTO;
    this.#maxBackoffMs = options.maxBackoffMs ?? BACKOFF_MAXIMO;
    this.#clock = options.clock ?? Date.now;
    this.#onRead = options.onRead;
    this.#onFills = options.onFills;
  }

  get intervalMs(): number {
    return this.#intervalMs;
  }

  /**
   * A partir de aqui un dato deja de poder presentarse como actual.
   *
   * Dos vueltas y media, el mismo criterio que el resto del proyecto: una
   * vuelta perdida puede ser un hipo, tres seguidas ya no.
   */
  get staleAfterMs(): number {
    return this.#intervalMs * 2.5;
  }

  state(id: string): TraderState | null {
    return this.#estado.get(id) ?? null;
  }

  /** Relee la lista y olvida a quien ya no esta o ha dejado de estar activo. */
  #sincronizar(): Trader[] {
    const todos = listTraders(this.#db);
    const activos = todos.filter((t) => t.active);
    const nuevos = new Set(activos.map((t) => t.id));

    const existen = new Set(todos.map((t) => t.id));
    for (const id of this.#activos) {
      if (nuevos.has(id)) continue;
      // Se invalida el testigo siempre: una respuesta que ya venia en camino
      // no puede escribir nada de alguien a quien se acaba de pausar.
      this.#testigos.delete(id);
      // PAUSADO conserva su ultima lectura, con su edad: es lo ultimo que se
      // le vio y sigue siendo cierto. Borrarla haria que la fila pasase sola
      // de "177 posiciones" a "ninguna" en el siguiente tick, sin que hubiera
      // pasado nada. ELIMINADO si se olvida entero.
      if (!existen.has(id)) this.#estado.delete(id);
    }
    this.#activos = nuevos;
    return activos;
  }

  /** Una vuelta: elige al que lleva mas tiempo sin consultarse y le toca. */
  async tick(): Promise<void> {
    const activos = this.#sincronizar();
    if (activos.length === 0) return;

    const ahora = this.#clock();
    const candidatos = activos.filter((t) => {
      if (this.#enVuelo.has(t.id)) return false;
      const e = this.#estado.get(t.id);
      return e === undefined || e.nextAttemptAt <= ahora;
    });
    if (candidatos.length === 0) return;

    // El que lleva mas tiempo sin intentarse. Sin estado previo es el primero.
    let elegido = candidatos[0]!;
    for (const t of candidatos) {
      const a = this.#estado.get(t.id)?.lastAttemptAt ?? 0;
      const b = this.#estado.get(elegido.id)?.lastAttemptAt ?? 0;
      if (a < b) elegido = t;
    }

    await this.#consultar(elegido);
  }

  async #consultar(trader: Trader): Promise<void> {
    const id = trader.id;
    const testigo = this.#siguienteTestigo++;
    this.#testigos.set(id, testigo);
    this.#enVuelo.add(id);

    const previo = this.#estado.get(id);
    const inicio = this.#clock();
    this.#estado.set(id, {
      account: previo?.account ?? null,
      updatedAt: previo?.updatedAt ?? null,
      error: previo?.error ?? null,
      errorAt: previo?.errorAt ?? null,
      failures: previo?.failures ?? 0,
      nextAttemptAt: previo?.nextAttemptAt ?? inicio,
      lastAttemptAt: inicio,
    });

    try {
      const cuenta = await this.#fetchPositions(trader.address);
      if (!this.#vigente(id, testigo)) return;
      const ahora = this.#clock();
      this.#estado.set(id, {
        account: cuenta,
        updatedAt: ahora,
        error: null,
        errorAt: null,
        failures: 0,
        nextAttemptAt: ahora,
        lastAttemptAt: ahora,
      });
      if (cuenta !== null && this.#onRead !== undefined) {
        try {
          this.#onRead(trader, previo?.account ?? null, cuenta);
        } catch {
          // Los avisos no pueden romper el seguimiento. Si fallan, se pierde
          // un aviso; si se propagase, se perderian las posiciones.
        }
      }
      if (cuenta !== null && this.#onFills !== undefined) {
        try {
          await this.#onFills(trader, cuenta.equityUsd);
        } catch {
          // Mismo criterio: una recogida de ejecuciones que falla no puede
          // tumbar la lectura de posiciones, que es lo que sostiene la
          // pantalla. Se reintenta en la siguiente vuelta.
        }
      }
    } catch (err) {
      if (!this.#vigente(id, testigo)) return;
      const ahora = this.#clock();
      const anterior = this.#estado.get(id);
      const fallos = (anterior?.failures ?? 0) + 1;
      // Espera progresiva: 1, 2, 4… vueltas, con tope.
      const espera = Math.min(this.#intervalMs * 2 ** (fallos - 1), this.#maxBackoffMs);
      this.#estado.set(id, {
        // La ultima foto buena se CONSERVA. Un fallo no es "cerro todo".
        account: anterior?.account ?? null,
        updatedAt: anterior?.updatedAt ?? null,
        error: err instanceof Error ? err.message : String(err),
        errorAt: ahora,
        failures: fallos,
        nextAttemptAt: ahora + espera,
        lastAttemptAt: ahora,
      });
    } finally {
      this.#enVuelo.delete(id);
    }
  }

  /** Sigue activo y con el mismo testigo con el que se pidio. */
  #vigente(id: string, testigo: number): boolean {
    return this.#activos.has(id) && this.#testigos.get(id) === testigo;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;

    const siguiente = () => {
      // A uno recien anadido se le lee enseguida. Con el reparto normal habria
      // que esperar la vuelta entera, y un minuto mirando "no data yet" tras
      // pegar una direccion parece que la pantalla esta rota.
      for (const id of this.#activos) if (!this.#estado.has(id)) return TICK_MINIMO;

      // En regimen, el tick se reparte entre los activos para que la vuelta
      // entera quepa en el intervalo, en vez de pedirlos todos de golpe.
      const n = Math.max(1, this.#activos.size);
      return Math.max(TICK_MINIMO, Math.round(this.#intervalMs / n));
    };

    const paso = async () => {
      if (!this.#running) return;
      try {
        await this.tick();
      } catch {
        // tick() ya captura lo suyo; si algo se escapa, el bucle no puede
        // morirse en silencio.
      }
      if (this.#running) this.#timer = setTimeout(() => void paso(), siguiente());
    };

    void paso();
  }

  stop(): void {
    this.#running = false;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }
}

/** Como se le presenta al usuario el estado de un trader. */
export type TraderStatus = 'paused' | 'waiting' | 'ok' | 'stale' | 'failing';

/**
 * Traduce estado interno a algo que se pueda pintar.
 *
 * Los cuatro casos que hay que distinguir y que no son lo mismo:
 * `paused` no se consulta, `waiting` es que aun no ha llegado la primera
 * respuesta, `stale` es que hay datos pero ya no valen como actuales, y
 * `failing` es que falla y ademas nunca hubo datos. "Sin posiciones" no es
 * ninguno de estos: es `ok` con la lista vacia, y lo pinta la pantalla.
 */
export function traderStatus(
  trader: Trader,
  estado: TraderState | null,
  staleAfterMs: number,
  now: number,
): TraderStatus {
  if (!trader.active) return 'paused';
  if (estado === null || (estado.updatedAt === null && estado.error === null)) return 'waiting';
  if (estado.updatedAt === null) return 'failing';
  return now - estado.updatedAt > staleAfterMs ? 'stale' : 'ok';
}
