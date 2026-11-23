import type { DatabaseSync } from 'node:sqlite';

/**
 * Historico de interes abierto.
 *
 * Dos cosas conviven en la misma tabla y conviene no confundirlas:
 *
 *  - `symbol = '*'` es el **total del venue**, calculado sobre TODOS sus
 *    mercados. Es completo siempre.
 *  - Cualquier otro simbolo es el desglose, y solo se guarda para los mercados
 *    que pasan un minimo de tamano. La cola de mercados diminutos, por doce
 *    venues y una muestra por hora, llena la SD sin aportar nada.
 *
 * Por eso **la suma del desglose no tiene por que dar el total**, y la
 * pantalla lo dice en vez de dejar que parezca un descuadre.
 */

/** El simbolo reservado para el total de un venue. */
export const TOTAL = '*';

export interface OiPoint {
  readonly ts: number;
  readonly venue: string;
  readonly symbol: string;
  readonly oiUsd: number;
}

/** Escribe una tanda. Una transaccion por tanda, nunca un commit por fila. */
export function insertOiSnapshots(db: DatabaseSync, puntos: readonly OiPoint[]): number {
  if (puntos.length === 0) return 0;
  const stmt = db.prepare(
    'INSERT OR REPLACE INTO oi_snapshot (ts, venue, symbol, oi_usd) VALUES (?, ?, ?, ?)',
  );
  db.exec('BEGIN');
  try {
    for (const p of puntos) stmt.run(p.ts, p.venue, p.symbol, p.oiUsd);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return puntos.length;
}

export interface OiSeriesQuery {
  readonly from: number;
  readonly to: number;
  /** `'*'` para los totales de venue. Un simbolo para el desglose. */
  readonly symbol: string;
  /** Vacio = todos los venues que haya. */
  readonly venues?: readonly string[];
  /**
   * Agrupa los puntos en cubos de este tamano y se queda con el ULTIMO de
   * cada cubo. Se queda con el ultimo y no con la media a proposito: el
   * interes abierto es un saldo, no un flujo, y promediarlo inventa un valor
   * que no existio en ningun instante.
   */
  readonly bucketMs?: number;
}

/**
 * Serie para la grafica.
 *
 * Devuelve puntos sueltos, no una linea: quien pinta decide que hacer con los
 * huecos. Aqui no se rellena nada, porque un tramo sin recogida no es un tramo
 * plano, es un tramo que no sabemos.
 */
export function oiSeries(db: DatabaseSync, q: OiSeriesQuery): OiPoint[] {
  const cubo = Math.max(1, Math.trunc(q.bucketMs ?? 1));
  const venues = q.venues ?? [];
  const filtro = venues.length === 0 ? '' : ` AND venue IN (${venues.map(() => '?').join(',')})`;

  // El tamano del cubo va ESCRITO en la consulta, no como parametro.
  // Comprobado: un `?` dentro de un GROUP BY no agrupa, devuelve una fila por
  // muestra como si no hubiera agrupacion, y la grafica salia con todos los
  // puntos en crudo por mucho que se pidiese una resolucion. No es inyeccion:
  // es un entero que calcula este modulo, y se fuerza a serlo.
  const filas = db.prepare(`
    SELECT venue, MAX(ts) AS ts, oi_usd
    FROM oi_snapshot
    WHERE symbol = ? AND ts >= ? AND ts <= ?${filtro}
    GROUP BY venue, ts / ${cubo}
    ORDER BY ts ASC
  `).all(q.symbol, q.from, q.to, ...venues) as Record<string, unknown>[];

  return filas.map((r) => ({
    ts: Number(r['ts']),
    venue: String(r['venue']),
    symbol: q.symbol,
    oiUsd: Number(r['oi_usd']),
  }));
}

/** De cuando es el dato mas viejo que se guarda, para poder decirlo. */
export function oiCoverage(db: DatabaseSync, symbol: string = TOTAL, venues?: readonly string[]): { from: number | null; to: number | null } {
  if (venues?.length === 0) return { from: null, to: null };
  const filter = venues === undefined ? '' : ' AND venue IN (' + venues.map(() => '?').join(',') + ')';
  const r = db.prepare('SELECT MIN(ts) a, MAX(ts) b FROM oi_snapshot WHERE symbol = ?' + filter).get(symbol, ...(venues ?? [])) as
    { a: number | null; b: number | null };
  return { from: r.a === null ? null : Number(r.a), to: r.b === null ? null : Number(r.b) };
}

export interface OiRetention {
  /** Dias que se conserva el desglose por simbolo. */
  readonly symbolDays: number;
  /** Dias que se conservan los totales, que ocupan mil veces menos. */
  readonly totalDays: number;
}

export const OI_RETENTION: OiRetention = { symbolDays: 30, totalDays: 365 };

const DIA = 86_400_000;

/** Purga lo viejo. Devuelve cuantas filas se fueron. */
export function pruneOi(db: DatabaseSync, policy: OiRetention = OI_RETENTION, now: number = Date.now()): number {
  const porSimbolo = db
    .prepare('DELETE FROM oi_snapshot WHERE symbol != ? AND ts < ?')
    .run(TOTAL, now - policy.symbolDays * DIA).changes;
  const totales = db
    .prepare('DELETE FROM oi_snapshot WHERE symbol = ? AND ts < ?')
    .run(TOTAL, now - policy.totalDays * DIA).changes;
  return Number(porSimbolo) + Number(totales);
}

/**
 * Inserta SIN pisar: para el historico rellenado desde fuera (DefiLlama,
 * Bybit). Si ya hay un punto medido con el mismo sello, gana el medido.
 */
export function insertOiIfAbsent(db: DatabaseSync, puntos: readonly OiPoint[]): number {
  if (puntos.length === 0) return 0;
  const stmt = db.prepare('INSERT OR IGNORE INTO oi_snapshot (ts, venue, symbol, oi_usd) VALUES (?, ?, ?, ?)');
  let n = 0;
  db.exec('BEGIN');
  try {
    for (const p of puntos) n += Number(stmt.run(p.ts, p.venue, p.symbol, p.oiUsd).changes);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return n;
}

/**
 * El ultimo valor de cada venue y simbolo dentro de una ventana que acaba en
 * `ts`. Para comparar "ahora" con "hace 24 h": si un venue no tiene punto en
 * la ventana no aparece, y quien compara lo deja fuera de las dos fotos.
 *
 * `symbol` null trae todos los simbolos (sin los totales); un simbolo, solo
 * ese; `TOTAL`, los totales de venue.
 */
export function oiAt(
  db: DatabaseSync,
  q: { ts: number; toleranceMs: number; symbol: string | null; venues?: readonly string[] },
): Map<string, Map<string, number>> {
  const venues = q.venues ?? [];
  const filtroVenue = venues.length > 0 ? ` AND venue IN (${venues.map(() => '?').join(',')})` : '';
  const filtroSimbolo = q.symbol === null ? ` AND symbol != '${TOTAL}'` : ' AND symbol = ?';
  const filas = db.prepare(
    `SELECT venue, symbol, oi_usd FROM oi_snapshot
      WHERE ts >= ? AND ts <= ?${filtroSimbolo}${filtroVenue}
      ORDER BY ts ASC`,
  ).all(q.ts - q.toleranceMs, q.ts, ...(q.symbol === null ? [] : [q.symbol]), ...venues) as { venue: string; symbol: string; oi_usd: number }[];
  const out = new Map<string, Map<string, number>>();
  for (const f of filas) {
    const porVenue = out.get(f.symbol) ?? new Map<string, number>();
    porVenue.set(f.venue, f.oi_usd);
    out.set(f.symbol, porVenue);
  }
  return out;
}

/**
 * Borra lo rellenado de un venue (los puntos de inicio de dia UTC desde
 * `desde`). Para cuando se descubre que su historico de fuera no mide lo mismo
 * que lo nuestro: mejor un hueco que una serie que mezcla dos magnitudes.
 */
export function borrarRellenoOi(db: DatabaseSync, venue: string, desde: number): number {
  return Number(db.prepare(
    `DELETE FROM oi_snapshot WHERE venue = ? AND symbol = '${TOTAL}' AND ts >= ? AND ts % 86400000 = 0`,
  ).run(venue, desde).changes);
}
