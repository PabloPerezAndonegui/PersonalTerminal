import type { DatabaseSync } from 'node:sqlite';
import { validateAddress } from './wallets.ts';

/**
 * Traders que el usuario sigue.
 *
 * Son direcciones PUBLICAS de terceros: aqui no hay ni puede haber una clave.
 * Se guardan en SQLite y no en el navegador porque la misma lista la usan la
 * pantalla de Traders, la de Terminal y el servicio que sondea posiciones; en
 * localStorage cada pestana tendria la suya y el servidor no tendria ninguna.
 *
 * Es una tabla aparte de `wallet`, que son las direcciones del propio usuario.
 * Mezclarlas meteria las cuentas que sigues dentro de tu Tracker personal.
 */
export interface Trader {
  readonly id: string;
  /** Hoy siempre 'hyperliquid'. La unicidad de una direccion es por venue. */
  readonly venue: string;
  readonly address: string;
  readonly alias: string | null;
  /** Color con el que se distingue en graficos y listas. '#rrggbb' o null. */
  readonly color: string | null;
  readonly group: string | null;
  readonly notes: string | null;
  /** Pausado = false. Se conserva la fila y se deja de consultar. */
  readonly active: boolean;
  readonly createdAt: number;
  /**
   * Los pares que interesan de ESTA wallet. null = todos.
   *
   * null y lista vacia no son lo mismo: null es "no he elegido", y una lista
   * vacia seria "ninguno", que dejaria la wallet muda sin que se note por que.
   * Por eso una lista vacia se guarda como null.
   */
  readonly symbols: readonly string[] | null;
  /**
   * Solo las operaciones que muevan al menos este % de SU cuenta. null = sin
   * minimo. Es un filtro de conviccion: quien mueve el 5 % de su cuenta dice
   * mas que quien mueve el 0,01 %, y un creador de mercado hace miles de las
   * segundas por hora.
   */
  readonly minAccountPct: number | null;
}

export interface NewTrader {
  readonly address: string;
  readonly venue?: string;
  readonly alias?: string | null;
  readonly color?: string | null;
  readonly group?: string | null;
  readonly notes?: string | null;
}

/** Lo que se puede cambiar de un trader ya guardado. */
export interface TraderPatch {
  readonly alias?: string | null;
  readonly color?: string | null;
  readonly group?: string | null;
  readonly notes?: string | null;
  readonly active?: boolean;
  readonly symbols?: readonly string[] | null;
  readonly minAccountPct?: number | null;
}

const MAX_TEXTO = 200;
const COLOR = /^#[0-9a-fA-F]{6}$/;
/** Hyperliquid son cuentas EVM. Se comprueba el formato antes de guardar. */
const EVM = /^0x[0-9a-fA-F]{40}$/;

/** Lista de simbolos limpia: mayusculas, sin repetidos, y vacia = null. */
function simbolos(v: readonly string[] | null | undefined): string | null {
  if (v === undefined || v === null) return null;
  const limpios = [...new Set(v.map((x) => x.trim().toUpperCase()).filter((x) => x !== ''))];
  if (limpios.length === 0) return null;
  if (limpios.length > 100) throw new Error('too many symbols');
  for (const x of limpios) {
    // Lo mismo que admite el normalizador: letras, cifras y los separadores
    // de los HIP-3. Fuera comas, que son el separador con el que se guarda.
    if (!/^[A-Z0-9:._-]{1,24}$/.test(x)) throw new Error(`invalid symbol: ${x}`);
  }
  return limpios.join(',');
}

function porcentaje(v: number | null | undefined): number | null {
  if (v === undefined || v === null) return null;
  if (!Number.isFinite(v) || v < 0 || v > 100) throw new Error('minAccountPct must be between 0 and 100');
  // Cero es "sin minimo", que se guarda como null para que solo haya una
  // forma de decirlo.
  return v === 0 ? null : v;
}

function texto(v: string | null | undefined, campo: string): string | null {
  if (v === undefined || v === null) return null;
  const limpio = v.trim();
  if (limpio === '') return null;
  if (limpio.length > MAX_TEXTO) throw new Error(`${campo} is too long`);
  return limpio;
}

function color(v: string | null | undefined): string | null {
  if (v === undefined || v === null || v.trim() === '') return null;
  const limpio = v.trim();
  // Se valida el formato en vez de aceptar cualquier cadena: este valor acaba
  // en un atributo de estilo, y un color libre es una via de inyeccion tonta.
  if (!COLOR.test(limpio)) throw new Error('color must be #rrggbb');
  return limpio.toLowerCase();
}

