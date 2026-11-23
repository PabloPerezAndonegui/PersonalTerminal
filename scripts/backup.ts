/**
 * Copia de seguridad y restauracion de los datos del usuario.
 *
 * Uso:
 *   npm run backup                          copia a data/backups/<fecha>.json
 *   npm run backup -- --out ruta.json       copia a donde se diga
 *   npm run backup -- --verify ruta.json    restaura en una base TEMPORAL y
 *                                           comprueba que sale lo mismo, sin
 *                                           tocar la base real
 *   npm run backup -- --restore ruta.json --into otra.db
 *
 * La restauracion NUNCA apunta por defecto a la base en uso: hay que decir
 * `--into` a mano. Restaurar es justo el momento en que uno se equivoca de
 * fichero, y escribir encima de los registros buenos es lo que esta copia
 * existe para evitar.
 */
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDatabase, exportUserData, importUserData, countUserRows, type UserBackup } from '@defi/storage';

const args = process.argv.slice(2);
const flag = (nombre: string): string | null => {
  const i = args.indexOf(nombre);
  return i === -1 || i + 1 >= args.length ? null : (args[i + 1] ?? null);
};

const DB_PATH = process.env['DB_PATH'] ?? './data/defi.db';

const verificar = flag('--verify');
const restaurar = flag('--restore');

if (restaurar !== null) {
  const destino = flag('--into');
  if (destino === null) {
    console.error('falta --into <fichero.db>: hay que decir a que base se restaura.');
    console.error('NO se restaura sobre la base en uso por defecto, a proposito.');
    process.exit(1);
  }
  if (destino === DB_PATH) {
    console.error(`--into apunta a la base en uso (${DB_PATH}). Usa otro fichero.`);
    process.exit(1);
  }

  const copia = JSON.parse(readFileSync(restaurar, 'utf8')) as UserBackup;
  const db = openDatabase({ path: destino });
  try {
    const res = importUserData(db, copia);
    console.log(`restauradas ${res.total} filas en ${destino}`);
    for (const [t, n] of Object.entries(res.inserted)) console.log(`  ${t.padEnd(22)} ${n}`);
  } catch (err) {
    // Un stack trace aqui no ayuda: lo que hace falta es entender por que se
    // ha negado, que casi siempre es haber apuntado a la base equivocada.
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    db.close();
  }
  process.exit();
}

if (verificar !== null) {
  // Restauracion de prueba en una base temporal: es la unica forma de saber que
  // la copia sirve. Una copia que nunca se ha restaurado no es una copia, es un
  // fichero.
  const copia = JSON.parse(readFileSync(verificar, 'utf8')) as UserBackup;
  const tmp = `${verificar}.verify.db`;
  if (existsSync(tmp)) unlinkSync(tmp);

  const db = openDatabase({ path: tmp });
  const res = importUserData(db, copia);
  const tras = countUserRows(db);
  db.close();
  unlinkSync(tmp);
  for (const s of ['-wal', '-shm']) if (existsSync(tmp + s)) unlinkSync(tmp + s);

  console.log(`copia: ${verificar}`);
  console.log(`creada: ${new Date(copia.createdAt).toISOString()} (esquema v${copia.schemaVersion})`);
  console.log('\nTABLA                   EN LA COPIA   RESTAURADAS');
  let fallos = 0;
  for (const [t, filas] of Object.entries(copia.tables)) {
    const n = tras[t] ?? 0;
    const ok = n === filas.length;
    if (!ok) fallos++;
    console.log(`${t.padEnd(22)} ${String(filas.length).padStart(11)} ${String(n).padStart(13)}  ${ok ? 'OK' : 'DESCUADRA'}`);
  }
  console.log(`\n${res.total} filas restauradas en una base temporal, que ya se ha borrado.`);
  console.log(`La base en uso (${DB_PATH}) no se ha tocado.`);
  if (fallos > 0) process.exitCode = 1;
  process.exit();
}

// Por defecto: hacer la copia.
const salida = flag('--out') ?? `./data/backups/${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
mkdirSync(dirname(salida), { recursive: true });

const db = openDatabase({ path: DB_PATH });
const copia = exportUserData(db);
db.close();

writeFileSync(salida, JSON.stringify(copia, null, 1));

const total = Object.values(copia.tables).reduce((a, f) => a + f.length, 0);
console.log(`copia guardada en ${salida}`);
for (const [t, filas] of Object.entries(copia.tables)) {
  if (filas.length > 0) console.log(`  ${t.padEnd(22)} ${filas.length} filas`);
}
if (total === 0) {
  console.log('\nLa copia esta vacia: todavia no hay datos propios metidos.');
} else {
  console.log(`\n${total} filas. Comprueba que se puede restaurar:`);
  console.log(`  npm run backup -- --verify ${salida}`);
}
