import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import type { MarketSnapshot, OrderBook, VenueMeta } from '@defi/core';
import {
  buyCost, sellCost, toHourly, addressKind,
  clasificar, precioDeReferencia, CLASES, type ClaseActivo, familiaDe, familiasDeBusqueda,
} from '@defi/core';
import type { VenueAdapter, Pool, Bridge, ProveedorRutas, AgregadorBridge, Campana, EventoEconomico } from '@defi/venues';
import {
  VENUES_DEL_USUARIO,
  bridgeChains, routesBetween, AUSENTES_POR_DISENO, conecta, estadoCampana, enlaceOficial,
  POINTS_PROGRAMS, POINTS_STALE_AFTER_DAYS, pointsFreshness, daysSince,
  fetchHyperliquidCandles, esIntervalo, INTERVALOS, fetchLibroHl,
} from '@defi/venues';
import { scanGross, withDepth, fundingMatrix, type ScanOptions } from '@defi/scanner';
import {
  allSources, resolveImpact, statusToLight, SECTION_ORDER, SECTION_LABELS, SECTION_AREA, AREAS,
  NON_VENUE_SOURCES,
} from '@defi/sources';
import {
  readSeries, readVolumenDiario, readMidsAt, readPoolMeans, MINIMO_DIAS, type MediasPools, listWallets, addWallet, removeWallet,
  addFundingPosition, listFundingPositions, updateFundingPosition, removeFundingPosition,
  positionMetricsFromDb, estimateFundingFromHistory,
  addSizeChange, listSizeChanges, removeSizeChange,
  addIncomeEntry, listIncomeEntries, removeIncomeEntry, incomeTotals,
  setReferralLink, listReferralLinks, removeReferralLink,
  addPointsProgram, listPointsPrograms, removePointsProgram, reorderPointsPrograms,
  addFarmingAction, listFarmingActions, removeFarmingAction,
  actionMetrics, farmingPortfolio,
  addTrader, listTraders, updateTrader, removeTrader, readFills, type TraderPatch,
} from '@defi/storage';
import { traderStatus, type TraderState } from './traderTracker.ts';
import { escanearParidad, historiaParidad } from './parityScan.ts';
import { CatalogoHyperliquid } from './hlCatalogo.ts';
import type { AlertsStatus } from './alertService.ts';
import type { Sostenibilidad } from './sustainability.ts';
import type { AlertEvent, ParDeVenues } from '@defi/storage';
import type { SourceHealth } from '@defi/collector';
import {
  HttpProblem, badRequest, notFound, sendJson, sendProblem,
  numberParam, enumParam, stringParam, listParam, readJsonBody, openEventStream,
} from './http.ts';
import { WidgetHealth } from './widgetHealth.ts';

/**
 * Dependencias como interfaz estructural, no como clases concretas: asi los
 * tests montan la API sin abrir conexiones ni tocar la red.
 */
export interface ApiDeps {
  readonly collector: {
    snapshots(): Map<string, Map<string, MarketSnapshot>>;
    health(): SourceHealth[];
    readonly venues: string[];
    readonly rejected: readonly { venue: string; reason: string }[];
    readonly lastCycle: { at: number; durationMs: number; ok: number; failed: number; freshSymbols: number } | null;
    /** Hallazgos de plausibilidad del ultimo ciclo (tickers ambiguos, precios raros). */
    readonly findings?: readonly { venue: string; symbol: string | null; rule: string; severity: string; message: string }[];
    onCycle(listener: (r: unknown) => void): () => void;
  };
  readonly db: DatabaseSync;
  readonly metas: ReadonlyMap<string, VenueMeta>;
  readonly adapters: ReadonlyMap<string, VenueAdapter>;
  /** Intervalo real de recogida, para no describir una cadencia desfasada. */
  readonly collectIntervalMs: number;
  /** Catalogo completo de Hyperliquid para el Terminal. Ausente = uno propio. */
  readonly hlCatalogo?: CatalogoHyperliquid | undefined;
  /** Fuente de pools de DefiLlama. Ausente = la pestana lo declara. */
  readonly pools?: { data: Pool[] | null; health(): SourceHealth } | undefined;
  /** Fuente de bridges. Ausente = la pestana lo declara. */
  readonly bridges?: { data: Bridge[] | null; health(): SourceHealth } | undefined;
  /** Rutas confirmadas por LI.FI y deBridge, una fuente cada una. */
  readonly bridgeRoutes?: readonly { readonly id: string; data: ProveedorRutas[] | null; health(): SourceHealth }[] | undefined;
  /** Calendario economico de la semana (ForexFactory). */
  readonly calendar?: { data: EventoEconomico[] | null; health(): SourceHealth } | undefined;
  /** Campanas leidas en vivo del venue que las publica. */
  readonly campaigns?: { data: Campana[] | null; health(): SourceHealth } | undefined;
  /** Volumen de agregadores de puentes, de DefiLlama. */
  readonly bridgeAggregators?: { data: AgregadorBridge[] | null; health(): SourceHealth } | undefined;
  /** Seguimiento de traders. Ausente = la pantalla lo declara, no finge datos. */
  readonly traders?: {
    state(id: string): TraderState | null;
    readonly intervalMs: number;
    readonly staleAfterMs: number;
  } | undefined;
  /**
   * Avisos de cambio de posicion. Existe aunque Telegram no este configurado:
   * los cambios se detectan y se guardan igual, y su estado dice si salen.
   */
  readonly alerts?: {
    status(): AlertsStatus;
    recent(limit?: number, traderId?: string): AlertEvent[];
    test(): Promise<void>;
  } | undefined;
  /**
   * Nota de sostenibilidad de cada cruce. Ausente = la columna sale vacia,
   * que es un hueco y no un cero.
   */
  readonly sustainability?: {
    get(p: ParDeVenues): Sostenibilidad | null;
    observe(pares: readonly ParDeVenues[]): void;
  } | undefined;
  /** Interes abierto. Ausente = la pantalla lo declara. */
  readonly openInterest?: {
    query(o: { symbol?: string | undefined; venues?: readonly string[] | undefined; rangeMs?: number | undefined }): unknown;
    /** Salud de sus fuentes (CEX y DefiLlama), para Data Sources. */
    health?(): SourceHealth[];
  } | undefined;
}

/** Origenes admitidos. La API escucha en 127.0.0.1: solo la web local la usa. */
const ORIGENES_LOCALES = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function aplicarCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  // Lista blanca estricta en vez de '*': aunque solo escuche en local, un '*'
  // deja que cualquier pagina abierta en el navegador lea estos datos.
  if (typeof origin === 'string' && ORIGENES_LOCALES.test(origin)) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'origin');
    res.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type');
  }
}

/**
 * Cache de libros con caducidad.
 *
 * Cambiar el horizonte o el modo de fees NO cambia que libros hacen falta: solo
 * la aritmetica de amortizacion. Sin cache, cada clic en la pantalla dispara 80
 * peticiones a los venues, que en una Pi que comparte IP publica con los otros
 * bots es la forma mas rapida de comerse el rate limit.
 *
 * La caducidad va atada al ciclo de recogida: pedir el libro mas a menudo que
 * el resto de los datos no aporta nada, porque el snapshot con el que se
 * compara sigue siendo el mismo.
 */
class BookCache {
  #ttlMs: number;
  #entries = new Map<string, { at: number; book: OrderBook | null }>();

  constructor(ttlMs: number) {
    this.#ttlMs = ttlMs;
  }

