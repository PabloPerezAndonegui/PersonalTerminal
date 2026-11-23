import type { DatabaseSync } from 'node:sqlite';

/**
 * Avisos de cambio de posicion, guardados.
 *
 * Dos motivos para que esto viva en SQLite y no solo en memoria: que la
 * actividad reciente siga ahi tras reiniciar el proceso, y que se pueda decir
 * si un aviso LLEGO a salir por Telegram o solo se detecto. "No ha pasado
 * nada" y "paso y no te llego" son dos cosas distintas.
 *
 * Es un registro de observacion, asi que tiene tope de filas. Los datos del
 * usuario (wallets, operaciones, ingresos) no se purgan nunca; esto si.
 */
export interface AlertEvent {
  readonly id: number;
  readonly traderId: string;
  readonly venue: string;
  readonly address: string;
  readonly symbol: string;
  readonly kind: string;
  readonly side: string;
  readonly sizeBase: number;
  readonly prevSizeBase: number;
  readonly notionalUsd: number;
  readonly deltaUsd: number;
  readonly markPrice: number | null;
  readonly at: number;
  /** null = detectado pero NO enviado. */
  readonly notifiedAt: number | null;
}

export interface NewAlertEvent {
  readonly traderId: string;
  readonly venue: string;
  readonly address: string;
  readonly symbol: string;
  readonly kind: string;
  readonly side: string;
  readonly sizeBase: number;
  readonly prevSizeBase: number;
  readonly notionalUsd: number;
  readonly deltaUsd: number;
  readonly markPrice: number | null;
  readonly at: number;
}

/**
 * Tope de filas. A 60 s por vuelta y unos pocos traders, esto son meses de
 * actividad; y en un dia raro con mucho movimiento, sigue sin crecer sin
 * control en la SD de la Raspberry.
 */
export const MAX_ALERT_EVENTS = 5_000;

function toEvent(row: Record<string, unknown>): AlertEvent {
  return {
    id: Number(row['id']),
    traderId: String(row['trader_id']),
    venue: String(row['venue']),
    address: String(row['address']),
    symbol: String(row['symbol']),
    kind: String(row['kind']),
    side: String(row['side']),
    sizeBase: Number(row['size_base']),
    prevSizeBase: Number(row['prev_size_base']),
    notionalUsd: Number(row['notional_usd']),
    deltaUsd: Number(row['delta_usd']),
    markPrice: row['mark_price'] === null ? null : Number(row['mark_price']),
    at: Number(row['at']),
    notifiedAt: row['notified_at'] === null ? null : Number(row['notified_at']),
  };
}

/**
 * Guarda una tanda y devuelve los identificadores en el mismo orden.
 *
 * Hacen falta despues para marcar cuales salieron de verdad por Telegram.
 */
export function insertAlertEvents(db: DatabaseSync, eventos: readonly NewAlertEvent[]): number[] {
  if (eventos.length === 0) return [];
  const stmt = db.prepare(
    `INSERT INTO alert_event
       (trader_id, venue, address, symbol, kind, side, size_base, prev_size_base,
        notional_usd, delta_usd, mark_price, at, notified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  );

  const ids: number[] = [];
  // Una transaccion por tanda: son escrituras a una SD, y un commit por fila
  // es justo lo que este proyecto evita en todos los demas sitios.
  db.exec('BEGIN');
  try {
    for (const e of eventos) {
      const r = stmt.run(
        e.traderId, e.venue, e.address, e.symbol, e.kind, e.side,
        e.sizeBase, e.prevSizeBase, e.notionalUsd, e.deltaUsd, e.markPrice, e.at,
      );
      ids.push(Number(r.lastInsertRowid));
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return ids;
}

/** Marca los que han salido por Telegram. Los que fallaron se quedan sin sello. */
export function markAlertsNotified(db: DatabaseSync, ids: readonly number[], at: number = Date.now()): void {
  if (ids.length === 0) return;
  const stmt = db.prepare('UPDATE alert_event SET notified_at = ? WHERE id = ?');
  db.exec('BEGIN');
  try {
    for (const id of ids) stmt.run(at, id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function listAlertEvents(db: DatabaseSync, limit = 100, traderId?: string): AlertEvent[] {
  const tope = Math.min(Math.max(1, Math.trunc(limit)), 500);
  const filas = traderId === undefined
    ? db.prepare('SELECT * FROM alert_event ORDER BY at DESC, id DESC LIMIT ?').all(tope)
    : db.prepare('SELECT * FROM alert_event WHERE trader_id = ? ORDER BY at DESC, id DESC LIMIT ?')
      .all(traderId, tope);
  return (filas as Record<string, unknown>[]).map(toEvent);
}

/**
 * Deja solo los ultimos `max` y devuelve cuantos borro.
 *
 * Se corta por `id`, que es autoincremental, en vez de por fecha: asi el
 * borrado es un rango sobre la clave primaria y no hay que ordenar la tabla.
 */
export function trimAlertEvents(db: DatabaseSync, max = MAX_ALERT_EVENTS): number {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM alert_event').get() as { n: number };
  if (Number(n) <= max) return 0;
  const corte = db
    .prepare('SELECT id FROM alert_event ORDER BY id DESC LIMIT 1 OFFSET ?')
    .get(max) as { id: number } | undefined;
  if (corte === undefined) return 0;
  return Number(db.prepare('DELETE FROM alert_event WHERE id <= ?').run(corte.id).changes);
}
