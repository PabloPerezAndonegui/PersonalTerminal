/**
 * Punto de entrada del servicio.
 *
 * Compone collector, almacenamiento y API en un solo proceso, que es lo que
 * corre en la Raspberry. La frontera entre ellos esta en el codigo, asi que
 * separarlos el dia que haga falta es cambiar como se arranca, no reescribir.
 *
 * Aqui NO hay claves de ningun tipo: la firma vive en apps/signer, aparte.
 */
import { Collector, PollingSource } from '@defi/collector';
import { activeVenueIds, createAdapters, REGISTRY, fetchPools, fetchBridges, fetchHyperliquidFills,
  fetchLifiRoutes, fetchDebridgeRoutes, fetchBridgeAggregators, fetchPerplCampaigns, fetchEconomicCalendar,
} from '@defi/venues';
import {
  openDatabase, SnapshotPersister, writeHealth, runRetention, retentionPending, DEFAULT_RETENTION,
  insertFills, lastFillAt, pruneFills, writePoolDaily, prunePoolDaily,
} from '@defi/storage';
import { createApi } from './server.ts';
import { TraderTracker } from './traderTracker.ts';

/**
 * Cuanto tiempo se conservan las ejecuciones de las wallets seguidas. Noventa
 * dias dan para ver como entro y salio alguien de un movimiento entero, y
 * acotan el disco: una cuenta publica real daba 1.470 ejecuciones en quince
 * minutos.
 */
const FILLS_RETENCION_MS = 90 * 86_400_000;
let ultimaPurgaFills = 0;
import { AlertService } from './alertService.ts';
import { telegramFromEnv } from './telegram.ts';
import { SustainabilityIndex } from './sustainability.ts';
import { OpenInterestService } from './openInterest.ts';

const PORT = Number(process.env['API_PORT'] ?? 8080);
// 127.0.0.1 por defecto: desde fuera se llega por Tailscale, nunca abriendo un
// puerto del router. Ver ARCHITECTURE.md.
const HOST = process.env['API_HOST'] ?? '127.0.0.1';
const DB_PATH = process.env['DB_PATH'] ?? './data/defi.db';
const COLLECT_INTERVAL_MS = Number(process.env['COLLECT_INTERVAL_MS'] || 120_000);
const PERSIST_INTERVAL_MS = Number(process.env['PERSIST_INTERVAL_MS'] || 360_000);
// Vuelta completa a los traders activos. Las peticiones se reparten dentro de
// este intervalo, no se lanzan juntas: ver TraderTracker.
const TRADERS_INTERVAL_MS = Number(process.env['TRADERS_INTERVAL_MS'] || 60_000);

const db = openDatabase({ path: DB_PATH });
const persister = new SnapshotPersister({ db, intervalMs: PERSIST_INTERVAL_MS });

// Solo los venues activos: el registro sabe leer mas, pero cada uno gasta
// peticiones de una IP que se comparte con otros bots. Se cambia con VENUES.
const activos = activeVenueIds();
const adapters = createAdapters(activos);
const collector = new Collector({
  adapters,
  budget: { maxWebsockets: 8, maxRequestsPerMinute: 240 },
  intervalMs: COLLECT_INTERVAL_MS,
});

/** Un ano y un mes de APY diario por pool: unas 7.000 filas al dia. */
const POOLS_RETENCION_MS = 400 * 86_400_000;

/**
 * DefiLlama se recalcula cada hora en origen, asi que consultarlo mas a menudo
 * no aporta nada y solo gasta rate limit de una API que nos deja usarla gratis.
 */
const poolsSource = new PollingSource({
  id: 'defillama-pools',
  intervalMs: Number(process.env['POOLS_INTERVAL_MS'] ?? 3_600_000),
  fetch: async () => {
    const pools = await fetchPools();
    // Cada lectura deja el APY del dia de cada pool, del que salen las medias
    // de 7 y 15 dias que DefiLlama no publica. Si guardar falla, las pools se
    // sirven igual: el historico es un extra, no la fuente.
    try {
      writePoolDaily(db, Date.now(), pools);
      prunePoolDaily(db, Date.now() - POOLS_RETENCION_MS);
    } catch (err) {
      console.error('pools: no se pudo guardar el APY diario:', err instanceof Error ? err.message : err);
    }
    return pools;
  },
  count: (pools) => pools.length,
});

const bridgesSource = new PollingSource({
  id: 'defillama-bridges',
  intervalMs: Number(process.env['BRIDGES_INTERVAL_MS'] ?? 3_600_000),
  fetch: fetchBridges,
  count: (bridges) => bridges.length,
});

