/**
 * Recogida completa: collector -> almacenamiento.
 *
 * Es lo que correra como servicio en la Raspberry. Recoge en memoria cada 120 s,
 * vuelca a SQLite cada 6 min y aplica retencion una vez al dia.
 *
 * Uso:  npm run collect               (3 ciclos, imprime el panel y sale)
 *       npm run collect -- --forever  (hasta Ctrl+C)
 */
import { Collector } from '@defi/collector';
import { activeVenueIds, createAdapters } from '@defi/venues';
import {
  openDatabase,
  SnapshotPersister,
  writeHealth,
  runRetention,
  retentionPending,
  DEFAULT_RETENTION,
} from '@defi/storage';

const forever = process.argv.includes('--forever');

const COLLECT_INTERVAL_MS = Number(process.env['COLLECT_INTERVAL_MS'] || 120_000);
const PERSIST_INTERVAL_MS = Number(process.env['PERSIST_INTERVAL_MS'] || 360_000);
const DB_PATH = process.env['DB_PATH'] ?? './data/defi.db';

const db = openDatabase({ path: DB_PATH });
const persister = new SnapshotPersister({ db, intervalMs: PERSIST_INTERVAL_MS });

const collector = new Collector({
  adapters: createAdapters(activeVenueIds()),
  // Presupuesto de una Pi que comparte IP publica con los otros bots.
  budget: { maxWebsockets: 8, maxRequestsPerMinute: 240 },
  intervalMs: COLLECT_INTERVAL_MS,
});

console.log(`base de datos: ${DB_PATH}`);
// El banner tiene que describir lo que va a pasar AHORA, no la configuracion.
// Diciendo "recogida cada 120 s" antes de hacer tres ciclos seguidos parece que
// el collector esta pidiendo de mas y comiendose el rate limit de la Pi.
console.log(
  forever
    ? `recogida cada ${COLLECT_INTERVAL_MS / 1000} s, volcado cada ${PERSIST_INTERVAL_MS / 1000} s`
    : `3 ciclos de diagnostico con 2 s entre ellos, y sale. En servicio seria cada ` +
      `${COLLECT_INTERVAL_MS / 1000} s; para eso, --forever`,
);
console.log(`venues admitidos: ${collector.venues.join(', ')}`);
for (const r of collector.rejected) console.log(`RECHAZADO ${r.venue}: ${r.reason}`);

const pad = (s: string | number, n: number) => String(s).padStart(n);
const opt = (v: number | null, d = 0) => (v === null ? '—' : v.toFixed(d));


function alCerrarCiclo(): void {
  const cycle = collector.lastCycle;
  const health = collector.health();

  const escritas = persister.maybePersist(collector.snapshots());
  if (escritas > 0) {
    // La salud se guarda solo cuando se guardan datos: asi el uptime se muestrea
    // a la misma cadencia que el resto y no infla la base sin aportar nada.
    writeHealth(
      db,
      Date.now(),
      health.map((h) => ({
        source: h.venue,
        status: h.status,
        reason: h.reason,
        symbolCount: h.symbolCount,
        latencyP50Ms: h.latencyP50Ms,
      })),
    );
  }

  // Se pregunta a los datos, no a un temporizador en memoria: asi un
  // reinicio no borra el calendario y el trabajo atrasado se recupera solo.
  if (retentionPending(db, DEFAULT_RETENTION)) {
    const r = runRetention(db, DEFAULT_RETENTION);
    console.log(`retencion: ${r.agregadas} agregadas, ${r.borradas} comprimidas, ${r.purgadas} purgadas`);
  }

  console.log(
    `\n--- ciclo ${new Date(cycle?.at ?? Date.now()).toLocaleTimeString()} ` +
      `(${cycle?.durationMs} ms, ${cycle?.ok} ok / ${cycle?.failed} fallo, ` +
      `${cycle?.freshSymbols} frescos${escritas > 0 ? `, ${escritas} filas guardadas` : ''}) ---`,
  );
  console.log('VENUE          ESTADO      SIMB   COBERT   P50    P95   ERR%   MOTIVO');
  for (const h of health) {
    console.log(
      `${h.venue.padEnd(14)} ${h.status.padEnd(10)} ${pad(h.symbolCount, 4)}   ` +
        `${pad(h.coverageRatio === null ? '—' : Math.round(h.coverageRatio * 100) + '%', 5)}  ` +
        `${pad(opt(h.latencyP50Ms), 5)}  ${pad(opt(h.latencyP95Ms), 5)}  ` +
        `${pad(h.errorRatePct.toFixed(0), 4)}   ${h.reason ?? ''}`,
    );
  }
}

if (forever) {
  collector.onCycle(alCerrarCiclo);
  collector.start();
  const cerrar = () => {
    collector.stop();
    db.close();
    console.log('\ncollector detenido, base de datos cerrada.');
    process.exit(0);
  };
  process.on('SIGINT', cerrar);
  process.on('SIGTERM', cerrar);
} else {
  for (let i = 0; i < 3; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 2000));
    await collector.runCycle();
    alCerrarCiclo();
  }
  collector.stop();

  const filas = db.prepare('SELECT COUNT(*) AS n FROM market_snapshot').get() as { n: number };
  const venues = db.prepare('SELECT COUNT(DISTINCT venue) AS n FROM market_snapshot').get() as { n: number };
  const simbolos = db.prepare('SELECT COUNT(DISTINCT symbol) AS n FROM market_snapshot').get() as { n: number };
  console.log(`\nen la base: ${filas.n} filas, ${venues.n} venues, ${simbolos.n} simbolos distintos`);
  db.close();
}
