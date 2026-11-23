import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MIGRATIONS } from './schema.ts';

export interface OpenOptions {
  /** Ruta del fichero, o ':memory:' en tests. */
  readonly path: string;
}

/**
 * Abre la base de datos y deja aplicadas las migraciones pendientes.
 *
 * Los PRAGMA no son decoracion: estan elegidos para una Raspberry Pi con
 * tarjeta SD, donde el enemigo es el numero de escrituras fisicas.
 */
export function openDatabase(options: OpenOptions): DatabaseSync {
  if (options.path !== ':memory:') mkdirSync(dirname(options.path), { recursive: true });

  const db = new DatabaseSync(options.path);

  // WAL: las escrituras van a un journal secuencial en vez de reescribir el
  // fichero principal. Menos escrituras aleatorias, que es lo que desgasta la
  // SD, y ademas permite leer mientras se escribe.
  db.exec('PRAGMA journal_mode = WAL');

  // NORMAL en vez de FULL: no se hace fsync en cada commit, solo en los puntos
  // de control. Se arriesga el ultimo ciclo ante un corte de luz, cosa
  // asumible en datos de mercado que se vuelven a recoger en 15 segundos, y a
  // cambio se reducen mucho las escrituras.
  db.exec('PRAGMA synchronous = NORMAL');

  db.exec('PRAGMA foreign_keys = ON');

  // Cada 1000 paginas (~4 MB) en vez del valor por defecto: agrupa el volcado
  // del WAL en menos operaciones grandes.
  db.exec('PRAGMA wal_autocheckpoint = 1000');

  migrate(db);
  return db;
}

/**
 * Aplica las migraciones que falten, usando `user_version` como contador.
 * Cada migracion va en su propia transaccion: si una falla, no deja el esquema
 * a medias.
 */
export function migrate(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  const applied = row?.user_version ?? 0;

  for (let i = applied; i < MIGRATIONS.length; i++) {
    const migration = MIGRATIONS[i];
    if (migration === undefined) continue;
    db.exec('BEGIN');
    try {
      for (const statement of migration.statements) db.exec(statement);
      // user_version no acepta parametros enlazados, y el valor es un indice
      // interno, nunca entrada del usuario.
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`migracion ${migration.name} fallida: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return MIGRATIONS.length;
}

/**
 * Ejecuta `fn` dentro de una transaccion.
 *
 * Todo el trabajo por lotes pasa por aqui: un ciclo de recogida son cientos de
 * filas y tienen que entrar en UN solo commit. Insertarlas sueltas serian
 * cientos de escrituras y es exactamente lo que mata una tarjeta SD.
 */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
