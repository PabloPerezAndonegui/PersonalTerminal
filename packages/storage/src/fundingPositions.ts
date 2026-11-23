import type { DatabaseSync } from 'node:sqlite';

/**
 * Registro de arbitrajes de funding.
 *
 * Dato del usuario: no se purga nunca y entra en la copia de seguridad. En la
 * version anterior de la app esto vivia en el navegador; aqui vive en el
 * servidor, para poder verlo desde el movil y para que no se pierda al cambiar
 * de navegador.
 *
 * Los importes son `null` mientras no se sepan, jamas 0. "No he cobrado
 * funding" y "no se cuanto he cobrado" son afirmaciones distintas, y este
 * registro existe precisamente para distinguirlas.
 */

export interface FundingPosition {
  readonly id: string;
  readonly symbol: string;
  readonly longVenue: string;
  readonly shortVenue: string;
  readonly notionalUsd: number;
  readonly openedAt: number;
  /** null = sigue abierta. */
  readonly closedAt: number | null;
  readonly feesPaidUsd: number | null;
  readonly fundingCollectedUsd: number | null;
  readonly notes: string | null;
  readonly createdAt: number;
}

export interface NewFundingPosition {
  readonly symbol: string;
  readonly longVenue: string;
  readonly shortVenue: string;
  readonly notionalUsd: number;
  readonly openedAt: number;
  readonly closedAt?: number | null;
  readonly feesPaidUsd?: number | null;
  readonly fundingCollectedUsd?: number | null;
  readonly notes?: string | null;
}

function toPosition(row: Record<string, unknown>): FundingPosition {
  const opt = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    id: String(row['id']),
    symbol: String(row['symbol']),
    longVenue: String(row['long_venue']),
    shortVenue: String(row['short_venue']),
    notionalUsd: Number(row['notional_usd']),
    openedAt: Number(row['opened_at']),
    closedAt: opt(row['closed_at']),
    feesPaidUsd: opt(row['fees_paid_usd']),
    fundingCollectedUsd: opt(row['funding_collected_usd']),
    notes: row['notes'] === null || row['notes'] === undefined ? null : String(row['notes']),
    createdAt: Number(row['created_at']),
  };
}

export function addFundingPosition(
  db: DatabaseSync,
  p: NewFundingPosition,
  now: number = Date.now(),
): FundingPosition {
  const symbol = p.symbol.trim().toUpperCase();
  if (symbol === '') throw new Error('symbol is required');
  if (p.longVenue.trim() === '' || p.shortVenue.trim() === '') throw new Error('both venues are required');
  if (p.longVenue === p.shortVenue) throw new Error('both legs cannot be on the same venue');
  if (!Number.isFinite(p.notionalUsd) || p.notionalUsd <= 0) throw new Error('notional must be positive');
  if (p.closedAt != null && p.closedAt < p.openedAt) {
    throw new Error('the close date is before the open date');
  }

  const id = `${symbol}-${p.openedAt}-${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(
    `INSERT INTO funding_position
       (id, symbol, long_venue, short_venue, notional_usd, opened_at, closed_at,
        fees_paid_usd, funding_collected_usd, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, symbol, p.longVenue.trim(), p.shortVenue.trim(), p.notionalUsd, p.openedAt,
    p.closedAt ?? null, p.feesPaidUsd ?? null, p.fundingCollectedUsd ?? null,
    p.notes ?? null, now,
  );

  const guardada = getFundingPosition(db, id);
  if (guardada === null) throw new Error('could not save the position');
  return guardada;
}

