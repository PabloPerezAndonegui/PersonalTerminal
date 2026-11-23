import type { DatabaseSync } from 'node:sqlite';

/**
 * Lo sostenido que ha sido un cruce de funding.
 *
 * La pregunta que responde no es cuanto paga AHORA, que es lo que ya dice la
 * tabla, sino **donde merece la pena estar quieto**. Un diferencial del 80 %
 * anual que lleva veinte minutos y uno del 20 % que lleva tres dias se ven
 * exactamente igual en una foto, y solo el segundo se puede operar sin abrir y
 * cerrar cada rato, que es donde se van las comisiones y el spread.
 *
 * Se mide sobre el PAR concreto sostenido hacia atras, no sobre el mejor cruce
 * de cada momento. Perseguir el mejor cruce cambia de pareja sola y describe
 * una estrategia que precisamente se quiere evitar.
 *
 * Todo va **ponderado por tiempo, no por muestras**: la cadencia de recogida
 * cambia, y contar muestras haria que una hora bien muestreada pesase mas que
 * tres mal muestreadas. Los huecos de datos NO se rellenan ni se cuentan: si
 * el collector estuvo parado, ese tiempo no existe, no es tiempo a favor ni en
 * contra.
 */

export interface ParDeVenues {
  readonly symbol: string;
  /** Donde va el largo: el funding mas bajo. */
  readonly largo: string;
  /** Donde va el corto: el que cobra. */
  readonly corto: string;
}

export interface SustainabilityWindow {
  /** Milisegundos de datos SEGUIDOS, ya descontados los huecos. */
  readonly coveredMs: number;
  /** De ese tiempo, cuanto estuvo el diferencial a favor. */
  readonly favourableMs: number;
  /**
   * Tasa media por hora del periodo, ponderada por tiempo. Es lo que se habria
   * cobrado aguantando, contando tambien los ratos en contra.
   */
  readonly meanHourly: number | null;
  readonly samples: number;
}

export interface SustainabilityRow {
  readonly symbol: string;
  readonly largo: string;
  readonly corto: string;
  readonly short: SustainabilityWindow;
  readonly long: SustainabilityWindow;
}

export interface SustainabilityOptions {
  /** Ventana corta. Por defecto 7 dias. */
  readonly shortDays?: number;
  /** Ventana larga. Por defecto 14, que es lo que se guarda sin comprimir. */
  readonly longDays?: number;
  /**
   * Hueco maximo entre dos muestras para considerarlas seguidas. Por encima,
   * ese tramo no cuenta: no se sabe que paso ahi.
   */
  readonly maxGapMs?: number;
  readonly now?: number;
}

const DIA = 86_400_000;
/** Dos vueltas y media de persistencia, el mismo criterio del resto. */
const HUECO_MAXIMO = 15 * 60_000;

/**
 * Una sola consulta para todos los pares.
 *
 * El cruce se hace por sello EXACTO y sin interpolar, igual que en el resto
 * del proyecto: un punto inventado en una pantalla que busca desajustes es
 * peligroso. Y las sumas se hacen dentro de SQLite con funciones de ventana en
 * vez de traerse un millon de filas a memoria, que en una Raspberry no cabe.
 */
