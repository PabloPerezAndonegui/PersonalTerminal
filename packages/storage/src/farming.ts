import type { DatabaseSync } from 'node:sqlite';
import { transaction } from './db.ts';

/**
 * Calculadora de eficiencia de farmeo.
 *
 * Responde a una sola pregunta: **cuanto te cuesta cada punto**. Y a la de
 * verdad importante, que es la siguiente: si operando ganas mas de lo que pagas
 * en fees, el punto no te cuesta nada — te estan pagando por farmearlo.
 *
 * Dato del usuario: no se purga y entra en la copia de seguridad.
 */

export interface PointsProgram {
  readonly id: string;
  readonly venue: string;
  /** Puntos que reparte el programa por epoch. null = desconocido. */
  readonly pointsPerEpoch: number | null;
  /** Como se llama el epoch: 'per week', 'per day'... */
  readonly epochLabel: string;
  /** Volumen total del epoch, para estimar tu cuota. null = desconocido. */
  readonly epochVolumeUsd: number | null;
  /** Orden en el tablero: 1 es lo primero. null = filas antiguas, al final. */
  readonly priority: number | null;
  /** Texto libre de la tarjeta. */
  readonly note: string | null;
  readonly createdAt: number;
}

export interface FarmingAction {
  readonly id: string;
  readonly programId: string;
  readonly description: string | null;
  readonly volumeUsd: number | null;
  readonly feesPaidUsd: number | null;
  readonly pnlUsd: number | null;
  /** Puntos reales si se conocen. null = se estiman por cuota de volumen. */
  readonly pointsEarned: number | null;
  readonly occurredAt: number;
  readonly createdAt: number;
}

const opt = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function toProgram(r: Record<string, unknown>): PointsProgram {
  return {
    id: String(r['id']),
    venue: String(r['venue']),
    pointsPerEpoch: opt(r['points_per_epoch']),
    epochLabel: String(r['epoch_label']),
    epochVolumeUsd: opt(r['epoch_volume_usd']),
    priority: opt(r['priority']),
    note: r['note'] === null || r['note'] === undefined ? null : String(r['note']),
    createdAt: Number(r['created_at']),
  };
}

function toAction(r: Record<string, unknown>): FarmingAction {
  return {
    id: String(r['id']),
    programId: String(r['program_id']),
    description: r['description'] === null || r['description'] === undefined ? null : String(r['description']),
    volumeUsd: opt(r['volume_usd']),
    feesPaidUsd: opt(r['fees_paid_usd']),
    pnlUsd: opt(r['pnl_usd']),
    pointsEarned: opt(r['points_earned']),
    occurredAt: Number(r['occurred_at']),
    createdAt: Number(r['created_at']),
  };
}

// --- Programas ---------------------------------------------------------------

export function addPointsProgram(
  db: DatabaseSync,
  p: {
    venue: string; pointsPerEpoch?: number | null; epochLabel?: string;
    epochVolumeUsd?: number | null; note?: string | null;
  },
  now: number = Date.now(),
): PointsProgram {
  const venue = p.venue.trim();
  if (venue === '') throw new Error('venue is required');

  const note = p.note === undefined || p.note === null || p.note.trim() === '' ? null : p.note.trim().slice(0, 120);
  const id = `${venue}-${now}-${Math.random().toString(36).slice(2, 6)}`;
  // Lo nuevo entra al final del tablero: subirlo es decision del usuario.
  db.prepare(
    `INSERT INTO points_program (id, venue, points_per_epoch, epoch_label, epoch_volume_usd, note, priority, created_at)
     VALUES (?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(priority), 0) + 1 FROM points_program), ?)`,
  ).run(id, venue, p.pointsPerEpoch ?? null, p.epochLabel ?? 'per week', p.epochVolumeUsd ?? null, note, now);

  const row = db.prepare('SELECT * FROM points_program WHERE id = ?').get(id) as Record<string, unknown>;
  return toProgram(row);
}

export function listPointsPrograms(db: DatabaseSync): PointsProgram[] {
  const rows = db
    .prepare('SELECT * FROM points_program ORDER BY priority IS NULL, priority ASC, created_at ASC')
    .all() as Record<string, unknown>[];
  return rows.map(toProgram);
}

/**
 * Fija el orden del tablero. `ids` es el orden nuevo completo; un id que no
 * existe es un error, no se ignora: significaria que la pantalla y la base no
 * hablan de lo mismo.
 */
export function reorderPointsPrograms(db: DatabaseSync, ids: readonly string[]): number {
  return transaction(db, () => {
    const set = db.prepare('UPDATE points_program SET priority = ? WHERE id = ?');
    ids.forEach((id, i) => {
      if (Number(set.run(i + 1, id).changes) === 0) throw new Error(`unknown program: ${id}`);
    });
    return ids.length;
  });
}

export function removePointsProgram(db: DatabaseSync, id: string): boolean {
  // Las acciones cuelgan del programa: se borran con el, o quedarian huerfanas
  // contando puntos de un programa que ya no existe.
  db.prepare('DELETE FROM farming_action WHERE program_id = ?').run(id);
  return Number(db.prepare('DELETE FROM points_program WHERE id = ?').run(id).changes) > 0;
}

// --- Acciones ----------------------------------------------------------------