export function getFundingPosition(db: DatabaseSync, id: string): FundingPosition | null {
  const row = db.prepare('SELECT * FROM funding_position WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row === undefined ? null : toPosition(row);
}

/** Abiertas primero y, dentro de cada grupo, la mas reciente arriba. */
export function listFundingPositions(db: DatabaseSync): FundingPosition[] {
  const rows = db
    .prepare(
      `SELECT * FROM funding_position
        ORDER BY (closed_at IS NOT NULL) ASC, opened_at DESC`,
    )
    .all() as Record<string, unknown>[];
  return rows.map(toPosition);
}

export interface FundingPositionPatch {
  readonly closedAt?: number | null;
  readonly feesPaidUsd?: number | null;
  readonly fundingCollectedUsd?: number | null;
  readonly notes?: string | null;
}

/**
 * Actualiza solo los campos presentes.
 *
 * `undefined` significa "no tocar" y `null` significa "ponlo a desconocido".
 * Sin esa distincion no habria forma de borrar un importe que se metio mal.
 */
export function updateFundingPosition(
  db: DatabaseSync,
  id: string,
  patch: FundingPositionPatch,
): FundingPosition | null {
  const actual = getFundingPosition(db, id);
  if (actual === null) return null;

  const closedAt = patch.closedAt === undefined ? actual.closedAt : patch.closedAt;
  if (closedAt != null && closedAt < actual.openedAt) {
    throw new Error('the close date is before the open date');
  }

  db.prepare(
    `UPDATE funding_position
        SET closed_at = ?, fees_paid_usd = ?, funding_collected_usd = ?, notes = ?
      WHERE id = ?`,
  ).run(
    closedAt,
    patch.feesPaidUsd === undefined ? actual.feesPaidUsd : patch.feesPaidUsd,
    patch.fundingCollectedUsd === undefined ? actual.fundingCollectedUsd : patch.fundingCollectedUsd,
    patch.notes === undefined ? actual.notes : patch.notes,
    id,
  );
  return getFundingPosition(db, id);
}

export function removeFundingPosition(db: DatabaseSync, id: string): boolean {
  return Number(db.prepare('DELETE FROM funding_position WHERE id = ?').run(id).changes) > 0;
}

// --- Cambios de tamano -------------------------------------------------------

export interface SizeChange {
  readonly id: string;
  readonly positionId: string;
  /** Desde cuando esta vigente este nocional. */
  readonly at: number;
  /** Nocional POR PATA a partir de `at`, en USD. 0 = cerrada del todo. */
  readonly notionalUsd: number;
  readonly note: string | null;
  readonly createdAt: number;
}

export function addSizeChange(
  db: DatabaseSync,
  c: { positionId: string; at: number; notionalUsd: number; note?: string | null },
  now: number = Date.now(),
): SizeChange {
  const pos = getFundingPosition(db, c.positionId);
  if (pos === null) throw new Error('that position does not exist');
  if (!Number.isFinite(c.at) || c.at < pos.openedAt) {
    throw new Error('the change cannot predate the position');
  }
  if (!Number.isFinite(c.notionalUsd) || c.notionalUsd < 0) {
    throw new Error('notional cannot be negative');
  }

  const id = `sz-${c.at}-${Math.random().toString(36).slice(2, 6)}`;
  db.prepare(
    `INSERT INTO position_size_change (id, position_id, at, notional_usd, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, c.positionId, c.at, c.notionalUsd, c.note ?? null, now);

  return { id, positionId: c.positionId, at: c.at, notionalUsd: c.notionalUsd, note: c.note ?? null, createdAt: now };
}

export function listSizeChanges(db: DatabaseSync, positionId: string): SizeChange[] {
  const rows = db
    .prepare('SELECT * FROM position_size_change WHERE position_id = ? ORDER BY at ASC')
    .all(positionId) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: String(r['id']),
    positionId: String(r['position_id']),
    at: Number(r['at']),
    notionalUsd: Number(r['notional_usd']),
    note: r['note'] === null || r['note'] === undefined ? null : String(r['note']),
    createdAt: Number(r['created_at']),
  }));
}

export function removeSizeChange(db: DatabaseSync, id: string): boolean {
  return Number(db.prepare('DELETE FROM position_size_change WHERE id = ?').run(id).changes) > 0;
}

// --- Metricas derivadas ------------------------------------------------------

export interface PositionMetrics {
  /** Horas que lleva abierta, o que duro. */
  readonly hours: number;
  /**
   * Interes abierto por hora, **de UNA pata**: la integral del nocional a lo
   * largo del tiempo, no el nocional inicial por las horas.
   *
   * Que sea de una pata importa: una posicion delta-neutral genera este mismo
   * OI-hora en CADA uno de los dos venues, asi que el total de la operacion es
   * el doble. Se deja por pata porque es lo que cuenta cada venue por separado
   * en su programa, que es con lo que se comparan entre si.
   *
   * Si la posicion cambio de tamano, cada tramo pesa por su duracion. Antes se
   * calculaba con el nocional inicial durante toda la vida de la posicion: una
   * que paso de 10k a 30k salia con un tercio de su OI-hora real, y el coste
   * por 1k OI-h con el que se comparan venues quedaba inflado al triple.
   */
  readonly oiHours: number;
  /** funding cobrado - fees pagadas. null si falta cualquiera de los dos. */
  readonly netUsd: number | null;
  /**
   * Coste por cada 1.000 OI·h. **Cuanto mas negativo, mejor**: significa que
   * ademas de generar actividad te han pagado por hacerlo.
   */
  readonly costPer1kOiHours: number | null;
}

export interface FundingEstimate {
  /** Funding neto devengado segun NUESTRO historico, en USD. */
  readonly estimatedUsd: number;
  /** Fraccion del periodo cubierta por muestras. 1 = cubierto entero. */
  readonly coverage: number;
  /** Muestras con las dos patas a la vez que respaldan el calculo. */
  readonly samples: number;
}

/**
 * Funding devengado por la posicion segun el historico que hemos ido guardando.
 *
 * Es un contraste independiente de lo que el usuario anota a mano: si lo que
 * cobro se aleja mucho de esto, o se equivoco al apuntarlo, o el venue no pago
 * lo que publicaba. Ninguna de las dos cosas conviene descubrirla tarde.
 *
 * Se integra el diferencial (corto - largo) en el tiempo, usando cada muestra
 * hasta la siguiente. **`coverage` es la parte del calculo que no se puede
 * ignorar**: con el 10 % del periodo cubierto, la estimacion no vale nada, y la
 * pantalla tiene que decirlo en vez de presentar un numero con aplomo.
 */
/**
 * Cuanto tiempo puede representar UNA muestra de funding.
 *
 * Una hora, porque es cada cuanto liquidan cuatro de los cinco venues: una
 * lectura dice cual era la tasa de esa hora, y nada de la siguiente.
 */
const HORAS_POR_MUESTRA = 1;

export function estimateFundingFromHistory(
  db: DatabaseSync,
  p: FundingPosition,
  now: number = Date.now(),
): FundingEstimate {
  const desde = p.openedAt;
  const hasta = p.closedAt ?? now;
  if (hasta <= desde) return { estimatedUsd: 0, coverage: 0, samples: 0 };

  const rows = db
    .prepare(
      `SELECT ts, venue, funding_hourly
         FROM market_snapshot
        WHERE symbol = ? AND venue IN (?, ?) AND ts >= ? AND ts <= ?
        ORDER BY ts ASC`,
    )
    .all(p.symbol, p.longVenue, p.shortVenue, desde, hasta) as Record<string, unknown>[];

  // Agrupar por instante: solo sirven las fotos en las que estan las DOS patas.
  const porInstante = new Map<number, { long?: number; short?: number }>();
  for (const r of rows) {
    const ts = Number(r['ts']);
    const venue = String(r['venue']);
    const rate = Number(r['funding_hourly']);
    const e = porInstante.get(ts) ?? {};
    if (venue === p.longVenue) e.long = rate;
    if (venue === p.shortVenue) e.short = rate;
    porInstante.set(ts, e);
  }

  const completos = [...porInstante.entries()]
    .filter(([, e]) => e.long !== undefined && e.short !== undefined)
    .sort(([a], [b]) => a - b);

  if (completos.length === 0) return { estimatedUsd: 0, coverage: 0, samples: 0 };

  let usd = 0;
  let horasCubiertas = 0;

  for (let i = 0; i < completos.length; i++) {
    const actual = completos[i];
    if (actual === undefined) continue;
    const [ts, tasas] = actual;
    const siguiente = completos[i + 1]?.[0] ?? hasta;
    // Una muestra habla como mucho de SU hora, no de todo lo que venga
    // despues. Sin este tope, una sola foto se estiraba hasta el final del
    // periodo: una posicion abierta hace una semana, con una unica lectura,
    // daba 100 % de cobertura y 168 USD estimados. La cobertura existe justo
    // para decir cuanto del calculo tiene datos detras, asi que inflarla la
    // vuelve inutil. En marcha normal el tope no toca nada: las fotos van cada
    // 5 minutos y solo se aplica donde de verdad faltan datos.
    const horas = Math.min((siguiente - ts) / 3_600_000, HORAS_POR_MUESTRA);
    if (horas <= 0) continue;

    // El corto cobra su funding y el largo paga el suyo.
    const diferencial = (tasas.short ?? 0) - (tasas.long ?? 0);
    usd += diferencial * p.notionalUsd * horas;
    horasCubiertas += horas;
  }

  const horasTotales = (hasta - desde) / 3_600_000;
  return {
    estimatedUsd: usd,
    coverage: horasTotales > 0 ? Math.min(1, horasCubiertas / horasTotales) : 0,
    samples: completos.length,
  };
}

/**
 * Metricas de una posicion.
 *
 * `changes` son los cambios de tamano ya ordenados por fecha. Se pasan en vez
 * de leerse aqui para que la funcion siga siendo pura y testeable sin base de
 * datos; `positionMetricsFromDb` es el atajo que los lee.
 */
export function positionMetrics(
  p: FundingPosition,
  now: number = Date.now(),
  changes: readonly SizeChange[] = [],
): PositionMetrics {
  const fin = p.closedAt ?? now;
  const hours = Math.max(0, (fin - p.openedAt) / 3_600_000);

  // Integral del nocional en el tiempo: cada tramo pesa por lo que duro.
  // Los cambios posteriores al cierre no cuentan, y uno anterior a la apertura
  // no deberia existir (addSizeChange lo rechaza), pero si llegara se recorta.
  let oiHours = 0;
  let desde = p.openedAt;
  let vigente = p.notionalUsd;
  for (const c of [...changes].sort((a, b) => a.at - b.at)) {
    const hasta = Math.min(c.at, fin);
    if (hasta > desde) {
      oiHours += vigente * ((hasta - desde) / 3_600_000);
      // Avanzar el inicio del tramo aunque el cambio se haya recortado al
      // cierre: sin esto, un cambio con fecha posterior al cierre cerraba el
      // tramo y luego la cola volvia a sumarlo entero, doblando el OI-hora.
      desde = hasta;
    }
    if (c.at <= fin) vigente = c.notionalUsd;
  }
  if (fin > desde) oiHours += vigente * ((fin - desde) / 3_600_000);

  const netUsd =
    p.fundingCollectedUsd === null || p.feesPaidUsd === null
      ? null
      : p.fundingCollectedUsd - p.feesPaidUsd;

  return {
    hours,
    oiHours,
    netUsd,
    // El coste se expresa como lo contrario del neto: un neto positivo es un
    // coste negativo, o sea, te han pagado por farmear.
    costPer1kOiHours: netUsd === null || oiHours <= 0 ? null : -netUsd / (oiHours / 1000),
  };
}

/** `positionMetrics` leyendo de la base los cambios de tamano de la posicion. */
export function positionMetricsFromDb(
  db: DatabaseSync,
  p: FundingPosition,
  now: number = Date.now(),
): PositionMetrics {
  return positionMetrics(p, now, listSizeChanges(db, p.id));
}
