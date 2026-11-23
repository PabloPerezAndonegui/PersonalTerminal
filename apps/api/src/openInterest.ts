import type { DatabaseSync } from 'node:sqlite';
import type { MarketSnapshot } from '@defi/core';
import { precioDeReferencia, toHourly } from '@defi/core';
import { PollingSource, type SourceHealth } from '@defi/collector';
import {
  FUENTES_CEX, fetchLlamaOi, fetchLlamaRevenue, fetchLlamaTvl, claveProtocolo, COBERTURA_LLAMA, enlaceOficial,
  FICHA_DEX, COBERTURA_HIP3, fetchLlamaOiHistorico, fetchBybitOiHistorico, venueDeNombre,
  type LlamaInstrument, type LlamaOi, type LlamaRevenue, type OiConvention, type VenueOi,
} from '@defi/venues';
import { insertOiSnapshots, insertOiIfAbsent, oiAt, borrarRellenoOi, oiSeries, oiCoverage, pruneOi, OI_TOTAL } from '@defi/storage';

/**
 * Si el historico de fuera mide lo mismo que lo nuestro: su ultimo dato,
 * convertido, contra nuestra cifra de ahora, con un 25 % de margen. La de
 * Hyperliquid en DefiLlama incluye los HIP-3 y la nuestra no (11,1 B contra
 * 6,95 el 17 nov 2026): sin esta comprobacion la serie salta de una a otra.
 */
export function historicoCuadra(rellenado: number | undefined, medido: number | null | undefined): boolean {
  if (rellenado === undefined || medido == null || medido <= 0) return false;
  const r = rellenado / medido;
  return r >= 0.75 && r <= 1 / 0.75;
}

/** Cuanto vale una cifra de una pata, o de dos, expresada a dos patas. */
const aDosPatas = (c: OiConvention | undefined): number | null => (c === 'single' ? 2 : c === 'double' ? 1 : null);

/**
 * A partir de que factor dos precios ya no pueden ser el mismo activo.
 *
 * El mismo 1,5 que usa la matriz de funding, y por el mismo motivo: dos venues
 * no difieren un 50 % en el precio de lo mismo. Si difieren, o hay un
 * multiplicador mal aplicado o son activos distintos con el mismo nombre.
 */
const DESAJUSTE_TICKER = 1.5;

/**
 * Interes abierto: agregado, historico y consulta.
 *
 * **De donde sale cada numero.** Los DEX ya los lee el collector en cada
 * ciclo, asi que aqui no se pide nada: se leen sus snapshots en memoria. Los
 * CEX son una peticion por bolsa, cada una con todos sus mercados dentro.
 * Solo se integran bolsas que publican el interes abierto de TODOS sus
 * mercados de golpe: pedirlo simbolo a simbolo serian cientos de peticiones
 * por vuelta desde una IP que se comparte con otros bots.
 *
 * **Lo que NO se hace.** No se mezcla con el historico diario de DefiLlama.
 * Comprobado el 24 de septiembre de 2026: para Hyperliquid, DefiLlama publica
 * entre 8.100 y 9.000 millones mientras la API del propio venue da 12.230, y
 * la diferencia se mantiene dia tras dia, asi que no es un desfase de reloj.
 * **Por que difieren no se sabe todavia** y queda por investigar: podria ser
 * una seleccion distinta de mercados, otro precio de referencia o una
 * convencion de patas distinta. Mientras no se sepa, dibujarlos en la misma
 * linea meteria un salto del 47 % que nadie ha visto en el mercado.
 *
 * **Filtrar no descarga nada.** La pantalla filtra sobre lo que ya esta en
 * memoria y sobre el historico guardado; cambiar de simbolo o de venue no
 * dispara una vuelta a los exchanges.
 */

/**
 * Cruza nuestro nombre con el de DefiLlama.
 *
 * No coinciden: nosotros decimos "Hyperliquid" y alli es "Hyperliquid Perps",
 * "Phoenix" es "Phoenix Perp" y "dYdX" es "dYdX V4". Se prueba primero el
 * nombre exacto y despues el que EMPIECE por el nuestro, quedandose con el de
 * mas ingresos cuando hay varios, que es el producto principal y no una
 * version retirada como dYdX V3, que declara cero.
 *
 * Se exigen al menos cuatro letras para no cruzar por un prefijo corto: con
 * dos o tres, un nombre cualquiera arrastraria media lista.
 */
export function revenueDe(
  label: string,
  tablas: {
    porId?: ReadonlyMap<string, LlamaRevenue> | undefined;
    porProtocolo?: ReadonlyMap<string, LlamaRevenue> | undefined;
  } | undefined,
  defillamaId?: string | null,
): LlamaRevenue | null {
  if (tablas === undefined) return null;

  // Primero el identificador, que es exacto y no depende de como se llame.
  if (defillamaId != null) {
    const porId = tablas.porId?.get(defillamaId);
    if (porId !== undefined) return porId;
  }

  const porProtocolo = tablas.porProtocolo;
  if (porProtocolo === undefined) return null;
  const k = claveProtocolo(label);
  const exacto = porProtocolo.get(k);
  if (exacto !== undefined) return exacto;
  if (k.length < 4) return null;

  let mejor: LlamaRevenue | null = null;
  for (const [clave, v] of porProtocolo) {
    if (!clave.startsWith(k)) continue;
    if (mejor === null || (v.revenue30dUsd ?? 0) > (mejor.revenue30dUsd ?? 0)) mejor = v;
  }
  return mejor;
}

/**
 * Cada cuanto se cobra el funding, o null si el registro no lo dice.
 *
 * `fundingIntervalHours` del registro es la ventana a la que se refiere la
 * TASA, no siempre la cadencia de cobro: Variational publica la tasa ya
 * anualizada y declara 8.760 h, aunque cobra cada 4 u 8 h segun el mercado.
 * Compare la ensenaba como "funding every 8,760 h". Mas de un dia no es una
 * cadencia de cobro que exista en ningun venue, asi que se trata como
 * desconocida.
 */