  /**
   * Devuelve el libro Y cuando se obtuvo.
   *
   * La hora no es un extra: el slippage sale de cruzar DOS libros que no se
   * piden a la vez, y uno puede venir de cache mientras el otro se acaba de
   * pedir. Sin saber el desfase, el coste de ejecucion que sale de ahi no
   * corresponde a ningun instante real, y no hay forma de que la pantalla lo
   * advierta.
   */
  async get(
    venue: string,
    symbol: string,
    fetch: () => Promise<OrderBook | null>,
  ): Promise<{ book: OrderBook | null; at: number }> {
    const key = `${venue}:${symbol}`;
    const hit = this.#entries.get(key);
    if (hit !== undefined && Date.now() - hit.at < this.#ttlMs) return { book: hit.book, at: hit.at };

    // Un fallo se cachea igual que un exito: si un venue esta dando error, no
    // tiene sentido reintentarlo 80 veces por cada clic del usuario.
    const book = await fetch().catch(() => null);
    const at = Date.now();
    this.#entries.set(key, { at, book });
    return { book, at };
  }

  /** Descarta lo caducado para que el mapa no crezca sin limite. */
  prune(): void {
    const ahora = Date.now();
    for (const [key, entry] of this.#entries) {
      if (ahora - entry.at >= this.#ttlMs) this.#entries.delete(key);
    }
  }
}

export function createApi(deps: ApiDeps) {
  const books = new BookCache(deps.collectIntervalMs);
  // Los widgets los mide el navegador, no el servidor: aqui solo se recogen sus
  // reportes, y solo para ids que ya estan en el catalogo de fuentes.
  const widgets = new WidgetHealth(
    NON_VENUE_SOURCES.filter((f) => f.kind === 'widget').map((f) => f.id),
  );
  const limpieza = setInterval(() => books.prune(), deps.collectIntervalMs);
  limpieza.unref();

  const hl = deps.hlCatalogo ?? new CatalogoHyperliquid();
  // El libro del Terminal, con vida corta: `l2Book` pesa 2 y la pantalla lo
  // pide cada pocos segundos. El de arriba vive lo que un ciclo de recogida,
  // que para mirar un libro en directo es demasiado viejo.
  const librosHl = new BookCache(3_000);
  const limpiezaHl = setInterval(() => librosHl.prune(), 60_000);
  limpiezaHl.unref();
  const server = createHttpServer((req, res) => {
    void manejar(req, res, deps, books, widgets, hl, librosHl).catch((err: unknown) => sendProblem(res, err));
  });
  server.on('close', () => { clearInterval(limpieza); clearInterval(limpiezaHl); });
  return server;
}

async function manejar(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiDeps,
  books: BookCache,
  widgets: WidgetHealth,
  hl: CatalogoHyperliquid,
  librosHl: BookCache,
): Promise<void> {
  aplicarCors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

  const url = new URL(req.url ?? '/', 'http://localhost');
  const ruta = url.pathname.replace(/\/+$/, '') || '/';
  const metodo = req.method ?? 'GET';

  if (ruta === '/api/health' && metodo === 'GET') return salud(res, deps);
  if (ruta === '/api/sections' && metodo === 'GET') return secciones(res);
  if (ruta === '/api/venues' && metodo === 'GET') return venues(res, deps);
  if (ruta === '/api/sources' && metodo === 'GET') return fuentes(res, deps, widgets);
  if (ruta === '/api/widget-health' && metodo === 'POST') return reportarWidget(req, res, widgets);
  if (ruta === '/api/scanner' && metodo === 'GET') return scanner(res, deps, url, books);
  if (ruta === '/api/funding-matrix' && metodo === 'GET') return matriz(res, deps, url);
  if (ruta === '/api/volume' && metodo === 'GET') return volumen(res, deps, url);
  if (ruta === '/api/volume/weekly' && metodo === 'GET') return volumenSemanal(res, deps, url);
  if (ruta === '/api/explorer' && metodo === 'GET') return explorador(res, deps, url);
  if (ruta === '/api/pools' && metodo === 'GET') return pools(res, deps, url);
  if (ruta === '/api/bridges' && metodo === 'GET') return bridges(res, deps, url);
  if (ruta === '/api/points' && metodo === 'GET') return puntos(res, deps);
  if (ruta === '/api/calendar' && metodo === 'GET') return calendario(res, deps);
  if (ruta === '/api/parity/scan' && metodo === 'GET') return paridadEscaner(res, deps, url);
  if (ruta === '/api/parity/pair' && metodo === 'GET') return paridadPar(res, deps, url);
  if (ruta === '/api/parity/depth' && metodo === 'GET') return paridadProfundidad(res, deps, url, books);
  if (ruta === '/api/positions' && metodo === 'GET') return posiciones(res, deps, url);
  if (ruta === '/api/series' && metodo === 'GET') return series(res, deps, url);
  if (ruta === '/api/markets' && metodo === 'GET') return mercados(res, deps, url);
  if (ruta === '/api/candles' && metodo === 'GET') return velas(res, deps, url, hl);
  if (ruta === '/api/hl/markets' && metodo === 'GET') return mercadosHl(res, hl);
  if (ruta === '/api/hl/book' && metodo === 'GET') return libroHl(res, url, hl, librosHl);
  if (ruta === '/api/hl/trades' && metodo === 'GET') return tradesHl(res, url, hl);
  if (ruta === '/api/book' && metodo === 'GET') return libro(res, deps, url, books);
  if (ruta === '/api/stream' && metodo === 'GET') return stream(req, res, deps);

  if (ruta === '/api/funding-positions' && metodo === 'GET') return arbitrajes(res, deps);
  if (ruta === '/api/funding-positions' && metodo === 'POST') return crearArbitraje(req, res, deps);
  if (ruta.startsWith('/api/funding-positions/')) {
    const id = decodeURIComponent(ruta.slice('/api/funding-positions/'.length));
    if (id === '') throw badRequest('the id is required');
    if (metodo === 'PATCH') return actualizarArbitraje(req, res, deps, id);
    if (metodo === 'DELETE') {
      if (!removeFundingPosition(deps.db, id)) throw notFound('that position does not exist');
      return sendJson(res, 200, { deleted: id });
    }
  }

  if (ruta === '/api/size-changes' && metodo === 'POST') return crearCambioTamano(req, res, deps);
  if (ruta.startsWith('/api/size-changes/') && metodo === 'DELETE') {
    const id = decodeURIComponent(ruta.slice('/api/size-changes/'.length));
    if (!removeSizeChange(deps.db, id)) throw notFound('that size change does not exist');
    return sendJson(res, 200, { deleted: id });
  }

  if (ruta === '/api/income' && metodo === 'GET') return ingresos(res, deps);
  if (ruta === '/api/income' && metodo === 'POST') return crearIngreso(req, res, deps);
  if (ruta.startsWith('/api/income/') && metodo === 'DELETE') {
    const id = decodeURIComponent(ruta.slice('/api/income/'.length));
    if (!removeIncomeEntry(deps.db, id)) throw notFound('that entry does not exist');
    return sendJson(res, 200, { deleted: id });
  }
  if (ruta === '/api/referral-links' && metodo === 'POST') return guardarReferido(req, res, deps);
  if (ruta.startsWith('/api/referral-links/') && metodo === 'DELETE') {
    const venue = decodeURIComponent(ruta.slice('/api/referral-links/'.length));
    if (!removeReferralLink(deps.db, venue)) throw notFound('that link does not exist');
    return sendJson(res, 200, { deleted: venue });
  }

  if (ruta === '/api/farming' && metodo === 'GET') return farmeo(res, deps);
  if (ruta === '/api/farming/programs' && metodo === 'POST') return crearPrograma(req, res, deps);
  if (ruta.startsWith('/api/farming/programs/') && metodo === 'DELETE') {
    const id = decodeURIComponent(ruta.slice('/api/farming/programs/'.length));
    if (!removePointsProgram(deps.db, id)) throw notFound('that program does not exist');
    return sendJson(res, 200, { deleted: id });
  }
  if (ruta === '/api/farming/order' && metodo === 'PUT') return ordenarProgramas(req, res, deps);
  if (ruta === '/api/farming/actions' && metodo === 'POST') return crearAccion(req, res, deps);
  if (ruta.startsWith('/api/farming/actions/') && metodo === 'DELETE') {
    const id = decodeURIComponent(ruta.slice('/api/farming/actions/'.length));
    if (!removeFarmingAction(deps.db, id)) throw notFound('that action does not exist');
    return sendJson(res, 200, { deleted: id });
  }

  if (ruta === '/api/traders' && metodo === 'GET') return traders(res, deps);
  if (ruta === '/api/traders' && metodo === 'POST') return crearTrader(req, res, deps);
  if (ruta.startsWith('/api/traders/')) {
    const id = decodeURIComponent(ruta.slice('/api/traders/'.length));
    if (id === '') throw badRequest('the id is required');
    if (metodo === 'PATCH') return editarTrader(req, res, deps, id);
    if (metodo === 'DELETE') {
      if (!removeTrader(deps.db, id)) throw notFound('that trader is not on the list');
      return sendJson(res, 200, { deleted: id });
    }
  }

  if (ruta === '/api/open-interest' && metodo === 'GET') return interesAbierto(res, deps, url);
  if (ruta === '/api/fills' && metodo === 'GET') return ejecuciones(res, deps, url);
  if (ruta === '/api/alerts' && metodo === 'GET') return alertas(res, deps, url);
  if (ruta === '/api/alerts/test' && metodo === 'POST') return probarAvisos(res, deps);

  if (ruta === '/api/wallets' && metodo === 'GET') return sendJson(res, 200, listWallets(deps.db));
  if (ruta === '/api/wallets' && metodo === 'POST') return crearWallet(req, res, deps);
  if (ruta.startsWith('/api/wallets/') && metodo === 'DELETE') {
    const id = decodeURIComponent(ruta.slice('/api/wallets/'.length));
    if (id === '') throw badRequest('the id is required');
    if (!removeWallet(deps.db, id)) throw notFound('that wallet does not exist');
    return sendJson(res, 200, { deleted: id });
  }

  throw notFound();
}

// --- Endpoints ---------------------------------------------------------------

function salud(res: ServerResponse, deps: ApiDeps): void {
  const health = deps.collector.health();
  // "Live" solo dice que el flujo de eventos esta abierto. Lo que hace falta
  // saber es si las FUENTES estan bien y de cuando es el dato mas viejo que se
  // esta pintando: un venue congelado no corta el flujo.
  const degradadas = health.filter((h) => h.status === 'degraded').map((h) => h.venue);
  const caidas = health.filter((h) => h.status === 'down').map((h) => h.venue);
  const ultimosOk = health.map((h) => h.lastOkAt).filter((t): t is number => t !== null);

  sendJson(res, 200, {
    ok: true,
    lastCycle: deps.collector.lastCycle,
    venues: deps.collector.venues,
    rejected: deps.collector.rejected,
    sources: {
      total: health.length,
      ok: health.filter((h) => h.status === 'ok').length,
      degraded: degradadas,
      down: caidas,
      // El venue que lleva mas tiempo sin dar un ciclo bueno: es el que marca
      // la edad real de lo que se esta viendo.
      oldestOkAt: ultimosOk.length === 0 ? null : Math.min(...ultimosOk),
    },
  });
}

/** El menu lo sirve el backend: anadir o quitar una pestana se hace en un sitio. */
function secciones(res: ServerResponse): void {
  // Areas y secciones juntas: la navegacion entera se define en un sitio, y
  // la portada y los menus de area salen de la misma respuesta.
  sendJson(res, 200, {
    areas: AREAS,
    sections: SECTION_ORDER.map((id) => ({ id, label: SECTION_LABELS[id], area: SECTION_AREA[id] })),
  });
}

function venues(res: ServerResponse, deps: ApiDeps): void {
  sendJson(res, 200, [...deps.metas.values()]);
}

/**
 * Catalogo de fuentes con su semaforo y a que pestanas afecta cada fallo.
 * Es lo que alimenta la pestana Data Sources.
 */
function fuentes(res: ServerResponse, deps: ApiDeps, widgets: WidgetHealth): void {
  const health = deps.collector.health();
  // La cadencia se deriva del intervalo real configurado: escrita a mano se
  // desfasa en cuanto se cambie el collector, y la pantalla mentiria.
  const cadence = `every ${Math.round(deps.collectIntervalMs / 1000)}s`;
  const sources = allSources([...deps.metas.values()].map((m) => ({ id: m.id, label: m.label })), cadence);
  // Las fuentes externas reportan igual que los venues: si no se anadiesen
  // aqui, DefiLlama seguiria en amarillo aunque funcionase perfectamente.
  const externas = [
    ...(deps.pools === undefined ? [] : [{ id: 'defillama-pools', health: deps.pools.health() }]),
    ...(deps.bridges === undefined ? [] : [{ id: 'defillama-bridges', health: deps.bridges.health() }]),
    ...(deps.bridgeRoutes ?? []).map((f) => ({ id: f.id, health: f.health() })),
    ...(deps.bridgeAggregators === undefined ? [] : [{ id: 'defillama-bridge-aggregators', health: deps.bridgeAggregators.health() }]),
    ...(deps.campaigns === undefined ? [] : [{ id: 'perpl-campaigns', health: deps.campaigns.health() }]),
    ...(deps.calendar === undefined ? [] : [{ id: 'forexfactory-calendar', health: deps.calendar.health() }]),
    ...(deps.openInterest?.health?.() ?? []).map((h) => ({ id: h.venue, health: h })),
    { id: 'points-manual', health: saludDePuntos() },
    // Un widget sin reporte reciente se queda en null: amarillo "sin reportar",
    // que es exactamente lo que se sabe de el.
    ...NON_VENUE_SOURCES.filter((f) => f.kind === 'widget').flatMap((f) => {
      const h = widgets.health(f.id);
      return h === null ? [] : [{ id: f.id, health: h }];
    }),
  ];
  const states = [
    ...health.map((h) => ({ id: h.venue, light: statusToLight(h.status) })),
    ...externas.map((e) => ({ id: e.id, light: statusToLight(e.health.status) })),
  ];

  sendJson(res, 200, {
    sources: sources.map((s) => {
      const salud =
        health.find((h) => h.venue === s.id) ??
        externas.find((e) => e.id === s.id)?.health ??
        null;
      return {
        ...s,
        light: salud === null ? null : statusToLight(salud.status),
        health: salud,
        sections: s.feeds.map((f) => ({
          id: f.section,
          label: SECTION_LABELS[f.section],
          criticality: f.criticality,
        })),
      };
    }),
    impact: resolveImpact(sources, states).map((i) => ({ ...i, label: SECTION_LABELS[i.section] })),
    // Lo que la barra de estado cuenta como "data issues", con el detalle: un
    // numero sin poder ver que hay detras no sirve para comprobar nada.
    findings: deps.collector.findings ?? [],
  });
}

/**
 * Matriz de funding para el screener: simbolos por venues.
 *
 * `venues` elige que columnas se comparan; vacio = todas. El diferencial y los
 * papeles de largo y corto se calculan solo entre esas, por eso va en el
 * servidor y con pruebas, y no en la pantalla.
 *
 * No pide libros: es la vista barata. Con ~240 simbolos por cinco venues pedir
 * profundidad seria reventar el rate limit de la IP que compartes con tus bots.
 */
function matriz(res: ServerResponse, deps: ApiDeps, url: URL): void {
  const todos = [...deps.metas.keys()];
  const pedidos = listParam(url, 'venues');
  // Sin eleccion explicita se comparan los venues que OPERA el usuario, no
  // todos los que se recogen. Se recogen diez porque el volumen y la paridad
  // quieren amplitud; comparar el funding de un sitio donde no vas a abrir
  // nada solo mete columnas vacias. La eleccion del usuario manda y la web se
  // la recuerda.
  const porDefecto = todos.filter((v) => VENUES_DEL_USUARIO.includes(v));
  const venues = pedidos.length === 0
    ? (porDefecto.length > 0 ? porDefecto : todos)
    : todos.filter((v) => pedidos.includes(v));

  // Con UN SOLO venue elegido la pregunta cambia: no es "el mejor cruce entre
  // los elegidos", que con uno no existe, sino "el mejor cruce que puedo
  // montar desde aqui". Se compara contra todos los demas y se exige que una
  // de las dos patas caiga en el elegido.
  const anchor = venues.length === 1 ? venues[0] ?? null : null;
  const comparados = anchor === null ? venues : todos;

  const snapshots = deps.collector.snapshots();
  const salud = new Map(deps.collector.health().map((h) => [h.venue, h.status]));
  const filas = fundingMatrix(snapshots, comparados, 2, anchor);

  // Lo sostenido que ha sido CADA cruce. Se pide lo que la tabla va a ensenar
  // y se sirve lo que ya este calculado: el calculo entero tarda cerca de un
  // segundo y no puede ir dentro de la peticion. Lo que falte sale como hueco,
  // que significa "todavia no", no "no hay".
  const pares = filas.flatMap((f) => (f.longVenue !== null && f.shortVenue !== null
    ? [{ symbol: f.symbol, largo: f.longVenue, corto: f.shortVenue }]
    : []));
  deps.sustainability?.observe(pares);
  const conNota = filas.map((f) => ({
    ...f,
    sustained: f.longVenue === null || f.shortVenue === null
      ? null
      : deps.sustainability?.get({ symbol: f.symbol, largo: f.longVenue, corto: f.shortVenue }) ?? null,
  }));

  sendJson(res, 200, {
    at: Date.now(),
    lastCycleAt: deps.collector.lastCycle?.at ?? null,
    collectIntervalMs: deps.collectIntervalMs,
    // Anclado: la tabla tiene que ensenar TODAS las columnas aunque solo haya
    // un venue marcado, porque si no, no se ve quien es la contraparte.
    anchor,
    venues: todos.map((id) => {
      const meta = deps.metas.get(id);
      const muestra = snapshots.get(id)?.values().next().value;
      return {
        id,
        label: meta?.label ?? id,
        selected: anchor === null ? venues.includes(id) : comparados.includes(id),
        status: salud.get(id) ?? null,
        intervalHours: muestra?.funding.intervalHours ?? meta?.fundingIntervalHours ?? null,
        // Que publica este venue: la tasa del periodo en curso o la del
        // siguiente. dydx es el unico que publica la del siguiente.
        kind: muestra?.funding.kind ?? null,
        // DEX o CEX, para el filtro de tipo de venue de la pantalla.
        venueKind: meta?.kind === 'perp-cex' ? 'cex' : 'dex',
        url: enlaceOficial(id),
        symbols: snapshots.get(id)?.size ?? 0,
      };
    }),
    total: conNota.length,
    rows: conNota,
  });
}

async function scanner(
  res: ServerResponse,
  deps: ApiDeps,
  url: URL,
  books: BookCache,
): Promise<void> {
  const options: ScanOptions = {
    notionalPerLegUsd: numberParam(url, 'notional', { def: 10_000, min: 100, max: 50_000_000 }),
    holdHours: numberParam(url, 'days', { def: 7, min: 0.25, max: 365 }) * 24,
    feeMode: enumParam(url, 'feeMode', ['taker', 'maker'] as const, 'taker'),
    minGrossAprPct: numberParam(url, 'minApr', { def: 1, min: -1000, max: 10_000 }),
  };
  const limite = numberParam(url, 'limit', { def: 25, min: 1, max: 200 });
  const filtroSimbolo = (url.searchParams.get('symbol') ?? '').trim().toUpperCase();
  const filtroVenues = new Set(listParam(url, 'venues'));
  const minVolumeUsd = numberParam(url, 'minVolume', { def: 0, min: 0, max: 1e12 });

  const snapshots = deps.collector.snapshots();
  const todas = scanGross(snapshots, deps.metas, options);

  // El volumen se mira por venue y simbolo: un par solo cuenta como liquido si
  // AMBAS patas lo son. Que una sea profunda no sirve de nada si la otra no.
  const volumenDe = (venue: string, symbol: string): number | null =>
    snapshots.get(venue)?.get(symbol)?.volume24hUsd ?? null;

  const brutas = todas.filter((op) => {
    if (filtroSimbolo !== '' && !op.symbol.includes(filtroSimbolo)) return false;
    if (filtroVenues.size > 0 && !filtroVenues.has(op.longVenue) && !filtroVenues.has(op.shortVenue)) {
      return false;
    }
    if (minVolumeUsd > 0) {
      const vLargo = volumenDe(op.longVenue, op.symbol);
      const vCorto = volumenDe(op.shortVenue, op.symbol);
      // Volumen desconocido NO cuenta como que pasa el filtro: seria colar un
      // par sin comprobar por no tener el dato.
      if (vLargo === null || vCorto === null) return false;
      if (vLargo < minVolumeUsd || vCorto < minVolumeUsd) return false;
    }
    return true;
  });

  const candidatas = brutas.slice(0, limite);

  // Segunda fase: libros solo para los candidatos. Pedirlos para las 348
  // oportunidades de un ciclo serian cientos de peticiones por consulta.
  const completas = await Promise.all(
    candidatas.map(async (op) => {
      const largo = deps.adapters.get(op.longVenue);
      const corto = deps.adapters.get(op.shortVenue);
      if (largo?.fetchBook === undefined || corto?.fetchBook === undefined) return op;

      const [largoRes, cortoRes] = await Promise.all([
        books.get(op.longVenue, op.symbol, () => largo.fetchBook!(op.symbol)),
        books.get(op.shortVenue, op.symbol, () => corto.fetchBook!(op.symbol)),
      ]);
      const midLargo = largo.snapshot().get(op.symbol)?.mid;
      const midCorto = corto.snapshot().get(op.symbol)?.mid;
      if (!largoRes.book || !cortoRes.book || midLargo === undefined || midCorto === undefined) return op;

      const ahora = Date.now();
      const edades = {
        longAgeMs: ahora - largoRes.at,
        shortAgeMs: ahora - cortoRes.at,
        skewMs: Math.abs(largoRes.at - cortoRes.at),
      };

      // El largo COMPRA, asi que cruza contra los asks; el corto VENDE y cruza
      // contra los bids. Cambiarlos daria un coste sistematicamente optimista.
      const costeLargo = buyCost(largoRes.book, midLargo, options.notionalPerLegUsd);
      const costeCorto = sellCost(cortoRes.book, midCorto, options.notionalPerLegUsd);
      const sinFondo = costeLargo.insufficientDepth || costeCorto.insufficientDepth;
      const slippage = sinFondo ? 0 : (costeLargo.slippageBps + costeCorto.slippageBps) / 100;
      return withDepth(op, slippage, sinFondo, options, edades);
    }),
  );

  completas.sort((a, b) => (b.netAprPct ?? -Infinity) - (a.netAprPct ?? -Infinity));

  // Interes abierto agregado: se suma UNA vez por venue y simbolo, no por
  // oportunidad, o cada activo se contaria tantas veces como pares forme.
  let totalOiUsd = 0;
  let simbolos = 0;
  const distintos = new Set<string>();
  for (const porSimbolo of snapshots.values()) {
    for (const s of porSimbolo.values()) {
      if (s.openInterestUsd !== null) totalOiUsd += s.openInterestUsd;
      distintos.add(s.symbol);
      simbolos++;
    }
  }

  sendJson(res, 200, {
    total: brutas.length,
    totalUnfiltered: todas.length,
    shown: completas.length,
    opportunities: completas,
    stats: {
      totalOiUsd,
      venues: snapshots.size,
      symbols: distintos.size,
      listings: simbolos,
      bestNetAprPct: completas[0]?.netAprPct ?? null,
    },
  });
}

/**
 * Registra un aumento o una reduccion de una posicion abierta.
 *
 * Es lo que permite que el OI-hora sea la integral del nocional y no el
 * nocional inicial por las horas. Una posicion que paso de 10k a 30k salia
 * antes con un tercio de su actividad real.
 */
async function crearCambioTamano(req: IncomingMessage, res: ServerResponse, deps: ApiDeps): Promise<void> {
  const body = await readJsonBody(req);
  if (typeof body !== 'object' || body === null) throw badRequest('invalid body');
  const d = body as Record<string, unknown>;

  try {
    sendJson(res, 201, addSizeChange(deps.db, {
      positionId: String(d['positionId'] ?? ''),
      at: Number(d['at']),
      notionalUsd: Number(d['notionalUsd']),
      note: typeof d['note'] === 'string' && d['note'] !== '' ? d['note'] : null,
    }));
  } catch (err) {
    throw new HttpProblem(400, err instanceof Error ? err.message : 'invalid size change');
  }
}

/**
 * Ingresos fuera del P&L de trading, con sus totales y los enlaces de referido.
 *
 * Se devuelven tambien las competiciones detectadas, que salen del mismo
 * catalogo que la pestana Points: si un venue no expone sus competiciones por
 * API, esta pantalla tampoco puede saberlas, y eso se declara en vez de dejar
 * un hueco que parezca "no hay ninguna activa".
 */
function ingresos(res: ServerResponse, deps: ApiDeps): void {
  const entradas = listIncomeEntries(deps.db);
  sendJson(res, 200, {
    entries: entradas,
    totals: incomeTotals(entradas),
    referralLinks: listReferralLinks(deps.db),
    // Hoy ningun venue publica sus competiciones sin autenticacion, asi que
    // esta lista esta vacia por una razon concreta que la UI puede explicar.
    liveCompetitions: [],
    liveCompetitionsSupported: POINTS_PROGRAMS.some((p) => p.apiStatus === 'public'),
  });
}

async function crearIngreso(req: IncomingMessage, res: ServerResponse, deps: ApiDeps): Promise<void> {
  const body = await readJsonBody(req);
  if (typeof body !== 'object' || body === null) throw badRequest('invalid body');
  const d = body as Record<string, unknown>;

  const txt = (k: string) => (typeof d[k] === 'string' && d[k] !== '' ? (d[k] as string) : null);
  const kind = d['kind'] === 'competition' ? 'competition' : 'referral';

  try {
    sendJson(res, 201, addIncomeEntry(deps.db, {
      kind,
      venue: txt('venue') ?? '',
      amountUsd: Number(d['amountUsd']),
      receivedAt: Number(d['receivedAt']),
      competition: txt('competition'),
      placement: txt('placement'),
      period: txt('period'),
      note: txt('note'),
    }));
  } catch (err) {
    throw new HttpProblem(400, err instanceof Error ? err.message : 'invalid entry');
  }
}

async function guardarReferido(req: IncomingMessage, res: ServerResponse, deps: ApiDeps): Promise<void> {
  const body = await readJsonBody(req);
  if (typeof body !== 'object' || body === null) throw badRequest('invalid body');
  const d = body as Record<string, unknown>;
  try {
    sendJson(res, 201, setReferralLink(deps.db, String(d['venue'] ?? ''), String(d['url'] ?? '')));
  } catch (err) {
    throw new HttpProblem(400, err instanceof Error ? err.message : 'invalid link');
  }
}

/**
 * Farmeo de puntos: programas, acciones y coste por punto.
 *
 * Las metricas se calculan aqui y no en la pantalla para que el numero salga de
 * un solo sitio. Cada accion viaja con su `pointsEstimated`, que es lo que
 * permite a la UI marcar lo estimado sin tener que adivinarlo comparando campos.
 */
function farmeo(res: ServerResponse, deps: ApiDeps): void {
  const programas = listPointsPrograms(deps.db);
  const porId = new Map(programas.map((p) => [p.id, p]));
  const acciones = listFarmingActions(deps.db);

  sendJson(res, 200, {
    programs: programas,
    actions: acciones.map((a) => ({
      ...a,
      venue: porId.get(a.programId)?.venue ?? null,
      metrics: actionMetrics(a, porId.get(a.programId)),
    })),
    portfolio: farmingPortfolio(acciones, programas),
  });
}

async function crearPrograma(req: IncomingMessage, res: ServerResponse, deps: ApiDeps): Promise<void> {
  const body = await readJsonBody(req);
  if (typeof body !== 'object' || body === null) throw badRequest('invalid body');
  const d = body as Record<string, unknown>;

  // Un campo vacio es un dato desconocido, no un cero: se guarda NULL para que
  // el calculo se declare imposible en vez de estimar sobre un hueco.
  const num = (k: string) => {
    const v = d[k];
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  try {
    sendJson(res, 201, addPointsProgram(deps.db, {
      venue: String(d['venue'] ?? ''),
      pointsPerEpoch: num('pointsPerEpoch'),
      epochLabel: typeof d['epochLabel'] === 'string' && d['epochLabel'] !== '' ? d['epochLabel'] : 'per week',
      epochVolumeUsd: num('epochVolumeUsd'),
      note: typeof d['note'] === 'string' ? d['note'] : null,
    }));
  } catch (err) {
    throw new HttpProblem(400, err instanceof Error ? err.message : 'invalid program');
  }
}

/** Nuevo orden del tablero de Points: la lista entera de ids, de arriba abajo. */
async function ordenarProgramas(req: IncomingMessage, res: ServerResponse, deps: ApiDeps): Promise<void> {
  const body = await readJsonBody(req);
  const ids = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['ids'] : null;
  if (!Array.isArray(ids) || ids.length > 200 || !ids.every((x): x is string => typeof x === 'string')) {
    throw badRequest('ids must be a list of program ids');
  }
  try {
    reorderPointsPrograms(deps.db, ids);
  } catch (err) {
    throw new HttpProblem(400, err instanceof Error ? err.message : 'invalid order');
  }
  sendJson(res, 200, { programs: listPointsPrograms(deps.db) });
}

async function crearAccion(req: IncomingMessage, res: ServerResponse, deps: ApiDeps): Promise<void> {
  const body = await readJsonBody(req);
  if (typeof body !== 'object' || body === null) throw badRequest('invalid body');
  const d = body as Record<string, unknown>;

  const num = (k: string) => {
    const v = d[k];
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  try {
    sendJson(res, 201, addFarmingAction(deps.db, {
      programId: String(d['programId'] ?? ''),
      description: typeof d['description'] === 'string' && d['description'] !== '' ? d['description'] : null,
      volumeUsd: num('volumeUsd'),
      feesPaidUsd: num('feesPaidUsd'),
      pnlUsd: num('pnlUsd'),
      pointsEarned: num('pointsEarned'),
      occurredAt: Number(d['occurredAt']),
    }));
  } catch (err) {
    throw new HttpProblem(400, err instanceof Error ? err.message : 'invalid action');
  }
}

/**
 * Registro de arbitrajes de funding, con sus metricas y el contraste contra
 * nuestro propio historico.
 *
 * El resumen por venue responde a la pregunta que de verdad importa: cual sale
 * mas barato de farmear. Se mide en coste por 1.000 OI·h, y cuanto mas
 * negativo, mejor: significa que ademas de generar actividad te han pagado.
 */
function arbitrajes(res: ServerResponse, deps: ApiDeps): void {
  const posiciones = listFundingPositions(deps.db);

  const filas = posiciones.map((p) => ({
    ...p,
    metrics: positionMetricsFromDb(deps.db, p),
    sizeChanges: listSizeChanges(deps.db, p.id),
    // Contraste independiente de lo anotado a mano. `coverage` decide si el
    // numero vale algo, y viaja siempre con el.
    estimate: estimateFundingFromHistory(deps.db, p),
  }));

  // Coste por venue.
  //
  // El OI·h va ENTERO a cada pata, no a medias. `metrics.oiHours` es el de UNA
  // pata (el formulario pide "size per leg"), y cada venue ve exactamente ese
  // nocional durante ese tiempo: el suyo. Un venue no sabe nada de la pata que
  // tienes en el otro, y su programa de puntos cuenta lo que pasa en su casa.
  //
  // Se repartia a medias, lo que dejaba el denominador en la mitad y por tanto
  // el coste por 1k OI·h del DOBLE de lo real en cada venue. Es justo el numero
  // con el que se comparan venues entre si.
  //
  // Las fees y el neto si se reparten: son del conjunto de la operacion, y
  // atribuir el total a cada pata lo contaria dos veces. Sumando los dos venues
  // sale el coste de la posicion entera.
  const porVenue = new Map<string, { oiHours: number; feesUsd: number | null; netUsd: number | null; posiciones: number }>();
  const anotar = (venue: string, oiHours: number, fees: number | null, net: number | null) => {
    const e = porVenue.get(venue) ?? { oiHours: 0, feesUsd: null, netUsd: null, posiciones: 0 };
    e.oiHours += oiHours;
    e.posiciones += 1;
    if (fees !== null) e.feesUsd = (e.feesUsd ?? 0) + fees;
    if (net !== null) e.netUsd = (e.netUsd ?? 0) + net;
    porVenue.set(venue, e);
  };

  for (const f of filas) {
    const mitadFees = f.feesPaidUsd === null ? null : f.feesPaidUsd / 2;
    const mitadNeto = f.metrics.netUsd === null ? null : f.metrics.netUsd / 2;
    anotar(f.longVenue, f.metrics.oiHours, mitadFees, mitadNeto);
    anotar(f.shortVenue, f.metrics.oiHours, mitadFees, mitadNeto);
  }

  sendJson(res, 200, {
    positions: filas,
    byVenue: [...porVenue.entries()]
      .map(([venue, e]) => ({
        venue,
        ...e,
        costPer1kOiHours: e.netUsd === null || e.oiHours <= 0 ? null : -e.netUsd / (e.oiHours / 1000),
      }))
      // De mas barato a mas caro: el coste mas negativo primero.
      .sort((a, b) => (a.costPer1kOiHours ?? Infinity) - (b.costPer1kOiHours ?? Infinity)),
  });
}

async function crearArbitraje(req: IncomingMessage, res: ServerResponse, deps: ApiDeps): Promise<void> {
  const body = await readJsonBody(req);
  if (typeof body !== 'object' || body === null) throw badRequest('invalid body');
  const d = body as Record<string, unknown>;

  const texto = (k: string) => (typeof d[k] === 'string' ? (d[k] as string) : '');
  const numero = (k: string) => (typeof d[k] === 'number' && Number.isFinite(d[k]) ? (d[k] as number) : null);

  try {
    const creada = addFundingPosition(deps.db, {
      symbol: texto('symbol'),
      longVenue: texto('longVenue'),
      shortVenue: texto('shortVenue'),
      notionalUsd: numero('notionalUsd') ?? 0,
      openedAt: numero('openedAt') ?? Date.now(),
      closedAt: numero('closedAt'),
      feesPaidUsd: numero('feesPaidUsd'),
      fundingCollectedUsd: numero('fundingCollectedUsd'),
      notes: texto('notes') === '' ? null : texto('notes'),
    });
    sendJson(res, 201, creada);
  } catch (err) {
    throw new HttpProblem(400, err instanceof Error ? err.message : 'invalid position');
  }
}

async function actualizarArbitraje(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiDeps,
  id: string,
): Promise<void> {
  const body = await readJsonBody(req);
  if (typeof body !== 'object' || body === null) throw badRequest('invalid body');
  const d = body as Record<string, unknown>;

  // Un campo ausente NO se toca; uno enviado como null se pone en desconocido.
  // Sin esa distincion no habria forma de borrar un importe metido mal.
  const parche: Record<string, number | string | null> = {};
  for (const k of ['closedAt', 'feesPaidUsd', 'fundingCollectedUsd'] as const) {
    if (k in d) parche[k] = d[k] === null ? null : Number(d[k]);
  }
  if ('notes' in d) parche['notes'] = d['notes'] === null ? null : String(d['notes']);

  try {
    const actualizada = updateFundingPosition(deps.db, id, parche);
    if (actualizada === null) throw notFound('that position does not exist');
    sendJson(res, 200, actualizada);
  } catch (err) {
    if (err instanceof HttpProblem) throw err;
    throw new HttpProblem(400, err instanceof Error ? err.message : 'invalid update');
  }
}

/**
 * Posiciones de una direccion publica en todos los venues que lo permiten.
 *
 * Solo lectura y sin ninguna credencial: se consulta una direccion que
 * cualquiera podria consultar. Aqui no hay claves, ni las habra: la custodia
 * vive en apps/signer.
 *
 * Cada venue se informa por separado con su motivo. La distincion que importa
 * es entre "esta wallet no opera aqui" y "aqui no podemos mirar": la primera es
 * un dato, la segunda es un hueco, y confundirlas llevaria a creer que se ve
 * todo el portafolio cuando no es asi.
 */
async function posiciones(res: ServerResponse, deps: ApiDeps, url: URL): Promise<void> {
  const address = stringParam(url, 'address', 128);
  const kind = addressKind(address);
  if (kind === 'unknown') {
    throw badRequest('address does not look like an EVM, Solana or dYdX (dydx1…) address');
  }

  const resultados = await Promise.all(
    [...deps.adapters.values()].map(async (adapter) => {
      const id = adapter.meta.id;

      if (adapter.fetchPositions === undefined) {
        return {
          venue: id,
          status: 'unsupported' as const,
          reason: adapter.noPositionsReason ?? 'requires authentication',
          account: null,
        };
      }
      // Consultar una direccion de Solana contra un venue EVM devolveria un
      // vacio que se leeria como "no opera aqui". Se omite con motivo.
      if (adapter.addressKinds !== undefined && !adapter.addressKinds.includes(kind)) {
        return {
          venue: id,
          status: 'wrong-chain' as const,
          reason: `expects ${adapter.addressKinds.join(' or ')} addresses`,
          account: null,
        };
      }

      try {
        const account = await adapter.fetchPositions(address);
        return { venue: id, status: 'ok' as const, reason: null, account };
      } catch (err) {
        return {
          venue: id,
          status: 'error' as const,
          reason: err instanceof Error ? err.message : String(err),
          account: null,
        };
      }
    }),
  );

  const todas = resultados.flatMap((r) => r.account?.positions ?? []);
  const equity = resultados.reduce<number | null>(
    (a, r) => (r.account?.equityUsd == null ? a : (a ?? 0) + r.account.equityUsd),
    null,
  );

  // Exposicion NETA por simbolo: es el numero que dice si una posicion
  // supuestamente delta-neutral lo es de verdad. Dos patas iguales en venues
  // distintos suman cero aqui; si no suman cero, hay direccion abierta.
  const neto = new Map<string, { longUsd: number; shortUsd: number }>();
  for (const p of todas) {
    const e = neto.get(p.symbol) ?? { longUsd: 0, shortUsd: 0 };
    if (p.side === 'long') e.longUsd += p.notionalUsd;
    else e.shortUsd += p.notionalUsd;
    neto.set(p.symbol, e);
  }

  sendJson(res, 200, {
    address,
    addressKind: kind,
    equityUsd: equity,
    venues: resultados.map((r) => ({
      venue: r.venue,
      status: r.status,
      reason: r.reason,
      equityUsd: r.account?.equityUsd ?? null,
      positionCount: r.account?.positions.length ?? 0,
    })),
    positions: todas.sort((a, b) => b.notionalUsd - a.notionalUsd),
    exposure: [...neto.entries()]
      .map(([symbol, e]) => ({
        symbol,
        longUsd: e.longUsd,
        shortUsd: e.shortUsd,
        netUsd: e.longUsd - e.shortUsd,
        grossUsd: e.longUsd + e.shortUsd,
      }))
      .sort((a, b) => b.grossUsd - a.grossUsd),
  });
}

/**
 * Salud de la fuente manual de puntos.
 *
 * No se mide con una peticion, porque no hay ninguna: su frescura es la fecha
 * en que alguien comprobo cada entrada a mano. Pasado el plazo se pone amarilla
 * sola, que es lo que impide que un dato verificado hace meses siga
 * presentandose como vivo. Ver ARCHITECTURE.md, "Fuentes manuales".
 */
/**
 * Reporte de un widget del navegador.
 *
 * Es el unico endpoint que acepta un estado de salud desde fuera, y por eso
 * solo admite ids que ya existen en el catalogo: no se pueden inventar fuentes
 * desde el cliente, solo decir si una conocida se pinto o no.
 */
async function reportarWidget(
  req: IncomingMessage,
  res: ServerResponse,
  widgets: WidgetHealth,
): Promise<void> {
  const body = await readJsonBody(req);
  if (typeof body !== 'object' || body === null) throw badRequest('invalid body');
  const d = body as Record<string, unknown>;
  const id = String(d['id'] ?? '');
  if (!widgets.admite(id)) throw badRequest('unknown widget source');

  const loadMs = Number(d['loadMs']);
  widgets.report(id, {
    ok: d['ok'] === true,
    reason: typeof d['reason'] === 'string' && d['reason'] !== '' ? d['reason'] : null,
    loadMs: Number.isFinite(loadMs) && loadMs >= 0 ? loadMs : null,
  });
  sendJson(res, 202, { recorded: id });
}

function saludDePuntos(): SourceHealth {
  const { stale, oldestDays } = pointsFreshness();
  const caducada = stale.length > 0;

  return {
    venue: 'points-manual',
    status: caducada ? 'degraded' : 'ok',
    reason: caducada
      ? `${stale.length} entries unverified for over ${POINTS_STALE_AFTER_DAYS} days`
      : null,
    // La "ultima vez correcta" es la comprobacion manual mas reciente.
    lastOkAt: oldestDays === null ? null : Date.now() - oldestDays * 86_400_000,
    lastErrorAt: null,
    lastError: null,
    consecutiveFailures: 0,
    symbolCount: POINTS_PROGRAMS.length,
    baselineSymbolCount: null,
    coverageRatio: null,
    // No hay peticion, asi que no hay latencia que medir: null, nunca 0.
    latencyP50Ms: null,
    latencyP95Ms: null,
    errorRatePct: 0,
    cyclesTotal: 0,
    declaredRequestsPerMinute: 0,
  };
}

/**
 * Puntos y competiciones.
 *
 * Catalogo de enlaces oficiales, no de datos copiados. Se devuelve tambien la
 * frescura, porque una entrada verificada hace tres meses no es un dato vivo
 * aunque siga escrita.
 */
/**
 * Escaner de paridad entre venues: ver `parityScan.ts`. El volumen minimo por
 * pata y la antiguedad maxima del precio se pueden pedir; por defecto 250 K$ y
 * cinco minutos, que es lo que separa un desajuste de un mercado muerto.
 */
function paridadEscaner(res: ServerResponse, deps: ApiDeps, url: URL): void {
  const tipoVenue = enumParam(url, 'venueKind', ['dex', 'cex', 'all'] as const, 'all');
  // `fees=aster:3.5,extended:2.5`: la comision taker de quien mira, en bps.
  const mias = new Map<string, number>();
  for (const par of (url.searchParams.get('fees') ?? '').split(',')) {
    const [v, bps] = par.split(':');
    const n = Number(bps);
    if (v !== undefined && v.trim() !== '' && bps !== undefined && Number.isFinite(n) && n >= 0 && n <= 100) {
      mias.set(v.trim().toLowerCase(), n);
    }
  }
  const filas = escanearParidad(deps.collector.snapshots(), deps.metas, clasesVivas(deps), {
    ahora: Date.now(),
    minVolumeUsd: numberParam(url, 'minVolume', { def: 250_000, min: 0, max: 1e10 }),
    maxAgeMs: 5 * 60_000,
    clase: claseParam(url),
    q: (url.searchParams.get('q') ?? '').trim().toUpperCase(),
    tipoVenue: tipoVenue === 'all' ? null : tipoVenue,
    misComisionesBps: mias,
    orden: enumParam(url, 'sort', ['gap', 'net'] as const, 'gap'),
  });
  sendJson(res, 200, {
    estimated: true,
    total: filas.length,
    rows: filas.slice(0, numberParam(url, 'limit', { def: 60, min: 1, max: 500 })),
  });
}

/**
 * Historia de la diferencia entre dos venues para un simbolo, con su mediana:
 * es lo que dice si un desajuste es raro o es como cotiza ese par siempre.
 */
function paridadPar(res: ServerResponse, deps: ApiDeps, url: URL): void {
  const symbol = (url.searchParams.get('symbol') ?? '').trim().toUpperCase();
  const cheap = (url.searchParams.get('cheap') ?? '').trim();
  const rich = (url.searchParams.get('rich') ?? '').trim();
  if (symbol === '' || cheap === '' || rich === '') throw badRequest('symbol, cheap and rich are required');
  const days = numberParam(url, 'days', { def: 7, min: 1, max: 14 });
  const to = Date.now();
  const puntos = readSeries(deps.db, { symbol, from: to - days * 86_400_000, to, venues: [cheap, rich] });
  const coste = url.searchParams.has('cost') ? numberParam(url, 'cost', { def: 0, min: 0, max: 100 }) : null;
  sendJson(res, 200, { symbol, cheap, rich, days, ...historiaParidad(puntos, cheap, rich, coste) });
}

/**
 * Lo ejecutable A TAMANO: recorre el libro de las dos patas para un nocional.
 * Comprar en el barato cruza sus asks; vender en el caro, sus bids. La
 * diferencia que queda despues es la que se captura de verdad con ese tamano,
 * no la del mid. Solo para venues con libro; el resto se dice.
 */
async function paridadProfundidad(res: ServerResponse, deps: ApiDeps, url: URL, books: BookCache): Promise<void> {
  const symbol = stringParam(url, 'symbol', 32).toUpperCase();
  const notional = numberParam(url, 'notional', { def: 10_000, min: 100, max: 5_000_000 });
  const pata = async (venue: string, lado: 'buy' | 'sell') => {
    const adapter = deps.adapters.get(venue);
    if (adapter?.fetchBook === undefined) return { venue, available: false, reason: 'no order book' };
    if (!deps.collector.snapshots().get(venue)?.has(symbol)) return { venue, available: false, reason: 'not listed' };
    const { book } = await books.get(venue, symbol, () => adapter.fetchBook!(symbol));
    const mejorBid = book?.bids[0]?.price;
    const mejorAsk = book?.asks[0]?.price;
    if (book === null || mejorBid === undefined || mejorAsk === undefined) return { venue, available: false, reason: 'empty book' };
    const mid = (mejorBid + mejorAsk) / 2;
    const c = lado === 'buy' ? buyCost(book, mid, notional) : sellCost(book, mid, notional);
    if (c.insufficientDepth) return { venue, available: false, reason: `book too thin for ${notional} USD` };
    const precio = lado === 'buy' ? mid * (1 + c.slippageBps / 10_000) : mid * (1 - c.slippageBps / 10_000);
    return { venue, available: true, mid, avgPrice: precio, slippageBps: c.slippageBps, spreadBps: ((mejorAsk - mejorBid) / mid) * 10_000 };
  };
  const [cheap, rich] = await Promise.all([
    pata((url.searchParams.get('cheap') ?? '').trim(), 'buy'),
    pata((url.searchParams.get('rich') ?? '').trim(), 'sell'),
  ]);
  const ejecutable = cheap.available && rich.available && 'avgPrice' in cheap && 'avgPrice' in rich
    ? ((rich.avgPrice - cheap.avgPrice) / cheap.avgPrice) * 100
    : null;
  sendJson(res, 200, { symbol, notional, cheap, rich, executableGapPct: ejecutable });
}

/**
 * Eventos de la semana. Se mandan todos (unos 125) y la pantalla filtra por
 * impacto y divisa: son pocos y asi cambiar un filtro no espera a la red.
 */
function calendario(res: ServerResponse, deps: ApiDeps): void {
  const fuente = deps.calendar;
  const eventos = fuente?.data ?? null;
  sendJson(res, 200, {
    available: eventos !== null,
    ...frescura(fuente),
    reason: eventos === null ? (fuente?.health().reason ?? 'the calendar source has not been started') : null,
    events: eventos ?? [],
  });
}

function puntos(res: ServerResponse, deps: ApiDeps): void {
  const freshness = pointsFreshness();
  const ahora = Date.now();
  // Lo terminado hace mas de 30 dias ya no ayuda a decidir nada.
  const campanas = (deps.campaigns?.data ?? [])
    .map((c) => ({ ...c, status: estadoCampana(c, ahora) }))
    .filter((c) => c.status !== 'ended' || (c.endsAt !== null && ahora - c.endsAt < 30 * 86_400_000))
    .sort((a, b) => ['live', 'upcoming', 'ended'].indexOf(a.status) - ['live', 'upcoming', 'ended'].indexOf(b.status)
      || (a.endsAt ?? Infinity) - (b.endsAt ?? Infinity));
  sendJson(res, 200, {
    campaigns: { available: deps.campaigns?.data != null, ...frescura(deps.campaigns), rows: campanas },
    programs: POINTS_PROGRAMS.map((p) => ({ ...p, daysSinceCheck: daysSince(p.verifiedAt) })),
    staleAfterDays: POINTS_STALE_AFTER_DAYS,
    stale: freshness.stale.map((p) => p.venueId),
    oldestCheckDays: freshness.oldestDays,
    /**
     * Ninguno de los venues que seguimos publica sus puntos sin autenticacion.
     * Comprobado endpoint a endpoint; los codigos estan en `apiNote`.
     */
    livePrograms: POINTS_PROGRAMS.filter((p) => p.apiStatus === 'public').length,
  });
}

/**
 * Bridges entre dos redes.
 *
 * Sin origen y destino se devuelve solo el catalogo de cadenas: la pantalla
 * necesita poblar los dos selectores antes de que haya nada que consultar.
 */
/**
 * De cuando es la copia de una fuente de DefiLlama y si hay que avisar.
 *
 * Las dos fuentes se piden cada hora (DefiLlama renueva /pools cada ~58 min y
 * /protocols cada ~30, medido por sus cabeceras). Si dejan de responder, la
 * API sigue sirviendo la ultima copia buena, y eso es correcto, pero la
 * pantalla tiene que decirlo: una tabla de APYs de hace seis horas sin aviso
 * se lee como actual. `stale` sale de la salud de la propia fuente, que ya
 * sabe cuando se ha pasado de su cadencia.
 */
function frescura(fuente: { health(): SourceHealth } | undefined): { asOf: number | null; stale: boolean } {
  const h = fuente?.health();
  return { asOf: h?.lastOkAt ?? null, stale: h === undefined ? false : h.status !== 'ok' };
}

function bridges(res: ServerResponse, deps: ApiDeps, url: URL): void {
  const fuente = deps.bridges;
  const todos = fuente?.data ?? null;
  const proveedores = (deps.bridgeRoutes ?? []).flatMap((f) => f.data ?? []);

  // Sin DefiLlama ni rutas no hay nada que ensenar. Con una sola de las dos,
  // si: LI.FI y deBridge dicen que rutas existen aunque falte la liquidez.
  if (todos === null && proveedores.length === 0) {
    sendJson(res, 200, {
      available: false,
      reason: fuente?.health().reason ?? 'the bridges source has not been started',
      chains: [],
      routes: [],
      alwaysConsider: AUSENTES_POR_DISENO,
      aggregators: agregadoresBridge(deps),
    });
    return;
  }

  const from = (url.searchParams.get('from') ?? '').trim();
  const to = (url.searchParams.get('to') ?? '').trim();
  const porSlug = new Map((todos ?? []).map((b) => [b.id, b]));

  type Fila = {
    id: string; name: string; type: string; tvlUsd: number | null; url: string | null;
    description: string | null; networks: number; via: string[];
  };
  const filas = new Map<string, Fila>();

  if (from !== '' && to !== '') {
    // 1. Puentes con liquidez en las dos redes, segun DefiLlama.
    for (const b of routesBetween(todos ?? [], from, to)) {
      filas.set(b.id, {
        id: b.id, name: b.name, type: b.type, tvlUsd: b.tvlUsd, url: b.url,
        description: b.description, networks: b.chains.length, via: ['liquidity'],
      });
    }
    // 2. Puentes cuya ruta confirma LI.FI o deBridge. Si DefiLlama lo conoce,
    //    se une a su fila y se trae su TVL; si no, fila propia sin TVL.
    for (const p of proveedores) {
      if (!conecta(p, from, to)) continue;
      const clave = p.llamaSlug ?? p.id;
      const hecha = filas.get(clave);
      if (hecha !== undefined) {
        if (!hecha.via.includes(p.via)) hecha.via.push(p.via);
        continue;
      }
      const llama = p.llamaSlug === null ? undefined : porSlug.get(p.llamaSlug);
      filas.set(clave, {
        id: clave,
        name: llama?.name ?? p.name,
        type: llama?.type ?? 'bridge',
        tvlUsd: llama?.tvlUsd ?? null,
        url: llama?.url ?? null,
        description: llama?.description ?? null,
        networks: Math.max(llama?.chains.length ?? 0, p.chains.length),
        via: [p.via],
      });
    }
  }

  // Primero las rutas confirmadas por quien las enruta; dentro, por liquidez.
  // Una fila solo con "hay liquidez en las dos" es una pista, no una ruta.
  const confirmada = (f: Fila) => f.via.some((v) => v !== 'liquidity');
  const rutas = [...filas.values()].sort((a, b) =>
    Number(confirmada(b)) - Number(confirmada(a))
    || (b.tvlUsd ?? -1) - (a.tvlUsd ?? -1)
    || a.name.localeCompare(b.name));

  const cadenas = new Set(bridgeChains(todos ?? []));
  for (const p of proveedores) for (const c of p.chains) cadenas.add(c);
  const nombres = new Set(rutas.map((r) => r.name.toLowerCase()));

  sendJson(res, 200, {
    available: true,
    ...frescura(fuente),
    total: todos?.length ?? 0,
    chains: [...cadenas].sort(),
    from,
    to,
    routes: rutas.slice(0, numberParam(url, 'limit', { def: 40, min: 1, max: 100 })),
    // Solo los que no han salido ya por otra via: Across y CCTP los trae LI.FI.
    alwaysConsider: AUSENTES_POR_DISENO.filter((x) => !nombres.has(x.name.toLowerCase())),
    aggregators: agregadoresBridge(deps),
  });
}

/**
 * Agregadores de puentes por volumen, de DefiLlama. No se suman entre si:
 * Jumper esta construido sobre LI.FI y DefiLlama los cuenta por separado, asi
 * que un total contaria dos veces lo mismo.
 */
function agregadoresBridge(deps: ApiDeps) {
  const fuente = deps.bridgeAggregators;
  const lista = fuente?.data ?? null;
  if (lista === null) return { available: false, ...frescura(fuente), rows: [] };
  const rows = [...lista]
    .filter((a) => (a.volume30dUsd ?? 0) > 0)
    .sort((a, b) => (b.volume30dUsd ?? 0) - (a.volume30dUsd ?? 0))
    .slice(0, 15)
    .map((a) => ({
      ...a,
      // Cambio de la ultima semana frente a la anterior. null si falta una.
      change7dPct: a.volume7dUsd !== null && a.previous7dUsd !== null && a.previous7dUsd > 0
        ? ((a.volume7dUsd - a.previous7dUsd) / a.previous7dUsd) * 100
        : null,
    }));
  return { available: true, ...frescura(fuente), rows };
}

/**
 * Pools y yields, desde DefiLlama.
 *
 * Las ~17.000 pools se filtran y ordenan aqui: mandarlas todas al navegador
 * serian varios megabytes por consulta, y en una Pi sirviendo por Tailscale eso
 * se nota.
 */
/**
 * Medias de 7 y 15 dias, recalculadas solo cuando DefiLlama trae datos nuevos
 * (una vez por hora). Es una consulta sobre miles de filas y cada pantalla la
 * pediria en cada cambio de filtro.
 */
const mediasPorLectura = new WeakMap<readonly Pool[], MediasPools>();
function mediasDePools(deps: ApiDeps, todas: readonly Pool[]): MediasPools {
  const hecha = mediasPorLectura.get(todas);
  if (hecha !== undefined) return hecha;
  const nueva = readPoolMeans(deps.db, Date.now());
  mediasPorLectura.set(todas, nueva);
  return nueva;
}

function pools(res: ServerResponse, deps: ApiDeps, url: URL): void {
  const fuente = deps.pools;
  const todas = fuente?.data ?? null;

  if (todas === null) {
    // Sin datos NO se devuelve una lista vacia, que se leeria como "no hay
    // pools": se dice que la fuente aun no ha respondido y por que.
    sendJson(res, 200, {
      available: false,
      reason: fuente?.health().reason ?? 'the DefiLlama source has not been started',
      total: 0,
      shown: 0,
      pools: [],
      chains: [],
      projects: [],
    });
    return;
  }

  const medias = mediasDePools(deps, todas);
  const q = (url.searchParams.get('q') ?? '').trim().toUpperCase();
  const chain = (url.searchParams.get('chain') ?? '').trim();
  const project = (url.searchParams.get('project') ?? '').trim();
  const minTvl = numberParam(url, 'minTvl', { def: 0, min: 0, max: 1e12 });
  const limite = numberParam(url, 'limit', { def: 60, min: 1, max: 300 });
  // El orden se pide por columna y con sentido, porque ordenar en el cliente
  // solo reordenaria las 80 filas que se mandan: pedir "el TVL mas bajo" daria
  // el mas bajo DE LAS 80 con mas APY, que no es lo que nadie quiere saber.
  const orden = enumParam(
    url,
    'sort',
    ['apy', 'tvl', 'rewards', 'mean7d', 'mean15d', 'mean30d', 'pool', 'project', 'chain', 'none'] as const,
    'apy',
  );
  const sentido = enumParam(url, 'dir', ['desc', 'asc'] as const, 'desc');
  const soloEstables = url.searchParams.get('stable') === '1';
  // Por defecto se OCULTAN los APY no representativos. Ensenarlos primero seria
  // poner un 439.000 % arriba del todo, que es justo la trampa que hay que
  // evitar; quien quiera verlos los pide explicitamente.
  const incluirVolatiles = url.searchParams.get('volatile') === '1';

  const filtradas = todas.filter((p) => {
    if (minTvl > 0 && p.tvlUsd < minTvl) return false;
    if (chain !== '' && p.chain !== chain) return false;
    if (project !== '' && p.project !== project) return false;
    if (soloEstables && !p.stablecoin) return false;
    if (!incluirVolatiles && p.volatileApy) return false;
    if (q !== '') {
      const heno = `${p.symbol} ${p.project} ${p.chain} ${p.poolMeta ?? ''}`.toUpperCase();
      // Cada palabra por separado: "eth usdc" encuentra la pool aunque el
      // simbolo sea "USDC-ETH".
      if (!q.split(/[\s/]+/).filter((t) => t !== '').every((t) => heno.includes(t))) return false;
    }
    return true;
  });

  const clave = (x: Pool): number | string | null => {
    if (orden === 'tvl') return x.tvlUsd;
    if (orden === 'rewards') return x.apyReward;
    if (orden === 'mean7d') return medias.porPool.get(x.id)?.d7.mean ?? null;
    if (orden === 'mean15d') return medias.porPool.get(x.id)?.d15.mean ?? null;
    if (orden === 'mean30d') return x.apyMean30d;
    if (orden === 'pool') return x.symbol;
    if (orden === 'project') return x.project;
    if (orden === 'chain') return x.chain;
    return x.apy;
  };

  const ordenadas = orden === 'none'
    // Sin orden se respeta el de la fuente. No se inventa uno.
    ? [...filtradas]
    : [...filtradas].sort((a, b) => {
      const ka = clave(a);
      const kb = clave(b);
      // Lo que no se sabe va al final SIEMPRE, se pida ascendente o
      // descendente: un hueco no es ni el mayor ni el menor.
      if (ka === null) return kb === null ? 0 : 1;
      if (kb === null) return -1;
      const c = typeof ka === 'string'
        ? ka.localeCompare(String(kb))
        : ka - (kb as number);
      return sentido === 'asc' ? c : -c;
    });

  const cadenas = [...new Set(todas.map((p) => p.chain))].sort();
  // Los venues con su TVL total, para ordenar el selector por peso y no por
  // abecedario: Aave y Lido arriba, no "0x-protocol".
  const tvlPorVenue = new Map<string, number>();
  for (const p of todas) tvlPorVenue.set(p.project, (tvlPorVenue.get(p.project) ?? 0) + p.tvlUsd);
  const venues = [...tvlPorVenue.entries()].sort((a, b) => b[1] - a[1]).map(([id, tvlUsd]) => ({ id, tvlUsd }));

  sendJson(res, 200, {
    available: true,
    ...frescura(fuente),
    total: filtradas.length,
    totalUnfiltered: todas.length,
    shown: Math.min(limite, ordenadas.length),
    hiddenVolatile: incluirVolatiles ? 0 : todas.filter((p) => p.volatileApy).length,
    chains: cadenas,
    projects: venues,
    // Cuanto historico propio respalda las medias de 7 y 15 dias, y cuantos
    // dias hacen falta para darlas. La de 30 es de DefiLlama y no depende.
    history: { daysRecorded: medias.diasRecogidos, minDays7d: MINIMO_DIAS[7], minDays15d: MINIMO_DIAS[15] },
    pools: ordenadas.slice(0, limite).map((p) => ({
      ...p,
      apyMean7d: medias.porPool.get(p.id)?.d7.mean ?? null,
      apyMean15d: medias.porPool.get(p.id)?.d15.mean ?? null,
    })),
  });
}

/**
 * Explorador de activos: donde cotiza cada uno, a que precio, con que volumen
 * y con que fees.
 *
 * Se incluye la dispersion de precio entre venues porque es el dato que decide
 * si merece la pena mirar Parity: si todos coinciden, no hay nada que arbitrar;
 * si uno se sale, o hay oportunidad o hay un problema de datos, y ambas cosas
 * interesan.
 */
function explorador(res: ServerResponse, deps: ApiDeps, url: URL): void {
  const q = (url.searchParams.get('q') ?? '').trim().toUpperCase();
  const limite = numberParam(url, 'limit', { def: 40, min: 1, max: 200 });
  const clase = claseParam(url);
  const tipoVenue = enumParam(url, 'venueKind', ['dex', 'cex', 'all'] as const, 'all');

  // La busqueda mira el simbolo comun, el nombre de cada venue y la familia:
  // "SPY" trae tambien el S&P 500, "GOLD" el oro, PAXG y XAUT. Ver familias.ts.
  const familias = familiasDeBusqueda(q);
  const deFamilia = new Set(familias.flatMap((f) => f.simbolos));
  const coincide = (s: MarketSnapshot) =>
    q === '' || s.symbol.includes(q) || s.symbolNative.toUpperCase().includes(q) || deFamilia.has(s.symbol);

  const snaps = deps.collector.snapshots();
  const clases = clasesVivas(deps);
  const vivos = new Set<string>();

  interface Listado {
    venue: string; instrument: 'perp' | 'swap'; symbolNative: string; contractMultiplier: number;
    mid: number; fundingHourly: number | null; volume24hUsd: number | null; openInterestUsd: number | null;
  }
  // Una fila por simbolo y clase, como en DEX Volume: CAT en QFEX es
  // Caterpillar y en Aster un memecoin, y mezclarlos daria una dispersion
  // de precio enorme que no es ninguna oportunidad.
  const porFila = new Map<string, { symbol: string; clase: ClaseActivo; listados: Listado[] }>();
  const anotar = (venue: string, s: MarketSnapshot) => {
    vivos.add(s.symbol);
    const meta = deps.metas.get(venue);
    if (tipoVenue !== 'all' && (meta?.kind === 'perp-cex' ? 'cex' : 'dex') !== tipoVenue) return;
    if (!coincide(s)) return;
    const c = clases.get(venue)?.get(s.symbol) ?? 'crypto';
    if (clase !== null && c !== clase) return;
    const clave = `${s.symbol}|${c}`;
    const fila = porFila.get(clave) ?? { symbol: s.symbol, clase: c, listados: [] };
    const swap = s.instrument === 'swap';
    fila.listados.push({
      venue,
      instrument: swap ? 'swap' : 'perp',
      symbolNative: s.symbolNative,
      contractMultiplier: s.contractMultiplier,
      mid: s.mid,
      // Un swap no tiene funding: null, no un 0 % que parezca medido.
      fundingHourly: swap ? null : toHourly(s.funding),
      volume24hUsd: s.volume24hUsd,
      openInterestUsd: s.openInterestUsd,
    });
    porFila.set(clave, fila);
  };

  let swapVenues = 0;
  for (const [venue, bySymbol] of snaps) {
    for (const s of bySymbol.values()) anotar(venue, s);
    // Los otros contratos del mismo activo (los swaps de Variational junto a
    // su perp). Llegan en el mismo refresco que el resto del venue, asi que
    // si el venue esta fresco, ellos tambien.
    const otros = deps.adapters.get(venue)?.otrosInstrumentos?.() ?? [];
    for (const s of otros) anotar(venue, s);
    if (otros.length > 0 || [...bySymbol.values()].some((s) => s.instrument === 'swap')) swapVenues += 1;
  }

  const mediana = (xs: number[]): number | null => {
    if (xs.length === 0) return null;
    const o = [...xs].sort((a, b) => a - b);
    const m = Math.floor(o.length / 2);
    return o.length % 2 === 1 ? o[m] ?? null : ((o[m - 1] ?? 0) + (o[m] ?? 0)) / 2;
  };

  const assets = [...porFila.values()]
    .map((f) => {
      // Precio y dispersion salen de los perps. Un swap sigue el spot y un
      // perp el futuro: en el Brent hay 0,6 % de base entre los dos, que es
      // real pero no es una diferencia que vaya a cerrarse.
      const perps = f.listados.filter((l) => l.instrument === 'perp');
      const base = perps.length > 0 ? perps : f.listados;
      const precios = base.map((l) => l.mid).filter((m) => Number.isFinite(m) && m > 0);
      const ref = mediana(precios);
      const min = precios.length > 0 ? Math.min(...precios) : null;
      const max = precios.length > 0 ? Math.max(...precios) : null;
      const volumen = f.listados.reduce<number | null>(
        (a, l) => (l.volume24hUsd === null ? a : (a ?? 0) + l.volume24hUsd),
        null,
      );
      const familia = familiaDe(f.symbol);
      return {
        symbol: f.symbol,
        assetClass: f.clase,
        // Lo que sigue y los otros simbolos de lo mismo que hoy cotizan.
        tracks: familia?.label ?? null,
        related: familia === null ? [] : familia.simbolos.filter((s) => s !== f.symbol && vivos.has(s)),
        perpVenues: f.listados.filter((l) => l.instrument === 'perp').length,
        swapVenues: f.listados.filter((l) => l.instrument === 'swap').length,
        // Sin fuentes de spot todavia: se declara en cero, no se omite.
        spotVenues: 0,
        // La mediana: un venue que se sale no mueve el precio de la fila.
        price: ref,
        volume24hUsd: volumen,
        // Dispersion entre el venue mas caro y el mas barato, en %.
        priceSpreadPct: min !== null && max !== null && min > 0 ? ((max - min) / min) * 100 : null,
        listings: f.listados
          .map((l) => {
            const meta = deps.metas.get(l.venue);
            return {
              ...l,
              label: meta?.label ?? l.venue,
              venueKind: meta?.kind === 'perp-cex' ? 'cex' : 'dex',
              url: enlaceOficial(l.venue),
              fundingAprPct: l.fundingHourly === null ? null : l.fundingHourly * 24 * 365 * 100,
              // Cuanto se aparta este venue de la mediana: lo que mira Parity.
              vsMedianPct: ref !== null && ref > 0 && Number.isFinite(l.mid) ? ((l.mid - ref) / ref) * 100 : null,
              makerBps: meta?.fees.makerBps ?? null,
              takerBps: meta?.fees.takerBps ?? null,
              fundingIntervalHours: l.instrument === 'swap' ? null : meta?.fundingIntervalHours ?? null,
              chain: meta?.chain ?? null,
            };
          })
          .sort((a, b) => (b.volume24hUsd ?? -1) - (a.volume24hUsd ?? -1)),
      };
    })
    // Exacto primero, luego lo de la familia buscada, luego por volumen:
    // buscar "BTC" no puede enterrar BTC debajo de BTCDOM, ni "SPY" dejar el
    // S&P 500 en la pagina tres.
    .sort((a, b) => {
      const peso = (x: { symbol: string }) => (x.symbol === q ? 0 : deFamilia.has(x.symbol) ? 1 : 2);
      return peso(a) - peso(b) || (b.volume24hUsd ?? -1) - (a.volume24hUsd ?? -1);
    });

  sendJson(res, 200, {
    query: q,
    total: assets.length,
    families: familias.map((f) => f.label),
    // La cobertura se declara: perps de los venues admitidos, swaps donde los
    // hay, y nada de spot todavia.
    coverage: { perpVenues: deps.collector.venues.length, swapVenues, spotVenues: 0 },
    assets: assets.slice(0, limite),
  });
}

/**
 * La clase de activo de cada mercado vivo, con QFEX como referencia y el
 * precio como prueba. Ver `claseActivo.ts` en `@defi/core`.
 */
function clasesVivas(deps: ApiDeps): Map<string, Map<string, ClaseActivo>> {
  const mercados: { venue: string; symbol: string; mid: number | null }[] = [];
  for (const [venue, porSimbolo] of deps.collector.snapshots()) {
    for (const m of porSimbolo.values()) {
      mercados.push({ venue, symbol: m.symbol, mid: Number.isFinite(m.mid) && m.mid > 0 ? m.mid : null });
    }
  }
  return clasificar(mercados);
}

/** `?class=` valido o null (todas). */
function claseParam(url: URL): ClaseActivo | null {
  const q = (url.searchParams.get('class') ?? '').trim().toLowerCase();
  return CLASES.find((c) => c === q) ?? null;
}

/** Igual que en Open Interest: mas de 1,5x de distancia es otro activo. */
const DESAJUSTE_TICKER_VOLUMEN = 1.5;

/**
 * Volumen por par, agregado y desglosado por venue, con su clase de activo.
 *
 * A 24 h es **dato medido**: el volumen que publica cada venue ahora mismo. A 7
 * y 30 dias es **estimacion**: la media diaria del volumen 24 h registrado,
 * sumada por los dias que tienen dato. La respuesta lo declara en `measured` y
 * dice cuantos dias la respaldan (`coverageDays`), porque una estimacion con
 * dos dias no vale lo mismo que una con treinta (DESIGN.md: lo estimado se
 * etiqueta como estimado).
 *
 * Tres decisiones que conviene poder defender:
 *
 * **Los periodos largos leen las dos tablas.** El crudo se borra a los catorce
 * dias; lo anterior vive en la tabla horaria. Leyendo solo el crudo, la cifra
 * de treinta dias salia de multiplicar catorce.
 *
 * **Una fila por simbolo y clase.** CAT en QFEX es Caterpillar y CAT en Aster es
 * un memecoin: el clasificador ya los separa por precio, asi que son dos filas
 * y no una suma de dos cosas distintas.
 *
 * **Dentro de una fila, el precio vuelve a mandar.** Si un venue cotiza el
 * ticker a mas de 1,5x del resto, se aparta y se dice cuanto volumen se
 * aparto. Si no hay mayoria, no se suma ninguno: no se puede saber cual es cual.
 */
/** `?venueKind=dex|cex`: si un venue entra con el filtro DEX / CEX de la web. */
function filtroDeTipo(deps: ApiDeps, url: URL): (venue: string) => boolean {
  const tipo = enumParam(url, 'venueKind', ['dex', 'cex', 'all'] as const, 'all');
  if (tipo === 'all') return () => true;
  return (venue) => (deps.metas.get(venue)?.kind === 'perp-cex' ? 'cex' : 'dex') === tipo;
}

function volumen(res: ServerResponse, deps: ApiDeps, url: URL): void {
  const days = numberParam(url, 'days', { def: 1, min: 1, max: 30 });
  const filtro = (url.searchParams.get('symbol') ?? '').trim().toUpperCase();
  const clase = claseParam(url);
  const deTipo = filtroDeTipo(deps, url);
  const measured = days === 1;
  const snaps = deps.collector.snapshots();
  const clases = clasesVivas(deps);
  const claseDe = (venue: string, symbol: string): ClaseActivo => clases.get(venue)?.get(symbol) ?? 'crypto';

  // `simbolo|clase` -> venue -> USD del periodo
  const porFila = new Map<string, { symbol: string; clase: ClaseActivo; venues: Map<string, number> }>();
  const anotar = (symbol: string, venue: string, usd: number) => {
    if (!deTipo(venue)) return;
    if (filtro !== '' && !symbol.includes(filtro)) return;
    const c = claseDe(venue, symbol);
    if (clase !== null && c !== clase) return;
    const clave = `${symbol}|${c}`;
    const fila = porFila.get(clave) ?? { symbol, clase: c, venues: new Map<string, number>() };
    fila.venues.set(venue, (fila.venues.get(venue) ?? 0) + usd);
    porFila.set(clave, fila);
  };

  let coverageDays: number | null = null;
  if (measured) {
    for (const [venue, bySymbol] of snaps) {
      for (const s of bySymbol.values()) {
        if (s.volume24hUsd === null) continue;
        anotar(s.symbol, venue, s.volume24hUsd);
      }
    }
  } else {
    // Dias UTC enteros: hoy y los `days - 1` anteriores. Con una ventana de
    // `days * 24 h` justas, el primer dia entra a medias y siete dias suman ocho.
    const to = Date.now();
    const desde = Math.floor(to / 86_400_000) * 86_400_000 - (days - 1) * 86_400_000;
    const dias = new Set<number>();
    for (const d of readVolumenDiario(deps.db, desde, to)) {
      anotar(d.symbol, d.venue, d.volumeUsd);
      dias.add(d.dia);
    }
    coverageDays = dias.size;
  }

  let apartadoUsd = 0;
  const pairs = [...porFila.values()].map(({ symbol, clase: c, venues }) => {
    const conPrecio: { venue: string; precio: number }[] = [];
    for (const v of venues.keys()) {
      const p = snaps.get(v)?.get(symbol)?.mid;
      if (p !== undefined && Number.isFinite(p) && p > 0) conPrecio.push({ venue: v, precio: p });
    }
    const fuera = new Set<string>();
    if (conPrecio.length >= 2) {
      const ref = precioDeReferencia(conPrecio.map((x) => x.precio), DESAJUSTE_TICKER_VOLUMEN);
      for (const x of conPrecio) {
        const factor = ref === null ? Number.NaN : x.precio / ref.precio;
        if (ref === null || factor > DESAJUSTE_TICKER_VOLUMEN || factor < 1 / DESAJUSTE_TICKER_VOLUMEN) fuera.add(x.venue);
      }
    }
    const dentro = [...venues.entries()].filter(([v]) => !fuera.has(v));
    const total = dentro.reduce((a, [, usd]) => a + usd, 0);
    const apartado = [...venues.entries()].filter(([v]) => fuera.has(v));
    apartadoUsd += apartado.reduce((a, [, usd]) => a + usd, 0);
    return {
      symbol,
      assetClass: c,
      totalUsd: total,
      venueCount: dentro.length,
      keptOut: apartado.map(([venue, usd]) => ({ venue, volumeUsd: usd })),
      venues: dentro
        .map(([venue, usd]) => ({
          venue,
          volumeUsd: usd,
          share: total > 0 ? usd / total : 0,
          openInterestUsd: snaps.get(venue)?.get(symbol)?.openInterestUsd ?? null,
        }))
        .sort((a, b) => b.volumeUsd - a.volumeUsd),
    };
  }).filter((p) => p.venueCount > 0).sort((a, b) => b.totalUsd - a.totalUsd);

  // Cuantos mercados hay de cada clase, para que los botones lo digan.
  const marketsByClass: Record<string, number> = {};
  for (const porSimbolo of clases.values()) {
    for (const c of porSimbolo.values()) marketsByClass[c] = (marketsByClass[c] ?? 0) + 1;
  }

  sendJson(res, 200, {
    period: { days, measured, coverageDays },
    assetClass: clase,
    marketsByClass,
    totalUsd: pairs.reduce((a, p) => a + p.totalUsd, 0),
    keptOutUsd: apartadoUsd,
    pairCount: pairs.length,
    pairs: pairs.slice(0, numberParam(url, 'limit', { def: 100, min: 1, max: 1000 })),
  });
}

/**
 * Volumen semana a semana, sumando todos los venues.
 *
 * Una fila por semana (lunes a domingo, UTC) con el total, los dias con dato y
 * el cambio frente a la anterior. **El cambio solo se da entre dos semanas
 * completas**: con dias sin recogida, una semana parece caer porque la app
 * estuvo apagada, no porque el mercado se moviese. Sin esa regla, la tabla
 * mentiria justo en lo que se viene a mirar.
 *
 * La clase se toma de los mercados vivos: un mercado que ya no existe cuenta
 * como cripto, que es lo que son casi todos los que se deslistan.
 */
function volumenSemanal(res: ServerResponse, deps: ApiDeps, url: URL): void {
  const weeks = numberParam(url, 'weeks', { def: 12, min: 2, max: 52 });
  const clase = claseParam(url);
  const clases = clasesVivas(deps);
  const deTipo = filtroDeTipo(deps, url);

  const DIA = 86_400_000;
  const SEMANA = 7 * DIA;
  const ahora = Date.now();
  // El 1 de enero de 1970 fue jueves: el lunes 5 de enero cae cuatro dias despues.
  const LUNES_0 = 4 * DIA;
  const lunesActual = LUNES_0 + Math.floor((ahora - LUNES_0) / SEMANA) * SEMANA;
  const desde = lunesActual - (weeks - 1) * SEMANA;

  const porSemana = new Map<number, { totalUsd: number; dias: Set<number>; venues: Set<string> }>();
  for (const d of readVolumenDiario(deps.db, desde, ahora)) {
    if (!deTipo(d.venue)) continue;
    if (clase !== null && (clases.get(d.venue)?.get(d.symbol) ?? 'crypto') !== clase) continue;
    const semana = desde + Math.floor((d.dia - desde) / SEMANA) * SEMANA;
    const f = porSemana.get(semana) ?? { totalUsd: 0, dias: new Set<number>(), venues: new Set<string>() };
    f.totalUsd += d.volumeUsd;
    f.dias.add(d.dia);
    f.venues.add(d.venue);
    porSemana.set(semana, f);
  }

  const filas: {
    weekStart: number; inProgress: boolean; totalUsd: number | null; avgDailyUsd: number | null;
    daysWithData: number; daysElapsed: number; venueCount: number; complete: boolean;
  }[] = [];
  for (let s = desde; s <= lunesActual; s += SEMANA) {
    const f = porSemana.get(s);
    const enCurso = s === lunesActual;
    filas.push({
      weekStart: s,
      inProgress: enCurso,
      totalUsd: f?.totalUsd ?? null,
      // La media por dia con dato si se compara entre semanas con huecos; el
      // total no, porque una semana con un dia recogido suma un dia.
      avgDailyUsd: f === undefined ? null : f.totalUsd / f.dias.size,
      daysWithData: f?.dias.size ?? 0,
      daysElapsed: enCurso ? Math.floor((ahora - s) / DIA) + 1 : 7,
      venueCount: f?.venues.size ?? 0,
      complete: f !== undefined && !enCurso && f.dias.size === 7,
    });
  }

  const conCambio = filas.map((w, i) => {
    const previa = i > 0 ? filas[i - 1] : undefined;
    let changePct: number | null = null;
    if (previa !== undefined && w.complete && previa.complete
      && w.totalUsd !== null && previa.totalUsd !== null && previa.totalUsd > 0) {
      changePct = ((w.totalUsd - previa.totalUsd) / previa.totalUsd) * 100;
    }
    return { ...w, changePct };
  });

  sendJson(res, 200, { assetClass: clase, estimated: true, weeks: conCambio.reverse() });
}

/**
 * Los mercados de UN venue, con lo que hace falta para elegir uno.
 *
 * Es la lista que se mira antes de operar: precio, cuanto se ha movido hoy,
 * cuanto se negocia, cuanto hay abierto y lo que paga el funding.
 *
 * **No pide nada a nadie.** El precio, el volumen, el interes abierto y el
 * funding ya estan en el snapshot que el collector refresca cada 120 s. Y el
 * cambio de 24 h sale de nuestro propio historico, que lleva guardando el mid
 * cada seis minutos desde septiembre. Pedirle a cada venue su `prevDayPx`
 * obligaria a anadir un campo al snapshot de TODOS los adaptadores para una
 * columna de una pantalla.
 *
 * Un simbolo que no existia hace 24 h sale con `change24hPct` a null, no a
 * cero: no es que no se haya movido, es que no habia con que comparar.
 */
function mercados(res: ServerResponse, deps: ApiDeps, url: URL): void {
  const venue = (url.searchParams.get('venue') ?? 'hyperliquid').trim().toLowerCase().slice(0, 32);
  const mercadosDelVenue = deps.collector.snapshots().get(venue);
  if (mercadosDelVenue === undefined) {
    throw badRequest(`unknown venue: ${venue}`);
  }
  const salud = deps.collector.health().find((h) => h.venue === venue) ?? null;
  const meta = deps.metas.get(venue) ?? null;

  const ahora = Date.now();
  const antes = readMidsAt(deps.db, { venue, at: ahora - 86_400_000 });

  const filas = [...mercadosDelVenue.values()].map((m) => {
    // Primero lo que publica el venue, que es lo que ensena su web y no tiene
    // huecos. Nuestro historico es el respaldo, y falta los dias en que la app
    // no estuvo corriendo. Si no hay ninguno de los dos, null: no es que no se
    // haya movido, es que no hay con que compararlo.
    const delVenue = m.prevDayPrice ?? null;
    const previo = antes.get(m.symbol);
    const referencia = delVenue !== null && delVenue > 0
      ? { mid: delVenue, ts: null as number | null }
      : previo === undefined ? null : { mid: previo.mid, ts: previo.ts as number | null };
    const cambio = referencia === null || !Number.isFinite(m.mid) || m.mid <= 0
      ? null
      : ((m.mid - referencia.mid) / referencia.mid) * 100;
    return {
      symbol: m.symbol,
      symbolNative: m.symbolNative,
      mid: Number.isFinite(m.mid) && m.mid > 0 ? m.mid : null,
      change24hPct: cambio,
      /**
       * De donde sale el precio de referencia: del venue o de nuestro
       * historico. La pantalla lo dice, porque uno es el cierre de ayer que
       * publica el venue y el otro es la foto mas cercana que tengamos.
       */
      change24hFrom: referencia === null ? null : delVenue !== null && delVenue > 0 ? 'venue' : 'history',
      /** Si viene del historico, de cuando es esa foto. */
      comparedToAt: referencia?.ts ?? null,
      volume24hUsd: m.volume24hUsd,
      openInterestUsd: m.openInterestUsd,
      fundingHourly: toHourly(m.funding),
      fundingIntervalHours: m.funding.intervalHours,
      nextFundingAt: m.funding.nextFundingAt,
    };
  });
  // De mas a menos volumen, que es el orden con el que se mira una lista asi.
  filas.sort((a, b) => (b.volume24hUsd ?? -1) - (a.volume24hUsd ?? -1));

  sendJson(res, 200, {
    venue,
    label: meta?.label ?? venue,
    at: ahora,
    status: salud?.status ?? 'unknown',
    reason: salud?.reason ?? null,
    /** El venue admite velas para el grafico. Hoy solo Hyperliquid. */
    candles: venue === 'hyperliquid',
    intervals: INTERVALOS,
    markets: filas,
  });
}

/**
 * Velas OHLC de un activo, para el grafico.
 *
 * Se piden al venue en el momento y no se guardan: ver `sources/candles.ts`.
 * Va por `symbolNative` porque es lo que entiende el venue; nuestro nombre
 * normalizado no le vale.
 */
async function velas(res: ServerResponse, deps: ApiDeps, url: URL, hl: CatalogoHyperliquid): Promise<void> {
  const venue = (url.searchParams.get('venue') ?? 'hyperliquid').trim().toLowerCase().slice(0, 32);
  if (venue !== 'hyperliquid') throw badRequest(`no candles for venue: ${venue}`);

  const interval = (url.searchParams.get('interval') ?? '1h').trim().slice(0, 8);
  if (!esIntervalo(interval)) throw badRequest(`unknown interval: ${interval}`);
  const limite = numberParam(url, 'limit', { def: 500, min: 20, max: 1000 });

  // Por `coin`, el mercado tal cual de Hyperliquid (Terminal): perps HIP-3 y
  // spot incluidos, a su precio y sin normalizar. Solo si existe en su
  // catalogo, para no mandarle peticiones con cualquier cosa.
  const coin = (url.searchParams.get('coin') ?? '').trim().slice(0, 48);
  if (coin !== '') {
    if (await hl.existe(coin) === null) throw badRequest(`hyperliquid does not list ${coin}`);
    const candles = await fetchHyperliquidCandles(coin, interval, limite);
    sendJson(res, 200, { venue, symbol: coin, symbolNative: coin, interval, fetchedAt: Date.now(), candles });
    return;
  }

  const symbol = stringParam(url, 'symbol', 32).toUpperCase();
  if (symbol === '') throw badRequest('symbol or coin is required');

  // El nombre nativo sale del snapshot, no se adivina: el normalizador quita
  // sufijos y resuelve colisiones, asi que el nuestro puede no ser el suyo.
  const market = deps.collector.snapshots().get(venue)?.get(symbol);
  if (market === undefined) throw badRequest(venue + ' does not list ' + symbol);
  const nativo = market.symbolNative;
  const raw = await fetchHyperliquidCandles(nativo, interval, limite);
  // Misma unidad que las posiciones: kPEPE representa mil PEPE por contrato.
  const multiplier = market.contractMultiplier ?? 1;
  const candles = raw.map(c => ({ ...c,
    open: c.open / multiplier, high: c.high / multiplier,
    low: c.low / multiplier, close: c.close / multiplier,
    volume: c.volume === null ? null : c.volume * multiplier,
  }));
  sendJson(res, 200, { venue, symbol, symbolNative: nativo, interval, fetchedAt: Date.now(), candles });
}

/**
 * Libro de ordenes de un activo, para el panel de profundidad.
 *
 * Pasa por la MISMA cache que usa el scanner, con su tiempo de vida. No es un
 * detalle de rendimiento: el libro se pide por simbolo y la IP se comparte con
 * otros bots, asi que sin cache cada repintado de la pantalla seria una
 * peticion nueva al venue. Y como la cache guarda tambien los fallos, un venue
 * que este dando error no se reintenta en bucle a cada clic.
 *
 * Viaja `at`, que es cuando se obtuvo de verdad, no cuando se sirve: con un
 * libro de cache la pantalla tiene que poder decir de cuando es.
 */
async function libro(
  res: ServerResponse,
  deps: ApiDeps,
  url: URL,
  books: BookCache,
): Promise<void> {
  const venue = (url.searchParams.get('venue') ?? 'hyperliquid').trim().toLowerCase().slice(0, 32);
  const symbol = stringParam(url, 'symbol', 32).toUpperCase();

  const adapter = deps.adapters.get(venue);
  if (adapter === undefined) throw badRequest(`unknown venue: ${venue}`);
  if (adapter.fetchBook === undefined) throw badRequest(`${venue} does not expose an order book`);
  if (!deps.collector.snapshots().get(venue)?.has(symbol)) {
    throw badRequest(`${venue} does not list ${symbol}`);
  }

  const niveles = numberParam(url, 'levels', { def: 12, min: 1, max: 50 });
  const { book, at } = await books.get(venue, symbol, () => adapter.fetchBook!(symbol));

  sendJson(res, 200, {
    venue,
    symbol,
    at,
    // null y lista vacia NO son lo mismo: uno es que no se pudo leer el libro y
    // el otro es que el libro esta vacio de verdad. La pantalla los distingue.
    available: book !== null,
    bids: book === null ? [] : book.bids.slice(0, niveles),
    asks: book === null ? [] : book.asks.slice(0, niveles),
  });
}

/** Todos los mercados de Hyperliquid, con sus nombres. Ver `hlCatalogo.ts`. */
async function mercadosHl(res: ServerResponse, hl: CatalogoHyperliquid): Promise<void> {
  const c = await hl.get();
  // La proxima liquidacion: Hyperliquid cobra funding cada hora en punto.
  const hora = 3_600_000;
  sendJson(res, 200, {
    at: c.at,
    nextFundingAt: Math.ceil(Date.now() / hora) * hora,
    // Dexes HIP-3 (o el spot) que no respondieron en esta vuelta.
    failed: c.fallidos,
    markets: c.mercados,
  });
}

/** Libro de cualquier mercado de Hyperliquid, por su `coin`, con la cache comun. */
async function libroHl(res: ServerResponse, url: URL, hl: CatalogoHyperliquid, books: BookCache): Promise<void> {
  const coin = (url.searchParams.get('coin') ?? '').trim().slice(0, 48);
  if (await hl.existe(coin) === null) throw badRequest(`hyperliquid does not list ${coin}`);
  const niveles = numberParam(url, 'levels', { def: 12, min: 1, max: 50 });
  const { book, at } = await books.get('hl', coin, () => fetchLibroHl(coin));
  sendJson(res, 200, {
    coin,
    at,
    available: book !== null,
    bids: book === null ? [] : book.bids.slice(0, niveles),
    asks: book === null ? [] : book.asks.slice(0, niveles),
  });
}

/** La cinta de operaciones de un mercado de Hyperliquid. */
async function tradesHl(res: ServerResponse, url: URL, hl: CatalogoHyperliquid): Promise<void> {
  const coin = (url.searchParams.get('coin') ?? '').trim().slice(0, 48);
  if (await hl.existe(coin) === null) throw badRequest(`hyperliquid does not list ${coin}`);
  const r = await hl.trades(coin);
  sendJson(res, 200, { coin, at: r.at, trades: r.trades.slice(0, 60) });
}

function series(res: ServerResponse, deps: ApiDeps, url: URL): void {
  const symbol = stringParam(url, 'symbol', 32).toUpperCase();
  const to = numberParam(url, 'to', { def: Date.now(), min: 0, max: 4_102_444_800_000 });
  const from = numberParam(url, 'from', { def: to - 7 * 86_400_000, min: 0, max: 4_102_444_800_000 });
  if (from >= to) throw badRequest('from must be earlier than to');

  const venuesPedidos = listParam(url, 'venues');
  const puntos = readSeries(deps.db, {
    symbol,
    from,
    to,
    ...(venuesPedidos.length > 0 ? { venues: venuesPedidos } : {}),
  });
  sendJson(res, 200, { symbol, from, to, points: puntos });
}

/**
 * Traders seguidos, con su ultima lectura.
 *
 * Cada fila lleva su estado y de cuando es el dato, para que la pantalla no
 * tenga que adivinar. Los cuatro casos son distintos: pausado no se consulta,
 * waiting aun no ha respondido nunca, stale tiene datos que ya no valen como
 * actuales y failing falla sin haber tenido ninguno.
 *
 * "Sin posiciones" NO es un estado: es ok con la lista vacia. Por eso las
 * posiciones viajan siempre, aunque sean cero, y un fallo nunca las vacia.
 */
function traders(res: ServerResponse, deps: ApiDeps): void {
  const seguidor = deps.traders;
  const ahora = Date.now();
  const staleAfterMs = seguidor?.staleAfterMs ?? 0;

  sendJson(res, 200, {
    // Sin seguidor la lista se sirve igual, pero se declara que nadie la
    // refresca en vez de ensenar una tabla que parece viva.
    tracking: seguidor !== undefined,
    intervalMs: seguidor?.intervalMs ?? null,
    staleAfterMs: seguidor === undefined ? null : staleAfterMs,
    traders: listTraders(deps.db).map((t) => {
      const e = seguidor?.state(t.id) ?? null;
      return {
        ...t,
        status: seguidor === undefined ? 'waiting' : traderStatus(t, e, staleAfterMs, ahora),
        updatedAt: e?.updatedAt ?? null,
        error: e?.error ?? null,
        errorAt: e?.errorAt ?? null,
        failures: e?.failures ?? 0,
        equityUsd: e?.account?.equityUsd ?? null,
        marginUsedUsd: e?.account?.marginUsedUsd ?? null,
        positions: e?.account?.positions ?? [],
      };
    }),
  });
}

async function crearTrader(req: IncomingMessage, res: ServerResponse, deps: ApiDeps): Promise<void> {
  const body = await readJsonBody(req);
  if (typeof body !== 'object' || body === null) throw badRequest('invalid body');
  const d = body as Record<string, unknown>;
  const texto = (k: string) => (typeof d[k] === 'string' ? (d[k] as string) : null);

  const address = texto('address');
  if (address === null || address.trim() === '') throw badRequest('the address is required');

  try {
    // El modulo valida el formato, rechaza una seed phrase pegada por error en
    // el campo y normaliza a minusculas para que la misma cuenta escrita de
    // dos maneras no entre dos veces.
    sendJson(res, 201, addTrader(deps.db, {
      address,
      alias: texto('alias'),
      color: texto('color'),
      group: texto('group'),
      notes: texto('notes'),
    }));
  } catch (err) {
    throw badRequest(err instanceof Error ? err.message : 'invalid trader');
  }
}

async function editarTrader(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiDeps,
  id: string,
): Promise<void> {
  const body = await readJsonBody(req);
  if (typeof body !== 'object' || body === null) throw badRequest('invalid body');
  const d = body as Record<string, unknown>;

  // Solo se toca lo que viene. Ausente significa "no lo cambies", que no es lo
  // mismo que null, que significa "borralo".
  const patch: TraderPatch = {
    ...(d['alias'] !== undefined ? { alias: d['alias'] === null ? null : String(d['alias']) } : {}),
    ...(d['color'] !== undefined ? { color: d['color'] === null ? null : String(d['color']) } : {}),
    ...(d['group'] !== undefined ? { group: d['group'] === null ? null : String(d['group']) } : {}),
    ...(d['notes'] !== undefined ? { notes: d['notes'] === null ? null : String(d['notes']) } : {}),
    ...(typeof d['active'] === 'boolean' ? { active: d['active'] } : {}),
    // Filtros por wallet. null los quita; una lista o un numero los pone. La
    // validacion de verdad la hace el modulo de almacenamiento.
    ...(d['symbols'] === null ? { symbols: null }
      : Array.isArray(d['symbols']) ? { symbols: d['symbols'].map(String) } : {}),
    ...(d['minAccountPct'] === null ? { minAccountPct: null }
      : typeof d['minAccountPct'] === 'number' ? { minAccountPct: d['minAccountPct'] } : {}),
  };

  try {
    const actualizado = updateTrader(deps.db, id, patch);
    if (actualizado === null) throw notFound('that trader is not on the list');
    sendJson(res, 200, actualizado);
  } catch (err) {
    if (err instanceof HttpProblem) throw err;
    throw badRequest(err instanceof Error ? err.message : 'invalid trader');
  }
}

/**
 * Ejecuciones guardadas de las wallets seguidas.
 *
 * Son fills REALES leidos del venue, no movimientos deducidos comparando
 * fotos de posicion. Sirven a las marcas del grafico y a la tabla de
 * movimientos, y por eso el filtro vive aqui y no en la pantalla: las dos
 * tienen que ver exactamente lo mismo.
 *
 * `respectFilters=1` aplica los filtros que cada wallet tiene guardados (sus
 * pares y su minimo de % de cuenta). Sin el se devuelve todo lo guardado, que
 * es lo que quiere quien esta ajustando esos filtros y necesita ver lo que
 * dejarian fuera.
 */
function ejecuciones(res: ServerResponse, deps: ApiDeps, url: URL): void {
  const symbol = (url.searchParams.get('symbol') ?? '').trim().toUpperCase().slice(0, 32);
  // El mercado exacto de Hyperliquid (`xyz:NVDA`, `@107`). Respeta mayusculas:
  // `kPEPE` no es `KPEPE`.
  const coin = (url.searchParams.get('coin') ?? '').trim().slice(0, 48);
  const pedidos = listParam(url, 'traders');
  const to = numberParam(url, 'to', { def: Date.now(), min: 0, max: 4_102_444_800_000 });
  const from = numberParam(url, 'from', { def: to - 7 * 86_400_000, min: 0, max: 4_102_444_800_000 });
  const limit = numberParam(url, 'limit', { def: 500, min: 1, max: 5000 });
  const respetar = url.searchParams.get('respectFilters') === '1';

  const todos = listTraders(deps.db);
  const elegidos = pedidos.length === 0 ? todos : todos.filter((t) => pedidos.includes(t.id));

  let fills = elegidos.length === 0 ? [] : readFills(deps.db, {
    traderIds: elegidos.map((t) => t.id),
    ...(symbol !== '' ? { symbol } : {}),
    ...(coin !== '' ? { coin } : {}),
    from,
    to,
    limit,
  });

  if (respetar) {
    const porId = new Map(elegidos.map((t) => [t.id, t]));
    fills = fills.filter((f) => {
      const t = porId.get(f.traderId);
      if (t === undefined) return false;
      if (t.symbols !== null && !t.symbols.includes(f.symbol)) return false;
      // Sin porcentaje conocido NO pasa un minimo: no se sabe cuanto movia, y
      // afirmar que supera el umbral seria inventarselo.
      if (t.minAccountPct !== null && (f.accountPct === null || f.accountPct < t.minAccountPct)) return false;
      return true;
    });
  }

  sendJson(res, 200, {
    from,
    to,
    symbol: symbol === '' ? null : symbol,
    respectFilters: respetar,
    traders: elegidos.map((t) => ({
      id: t.id, alias: t.alias, address: t.address, color: t.color,
      symbols: t.symbols, minAccountPct: t.minAccountPct,
    })),
    fills,
  });
}

/** Rangos de la grafica. Solo estos tres: los que ofrece la pantalla. */
const RANGOS: Record<string, number> = {
  '1d': 86_400_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
  // Con el historico diario de DefiLlama rellenado, los rangos largos ya tienen dato.
  '90d': 90 * 86_400_000,
  '1y': 365 * 86_400_000,
};

/**
 * Interes abierto por venue, con su historico.
 *
 * Filtrar por simbolo o por venue NO dispara ninguna descarga: se responde con
 * lo que ya hay en memoria y con el historico guardado.
 */
function interesAbierto(res: ServerResponse, deps: ApiDeps, url: URL): void {
  const fuente = deps.openInterest;
  if (fuente === undefined) {
    return sendJson(res, 200, { available: false, venues: [], current: [], series: [], symbols: [] });
  }
  const symbol = url.searchParams.get('symbol');
  const rango = url.searchParams.get('range') ?? '7d';
  sendJson(res, 200, {
    available: true,
    range: rango in RANGOS ? rango : '7d',
    ...(fuente.query({
      symbol: symbol === null || symbol === '' ? undefined : symbol,
      // OI incluye el catalogo ampliado de protocolos, no solo venues directos.
      venues: listParam(url, 'venues', 500),
      rangeMs: RANGOS[rango] ?? RANGOS['7d'],
    }) as object),
  });
}

/**
 * Avisos de cambio de posicion, y como esta el bot.
 *
 * Los avisos se sirven CONFIGURADO EL BOT O NO: se detectan y se guardan
 * igual, y `telegram.configured` dice si ademas salen del ordenador. Aqui no
 * viaja el token ni el identificador del chat.
 */
function alertas(res: ServerResponse, deps: ApiDeps, url: URL): void {
  const servicio = deps.alerts;
  if (servicio === undefined) {
    return sendJson(res, 200, { available: false, events: [] });
  }
  const limite = Number(url.searchParams.get('limit') ?? 100);
  const trader = url.searchParams.get('trader');
  sendJson(res, 200, {
    available: true,
    ...servicio.status(),
    events: servicio.recent(
      Number.isFinite(limite) ? limite : 100,
      trader === null || trader === '' ? undefined : trader,
    ),
  });
}

/**
 * Mensaje de prueba. Lo dispara el usuario desde la pantalla.
 *
 * Es la unica forma de comprobar que el token y el chat son los correctos sin
 * esperar a que un trader mueva una posicion.
 */
async function probarAvisos(res: ServerResponse, deps: ApiDeps): Promise<void> {
  const servicio = deps.alerts;
  if (servicio === undefined) throw notFound('alerts are not running');
  try {
    await servicio.test();
    sendJson(res, 200, { sent: true });
  } catch (err) {
    throw badRequest(err instanceof Error ? err.message : 'could not send');
  }
}

async function crearWallet(req: IncomingMessage, res: ServerResponse, deps: ApiDeps): Promise<void> {
  const body = await readJsonBody(req);
  if (typeof body !== 'object' || body === null) throw badRequest('invalid body');
  const datos = body as Record<string, unknown>;

  const address = typeof datos['address'] === 'string' ? datos['address'] : '';
  const chain = typeof datos['chain'] === 'string' ? datos['chain'] : '';
  if (address === '' || chain === '') throw badRequest('address and chain are required');

  try {
    // addWallet valida la direccion y rechaza una seed phrase pegada por error.
    const wallet = addWallet(deps.db, {
      address,
      chain,
      label: typeof datos['label'] === 'string' ? datos['label'] : null,
      notes: typeof datos['notes'] === 'string' ? datos['notes'] : null,
    });
    sendJson(res, 201, wallet);
  } catch (err) {
    throw new HttpProblem(400, err instanceof Error ? err.message : 'invalid wallet');
  }
}

function stream(req: IncomingMessage, res: ServerResponse, deps: ApiDeps): void {
  const flujo = openEventStream(res);
  flujo.send('hello', { venues: deps.collector.venues, at: Date.now() });

  const baja = deps.collector.onCycle(() => {
    flujo.send('cycle', {
      cycle: deps.collector.lastCycle,
      health: deps.collector.health(),
    });
  });

  // Latido: sin trafico, un proxy o el propio navegador cierran la conexion en
  // silencio y el usuario se queda con datos congelados creyendo que son vivos.
  const latido = setInterval(() => flujo.send('ping', { at: Date.now() }), 25_000);

  const cerrar = () => {
    clearInterval(latido);
    baja();
    flujo.close();
  };
  req.on('close', cerrar);
  req.on('error', cerrar);
}