// Rutas reales y volumen de agregadores. Cada una por separado: si LI.FI cae,
// deBridge y DefiLlama siguen sirviendo, y Data Sources dice cual fallo.
const lifiSource = new PollingSource({
  id: 'lifi-routes',
  intervalMs: 3_600_000,
  fetch: fetchLifiRoutes,
  count: (p) => p.length,
});
const debridgeSource = new PollingSource({
  id: 'debridge-routes',
  intervalMs: 3_600_000,
  fetch: fetchDebridgeRoutes,
  count: (p) => p[0]?.chains.length ?? 0,
});
// Calendario economico de la semana. Ver `calendar.ts`.
const calendarSource = new PollingSource({
  id: 'forexfactory-calendar',
  intervalMs: 3_600_000,
  fetch: fetchEconomicCalendar,
  count: (e) => e.length,
});

// Competiciones y puntos que el venue publica. Solo Perpl lo hace sin clave.
const campaignsSource = new PollingSource({
  id: 'perpl-campaigns',
  intervalMs: 3_600_000,
  fetch: fetchPerplCampaigns,
  count: (c) => c.length,
});
const aggregatorsSource = new PollingSource({
  id: 'defillama-bridge-aggregators',
  intervalMs: 3_600_000,
  fetch: fetchBridgeAggregators,
  count: (a) => a.length,
});


collector.onCycle(() => {
  const escritas = persister.maybePersist(collector.snapshots());
  if (escritas === 0) return;

  writeHealth(
    db,
    Date.now(),
    collector.health().map((h) => ({
      source: h.venue,
      status: h.status,
      reason: h.reason,
      symbolCount: h.symbolCount,
      latencyP50Ms: h.latencyP50Ms,
    })),
  );

  // Se pregunta a los datos, no a un temporizador en memoria: asi un
  // reinicio no borra el calendario y el trabajo atrasado se recupera solo.
  if (retentionPending(db, DEFAULT_RETENTION)) {
    const r = runRetention(db, DEFAULT_RETENTION);
    console.log(`retencion: ${r.borradas} comprimidas, ${r.purgadas} purgadas`);
  }
});

/**
 * Avisos de cambio de posicion.
 *
 * El bot de Telegram es PROPIO y solo manda texto. Sin `TELEGRAM_BOT_TOKEN` y
 * `TELEGRAM_CHAT_ID` no se envia nada: los cambios se siguen detectando y
 * guardando, y la pantalla dice que no hay bot conectado. Poner esas dos
 * variables en el `.env` real, que vive fuera del repo, es el acto explicito
 * que enciende el envio.
 */
const alerts = new AlertService({
  db,
  telegram: telegramFromEnv(),
  minNotionalUsd: Number(process.env['ALERT_MIN_USD'] || 500),
  // Dos vueltas. Con mas hueco entre lecturas no se avisa: ver alertService.ts.
  maxGapMs: TRADERS_INTERVAL_MS * 2,
});

/**
 * Seguimiento de traders. Solo lee direcciones publicas.
 *
 * Va contra Hyperliquid porque es el unico venue con posiciones publicas sin
 * firma. Si ese adaptador no estuviese activo, no se arranca y la pantalla lo
 * declara en vez de ensenar una tabla que nadie refresca.
 */