export function cadenciaDeCobro(horas: number | undefined): number | null {
  if (horas === undefined || !Number.isFinite(horas) || horas <= 0 || horas > 24) return null;
  return horas;
}

export interface OiVenueEstado {
  readonly id: string;
  readonly label: string;
  readonly kind: 'cex' | 'dex';
  readonly convention: OiConvention;
  /**
   * Si la convencion se ha comprobado contra la API del propio venue.
   *
   * Separa dos cosas que no valen lo mismo. En los venues que leemos directos
   * la prueba esta medida y escrita en `FICHA_DEX`. En los noventa que solo
   * conocemos por DefiLlama, lo que hay es que la casa declara normalizar a una
   * pata y que eso cuadra en los siete donde podiamos contrastarlo. Sirve para
   * convertir a global, no para decir que esos noventa estan verificados.
   */
  readonly conventionProven: boolean;
  /**
   * Que instrumento es. Solo `perp` entra en el total de perps: una opcion y un
   * mercado de prediccion tambien tienen interes abierto y no es lo mismo.
   */
  readonly instrument: LlamaInstrument;
  /** Que parte del venue entra en esta cifra. Ninguna fuente lo cubre entero. */
  readonly coverage: string;
  /** false = solo hay total, sin reparto por activo. Filtrar por uno lo deja fuera. */
  readonly breakdown: boolean;
  /** Volumen de 24 h, si la fuente lo trae en la MISMA respuesta. */
  readonly volume24hUsd: number | null;
  /** Interes abierto ahora mismo, en dolares. null si la fuente esta caida. */
  readonly oiUsd: number | null;
  readonly markets: number;
  readonly asOf: number | null;
  /** El dato ya no vale como actual. */
  readonly stale: boolean;
  readonly error: string | null;
}

/** Cada cuanto se pide el interes abierto de los CEX. */
const INTERVALO = 5 * 60_000;
/** El total de cada venue se guarda cada cuarto de hora: son doce filas. */
const PASO_TOTAL = 15 * 60_000;
/** El desglose por simbolo, cada hora: son miles de filas. */
const PASO_SIMBOLO = 60 * 60_000;
/** Por debajo de esto un mercado no entra en el historico por simbolo. */
const MINIMO_SIMBOLO_USD = 1_000_000;

export interface OpenInterestServiceOptions {
  readonly db: DatabaseSync;
  /** Snapshots vivos del collector, para los DEX. */
  readonly dex: () => ReadonlyMap<string, ReadonlyMap<string, MarketSnapshot>>;
  /** Etiqueta y estado de cada venue DEX, de la misma fuente que Data Sources. */
  readonly dexMeta: () => ReadonlyMap<string, {
    label: string;
    status: string | null;
    /** Ficha del registro, para poder comparar venues por algo mas que tamano. */
    chain?: string | null;
    collateral?: string;
    fundingIntervalHours?: number;
    makerBps?: number | null;
    takerBps?: number | null;
  }>;
  readonly intervalMs?: number;
  readonly minSymbolUsd?: number;
  readonly clock?: () => number;
  readonly sources?: readonly { id: string; label: string; fetch(): Promise<VenueOi> }[];
}

interface Agregado {
  /**
   * Por venue: precio de cada simbolo, SOLO para detectar colisiones.
   *
   * Un ticker puede ser dos activos distintos: CAT es Caterpillar a 847
   * dolares en QFEX y un memecoin a 0,0000023 en Aster. Los dos publican un
   * interes abierto en dolares con buena pinta, asi que sin mirar el precio se
   * suman como si fuesen lo mismo. No se muestra: solo se compara.
   */
  readonly preciosPorVenue: Map<string, Map<string, number | null>>;
  /** Por venue: interes abierto por simbolo normalizado. */
  readonly porVenue: Map<string, Map<string, number | null>>;
  readonly estados: OiVenueEstado[];
}

export class OpenInterestService {
  readonly #db: DatabaseSync;
  readonly #dex: OpenInterestServiceOptions['dex'];
  readonly #dexMeta: OpenInterestServiceOptions['dexMeta'];
  readonly #intervalMs: number;
  readonly #minSymbolUsd: number;
  readonly #clock: () => number;
  readonly #fuentes: PollingSource<VenueOi>[];
  readonly #llama: PollingSource<LlamaOi>;
  readonly #revenue: PollingSource<{ porId: ReadonlyMap<string, LlamaRevenue>; porProtocolo: ReadonlyMap<string, LlamaRevenue>; at: number }>;
  readonly #tvl: PollingSource<{ porId: ReadonlyMap<string, number>; at: number }>;

  readonly #definitions: readonly { id: string; label: string; fetch(): Promise<VenueOi> }[];
  #storageError: string | null = null;
  #ultimoTotal = 0;
  #ultimoSimbolo = 0;
  #ultimaPurga = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  /** Cuando se relleno por ultima vez el historico de totales de DefiLlama. */
  #rellenoTotales = 0;
  #rellenandoTotales = false;
  /** Cuando se relleno cada simbolo desde Bybit, para no repetir en una hora. */
  readonly #rellenoBybit = new Map<string, number>();

