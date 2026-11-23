import type { DatabaseSync } from 'node:sqlite';
import type { MarketSnapshot } from '@defi/core';
import { transaction } from './db.ts';
import { purgeHourly, rollupHourly, writeSnapshots } from './market.ts';

const DIA = 86_400_000;

/**
 * Decide CUANDO se escribe a disco.
 *
 * La recogida va a 60 s para que la vista en vivo sea en vivo, pero volcar cada
 * ciclo son 2,8 millones de filas al dia y eso mata una tarjeta SD en meses.
 * Este objeto se llama en cada ciclo y solo escribe cuando toca.
 */
export class SnapshotPersister {
  #db: DatabaseSync;
  #intervalMs: number;
  #clock: () => number;
  #lastWriteAt: number | null = null;

  constructor(options: { db: DatabaseSync; intervalMs: number; clock?: () => number }) {
    this.#db = options.db;
    this.#intervalMs = options.intervalMs;
    this.#clock = options.clock ?? Date.now;
  }

  /** Instante del ultimo volcado, o null si aun no ha habido ninguno. */
  get lastWriteAt(): number | null {
    return this.#lastWriteAt;
  }

  /** true si el proximo ciclo escribiria. */
  get dueNow(): boolean {
    return this.#lastWriteAt === null || this.#clock() - this.#lastWriteAt >= this.#intervalMs;
  }

  /**
   * Escribe si ha pasado el intervalo. Devuelve las filas escritas, o 0 si no
   * tocaba. El primer ciclo siempre escribe, para no esperar cinco minutos a
   * tener el primer dato en la base.
   */
  maybePersist(snapshots: ReadonlyMap<string, ReadonlyMap<string, MarketSnapshot>>): number {
    if (!this.dueNow) return 0;
    const ts = this.#clock();
    const written = writeSnapshots(this.#db, ts, snapshots);
    this.#lastWriteAt = ts;
    return written;
  }
}

/** Estado de una fuente, como dato plano: storage no depende de collector. */
export interface HealthRow {
  readonly source: string;
  readonly status: string;
  readonly reason: string | null;
  readonly symbolCount: number | null;
  readonly latencyP50Ms: number | null;
}

/** Guarda el estado de las fuentes. Alimenta el uptime de Data Sources. */
export function writeHealth(db: DatabaseSync, ts: number, rows: readonly HealthRow[]): number {
  const insert = db.prepare(
    `INSERT OR REPLACE INTO source_health
       (ts, source, status, reason, symbol_count, latency_p50_ms)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  return transaction(db, () => {
    for (const r of rows) {
      insert.run(ts, r.source, r.status, r.reason, r.symbolCount, r.latencyP50Ms);
    }
    return rows.length;
  });
}

export interface Uptime {
  readonly source: string;
  /** Fraccion de muestras en 'ok' sobre el total del periodo. */
  readonly okRatio: number;
  readonly samples: number;
}

/**
 * Uptime por fuente en una ventana.
 *
 * Devuelve solo fuentes con alguna muestra: una fuente sin datos no tiene un
 * uptime del 0 %, tiene un uptime desconocido, y la UI debe pintar "—".
 */
export function readUptime(db: DatabaseSync, from: number, to: number): Uptime[] {
  const rows = db
    .prepare(
      `SELECT source,
              SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) * 1.0 / COUNT(*) AS ok_ratio,
              COUNT(*) AS samples
         FROM source_health
        WHERE ts >= ? AND ts <= ?
        GROUP BY source
        ORDER BY source`,
    )
    .all(from, to) as Record<string, unknown>[];

  return rows.map((r) => ({
    source: String(r['source']),
    okRatio: Number(r['ok_ratio']),
    samples: Number(r['samples']),
  }));
}

export interface RetentionPolicy {
  /** Dias a resolucion completa antes de comprimir a agregados por hora. */
  readonly fullDays: number;
  /** Dias de agregados por hora antes de purgar. */
  readonly hourlyDays: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = { fullDays: 14, hourlyDays: 365 };

export interface RetentionResult {
  readonly agregadas: number;
  readonly borradas: number;
  readonly purgadas: number;
  readonly saludBorrada: number;
}

/**
 * ¿Queda trabajo de retencion pendiente?
 *
 * Se pregunta a los DATOS, no a un temporizador. Antes el ciclo se disparaba
 * con un `ultimaRetencion = Date.now()` en memoria, inicializado al arrancar:
 * en una Raspberry que se reinicia por un corte de luz, un despliegue o un
 * fallo, el contador volvia a cero cada vez y la retencion **no se ejecutaba
 * nunca**. La base crecia sin comprimir y sin que nadie se enterase.
 *
 * Preguntando por el dato mas viejo no hay estado que perder: tras cualquier
 * reinicio, el primer ciclo ve el trabajo atrasado y lo hace. Y como
 * `rollupHourly` alinea el corte a la hora en punto, repetirlo no duplica ni
 * pierde nada: si no queda nada que comprimir, no toca nada.
 *
 * La consulta es barata: `ts` es la primera columna de la clave primaria de
 * `market_snapshot`, asi que el minimo se resuelve por indice.
 */
export function retentionPending(
  db: DatabaseSync,
  policy: RetentionPolicy = DEFAULT_RETENTION,
  now: number = Date.now(),
): boolean {
  const cortesFull = now - policy.fullDays * DIA;
  const cortesHourly = now - policy.hourlyDays * DIA;

  const masViejo = db.prepare('SELECT MIN(ts) AS t FROM market_snapshot').get() as { t: number | null };
  // El corte se alinea igual que en rollupHourly: si el dato mas viejo cae en
  // la hora que el corte parte, esa hora todavia no esta cerrada y no hay nada
  // que hacer. Sin esta alineacion se dispararia un pase en balde cada ciclo.
  const corteAlineado = Math.floor(cortesFull / 3_600_000) * 3_600_000;
  if (masViejo.t !== null && masViejo.t < corteAlineado) return true;

  const horaMasVieja = db.prepare('SELECT MIN(hour) AS h FROM market_hourly').get() as { h: number | null };
  if (horaMasVieja.h !== null && horaMasVieja.h < cortesHourly) return true;

  const saludMasVieja = db.prepare('SELECT MIN(ts) AS t FROM source_health').get() as { t: number | null };
  return saludMasVieja.t !== null && saludMasVieja.t < cortesHourly;
}

/**
 * Comprime y purga. Solo toca datos de mercado y de salud: los datos del
 * usuario (wallets, operaciones, ingresos) NO se purgan nunca.
 */
export function runRetention(
  db: DatabaseSync,
  policy: RetentionPolicy = DEFAULT_RETENTION,
  now: number = Date.now(),
): RetentionResult {
  const cortesFull = now - policy.fullDays * DIA;
  const cortesHourly = now - policy.hourlyDays * DIA;

  const { agregadas, borradas } = rollupHourly(db, cortesFull);
  const purgadas = purgeHourly(db, cortesHourly);
  const saludBorrada = Number(
    db.prepare('DELETE FROM source_health WHERE ts < ?').run(cortesHourly).changes,
  );

  return { agregadas, borradas, purgadas, saludBorrada };
}