export function pairSustainability(
  db: DatabaseSync,
  pares: readonly ParDeVenues[],
  options: SustainabilityOptions = {},
): SustainabilityRow[] {
  if (pares.length === 0) return [];

  const ahora = options.now ?? Date.now();
  const corte = options.maxGapMs ?? HUECO_MAXIMO;
  const desdeLargo = ahora - (options.longDays ?? 14) * DIA;
  const desdeCorto = ahora - (options.shortDays ?? 7) * DIA;

  db.exec('DROP TABLE IF EXISTS temp.par_sost');
  db.exec('CREATE TEMP TABLE par_sost (symbol TEXT NOT NULL, largo TEXT NOT NULL, corto TEXT NOT NULL)');
  const ins = db.prepare('INSERT INTO par_sost (symbol, largo, corto) VALUES (?, ?, ?)');
  db.exec('BEGIN');
  try {
    for (const p of pares) ins.run(p.symbol, p.largo, p.corto);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  // Interpolacion lineal entre muestras: recorta cada ventana y calcula el
  // cruce real por cero. No se atribuye media duracion a cualquier cambio de signo.
  const filas = db.prepare(`
    WITH s AS (
      SELECT p.symbol, p.largo, p.corto, a.ts,
             b.funding_hourly - a.funding_hourly AS spread
      FROM par_sost p
      JOIN market_snapshot a ON a.symbol = p.symbol AND a.venue = p.largo AND a.ts >= ? AND a.ts <= ?
      JOIN market_snapshot b ON b.ts = a.ts AND b.symbol = a.symbol AND b.venue = p.corto
    ), d AS (
      SELECT *, LAG(ts) OVER w AS prev_ts, LAG(spread) OVER w AS prev
      FROM s WINDOW w AS (PARTITION BY symbol, largo, corto ORDER BY ts)
    ), ventanas(nombre, inicio) AS (VALUES ('largo', ?), ('corto', ?)),
    recorte AS (
      SELECT d.*, nombre, ts - MAX(prev_ts, inicio) AS duracion,
        prev + (spread - prev) * (MAX(prev_ts, inicio) - prev_ts) / (ts - prev_ts) AS inicial
      FROM d CROSS JOIN ventanas
      WHERE ts > inicio AND ts > prev_ts AND ts - prev_ts <= ?
        AND spread IS NOT NULL AND prev IS NOT NULL
    ), t AS (
      SELECT *, (inicial + spread) / 2.0 AS media,
        CASE WHEN inicial >= 0 AND spread >= 0 AND (inicial > 0 OR spread > 0) THEN 1.0
             WHEN inicial <= 0 AND spread <= 0 THEN 0.0
             WHEN inicial > 0 THEN inicial / (inicial - spread)
             ELSE spread / (spread - inicial) END AS favor
      FROM recorte
    )
    SELECT symbol, largo, corto,
      SUM(CASE WHEN nombre = 'largo' THEN duracion ELSE 0 END) AS cub_largo,
      SUM(CASE WHEN nombre = 'largo' THEN duracion * favor ELSE 0 END) AS fav_largo,
      SUM(CASE WHEN nombre = 'largo' THEN duracion * media ELSE 0 END) AS acum_largo,
      SUM(CASE WHEN nombre = 'largo' THEN 1 ELSE 0 END) AS n_largo,
      SUM(CASE WHEN nombre = 'corto' THEN duracion ELSE 0 END) AS cub_corto,
      SUM(CASE WHEN nombre = 'corto' THEN duracion * favor ELSE 0 END) AS fav_corto,
      SUM(CASE WHEN nombre = 'corto' THEN duracion * media ELSE 0 END) AS acum_corto,
      SUM(CASE WHEN nombre = 'corto' THEN 1 ELSE 0 END) AS n_corto
    FROM t GROUP BY symbol, largo, corto
  `).all(desdeLargo - corte, ahora, desdeLargo, desdeCorto, corte) as Record<string, unknown>[];

  db.exec('DROP TABLE IF EXISTS temp.par_sost');

  const ventana = (cubierto: number, favorable: number, acumulado: number, n: number): SustainabilityWindow => ({
    coveredMs: cubierto,
    favourableMs: favorable,
    // El acumulado viene como tasa por hora multiplicada por milisegundos.
    // Dividir entre el tiempo cubierto devuelve la tasa media por hora.
    meanHourly: cubierto <= 0 ? null : acumulado / cubierto,
    samples: n,
  });

  return filas.map((r) => ({
    symbol: String(r['symbol']),
    largo: String(r['largo']),
    corto: String(r['corto']),
    long: ventana(Number(r['cub_largo']), Number(r['fav_largo']), Number(r['acum_largo']), Number(r['n_largo'])),
    short: ventana(Number(r['cub_corto']), Number(r['fav_corto']), Number(r['acum_corto']), Number(r['n_corto'])),
  }));
}