  constructor(options: OpenInterestServiceOptions) {
    this.#db = options.db;
    this.#dex = options.dex;
    this.#dexMeta = options.dexMeta;
    this.#intervalMs = options.intervalMs ?? INTERVALO;
    this.#minSymbolUsd = options.minSymbolUsd ?? MINIMO_SIMBOLO_USD;
    this.#clock = options.clock ?? Date.now;

    this.#definitions = options.sources ?? FUENTES_CEX;
    this.#fuentes = this.#definitions.map((f) => new PollingSource<VenueOi>({
      id: `oi-${f.id}`,
      intervalMs: this.#intervalMs,
      fetch: () => f.fetch(),
      clock: this.#clock,
      count: (d) => d.markets.length,
    }));

    // DefiLlama publica un total por protocolo y AL DIA, asi que pedirlo mas de
    // una vez por hora no aporta nada y gasta el limite de una API gratuita.
    this.#llama = new PollingSource<LlamaOi>({
      id: "oi-defillama",
      intervalMs: 3_600_000,
      fetch: () => fetchLlamaOi(this.#clock()),
      clock: this.#clock,
      count: (d) => d.protocols.length,
    });

    // Los ingresos son diarios en origen: una vez por hora sobra. Es lo unico
    // gratuito que queda de esta familia; el volumen de derivados paso a plan
    // de pago y devuelve 402.
    this.#revenue = new PollingSource({
      id: "oi-defillama-revenue",
      intervalMs: 3_600_000,
      fetch: () => fetchLlamaRevenue(this.#clock()),
      clock: this.#clock,
      count: (d) => d.porId.size,
    });

    // El capital depositado tambien es diario en origen. Su respuesta es la mas
    // pesada de las tres (8.400 protocolos), razon de mas para una vez por hora.
    this.#tvl = new PollingSource({
      id: "oi-defillama-tvl",
      intervalMs: 3_600_000,
      fetch: () => fetchLlamaTvl(this.#clock()),
      clock: this.#clock,
      count: (d) => d.porId.size,
    });
  }

  get intervalMs(): number {
    return this.#intervalMs;
  }

  start(): void {
    if (this.#timer !== null) return;
    for (const f of this.#fuentes) f.start();
    this.#llama.start();
    this.#revenue.start();
    this.#tvl.start();
    // El historico se escribe SOLO, no cuando alguien abre la pantalla. Atado
    // a la consulta, una tarde sin mirar la pestana dejaba un agujero en la
    // grafica y ademas la purga no corria nunca.
    const paso = () => {
      if (this.#timer === null) return;
      try {
        this.sample();
      } catch { /* sample deja el error visible y permite reintentar. */ }
      // Una vez al dia, el historico de DefiLlama. No bloquea el ciclo.
      if (this.#clock() - this.#rellenoTotales > 86_400_000) void this.rellenarTotales().catch(() => undefined);
      this.#timer = setTimeout(paso, this.#intervalMs);
    };
    this.#timer = setTimeout(paso, this.#intervalMs);
  }

  stop(): void {
    for (const f of this.#fuentes) f.stop();
    this.#llama.stop();
    this.#revenue.stop();
    this.#tvl.stop();
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }

  /** Salud de las fuentes CEX, para Data Sources. */
  health(): SourceHealth[] {
    return [...this.#fuentes.map((f) => f.health()), this.#llama.health(), this.#revenue.health(), this.#tvl.health()];
  }

  /**
   * La foto de ahora, ya normalizada.
   *
   * Los DEX salen del collector y los CEX de su propia cache. Un venue caido
   * aparece con `oiUsd` a null y su motivo: cero seria mentira, porque no es
   * que no haya interes abierto, es que no lo sabemos.
   */
  #agregar(): Agregado {
    const porVenue = new Map<string, Map<string, number | null>>();
    const preciosPorVenue = new Map<string, Map<string, number | null>>();
    const estados: OiVenueEstado[] = [];

    const now = this.#clock();
    const valid = (v: number | null): number | null => v !== null && Number.isFinite(v) && v >= 0 ? v : null;
    const expired = (at: number, maxAge: number) => !Number.isFinite(at) || now - at > maxAge || at - now > 30_000;
    const sum = (m: Map<string, number | null>): number | null => m.size === 0 || [...m.values()].some(v => v === null) ? null : [...m.values()].reduce<number>((a, v) => a + (v ?? 0), 0);
    const dex = this.#dex();
    const llama = this.#llama.data;
    const saludLlama = this.#llama.health();
    const llamaStale = saludLlama.status !== 'ok' || llama === null
      || expired(llama.at, 3_600_000 * 2.5);
    for (const [venue, meta] of this.#dexMeta()) {
      const markets = dex.get(venue);
      const map = new Map<string, number | null>();
      const stamps = [...(markets?.values() ?? [])].map(m => m.at);
      const at = stamps.length ? Math.min(...stamps) : null;
      const stale = meta.status !== 'ok' || at === null || expired(at, 300_000);
      let volumen: number | null = null;
      const precios = new Map<string, number | null>();
      for (const [symbol, m] of markets ?? []) {
        map.set(symbol, stale ? null : valid(m.openInterestUsd));
        precios.set(symbol, valid(m.mid));
        const v = valid(m.volume24hUsd);
        if (!stale && v !== null) volumen = (volumen ?? 0) + v;
      }
      porVenue.set(venue, map);
      preciosPorVenue.set(venue, precios);
      const total = stale ? null : sum(map);
      const ficha = FICHA_DEX[venue];

      /**
       * El respaldo de DefiLlama, solo para un hueco ESTRUCTURAL.
       *
       * Se usa cuando la fuente esta sana y aun asi no trae ni un interes
       * abierto en ningun mercado, que es lo que pasa con Aster: su API lo
       * publica simbolo a simbolo y no lo pedimos. No se usa si el venue esta
       * caido o rancio, porque sustituirlo por otra fuente lo haria parecer
       * vivo, ni si trae el dato de unos mercados y no de otros, porque
       * entonces el hueco es parcial y mezclar las dos fuentes daria un total
       * que no es de ninguna de las dos.
       */
      const sinNingunDato = !stale && map.size > 0 && [...map.values()].every((v) => v === null);
      const respaldo = sinNingunDato && !llamaStale ? llama?.respaldoDeLosNuestros.get(venue) ?? null : null;

      estados.push({ id: venue, label: meta.label, kind: 'dex',
        convention: respaldo?.convention ?? ficha?.convention ?? 'unverified',
        conventionProven: respaldo !== null ? respaldo.conventionFromVenue : ficha?.proven ?? false,
        instrument: 'perp',
        coverage: respaldo !== null
          ? `${COBERTURA_LLAMA} Our own read of this venue does not include open interest.`
          : ficha?.coverage ?? 'Every market the collector reads from this venue.',
        breakdown: respaldo === null,
        volume24hUsd: volumen,
        oiUsd: respaldo?.oiUsd ?? total,
        markets: map.size,
        asOf: respaldo !== null ? llama?.at ?? at : at,
        stale,
        error: stale ? 'Source unavailable or stale'
          : respaldo !== null ? null
            : total === null ? 'Open interest missing for some listed markets' : null });
    }
    for (const [i, source] of this.#fuentes.entries()) {
      const def = this.#definitions[i];
      if (!def) continue;
      const d = source.data, health = source.health();
      const stamps = d?.markets.map(m => m.sourceAt ?? d.at) ?? [];
      const at = stamps.length ? Math.min(...stamps) : d?.at ?? null;
      const stale = health.status !== 'ok' || at === null || expired(at, this.#intervalMs * 2.5);
      const map = new Map<string, number | null>();
      const precios = new Map<string, number | null>();
      let volumen: number | null = null;
      for (const m of d?.markets ?? []) {
        const vol = valid(m.volume24hUsd ?? null);
        if (!stale && vol !== null) volumen = (volumen ?? 0) + vol;
        const value = stale ? null : valid(m.openInterestUsd);
        const previous = map.get(m.symbol);
        map.set(m.symbol, value === null || previous === null ? null : (previous ?? 0) + value);
        // El primero que llegue: con varios contratos del mismo simbolo el
        // precio es el mismo, y lo que importa es el orden de magnitud.
        if (!precios.has(m.symbol)) precios.set(m.symbol, valid(m.mid ?? null));
      }
      porVenue.set(def.id, map);
      preciosPorVenue.set(def.id, precios);
      const total = stale ? null : sum(map);
      estados.push({ id: def.id, label: def.label, kind: 'cex', convention: d?.convention ?? 'unverified',
        conventionProven: (d?.convention ?? 'unverified') !== 'unverified',
        instrument: 'perp',
        coverage: d?.coverage ?? 'Not known while the source is unavailable.', breakdown: true,
        volume24hUsd: volumen,
        oiUsd: total, markets: d?.markets.length ?? 0, asOf: at, stale,
        error: stale ? health.reason ?? 'Source unavailable or stale' : total === null ? 'Open interest missing for some listed markets' : null });
    }

    // Y los protocolos que solo conocemos por DefiLlama. Van sin mapa de
    // simbolos a proposito: su dato es un total por protocolo, asi que al
    // filtrar por un activo no pueden aportar nada y quedan fuera, que no es
    // lo mismo que aportar cero.
    for (const p of llama?.protocols ?? []) {
      estados.push({
        id: p.id,
        label: p.label,
        kind: 'dex',
        convention: p.convention,
        conventionProven: p.conventionFromVenue,
        instrument: p.instrument,
        coverage: p.conventionFromVenue ? COBERTURA_HIP3 : COBERTURA_LLAMA,
        breakdown: false,
        volume24hUsd: null,
        oiUsd: llamaStale ? null : p.oiUsd,
        markets: 0,
        asOf: llama?.at ?? null,
        stale: llamaStale,
        error: llamaStale ? saludLlama.reason ?? 'Source unavailable or stale' : null,
      });
    }

    return { porVenue, preciosPorVenue, estados };
  }

  /**
   * Guarda lo que toque segun la cadencia de cada cosa.
   *
   * Solo lo llama el temporizador del servicio. Consultar no escribe ni purga.
   * Las marcas avanzan tras el commit y permiten reintentar un fallo.
   *
   * **Cuanto ocupa esto.** El total son 14 filas cada cuarto de hora, unas
   * 1.300 al dia. El desglose por simbolo son unas 900 filas por hora, unas
   * 21.600 al dia. Con la retencion de 30 dias el desglose se estabiliza sobre
   * 650.000 filas y los totales, a 365 dias, sobre 490.000. Son cifras
   * CALCULADAS a partir de lo que se ha medido en una hora de funcionamiento,
   * no consumo observado a largo plazo: hay que volver a mirarlo con dias
   * reales antes de darlo por bueno en la Raspberry.
   */
  #persistir(agregado: Agregado): void {
    const ahora = this.#clock();
    const puntos: { ts: number; venue: string; symbol: string; oiUsd: number }[] = [];

    if (ahora - this.#ultimoTotal >= PASO_TOTAL) {
      // El sello se alinea al cuarto de hora para que los puntos de venues
      // distintos caigan JUNTOS y la grafica pueda apilarlos.
      const ts = Math.floor(ahora / PASO_TOTAL) * PASO_TOTAL;
      for (const e of agregado.estados) {
        if (e.stale || e.oiUsd === null) continue;
        puntos.push({ ts, venue: e.id, symbol: OI_TOTAL, oiUsd: e.oiUsd });
      }

    }

    if (ahora - this.#ultimoSimbolo >= PASO_SIMBOLO) {
      const ts = Math.floor(ahora / PASO_SIMBOLO) * PASO_SIMBOLO;
      for (const [venue, porSimbolo] of agregado.porVenue) {
        for (const [symbol, oi] of porSimbolo) {
          if (oi === null || oi < this.#minSymbolUsd) continue;
          puntos.push({ ts, venue, symbol, oiUsd: oi });
        }
      }

    }

    if (puntos.length > 0) {
      insertOiSnapshots(this.#db, puntos);
      if (puntos.some(p => p.symbol === OI_TOTAL)) this.#ultimoTotal = ahora;
      if (puntos.some(p => p.symbol !== OI_TOTAL)) this.#ultimoSimbolo = ahora;
    }

    // Una purga al dia basta y es barata comparada con el borrado acumulado.
    if (ahora - this.#ultimaPurga >= 24 * 60 * 60_000) {
      pruneOi(this.#db, undefined, ahora);
      this.#ultimaPurga = ahora;
    }
  }

  /**
   * Rellena los totales por venue con el OI diario de DefiLlama del ultimo ano
   * (la retencion de totales). Cada cifra se pasa a la convencion de patas del
   * venue, la misma con la que se guarda lo medido: para las filas de DefiLlama
   * es la suya; para los venues que leemos directos, la de su ficha, y si no se
   * puede convertir no se guarda. Lo medido manda: no se pisa ningun punto.
   */
  async rellenarTotales(): Promise<number> {
    const llama = this.#llama.data;
    if (llama === null || this.#rellenandoTotales) return 0;
    this.#rellenandoTotales = true;
    try {
      const dias = await fetchLlamaOiHistorico(365, this.#clock());
      const filas = new Map(llama.protocols.map((p) => [p.label, p]));
      const puntos: { ts: number; venue: string; symbol: string; oiUsd: number }[] = [];
      for (const d of dias) {
        for (const [nombre, v] of Object.entries(d.porProtocolo)) {
          const fila = filas.get(nombre);
          if (fila !== undefined) {
            puntos.push({ ts: d.dia, venue: fila.id, symbol: OI_TOTAL, oiUsd: v });
            continue;
          }
          const nuestro = venueDeNombre(nombre);
          const respaldo = nuestro === null ? undefined : llama.respaldoDeLosNuestros.get(nuestro);
          // Solo la fila de perps que ya sirve de respaldo: de Paradex hay
          // tambien opciones, y no son lo mismo.
          if (nuestro === null || respaldo === undefined || respaldo.label !== nombre) continue;
          const nuestra = aDosPatas(FICHA_DEX[nuestro]?.convention);
          const suya = aDosPatas(respaldo.convention);
          if (nuestra === null || suya === null) continue;
          puntos.push({ ts: d.dia, venue: nuestro, symbol: OI_TOTAL, oiUsd: (v * suya) / nuestra });
        }
      }
      // Solo los venues cuyo historico cuadra con lo medido ahora. A los que no,
      // se les borra lo que se hubiese rellenado antes.
      const medido = new Map(this.#agregar().estados.map((e) => [e.id, e.oiUsd]));
      const ultimoDia = Math.max(...puntos.map((p) => p.ts));
      const ultimo = new Map(puntos.filter((p) => p.ts === ultimoDia).map((p) => [p.venue, p.oiUsd]));
      const validos = new Set<string>();
      const desde = Math.min(...puntos.map((p) => p.ts));
      for (const venue of new Set(puntos.map((p) => p.venue))) {
        if (historicoCuadra(ultimo.get(venue), medido.get(venue))) validos.add(venue);
        else borrarRellenoOi(this.#db, venue, desde);
      }
      const n = insertOiIfAbsent(this.#db, puntos.filter((p) => validos.has(p.venue)));
      this.#rellenoTotales = this.#clock();
      return n;
    } finally {
      this.#rellenandoTotales = false;
    }
  }

  /**
   * Rellena un activo con el OI horario de Bybit (200 horas). Se lanza al
   * pedir ese activo y como mucho una vez por hora; no bloquea la respuesta,
   * asi que lo rellenado aparece en el siguiente refresco de la pantalla.
   */
  async rellenarBybit(symbol: string): Promise<number> {
    const ahora = this.#clock();
    if (ahora - (this.#rellenoBybit.get(symbol) ?? 0) < 3_600_000) return 0;
    this.#rellenoBybit.set(symbol, ahora);
    const serie = await fetchBybitOiHistorico(symbol);
    return insertOiIfAbsent(this.#db, serie.map((p) => ({ ts: p.ts, venue: 'bybit', symbol, oiUsd: p.oiUsd })));
  }

  /**
   * Cambio del OI frente a hace `horas`, a dos patas y con los MISMOS venues
   * en las dos fotos: un venue sin punto en la foto vieja sale de las dos, o
   * su llegada pareceria un aumento.
   */
  #cambio(
    actual: ReadonlyMap<string, number>,
    convencion: ReadonlyMap<string, OiConvention>,
    simbolo: string,
    venues: readonly string[],
    horas: number,
    toleranciaMs: number,
  ): { pct: number | null; venues: number } {
    const antes = oiAt(this.#db, { ts: this.#clock() - horas * 3_600_000, toleranceMs: toleranciaMs, symbol: simbolo, venues })
      .get(simbolo) ?? new Map<string, number>();
    let ahora = 0;
    let entonces = 0;
    let n = 0;
    for (const [v, valor] of actual) {
      const previo = antes.get(v);
      const f = aDosPatas(convencion.get(v));
      if (previo === undefined || f === null) continue;
      ahora += valor * f;
      entonces += previo * f;
      n += 1;
    }
    return { pct: n === 0 || entonces <= 0 ? null : ((ahora - entonces) / entonces) * 100, venues: n };
  }

  /** El temporizador es el unico escritor. Las consultas son de solo lectura. */
  sample(): void {
    try { this.#persistir(this.#agregar()); this.#storageError = null; }
    catch (error) { this.#storageError = 'Open interest history could not be saved'; throw error; }
  }

  /** Lo que sirve la API. Filtrar aqui no dispara ninguna descarga. */
  query(opciones: { symbol?: string | undefined; venues?: readonly string[] | undefined; rangeMs?: number | undefined }) {
    const agregado = this.#agregar();


    const ahora = this.#clock();
    const symbol = opciones.symbol === undefined || opciones.symbol === '' ? null : opciones.symbol.toUpperCase();
    const elegidos = opciones.venues === undefined || opciones.venues.length === 0
      ? agregado.estados.map((e) => e.id)
      : agregado.estados.filter((e) => opciones.venues?.includes(e.id)).map((e) => e.id);
    const rango = opciones.rangeMs ?? 7 * 86_400_000;

    /**
     * Venues cuyo "mismo ticker" es en realidad OTRO activo.
     *
     * Un ticker se repite entre venues sin significar lo mismo: CAT es
     * Caterpillar a 847 dolares en QFEX y un memecoin a 0,0000023 en Aster, y
     * los dos publican interes abierto en dolares. Sumandolos salia un total
     * de dos activos distintos presentado como uno, y encima con
     * `partial: false`, o sea como si estuviese completo.
     *
     * Se resuelve igual que en la matriz de funding, con el mismo helper y la
     * misma tolerancia: manda el grupo de precios MAYORITARIO y lo que se sale
     * queda fuera. Sin mayoria no se elige: fuera todos, porque entonces no se
     * puede saber cual de los dos activos es "el" simbolo.
     *
     * Un venue sin precio no se puede comprobar, asi que se queda. Se dice en
     * la respuesta para que la pantalla no lo presente como verificado.
     */
    const enConflicto = new Set<string>();
    let sinPrecio = 0;
    if (symbol !== null) {
      const conPrecio: { id: string; precio: number }[] = [];
      for (const id of elegidos) {
        const p = agregado.preciosPorVenue.get(id)?.get(symbol);
        if (!agregado.porVenue.get(id)?.has(symbol)) continue;
        if (p === null || p === undefined || !Number.isFinite(p) || p <= 0) { sinPrecio += 1; continue; }
        conPrecio.push({ id, precio: p });
      }
      if (conPrecio.length >= 2) {
        const referencia = precioDeReferencia(conPrecio.map((x) => x.precio), DESAJUSTE_TICKER);
        if (referencia === null) {
          // Dos grupos empatados: el ticker significa dos cosas y ninguna manda.
          for (const x of conPrecio) enConflicto.add(x.id);
        } else {
          for (const x of conPrecio) {
            const factor = x.precio / referencia.precio;
            if (factor > DESAJUSTE_TICKER || factor < 1 / DESAJUSTE_TICKER) enConflicto.add(x.id);
          }
        }
      }
    }

    // Lo de ahora, ya filtrado. Un venue sin el simbolo no suma nada y se
    // distingue de uno que esta caido: uno tiene cero y el otro no tiene dato.
    const actual = agregado.estados
      .filter((e) => elegidos.includes(e.id))
      .map((e) => {
        const porSimbolo = agregado.porVenue.get(e.id);
        const choca = enConflicto.has(e.id);
        const oi = e.stale || choca ? null : symbol === null ? e.oiUsd : porSimbolo?.get(symbol) ?? null;
        return {
          ...e,
          oiUsd: oi,
          // Un venue apartado por colision NO es un hueco de datos: lista el
          // ticker, pero de otro activo. Marcarlo como "no listado" lo saca
          // del recuento de exchanges sin inflar el aviso de datos que faltan.
          listed: choca ? false : symbol === null || e.stale || (porSimbolo?.has(symbol) ?? false),
        };
      });

    // Con un simbolo elegido, los venues que NO lo listan no cuentan como
    // exchanges del total: su cero es real, pero decir "14 exchanges" cuando
    // solo diez lo listan seria engordar la cifra con ceros.
    // Solo perps. Una opcion y un mercado de prediccion tambien tienen interes
    // abierto, y DefiLlama los mete en la misma dimension: 2,0 B de opciones y
    // 2,1 B de prediccion sobre 18,5 B. Sumarlos a un total de perps da una
    // cifra que no mide nada comparable, asi que quedan listados y fuera.
    const conDato = actual.filter((e) => e.oiUsd !== null && e.listed && e.instrument === 'perp');
    const otrosInstrumentos = actual.filter((e) => e.oiUsd !== null && e.listed && e.instrument !== 'perp');
    const total = conDato.reduce((a, e) => a + (e.oiUsd ?? 0), 0);

    // El total se parte en dos: lo que suma con una convencion comprobada
    // CONTRA EL VENUE y lo que descansa solo en lo que declara DefiLlama.
    // Juntarlos sin avisar seria presentar como medido algo que no lo esta.
    const verificados = conDato.filter((e) => e.conventionProven);
    const sinVerificar = conDato.filter((e) => !e.conventionProven);
    const sumar = (l: typeof conDato) => l.reduce((a, e) => a + (e.oiUsd ?? 0), 0);

    /**
     * El interes abierto GLOBAL, o sea contando las dos patas de cada contrato.
     *
     * Es lo comparable entre venues, porque cada uno publica lo que le parece:
     * donde la fuente da una pata se multiplica por dos y donde ya da las dos
     * se deja. Un venue cuya convencion no se sabe NO entra: meterlo seria
     * elegir entre equivocarse por la mitad o por el doble.
     */
    const globalizar = (e: { oiUsd: number | null; convention: OiConvention }): number | null =>
      e.oiUsd === null ? null
        : e.convention === 'single' ? e.oiUsd * 2
          : e.convention === 'double' ? e.oiUsd
            : null;
    const conGlobal = conDato.filter((e) => globalizar(e) !== null);
    const sinConvencion = conDato.filter((e) => globalizar(e) === null);

    // Resolucion segun lo que se guarda: el total va cada cuarto de hora y el
    // desglose por simbolo cada hora. Decirlo evita leer una linea de simbolo
    // como si tuviese el mismo detalle que la del total.
    const paso = symbol === null ? PASO_TOTAL : PASO_SIMBOLO;
    const cubo = Math.max(paso, Math.floor(rango / 240));
    // Sin venues elegidos no se consulta nada. Para el almacenamiento la lista
    // vacia significa "todos", asi que preguntarle daria las trece series
    // justo cuando el usuario acaba de quitarlas todas.
    const puntos = elegidos.length === 0 ? [] : oiSeries(this.#db, {
      from: ahora - rango,
      to: ahora,
      symbol: symbol ?? OI_TOTAL,
      venues: elegidos,
      bucketMs: cubo,
    });

    const ingresos = this.#revenue.data ?? undefined;
    const capital = this.#tvl.data;
    const fichas = this.#dexMeta();
    const llama = this.#llama.data;

    const series = new Map<string, { t: number; v: number }[]>();
    for (const p of puntos) {
      const l = series.get(p.venue) ?? [];
      l.push({ t: p.ts, v: p.oiUsd });
      series.set(p.venue, l);
    }

    // Catalogo para el selector: todos los simbolos vistos, ordenados por
    // tamano. Son los que hay AHORA en los venues elegidos, no un catalogo
    // fijo escrito a mano.
    const catalogo = new Map<string, number>();
    // Y el reparto por exchange de cada uno, que es lo que dice DONDE esta el
    // riesgo. Un activo con 3.000 millones repartidos entre seis exchanges y
    // otro con los mismos 3.000 en uno solo no son la misma situacion.
    const reparto = new Map<string, Map<string, number>>();
    const tipo = new Map(agregado.estados.map((e) => [e.id, e.kind]));
    for (const id of elegidos) {
      for (const [s, v] of agregado.porVenue.get(id) ?? []) {
        if (v === null) continue;
        catalogo.set(s, (catalogo.get(s) ?? 0) + v);
        const porVenue = reparto.get(s) ?? new Map<string, number>();
        porVenue.set(id, (porVenue.get(id) ?? 0) + v);
        reparto.set(s, porVenue);
      }
    }

    /**
     * Los activos mas grandes, con su concentracion.
     *
     * `topShare` es la parte que se lleva el exchange mayor. Cerca de uno
     * significa que ese activo vive practicamente en un sitio, con lo que eso
     * implica para cerrar una pata. El reparto CEX contra DEX va al lado
     * porque es la otra pregunta que se hace con esto delante.
     */
    // --- Cambios y posicionamiento ---
    const convencion = new Map(agregado.estados.map((e) => [e.id, e.convention]));
    const vistos = elegidos.length === 0 ? agregado.estados.map((e) => e.id) : elegidos;
    // Lo que hay AHORA de lo que se esta mirando, en la convencion de cada venue
    // (la misma con la que se guarda), para compararlo con lo guardado.
    const oiAhora = new Map<string, number>();
    for (const e of agregado.estados) {
      if (!vistos.includes(e.id)) continue;
      const v = symbol === null ? e.oiUsd : agregado.porVenue.get(e.id)?.get(symbol) ?? null;
      if (v !== null && v !== undefined && v > 0) oiAhora.set(e.id, v);
    }
    const simboloGuardado = symbol ?? OI_TOTAL;
    // 24 h con margen de tres horas (el desglose se guarda cada hora); 7 dias
    // con margen de un dia, porque lo rellenado de DefiLlama es diario.
    const cambio = {
      h24: this.#cambio(oiAhora, convencion, simboloGuardado, vistos, 24, 3 * 3_600_000),
      d7: this.#cambio(oiAhora, convencion, simboloGuardado, vistos, 168, 26 * 3_600_000),
    };
    // Bybit tiene historico horario por activo: se pide al mirar uno.
    if (symbol !== null && vistos.includes('bybit')) void this.rellenarBybit(symbol).catch(() => undefined);
    // El primer relleno de totales, en cuanto DefiLlama ha respondido: el del
    // temporizador no llega hasta el primer ciclo de guardado.
    if (this.#rellenoTotales === 0 && this.#llama.data !== null) void this.rellenarTotales().catch(() => undefined);

    // OI de cada activo hace 24 h, una sola consulta para toda la tabla.
    const hace24h = oiAt(this.#db, { ts: ahora - 86_400_000, toleranceMs: 3 * 3_600_000, symbol: null, venues: vistos });
    const instantaneas = this.#dex();

    const concentracion = [...catalogo.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)
      .map(([s, totalSimbolo]) => {
        const porVenue = [...(reparto.get(s) ?? new Map<string, number>()).entries()]
          .sort((a, b) => b[1] - a[1]);
        const mayor = porVenue[0];
        const cex = porVenue.filter(([v]) => tipo.get(v) === 'cex').reduce((a, [, v]) => a + v, 0);
        return {
          symbol: s,
          oiUsd: totalSimbolo,
          venues: porVenue.length,
          topVenue: mayor?.[0] ?? null,
          topShare: mayor === undefined || totalSimbolo <= 0 ? null : mayor[1] / totalSimbolo,
          cexUsd: cex,
          dexUsd: totalSimbolo - cex,
          // Cambio en 24 h con los mismos venues en las dos fotos.
          change24hPct: (() => {
            const antes = hace24h.get(s);
            if (antes === undefined) return null;
            let ya = 0;
            let entonces = 0;
            for (const [v] of porVenue) {
              const ahoraV = agregado.porVenue.get(v)?.get(s);
              const previo = antes.get(v);
              const f = aDosPatas(convencion.get(v));
              if (ahoraV == null || previo === undefined || f === null) continue;
              ya += ahoraV * f;
              entonces += previo * f;
            }
            return entonces > 0 ? ((ya - entonces) / entonces) * 100 : null;
          })(),
          // Funding medio ponderado por el OI de cada venue que lo publica:
          // dice hacia que lado esta cargado el mercado de ese activo.
          fundingHourly: (() => {
            let peso = 0;
            let suma = 0;
            for (const [v, oiV] of porVenue) {
              const snap = instantaneas.get(v)?.get(s);
              // Sin funding en la foto no hay nada que ponderar; no rompe la respuesta.
              if (snap?.funding === undefined || oiV <= 0) continue;
              suma += toHourly(snap.funding) * oiV;
              peso += oiV;
            }
            return peso > 0 ? suma / peso : null;
          })(),
        };
      });

    return {
      storageError: this.#storageError,
      asOf: ahora,
      /** Cambio del OI que se esta mirando, a dos patas y con los mismos venues. */
      change: cambio,
      // De cuando son los ingresos y comisiones de Compare. Vienen de DefiLlama
      // cada hora y se sirve la ultima copia buena si falla: la pantalla tiene
      // que poder decir que es vieja (hallazgo de la auditoria).
      revenueAsOf: this.#revenue.health().lastOkAt,
      revenueStale: this.#revenue.health().status !== 'ok',
      intervalMs: this.#intervalMs,
      symbol,
      venues: agregado.estados,
      current: actual,
      total: {
        oiUsd: conDato.length === 0 ? null : total,
        venues: conDato.length,
        /**
         * El total mezcla convenciones y por tanto es PROVISIONAL. Se marca
         * aqui para que la pantalla no tenga que deducirlo.
         */
        provisional: sinVerificar.length > 0,
        /** Suma de los venues cuya convencion esta demostrada. */
        verifiedUsd: verificados.length === 0 ? null : sumar(verificados),
        verifiedVenues: verificados.length,
        /** Lo que suman los venues cuya convencion solo la declara DefiLlama. */
        unverifiedUsd: sinVerificar.length === 0 ? null : sumar(sinVerificar),
        /**
         * El total a DOS patas, que es el comparable entre venues.
         *
         * Solo suma los venues cuya convencion se conoce. Los que no la dicen
         * se quedan fuera y se cuentan en `withoutConvention`, porque un venue
         * del que no se sabe si publica una pata o dos no se puede convertir.
         */
        globalUsd: conGlobal.length === 0 ? null : conGlobal.reduce((a, e) => a + (globalizar(e) ?? 0), 0),
        globalVenues: conGlobal.length,
        withoutConvention: sinConvencion.map((e) => e.id),
        /** Interes abierto que NO es de perps, listado aparte y nunca sumado. */
        otherInstrumentsUsd: otrosInstrumentos.length === 0 ? null : otrosInstrumentos.reduce((a, e) => a + (e.oiUsd ?? 0), 0),
        otherInstruments: otrosInstrumentos.length,
        /** Falta el dato de algun venue elegido: el total no es de todos. */
        partial: actual.some((e) => e.listed && e.oiUsd === null),
        missing: actual.filter((e) => e.listed && e.oiUsd === null).map((e) => e.id),
        /** Elegidos que no listan el simbolo. Su cero es real, no un hueco. */
        notListed: actual.filter((e) => !e.listed).map((e) => e.id),
        /**
         * Venues apartados porque su precio dice que ese ticker es otro
         * activo. No es que falte el dato: es que no es el mismo activo.
         */
        tickerConflict: [...enConflicto],
        /** Venues que listan el simbolo pero no publican precio comprobable. */
        withoutPrice: sinPrecio,
        unverified: sinVerificar.map((e) => e.id),
      },
      series: [...series.entries()].map(([venue, points]) => ({ venue, points })),
      symbols: [...catalogo.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([s, v]) => ({ symbol: s, oiUsd: v })),
      concentration: concentracion,
      /**
       * Un protocolo por fila, con lo que se sabe de el, para poder comparar
       * dos de frente.
       *
       * Cada metrica viene de un sitio y no todas existen para todos, asi que
       * viajan por separado en vez de en un indice cocinado: el interes abierto
       * es nuestro o de DefiLlama segun la fila, el volumen solo lo hay donde
       * venia en la MISMA respuesta que el interes abierto, y los ingresos son
       * de DefiLlama cruzando por nombre dentro de la categoria Derivatives.
       * Lo que no se sabe va en null y la pantalla lo pinta como hueco.
       */
      protocols: agregado.estados.map((e) => {
        // El identificador de DefiLlama sale de su propia lista: para los que
        // leemos directos viene del cruce de exclusion, y para los suyos de la
        // fila. Sin el se cae al nombre, que es lo menos fiable.
        const llamaId = e.id.startsWith("llama:")
          ? llama?.protocols.find((p) => p.id === e.id)?.defillamaId ?? null
          : llama?.idsDeLosNuestros.get(e.id) ?? null;
        const rev = revenueDe(e.label, ingresos, llamaId);
        return {
          id: e.id,
          label: e.label,
          kind: e.kind,
          fromDefillama: e.id.startsWith('llama:'),
          oiUsd: e.oiUsd,
          volume24hUsd: e.volume24hUsd,
          revenue24hUsd: rev?.revenue24hUsd ?? null,
          revenue30dUsd: rev?.revenue30dUsd ?? null,
          tvlUsd: llamaId === null ? null : capital?.porId.get(llamaId) ?? null,
          fees24hUsd: rev?.fees24hUsd ?? null,
          fees30dUsd: rev?.fees30dUsd ?? null,
          markets: e.markets,
          // Web oficial de los que leemos directos y de las CEX; los que solo
          // conocemos por DefiLlama no tienen uno comprobado.
          url: enlaceOficial(e.id),
          convention: e.convention,
          coverage: e.coverage,
          // De nuestro registro, no de DefiLlama: son datos que verificamos al
          // integrar cada venue. Un CEX no los tiene porque no es un venue del
          // registro, solo una fuente de interes abierto.
          chain: fichas.get(e.id)?.chain ?? null,
          collateral: fichas.get(e.id)?.collateral ?? null,
          fundingIntervalHours: cadenciaDeCobro(fichas.get(e.id)?.fundingIntervalHours),
          makerBps: fichas.get(e.id)?.makerBps ?? null,
          takerBps: fichas.get(e.id)?.takerBps ?? null,
        };
      }),
      history: {
        ...oiCoverage(this.#db, symbol ?? OI_TOTAL, elegidos),
        resolutionMs: cubo,
        /** Por debajo de esto un simbolo no tiene historico propio. */
        minSymbolUsd: this.#minSymbolUsd,
      },
    };
  }
}
