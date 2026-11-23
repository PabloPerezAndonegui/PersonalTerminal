import type { DatabaseSync } from 'node:sqlite';

/**
 * Ingresos fuera del P&L de trading.
 *
 * Comisiones de referidos y premios de competiciones. Se guardan aparte del
 * registro de arbitrajes a proposito: no son resultado de operar, y mezclarlos
 * falsearia las dos cifras. Saber cuanto viene de operar y cuanto de incentivos
 * es justo lo que dice si una estrategia se sostiene sola.
 *
 * Dato del usuario: no se purga y entra en la copia de seguridad.
 */

export type IncomeKind = 'referral' | 'competition';

export interface IncomeEntry {
  readonly id: string;
  readonly kind: IncomeKind;
  readonly venue: string;
  readonly amountUsd: number;
  readonly receivedAt: number;
  /** Solo en competiciones. */
  readonly competition: string | null;
  readonly placement: string | null;
  readonly period: string | null;
  readonly note: string | null;
  readonly createdAt: number;
}

export interface NewIncomeEntry {
  readonly kind: IncomeKind;
  readonly venue: string;
  readonly amountUsd: number;
  readonly receivedAt: number;
  readonly competition?: string | null;
  readonly placement?: string | null;
  readonly period?: string | null;
  readonly note?: string | null;
}

const texto = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

function toEntry(row: Record<string, unknown>): IncomeEntry {
  return {
    id: String(row['id']),
    kind: row['kind'] === 'competition' ? 'competition' : 'referral',
    venue: String(row['venue']),
    amountUsd: Number(row['amount_usd']),
    receivedAt: Number(row['received_at']),
    competition: texto(row['competition']),
    placement: texto(row['placement']),
    period: texto(row['period']),
    note: texto(row['note']),
    createdAt: Number(row['created_at']),
  };
}

export function addIncomeEntry(
  db: DatabaseSync,
  e: NewIncomeEntry,
  now: number = Date.now(),
): IncomeEntry {
  const venue = e.venue.trim();
  if (venue === '') throw new Error('venue is required');
  if (!Number.isFinite(e.amountUsd)) throw new Error('the amount is not a number');
  // Se admiten importes negativos: una comision revertida es un ingreso
  // negativo, y forzarlo a positivo falsearia el total.
  if (!Number.isFinite(e.receivedAt) || e.receivedAt <= 0) throw new Error('a received date is required');

  const id = `${e.kind}-${e.receivedAt}-${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(
    `INSERT INTO income_entry
       (id, kind, venue, amount_usd, received_at, competition, placement, period, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, e.kind, venue, e.amountUsd, e.receivedAt,
    e.competition ?? null, e.placement ?? null, e.period ?? null, e.note ?? null, now,
  );

  const guardada = db.prepare('SELECT * FROM income_entry WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  if (guardada === undefined) throw new Error('could not save the entry');
  return toEntry(guardada);
}

export function listIncomeEntries(db: DatabaseSync): IncomeEntry[] {
  const rows = db
    .prepare('SELECT * FROM income_entry ORDER BY received_at DESC')
    .all() as Record<string, unknown>[];
  return rows.map(toEntry);
}

export function removeIncomeEntry(db: DatabaseSync, id: string): boolean {
  return Number(db.prepare('DELETE FROM income_entry WHERE id = ?').run(id).changes) > 0;
}

export interface IncomeTotals {
  /** null cuando no hay ninguna entrada: no se afirma un ingreso de 0. */
  readonly referralUsd: number | null;
  readonly competitionUsd: number | null;
  readonly totalUsd: number | null;
  readonly byVenue: readonly { venue: string; referralUsd: number; competitionUsd: number; totalUsd: number }[];
}

/**
 * Totales por tipo y por venue.
 *
 * Sin ninguna entrada los totales son `null`, no 0: "no he cobrado nada" y "no
 * he apuntado nada" son cosas distintas, y esta pantalla existe para poder
 * distinguirlas.
 */
export function incomeTotals(entries: readonly IncomeEntry[]): IncomeTotals {
  if (entries.length === 0) {
    return { referralUsd: null, competitionUsd: null, totalUsd: null, byVenue: [] };
  }

  let referral = 0;
  let competition = 0;
  const porVenue = new Map<string, { referralUsd: number; competitionUsd: number }>();

  for (const e of entries) {
    const v = porVenue.get(e.venue) ?? { referralUsd: 0, competitionUsd: 0 };
    if (e.kind === 'referral') {
      referral += e.amountUsd;
      v.referralUsd += e.amountUsd;
    } else {
      competition += e.amountUsd;
      v.competitionUsd += e.amountUsd;
    }
    porVenue.set(e.venue, v);
  }

  return {
    referralUsd: referral,
    competitionUsd: competition,
    totalUsd: referral + competition,
    byVenue: [...porVenue.entries()]
      .map(([venue, v]) => ({ venue, ...v, totalUsd: v.referralUsd + v.competitionUsd }))
      .sort((a, b) => b.totalUsd - a.totalUsd),
  };
}

// --- Enlaces de referido -----------------------------------------------------

export interface ReferralLink {
  readonly venue: string;
  readonly url: string;
  readonly createdAt: number;
}

export function setReferralLink(
  db: DatabaseSync,
  venue: string,
  url: string,
  now: number = Date.now(),
): ReferralLink {
  const v = venue.trim();
  const u = url.trim();
  if (v === '') throw new Error('venue is required');
  // Solo http(s): un enlace con otro esquema no es un referido y podria ser
  // un intento de colar algo raro en un campo que luego se pincha.
  if (!/^https?:\/\//i.test(u)) throw new Error('the link must start with http:// or https://');

  db.prepare(
    `INSERT INTO referral_link (venue, url, created_at) VALUES (?, ?, ?)
     ON CONFLICT(venue) DO UPDATE SET url = excluded.url`,
  ).run(v, u, now);

  return { venue: v, url: u, createdAt: now };
}

export function listReferralLinks(db: DatabaseSync): ReferralLink[] {
  const rows = db
    .prepare('SELECT * FROM referral_link ORDER BY venue ASC')
    .all() as Record<string, unknown>[];
  return rows.map((r) => ({
    venue: String(r['venue']),
    url: String(r['url']),
    createdAt: Number(r['created_at']),
  }));
}

export function removeReferralLink(db: DatabaseSync, venue: string): boolean {
  return Number(db.prepare('DELETE FROM referral_link WHERE venue = ?').run(venue).changes) > 0;
}