const hyperliquid = adapters.find((a) => a.meta.id === 'hyperliquid');
const tracker = hyperliquid?.fetchPositions === undefined
  ? undefined
  : new TraderTracker({
    db,
    fetchPositions: (address) => hyperliquid.fetchPositions!(address),
    intervalMs: TRADERS_INTERVAL_MS,
    onRead: (trader, prev, next) => { alerts.onRead(trader, prev, next); },
    onFills: async (trader, equityUsd) => {
      // El venue corta en 2.000 por respuesta y, medido el 16 de noviembre de
      // 2026, con fecha devuelve las 2.000 MAS ANTIGUAS de la ventana y sin
      // fecha las 2.000 mas recientes. De ahi la politica:
      //
      // - Primera vez: las recientes. Empezar siete dias atras con una cuenta
      //   muy activa era ir gateando desde el pasado sin alcanzar nunca el
      //   presente, 2.000 ejecuciones por vuelta.
      // - Despues: desde la ultima guardada, con cinco minutos de solape. Los
      //   duplicados los descarta `tid`, asi que solapar es gratis.
      // - Si aun asi vuelven 2.000 justas, la cuenta opera mas rapido de lo
      //   que se la lee: se piden TAMBIEN las recientes para que el presente
      //   quede cubierto, y se acepta el hueco de en medio. Quien hace mas de
      //   2.000 operaciones por vuelta es un creador de mercado.
      const ultima = lastFillAt(db, trader.id);
      const lotes = ultima === null
        ? [await fetchHyperliquidFills(trader.address)]
        : [await fetchHyperliquidFills(trader.address, ultima - 300_000)];
      if (ultima !== null && lotes[0]?.completo === false) {
        lotes.push(await fetchHyperliquidFills(trader.address));
      }

      const filas = lotes.flatMap((l) => l.fills).map((f) => ({
        tid: f.tid,
        traderId: trader.id,
        symbol: f.symbol,
        coin: f.symbolNative,
        ts: f.ts,
        dir: f.dir,
        side: f.side,
        px: f.px,
        sz: f.sz,
        notionalUsd: f.notionalUsd,
        closedPnl: f.closedPnl,
        fee: f.fee,
        // Con el equity de ESTA lectura, no el de hoy: recalcularlo despues
        // daria a una operacion de hace un mes un porcentaje que nunca tuvo.
        accountPct: equityUsd === null || equityUsd <= 0
          ? null : (f.notionalUsd / equityUsd) * 100,
      }));
      if (filas.length > 0) insertFills(db, filas);

      // Retencion, una vez al dia como mucho. Sin ella, seguir a una cuenta
      // muy activa llena el disco: 1.470 ejecuciones en quince minutos.
      if (Date.now() - ultimaPurgaFills > 86_400_000) {
        pruneFills(db, Date.now() - FILLS_RETENCION_MS);
        ultimaPurgaFills = Date.now();
      }
    },
  });

/**
 * Interes abierto. Los DEX salen del collector, sin pedir nada nuevo; los CEX
 * son dos peticiones por vuelta, una por bolsa, con todos sus mercados dentro.
 */
const openInterest = new OpenInterestService({
  db,
  dex: () => collector.snapshots(),
  dexMeta: () => new Map(activos.flatMap((id) => {
    const e = REGISTRY.get(id);
    if (e === undefined) return [];
    const salud = collector.health().find((h) => h.venue === id);
    return [[id, {
      label: e.meta.label,
      status: salud?.status ?? null,
      chain: e.meta.chain,
      collateral: e.meta.collateral,
      fundingIntervalHours: e.meta.fundingIntervalHours,
      makerBps: e.meta.fees.makerBps,
      takerBps: e.meta.fees.takerBps,
    }] as const];
  })),
  intervalMs: Number(process.env['OI_INTERVAL_MS'] || 300_000),
});

const server = createApi({
  collector,
  db,
  // Solo los activos: si entrasen todos, Data Sources ensenaria en amarillo
  // para siempre cuatro venues que nadie esta pidiendo.
  metas: new Map(activos.flatMap((id) => {
    const e = REGISTRY.get(id);
    return e === undefined ? [] : [[id, e.meta] as const];
  })),
  adapters: new Map(adapters.map((a) => [a.meta.id, a])),
  collectIntervalMs: COLLECT_INTERVAL_MS,
  pools: poolsSource,
  bridges: bridgesSource,
  bridgeRoutes: [lifiSource, debridgeSource],
  bridgeAggregators: aggregatorsSource,
  campaigns: campaignsSource,
  calendar: calendarSource,
  traders: tracker,
  alerts,
  sustainability: new SustainabilityIndex({ db }),
  openInterest,
});

collector.start();
poolsSource.start();
bridgesSource.start();
lifiSource.start();
debridgeSource.start();
aggregatorsSource.start();
campaignsSource.start();
calendarSource.start();
tracker?.start();
openInterest.start();
server.listen(PORT, HOST, () => {
  console.log(`API en http://${HOST}:${PORT}`);
  console.log(`base de datos: ${DB_PATH}`);
  console.log(`venues: ${collector.venues.join(', ')}`);
  for (const r of collector.rejected) console.log(`RECHAZADO ${r.venue}: ${r.reason}`);
});

const cerrar = () => {
  console.log('\ncerrando...');
  collector.stop();
  poolsSource.stop();
  bridgesSource.stop();
  lifiSource.stop();
  debridgeSource.stop();
  aggregatorsSource.stop();
  campaignsSource.stop();
  calendarSource.stop();
  tracker?.stop();
  openInterest.stop();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  // Si alguna conexion SSE no cierra a tiempo, no se deja el proceso colgado.
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', cerrar);
process.on('SIGTERM', cerrar);
