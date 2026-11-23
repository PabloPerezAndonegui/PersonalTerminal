import type { DatabaseSync } from 'node:sqlite';

/**
 * Copia de seguridad de los datos del USUARIO.
 *
 * Cinco modulos dicen "entra en la copia de seguridad" y no habia ninguna. Esto
 * la hace.
 *
 * Solo el dominio de usuario: wallets, arbitrajes, ingresos, puntos y farmeo.
 * El de mercado se queda fuera a proposito — son cientos de miles de filas que
 * se vuelven a recoger, mientras que esto son unos cientos que no se recuperan
 * de ningun sitio si se pierden.
 *
 * En JSON y no copiando el fichero: copiar una base SQLite en marcha, con WAL
 * activo, puede dar una copia inconsistente. Ademas el JSON se abre con
 * cualquier cosa, se puede revisar antes de restaurar y sobrevive a un cambio
 * de esquema.
 */

/** Tablas del dominio de usuario, en orden de dependencia. */
const TABLAS = [
  'wallet',
  'funding_position',
  // Va detras de funding_position: sus filas apuntan a ella.
  'position_size_change',
  'income_entry',
  'referral_link',
  'points_program',
  // Detras de points_program, por lo mismo.
  'farming_action',
] as const;

export interface UserBackup {
  readonly format: 'defi-terminal-user-backup';
  readonly version: 1;
  readonly createdAt: number;
  /** `user_version` del esquema con el que se creo, para poder avisar. */
  readonly schemaVersion: number;
  readonly tables: Readonly<Record<string, readonly Record<string, unknown>[]>>;
}

export function exportUserData(db: DatabaseSync, now: number = Date.now()): UserBackup {
  const tables: Record<string, Record<string, unknown>[]> = {};
  for (const t of TABLAS) {
    // Una tabla que aun no existe (base vieja) no es un error: se omite.
    const existe = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?")
      .get(t);
    if (existe === undefined) continue;
    tables[t] = db.prepare(`SELECT * FROM ${t}`).all() as Record<string, unknown>[];
  }

  const v = db.prepare('PRAGMA user_version').get() as { user_version: number };
  return {
    format: 'defi-terminal-user-backup',
    version: 1,
    createdAt: now,
    schemaVersion: v.user_version,
    tables,
  };
}

/** Cuantas filas de usuario hay ahora mismo, por tabla. */
export function countUserRows(db: DatabaseSync): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of TABLAS) {
    const existe = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(t);
    if (existe === undefined) continue;
    out[t] = Number((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n);
  }
  return out;
}

export interface RestoreResult {
  readonly inserted: Readonly<Record<string, number>>;
  readonly total: number;
}

/**
 * Restaura una copia en una base.
 *
 * **Se niega a escribir sobre datos de usuario existentes** salvo que se pida
 * explicitamente con `allowNonEmpty`. Restaurar es justo el momento en que uno
 * se equivoca de fichero, y perder los registros buenos por encima de los
 * malos seria exactamente lo que esta copia existe para evitar.
 *
 * No borra nada: inserta. Si la base destino tiene la misma fila, falla la
 * insercion de esa fila y se dice, en vez de sobrescribir en silencio.
 */
export function importUserData(
  db: DatabaseSync,
  backup: UserBackup,
  options: { allowNonEmpty?: boolean } = {},
): RestoreResult {
  if (backup.format !== 'defi-terminal-user-backup') {
    throw new Error('that file is not a user backup');
  }

  if (options.allowNonEmpty !== true) {
    const actuales = countUserRows(db);
    const ocupadas = Object.entries(actuales).filter(([, n]) => n > 0);
    if (ocupadas.length > 0) {
      throw new Error(
        `the target database already has user data (${ocupadas
          .map(([t, n]) => `${t}: ${n}`)
          .join(', ')}); restore into an empty one or pass allowNonEmpty`,
      );
    }
  }

  const inserted: Record<string, number> = {};
  let total = 0;

  db.exec('BEGIN');
  try {
    for (const t of TABLAS) {
      const filas = backup.tables[t] ?? [];
      if (filas.length === 0) continue;

      const columnas = Object.keys(filas[0] ?? {});
      if (columnas.length === 0) continue;
      const sql = `INSERT INTO ${t} (${columnas.join(', ')}) VALUES (${columnas.map(() => '?').join(', ')})`;
      const stmt = db.prepare(sql);

      let n = 0;
      for (const fila of filas) {
        stmt.run(...columnas.map((c) => (fila[c] ?? null) as null));
        n++;
      }
      inserted[t] = n;
      total += n;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { inserted, total };
}