/**
 * Normaliza y valida la direccion.
 *
 * Pasa primero por `validateAddress`, que es quien rechaza una seed phrase
 * pegada por error en el campo, y despues se exige formato EVM porque el unico
 * venue de momento es Hyperliquid. Se guarda en minusculas para que la misma
 * cuenta escrita de dos maneras no entre dos veces.
 */
function direccion(raw: string): string {
  const limpia = validateAddress(raw);
  if (!EVM.test(limpia)) throw new Error('not a Hyperliquid address (0x + 40 hex)');
  return limpia.toLowerCase();
}

function toTrader(row: Record<string, unknown>): Trader {
  return {
    id: String(row['id']),
    venue: String(row['venue']),
    address: String(row['address']),
    alias: row['alias'] === null ? null : String(row['alias']),
    color: row['color'] === null ? null : String(row['color']),
    group: row['group_name'] === null ? null : String(row['group_name']),
    notes: row['notes'] === null ? null : String(row['notes']),
    active: Number(row['active']) === 1,
    createdAt: Number(row['created_at']),
    symbols: typeof row['symbols'] === 'string' && row['symbols'] !== ''
      ? row['symbols'].split(',')
      : null,
    minAccountPct: row['min_account_pct'] === null || row['min_account_pct'] === undefined
      ? null
      : Number(row['min_account_pct']),
  };
}

export function addTrader(db: DatabaseSync, nuevo: NewTrader, now: number = Date.now()): Trader {
  const venue = (nuevo.venue ?? 'hyperliquid').trim().toLowerCase();
  const address = direccion(nuevo.address);
  const id = `${venue}:${address}`;

  const ya = db.prepare('SELECT * FROM trader WHERE venue = ? AND address = ?').get(venue, address) as
    | Record<string, unknown>
    | undefined;
  if (ya !== undefined) throw new Error('this trader is already on the list');

  db.prepare(
    `INSERT INTO trader (id, venue, address, alias, color, group_name, notes, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
  ).run(
    id,
    venue,
    address,
    texto(nuevo.alias, 'alias'),
    color(nuevo.color),
    texto(nuevo.group, 'group'),
    texto(nuevo.notes, 'notes'),
    now,
  );

  const fila = db.prepare('SELECT * FROM trader WHERE id = ?').get(id) as Record<string, unknown>;
  return toTrader(fila);
}

export function listTraders(db: DatabaseSync): Trader[] {
  const filas = db
    .prepare('SELECT * FROM trader ORDER BY created_at ASC')
    .all() as Record<string, unknown>[];
  return filas.map(toTrader);
}

export function getTrader(db: DatabaseSync, id: string): Trader | null {
  const fila = db.prepare('SELECT * FROM trader WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return fila === undefined ? null : toTrader(fila);
}

/**
 * Cambia solo los campos presentes.
 *
 * Un `undefined` no es un `null`: el primero significa "no lo toques" y el
 * segundo "borralo". Confundirlos vaciaria el alias al pausar a alguien.
 */
export function updateTrader(db: DatabaseSync, id: string, patch: TraderPatch): Trader | null {
  const actual = getTrader(db, id);
  if (actual === null) return null;

  const campos: string[] = [];
  const valores: (string | number | null)[] = [];
  const set = (columna: string, valor: string | number | null) => {
    campos.push(`${columna} = ?`);
    valores.push(valor);
  };

  if (patch.alias !== undefined) set('alias', texto(patch.alias, 'alias'));
  if (patch.color !== undefined) set('color', color(patch.color));
  if (patch.group !== undefined) set('group_name', texto(patch.group, 'group'));
  if (patch.notes !== undefined) set('notes', texto(patch.notes, 'notes'));
  if (patch.active !== undefined) set('active', patch.active ? 1 : 0);
  if (patch.symbols !== undefined) set('symbols', simbolos(patch.symbols));
  if (patch.minAccountPct !== undefined) set('min_account_pct', porcentaje(patch.minAccountPct));
  if (campos.length === 0) return actual;

  db.prepare(`UPDATE trader SET ${campos.join(', ')} WHERE id = ?`).run(...valores, id);
  return getTrader(db, id);
}

export function removeTrader(db: DatabaseSync, id: string): boolean {
  const r = db.prepare('DELETE FROM trader WHERE id = ?').run(id);
  // Sus avisos se van con el: `alert_event` no tiene clave ajena, y sin esto
  // el panel de cambios seguia ensenando 384 movimientos de una wallet que ya
  // no se seguia (visto el 17 nov 2026).
  if (Number(r.changes) > 0) db.prepare('DELETE FROM alert_event WHERE trader_id = ?').run(id);
  return Number(r.changes) > 0;
}
