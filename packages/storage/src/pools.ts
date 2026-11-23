import type { DatabaseSync } from 'node:sqlite';
import { transaction } from './db.ts';

/**
 * Historico diario del APY de cada pool.
 *
 * ## Por que existe
 *
 * DefiLlama publica la media de 30 dias (`apyMean30d`) pero NO la de 7 ni la
 * de 15. Sus `apyPct7D` y `apyPct30D` no son medias: son cuanto ha cambiado
 * el APY en ese plazo. Su endpoint de historico por pool trae todos los dias
 * desde 2022 (unos 250 KB por pool): pedirlo para las miles de pools grandes
 * serian cientos de megas, que no es un uso razonable de una API gratuita.
 *
 * Asi que se guarda aqui el APY de cada dia, una fila por pool y dia, y las
 * medias de 7 y 15 dias salen de esta tabla.
 *
 * ## Que se guarda
 *
 * Solo pools con al menos 100 K$ de TVL (unas 7.000 de las 15.000): por debajo
 * el APY es ruido y la tabla creceria sin aportar. Y el ULTIMO valor del dia:
 * DefiLlama lo recalcula cada hora y el de la ultima lectura es el mas cercano
 * a su cierre diario, que es lo que publica en su propio historico.
 */

export const DIA_MS = 86_400_000;

/** Por debajo de esto no se guarda: ver la cabecera. */
export const TVL_MINIMO_HISTORICO = 100_000;

/** Lo que hace falta de cada pool para guardarla. */
export interface PoolParaHistorico {
  readonly id: string;
  readonly apy: number | null;
  readonly tvlUsd: number;
}

/** Inicio del dia UTC de un instante. */
export function diaUtc(ts: number): number {
  return Math.floor(ts / DIA_MS) * DIA_MS;
}

/**
 * Guarda el APY de hoy de cada pool. Se puede llamar cada hora: la fila del dia
 * se reescribe con el ultimo valor. Un APY desconocido no se guarda como cero.
 */
export function writePoolDaily(db: DatabaseSync, ts: number, pools: readonly PoolParaHistorico[]): number {
  const dia = diaUtc(ts);
  const insert = db.prepare(
    'INSERT OR REPLACE INTO pool_apy_daily (day, pool, apy, tvl_usd) VALUES (?, ?, ?, ?)',
  );
  return transaction(db, () => {
    let n = 0;
    for (const p of pools) {
      if (p.apy === null || !Number.isFinite(p.apy) || p.tvlUsd < TVL_MINIMO_HISTORICO) continue;
      insert.run(dia, p.id, p.apy, p.tvlUsd);
      n += 1;
    }
    return n;
  });
}

/** Borra lo anterior a `antesDe`. */
export function prunePoolDaily(db: DatabaseSync, antesDe: number): number {
  return Number(db.prepare('DELETE FROM pool_apy_daily WHERE day < ?').run(antesDe).changes);
}

/** Media de una ventana y cuantos dias la respaldan. */
export interface MediaVentana {
  /** null si no hay dias suficientes: ver `MINIMO_DIAS`. */
  readonly mean: number | null;
  readonly days: number;
}

/**
 * Dias minimos para dar una media. Una "media de 7 dias" con dos dias es la
 * media de dos dias, y presentarla como de siete seria mentir con un calculo
 * correcto. Se toleran algunos huecos (la app parada un rato) pero no mas.
 */
export const MINIMO_DIAS: Readonly<Record<7 | 15, number>> = { 7: 5, 15: 11 };

export interface MediasPools {
  readonly porPool: ReadonlyMap<string, { readonly d7: MediaVentana; readonly d15: MediaVentana }>;
  /** Dias distintos recogidos en los ultimos 15: cuanto historico hay. */
  readonly diasRecogidos: number;
}

/**
 * Medias de 7 y 15 dias de todas las pools, contando hoy.
 *
 * Una sola consulta para todas: la pantalla ordena por estas columnas y el
 * orden se hace en el servidor sobre las miles de pools, no sobre las 80 que
 * se pintan.
 */
export function readPoolMeans(db: DatabaseSync, ahora: number): MediasPools {
  const hoy = diaUtc(ahora);
  const desde7 = hoy - 6 * DIA_MS;
  const desde15 = hoy - 14 * DIA_MS;
  const filas = db.prepare(
    `SELECT pool,
            AVG(CASE WHEN day >= ? THEN apy END) AS m7,
            COUNT(CASE WHEN day >= ? THEN 1 END) AS d7,
            AVG(apy) AS m15,
            COUNT(*) AS d15
       FROM pool_apy_daily
      WHERE day >= ?
      GROUP BY pool`,
  ).all(desde7, desde7, desde15) as { pool: string; m7: number | null; d7: number; m15: number; d15: number }[];

  const porPool = new Map<string, { d7: MediaVentana; d15: MediaVentana }>();
  for (const f of filas) {
    porPool.set(f.pool, {
      d7: { mean: f.d7 >= MINIMO_DIAS[7] ? f.m7 : null, days: f.d7 },
      d15: { mean: f.d15 >= MINIMO_DIAS[15] ? f.m15 : null, days: f.d15 },
    });
  }
  const r = db.prepare('SELECT COUNT(DISTINCT day) AS n FROM pool_apy_daily WHERE day >= ?').get(desde15) as { n: number };
  return { porPool, diasRecogidos: r.n };
}
