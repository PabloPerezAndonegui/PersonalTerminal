import type { DatabaseSync } from 'node:sqlite';
import type { MarketSnapshot } from '@defi/core';
import { toHourly } from '@defi/core';
import { transaction } from './db.ts';

/** Una muestra de la serie temporal, ya normalizada. */
export interface MarketPoint {
  readonly ts: number;
  readonly venue: string;
  readonly symbol: string;
  readonly mid: number;
  readonly fundingHourly: number;
  readonly openInterestUsd: number | null;
  readonly volume24hUsd: number | null;
}

export interface SeriesQuery {
  readonly symbol: string;
  readonly from: number;
  readonly to: number;
  /** Si se omite, todos los venues. */
  readonly venues?: readonly string[];
}

/**
 * Guarda un ciclo entero en UNA transaccion.
 *
 * Es la regla de oro para la tarjeta SD: cientos de filas, un solo commit.
 * Insertarlas sueltas serian cientos de escrituras fisicas por ciclo.
 *
 * El funding se guarda ya normalizado a tasa horaria: es la unica forma de que
 * una consulta que cruza venues con intervalos distintos (1 h, 8 h) compare
 * magnitudes homogeneas sin repetir la conversion en cada consulta.
 */
export function writeSnapshots(
  db: DatabaseSync,
  ts: number,
  snapshots: ReadonlyMap<string, ReadonlyMap<string, MarketSnapshot>>,
): number {
  const insert = db.prepare(
    `INSERT OR REPLACE INTO market_snapshot
       (ts, venue, symbol, mid, funding_hourly, open_interest_usd, volume_24h_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  return transaction(db, () => {
    let written = 0;
    for (const [venue, bySymbol] of snapshots) {
      for (const [symbol, snapshot] of bySymbol) {
        insert.run(
          ts,
          venue,
          symbol,
          snapshot.mid,
          toHourly(snapshot.funding),
          snapshot.openInterestUsd,
          snapshot.volume24hUsd,
        );
        written++;
      }
    }
    return written;
  });
}

/** Serie temporal de un simbolo, para Parity y el historico de funding. */
export function readSeries(db: DatabaseSync, query: SeriesQuery): MarketPoint[] {
  const venues = query.venues ?? [];
  const filtroVenues = venues.length > 0 ? ` AND venue IN (${venues.map(() => '?').join(',')})` : '';

  const rows = db
    .prepare(
      `SELECT ts, venue, symbol, mid, funding_hourly, open_interest_usd, volume_24h_usd
         FROM market_snapshot
        WHERE symbol = ? AND ts >= ? AND ts <= ?${filtroVenues}
        ORDER BY ts ASC`,
    )
    .all(query.symbol, query.from, query.to, ...venues) as Record<string, unknown>[];

  return rows.map(toPoint);
}

/** Ultima foto de cada venue para un simbolo. */
export function readLatest(db: DatabaseSync, symbol: string): MarketPoint[] {
  const rows = db
    .prepare(
      `SELECT s.ts, s.venue, s.symbol, s.mid, s.funding_hourly,
              s.open_interest_usd, s.volume_24h_usd
         FROM market_snapshot s
         JOIN (SELECT venue, MAX(ts) AS ts
                 FROM market_snapshot
                WHERE symbol = ?
                GROUP BY venue) ultima
           ON ultima.venue = s.venue AND ultima.ts = s.ts
        WHERE s.symbol = ?`,
    )
    .all(symbol, symbol) as Record<string, unknown>[];

  return rows.map(toPoint);
}

/**
 * Comprime a agregados horarios todo lo anterior a `before` y borra el detalle.
 *
 * Se ejecuta periodicamente. Los graficos de evolucion leen de aqui cuando se
 * pide mas rango del que cubre la resolucion completa.
 *
 * **El corte se alinea SIEMPRE hacia abajo a la hora en punto**, y de ahi
 * depende que no se pierda historia. Con el corte a media hora, el primer pase
 * agregaba media hora, la escribia con `INSERT OR REPLACE` y borraba esas
 * fotos; al dia siguiente entraba la otra media y REESCRIBIA la fila con solo
 * esa mitad. La primera se perdia dos veces: las fotos borradas y la media
 * sobrescrita. En una prueba con tres fotos a 100 y dos a 200, la hora quedaba
 * en 200 con dos muestras en vez de 140 con cinco — una hora estropeada por
 * cada pase de retencion, o sea una al dia y para siempre.
 *
 * Alineando, una hora solo se agrega cuando esta entera, y se agrega una vez.
 * La hora en curso se queda a resolucion completa hasta el pase siguiente.
 */
export function rollupHourly(db: DatabaseSync, before: number): { agregadas: number; borradas: number } {
  const corte = Math.floor(before / 3_600_000) * 3_600_000;

  return transaction(db, () => {
    const agregadas = db
      .prepare(
        `INSERT OR REPLACE INTO market_hourly
           (hour, venue, symbol, mid_avg, funding_hourly_avg,
            open_interest_usd_avg, volume_24h_usd_avg, samples)
         SELECT (ts / 3600000) * 3600000 AS hour,
                venue, symbol,
                AVG(mid), AVG(funding_hourly),
                AVG(open_interest_usd), AVG(volume_24h_usd),
                COUNT(*)
           FROM market_snapshot
          WHERE ts < ?
          GROUP BY hour, venue, symbol`,
      )
      .run(corte);

    // El MISMO corte que la agregacion: con uno mas amplio se borrarian fotos
    // que no ha llegado a agregar nadie.
    const borradas = db.prepare('DELETE FROM market_snapshot WHERE ts < ?').run(corte);

    return {
      agregadas: Number(agregadas.changes),
      borradas: Number(borradas.changes),
    };
  });
}

/** Media de volumen 24 h por venue y simbolo dentro de una ventana. */
export interface VolumeAverage {
  readonly venue: string;
  readonly symbol: string;
  readonly avgVolume24hUsd: number;
  readonly samples: number;
  /** Horas entre la primera y la ultima muestra: cuanto respalda la media. */
  readonly coverageHours: number;
}

/**
 * Medias de volumen para las estimaciones a 7 y 30 dias.
 *
 * El volumen a 7 y 30 dias NO se mide: se estima como la media del volumen 24 h
 * registrado, multiplicada por los dias. La calidad depende de cuanto historico
 * haya, por eso se devuelve `coverageHours`: una estimacion respaldada por tres
 * horas de muestras no vale lo mismo que una de siete dias, y la pantalla tiene
 * que poder decirlo en vez de presentar las dos igual.
 */
export function readVolumeAverages(db: DatabaseSync, from: number, to: number): VolumeAverage[] {
  const rows = db
    .prepare(
      `SELECT venue, symbol,
              AVG(volume_24h_usd) AS avg_vol,
              COUNT(volume_24h_usd) AS n,
              MIN(ts) AS primera,
              MAX(ts) AS ultima
         FROM market_snapshot
        WHERE ts >= ? AND ts <= ? AND volume_24h_usd IS NOT NULL
        GROUP BY venue, symbol`,
    )
    .all(from, to) as Record<string, unknown>[];

  return rows.map((r) => ({
    venue: String(r['venue']),
    symbol: String(r['symbol']),
    avgVolume24hUsd: Number(r['avg_vol']),
    samples: Number(r['n']),
    coverageHours: (Number(r['ultima']) - Number(r['primera'])) / 3_600_000,
  }));
}

/** Purga agregados mas viejos que `before`. Los datos de usuario no se tocan. */
export function purgeHourly(db: DatabaseSync, before: number): number {
  const res = db.prepare('DELETE FROM market_hourly WHERE hour < ?').run(before);
  return Number(res.changes);
}

function toPoint(row: Record<string, unknown>): MarketPoint {
  return {
    ts: Number(row['ts']),
    venue: String(row['venue']),
    symbol: String(row['symbol']),
    mid: Number(row['mid']),
    fundingHourly: Number(row['funding_hourly']),
    // Un NULL en la base es un dato que el venue no dio. Se mantiene null hasta
    // la UI, que pinta "—". Convertirlo a 0 aqui seria inventarselo.
    openInterestUsd: row['open_interest_usd'] === null ? null : Number(row['open_interest_usd']),
    volume24hUsd: row['volume_24h_usd'] === null ? null : Number(row['volume_24h_usd']),
  };
}

/**
 * El precio de cada simbolo de un venue tal como estaba hace un rato.
 *
 * Es lo que permite dar el cambio de 24 h sin pedirle nada a nadie: el dato ya
 * esta guardado desde el 21 de septiembre, cada seis minutos. Pedirle a cada
 * venue su `prevDayPx` seria anadir un campo al snapshot de TODOS los
 * adaptadores para una columna de una pantalla.
 *
 * Se busca la ultima foto ANTERIOR a `at`, no la mas cercana: una posterior
 * daria un cambio de menos de 24 h sin decirlo. Y se acota por abajo con
 * `windowMs` para no barrer el historico entero cuando un simbolo es nuevo y
 * no existia hace un dia; en ese caso no sale en el mapa, que es distinto de
 * salir con cambio cero.
 */
export function readMidsAt(
  db: DatabaseSync,
  query: { venue: string; at: number; windowMs?: number },
): Map<string, { mid: number; ts: number }> {
  const ventana = query.windowMs ?? 6 * 3_600_000;
  const rows = db
    .prepare(
      `SELECT symbol, mid, ts FROM (
         SELECT symbol, mid, ts,
                ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY ts DESC) AS rn
           FROM market_snapshot
          WHERE venue = ? AND ts <= ? AND ts >= ?
       ) WHERE rn = 1`,
    )
    .all(query.venue, query.at, query.at - ventana) as Record<string, unknown>[];

  const out = new Map<string, { mid: number; ts: number }>();
  for (const r of rows) {
    const symbol = r['symbol'];
    const mid = Number(r['mid']);
    const ts = Number(r['ts']);
    if (typeof symbol !== 'string' || !Number.isFinite(mid) || mid <= 0) continue;
    out.set(symbol, { mid, ts });
  }
  return out;
}

/** Volumen de un dia para un mercado: la media de su volumen de 24 h ese dia. */
export interface VolumenDiario {
  /** Medianoche UTC del dia, en epoch ms. */
  readonly dia: number;
  readonly venue: string;
  readonly symbol: string;
  readonly volumeUsd: number;
}

/**
 * Volumen por dia, venue y simbolo, leyendo LAS DOS tablas.
 *
 * El crudo se guarda catorce dias y despues se agrega por horas, que se
 * guardan un ano. La consulta anterior solo miraba el crudo, asi que pedir
 * treinta dias leia catorce y multiplicaba: una cifra de treinta dias hecha
 * con menos de la mitad. Aqui se unen las dos, llevadas antes a la misma
 * resolucion (una cifra por hora) para que las horas recientes, que tienen
 * diez fotos cada una, no pesen diez veces mas que las antiguas.
 *
 * Es una ESTIMACION y se dice asi en pantalla: el venue publica volumen de
 * 24 horas moviles, y la media de ese numero a lo largo de un dia se acerca al
 * volumen del dia sin ser exactamente el.
 *
 * Un dia sin ninguna foto no sale. No es un dia de volumen cero: es un dia en
 * que la app no estaba encendida.
 */
export function readVolumenDiario(db: DatabaseSync, from: number, to: number): VolumenDiario[] {
  const rows = db
    .prepare(
      `WITH horas AS (
         SELECT venue, symbol, (ts / 3600000) * 3600000 AS hora, AVG(volume_24h_usd) AS v
           FROM market_snapshot
          WHERE ts >= ? AND ts <= ? AND volume_24h_usd IS NOT NULL
          GROUP BY venue, symbol, hora
         UNION ALL
         SELECT venue, symbol, hour AS hora, volume_24h_usd_avg AS v
           FROM market_hourly
          WHERE hour >= ? AND hour <= ? AND volume_24h_usd_avg IS NOT NULL
       )
       SELECT (hora / 86400000) * 86400000 AS dia, venue, symbol, AVG(v) AS v
         FROM horas
        GROUP BY dia, venue, symbol`,
    )
    .all(from, to, from, to) as Record<string, unknown>[];
  return rows.map((r) => ({
    dia: Number(r['dia']),
    venue: String(r['venue']),
    symbol: String(r['symbol']),
    volumeUsd: Number(r['v']),
  }));
}