export function addFarmingAction(
  db: DatabaseSync,
  a: {
    programId: string; description?: string | null; volumeUsd?: number | null;
    feesPaidUsd?: number | null; pnlUsd?: number | null; pointsEarned?: number | null;
    occurredAt: number;
  },
  now: number = Date.now(),
): FarmingAction {
  const existe = db.prepare('SELECT 1 FROM points_program WHERE id = ?').get(a.programId);
  if (existe === undefined) throw new Error('that points program does not exist');
  if (!Number.isFinite(a.occurredAt) || a.occurredAt <= 0) throw new Error('a date is required');

  const id = `act-${a.occurredAt}-${Math.random().toString(36).slice(2, 6)}`;
  db.prepare(
    `INSERT INTO farming_action
       (id, program_id, description, volume_usd, fees_paid_usd, pnl_usd, points_earned, occurred_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, a.programId, a.description ?? null, a.volumeUsd ?? null,
    a.feesPaidUsd ?? null, a.pnlUsd ?? null, a.pointsEarned ?? null, a.occurredAt, now,
  );

  const row = db.prepare('SELECT * FROM farming_action WHERE id = ?').get(id) as Record<string, unknown>;
  return toAction(row);
}

export function listFarmingActions(db: DatabaseSync): FarmingAction[] {
  const rows = db
    .prepare('SELECT * FROM farming_action ORDER BY occurred_at DESC')
    .all() as Record<string, unknown>[];
  return rows.map(toAction);
}

export function removeFarmingAction(db: DatabaseSync, id: string): boolean {
  return Number(db.prepare('DELETE FROM farming_action WHERE id = ?').run(id).changes) > 0;
}

// --- Calculo -----------------------------------------------------------------

export interface ActionMetrics {
  /** Puntos usados en el calculo. null si no se conocen ni se pueden estimar. */
  readonly points: number | null;
  /** true si `points` es una estimacion por cuota de volumen, no un dato. */
  readonly pointsEstimated: boolean;
  /** fees / puntos. Lo que cuesta cada punto sin contar el resultado de operar. */
  readonly costPerPoint: number | null;
  /**
   * (fees - P&L) / puntos. **Si sale negativo, el punto no te cuesta nada**:
   * ganaste operando mas de lo que pagaste en comisiones, asi que te estan
   * pagando por farmear.
   */
  readonly netCostPerPoint: number | null;
}

/**
 * Metricas de una accion.
 *
 * Los puntos se estiman por cuota de volumen solo si estan los tres datos que
 * hacen falta (volumen propio, volumen del epoch y puntos del epoch). Si falta
 * cualquiera, se devuelve null y la pantalla lo dice: una estimacion con un
 * hueco dentro no es una estimacion, es un numero inventado.
 */
export function actionMetrics(a: FarmingAction, program: PointsProgram | undefined): ActionMetrics {
  let points = a.pointsEarned;
  let estimados = false;

  if (points === null && program !== undefined) {
    const { epochVolumeUsd, pointsPerEpoch } = program;
    if (a.volumeUsd !== null && epochVolumeUsd !== null && epochVolumeUsd > 0 && pointsPerEpoch !== null) {
      points = (a.volumeUsd / epochVolumeUsd) * pointsPerEpoch;
      estimados = true;
    }
  }

  if (points === null || points <= 0) {
    return { points, pointsEstimated: estimados, costPerPoint: null, netCostPerPoint: null };
  }

  const fees = a.feesPaidUsd;
  return {
    points,
    pointsEstimated: estimados,
    costPerPoint: fees === null ? null : fees / points,
    netCostPerPoint: fees === null || a.pnlUsd === null ? null : (fees - a.pnlUsd) / points,
  };
}

export interface FarmingPortfolio {
  readonly totalPoints: number | null;
  readonly estimatedPoints: number;
  readonly totalFeesUsd: number | null;
  readonly totalPnlUsd: number | null;
  /** P&L - fees. Lo que te ha costado (o dado) el farmeo, sin contar puntos. */
  readonly netResultUsd: number | null;
  readonly avgCostPerPoint: number | null;
  readonly avgNetCostPerPoint: number | null;
}

/**
 * Resumen de todo el farmeo.
 *
 * Los totales son null cuando no hay ni un dato del que sumar: 0 afirmaria que
 * no has pagado fees, y lo cierto es que no se sabe.
 */
export function farmingPortfolio(
  actions: readonly FarmingAction[],
  programs: readonly PointsProgram[],
): FarmingPortfolio {
  const porId = new Map(programs.map((p) => [p.id, p]));

  let points: number | null = null;
  let estimados = 0;
  let fees: number | null = null;
  let pnl: number | null = null;

  for (const a of actions) {
    const m = actionMetrics(a, porId.get(a.programId));
    if (m.points !== null) {
      points = (points ?? 0) + m.points;
      if (m.pointsEstimated) estimados += m.points;
    }
    if (a.feesPaidUsd !== null) fees = (fees ?? 0) + a.feesPaidUsd;
    if (a.pnlUsd !== null) pnl = (pnl ?? 0) + a.pnlUsd;
  }

  const netResult = fees === null || pnl === null ? null : pnl - fees;

  return {
    totalPoints: points,
    estimatedPoints: estimados,
    totalFeesUsd: fees,
    totalPnlUsd: pnl,
    netResultUsd: netResult,
    avgCostPerPoint: points === null || points <= 0 || fees === null ? null : fees / points,
    avgNetCostPerPoint:
      points === null || points <= 0 || netResult === null ? null : -netResult / points,
  };
}
