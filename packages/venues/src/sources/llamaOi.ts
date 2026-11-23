import { getJson, isRecord, num } from '../http.ts';
import type { OiConvention, VenueOi } from './openInterest.ts';

/**
 * Interes abierto de DefiLlama, para los protocolos que NO leemos directos.
 *
 * Leemos doce venues contra su propia API y cinco CEX contra la suya. DefiLlama
 * publica 94 protocolos con interes abierto, asi que aporta unos ochenta que no
 * tocamos: tradeXYZ, edgeX, Lighter, Grvt, los mercados de prediccion y una
 * cola larga de perps pequenos. Sin esto, la pantalla dice "aqui esta el
 * interes abierto" ensenando una parte del mapa.
 *
 * ## Dos cosas que esta fuente NO es
 *
 * **No es la misma medida, y el 2 de octubre de 2026 se averiguo por que.**
 * Ellos normalizan a UNA pata y nosotros publicamos lo que da el venue, asi que
 * donde el venue cuenta las dos, su cifra sale a la mitad. Eso explica el
 * desacuerdo que llevaba semanas abierto en Hyperliquid: 12,95 B nuestros a dos
 * patas son 6,48 a una, y los 8,23 que publican ellos quedan por encima porque
 * su fila de Hyperliquid no es solo el perp principal. Cuanto se le suma no
 * esta medido, asi que esa parte sigue pendiente y se dice asi.
 *
 * Los protocolos que YA leemos directos se descartan igual, y no por el
 * desacuerdo sino para **evitar contarlos dos veces**, que seria peor. La lista
 * de exclusion es explicita y esta abajo.
 *
 * **No tiene desglose por simbolo.** Es un total por protocolo y al dia. Al
 * filtrar por un activo, estos protocolos no pueden decir cuanto ponen, asi que
 * quedan fuera de esa vista en vez de aportar un cero.
 */

const URL_OI = 'https://api.llama.fi/overview/open-interest'
  + '?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true';

/**
 * Los que leemos contra la API del propio venue.
 *
 * Se compara sobre el nombre en minusculas y sin separadores, porque DefiLlama
 * los llama "Hyperliquid Perps", "dYdX V4" o "Phoenix Perp". Si algun dia
 * renombra uno, lo que pasa es que ese protocolo aparecera DOS veces, y por eso
 * el smoke cuenta cuantos se excluyen y avisa si cambia.
 */
export const YA_LEIDOS_DIRECTOS: readonly string[] = [
  'hyperliquid', 'aster', 'variational', 'paradex', 'orderly', 'extended',
  'pacifica', 'dydx', 'phoenix', 'perpl', 'qfex', 'backpack',
  // Anadidos el 25 de septiembre de 2026. 'entropy' importa especialmente:
  // DefiLlama lo llama 'entropy.io' y ahora lo leemos directo contra
  // Hyperliquid, asi que sin esta linea contaria sus 54 M dos veces.
  'arcus', 'risex', 'entropy',
];

const clave = (nombre: string): string => nombre.toLowerCase().replace(/[^a-z]/g, '');

/** true si ese protocolo ya lo leemos nosotros y contarlo seria duplicarlo. */
export function esDuplicado(nombre: string): boolean {
  return venueDeNombre(nombre) !== null;
}

/** A cual de nuestros venues corresponde este nombre de DefiLlama, si a alguno. */
/**
 * Los que se cruzan por nombre EXACTO, porque un `includes` arrastraria otro
 * producto. Lighter: "Lighter Perps" es el que leemos; "Lighter Robinhood
 * Perps" (177 M el 17 nov 2026) es otro despliegue que no leemos, y con
 * `includes('lighter')` se habria excluido y su interes abierto se perderia.
 */
const EXACTOS: Readonly<Record<string, string>> = {
  lighterperps: 'lighter',
};

export function venueDeNombre(nombre: string): string | null {
  const k = clave(nombre);
  return EXACTOS[k] ?? YA_LEIDOS_DIRECTOS.find((v) => k.includes(v)) ?? null;
}

/**
 * Que instrumento es, porque no todo lo que DefiLlama mete en esta dimension
 * es un perpetuo.
 *
 * Su lista trae opciones (Derive, 1,9 B), mercados de prediccion (Kalshi,
 * 1,5 B) y derivados de tipo de interes (Boros). Sumarlos a un total de perps
 * da una cifra que no mide nada: el interes abierto de una opcion es nocional
 * de opcion, el de un mercado de prediccion son dolares bloqueados hasta que
 * se resuelve, y ninguna de las dos cosas se arbitra contra un funding. Son
 * 4,1 B de los 18,5 que publican, asi que no es una esquina.
 *
 * No se descartan: se etiquetan. El dato sigue estando y se puede mirar, pero
 * no entra en el total de perps.
 */
export type LlamaInstrument = 'perp' | 'option' | 'prediction' | 'rates' | 'other';

/** De la categoria que declara DefiLlama a lo que es el instrumento. */
function instrumentoDe(category: string | null): LlamaInstrument {
  switch (category) {
    case 'Options': return 'option';
    case 'Prediction Market': return 'prediction';
    case 'Interest Rate Derivatives': return 'rates';
    case 'Derivatives': case 'Interface': case 'Synthetics': return 'perp';
    default: return 'other';
  }
}

/**
 * Un perp HIP-3 desplegado sobre Hyperliquid por un tercero.
 *
 * DefiLlama los clasifica como "Interface" sobre la cadena Hyperliquid L1.
 * Importan por dos razones:
 *
 * **Su cifra viene a DOS patas.** Es la excepcion conocida a la convencion de
 * la casa: al resto de la dimension le aplican una pata, y a estos les pasan el
 * campo crudo de Hyperliquid sin dividir. Medido el 2 de octubre de 2026
 * leyendo `metaAndAssetCtxs` con cada `dex` contra la API de Hyperliquid, y la
 * coincidencia es exacta, no parecida: entropy.io 60,1 M contra 60,1 M del dex
 * `io`, paragon 20,3 contra 20,3 de `para`, kinetiq-markets 9,2 contra 9,2 de
 * `mkts`, tradeXYZ 3.854 contra 3.848 de `xyz`. Es el mismo numero de la misma
 * API, asi que lo que mide el cociente es el factor dos y nada mas.
 *
 * **Pero NO se cuentan dos veces.** "Interface" suena a frontend sobre el libro
 * de otro, y para estos no lo es: `metaAndAssetCtxs` sin parametro `dex`
 * devuelve 234 mercados y 12,95 B que NO incluyen los de los HIP-3. Cada uno
 * tiene su libro y su funding. Son venues de verdad, y asi entran.
 */
function esHip3(category: string | null, chains: readonly string[]): boolean {
  return category === 'Interface'
    && chains.some((c) => c.toLowerCase().includes('hyperliquid'));
}

/** Un protocolo de DefiLlama, ya filtrado. */
export interface LlamaProtocolOi {
  readonly id: string;
  readonly label: string;
  readonly oiUsd: number;
  /**
   * El identificador de DefiLlama.
   *
   * Es la pieza que permite cruzar con sus ingresos SIN adivinar por el
   * nombre. Cruzar por nombre en una lista de 2.400 protocolos es como acabar
   * poniendole a Bybit los ingresos de "Bybit Staked SOL".
   */
  readonly defillamaId: string | null;
  /** Cadenas donde opera, tal como las declara DefiLlama. */
  readonly chains: readonly string[];
  /** La categoria que declara DefiLlama, sin interpretar. */
  readonly category: string | null;
  /** Que instrumento es. Solo los `perp` entran en el total de perps. */
  readonly instrument: LlamaInstrument;
  /**
   * Una pata o dos, y de donde sale saberlo.
   *
   * DefiLlama normaliza esta dimension a UNA pata. Lo dice el codigo de sus
   * adaptadores: "so halve it here to match the one-sided convention used
   * across perp OI". Y cuadra contra los siete venues que leemos directos y de
   * los que ya sabiamos la convencion por otra via: a variational, arcus,
   * phoenix y perpl les pasan la cifra igual, y a pacifica, paradex y risex se
   * la dividen justo entre dos. Siete de siete.
   *
   * La excepcion son los HIP-3, que van a dos patas. Ver `esHip3`.
   */
  readonly convention: OiConvention;
  /**
   * Si la convencion esta comprobada contra la API del propio venue o solo
   * descansa en la normalizacion que declara DefiLlama.
   *
   * Importa para no inflar el subtotal de "verificado". Que la casa declare una
   * convencion y que cuadre en siete venues es un buen indicio para los noventa
   * restantes, pero no es haber medido esos noventa. Lo unico que aqui sale
   * `true` son los HIP-3, cuya cifra se ha medido contra Hyperliquid.
   */
  readonly conventionFromVenue: boolean;
}

export interface LlamaOi {
  readonly protocols: readonly LlamaProtocolOi[];
  /** Cuantos se han descartado por leerlos ya directos. */
  readonly excluded: number;
  /**
   * De nuestro id de venue al identificador de DefiLlama, para los que SI
   * leemos directos.
   *
   * Sus cifras de interes abierto se descartan para no contarlas dos veces,
   * pero su identidad sigue sirviendo: es lo que permite traerles los ingresos.
   */
  readonly idsDeLosNuestros: ReadonlyMap<string, string>;
  /**
   * La cifra de DefiLlama para los venues que SI leemos directos, guardada
   * como respaldo y no para sumarla.
   *
   * Existe por Aster. Su API publica el interes abierto en un endpoint por
   * simbolo, `/fapi/v1/openInterest?symbol=`, y nuestro adaptador no lo llama:
   * serian 576 peticiones por vuelta desde una IP compartida. Asi que leemos
   * Aster entero menos esto, y la fila se queda a null teniendo DefiLlama 1,42
   * B publicados. Un hueco que se puede rellenar, con su etiqueta, es mejor que
   * un hueco.
   *
   * Solo se usa donde nuestra lectura no trae NINGUN interes abierto. Si el
   * venue esta caido o rancio, la fila sigue a null: sustituir un venue caido
   * por otra fuente lo haria parecer vivo.
   */
  readonly respaldoDeLosNuestros: ReadonlyMap<string, LlamaProtocolOi>;
  readonly at: number;
}

export async function fetchLlamaOi(now: number = Date.now()): Promise<LlamaOi> {
  const raw = await getJson(URL_OI);
  if (!isRecord(raw) || !Array.isArray(raw['protocols'])) throw new Error('llama-oi: respuesta inesperada');

  const protocols: LlamaProtocolOi[] = [];
  const idsDeLosNuestros = new Map<string, string>();
  const respaldo = new Map<string, LlamaProtocolOi>();
  let excluded = 0;

  for (const fila of raw['protocols']) {
    if (!isRecord(fila)) continue;
    const nombre = typeof fila['name'] === 'string' ? fila['name'] : null;
    if (nombre === null) continue;

    const oi = num(fila['total24h']);
    // Sin cifra no entra: un protocolo listado sin dato no es un protocolo con
    // cero interes abierto.
    if (oi === null || oi <= 0) continue;

    const llamaId = typeof fila['defillamaId'] === 'string' ? fila['defillamaId']
      : typeof fila['defillamaId'] === 'number' ? String(fila['defillamaId'])
        : null;

    // Los que ya leemos directos no aportan su interes abierto, que seria
    // contarlo dos veces, pero SI su identidad: con ella se les traen despues
    // los ingresos sin tener que adivinar por el nombre.
    const chains = Array.isArray(fila['chains'])
      ? fila['chains'].filter((c): c is string => typeof c === 'string')
      : [];
    const category = typeof fila['category'] === 'string' ? fila['category'] : null;
    const hip3 = esHip3(category, chains);
    const instrument = instrumentoDe(category);

    const nuestro = venueDeNombre(nombre);
    if (nuestro !== null) {
      excluded++;
      if (llamaId !== null && !idsDeLosNuestros.has(nuestro)) idsDeLosNuestros.set(nuestro, llamaId);
      // De respaldo solo valen los perps, y hay que elegir: de Paradex publican
      // "Paradex Options" con 127 M y "Paradex Perps" con 9, y lo que leemos
      // nosotros son los perps. Quedarse con la mayor pondria las opciones.
      if (instrument === 'perp' && !respaldo.has(nuestro)) {
        respaldo.set(nuestro, {
          id: `llama:${clave(nombre)}`, label: nombre, oiUsd: oi, defillamaId: llamaId,
          chains, category, instrument, convention: hip3 ? 'double' : 'single',
          conventionFromVenue: hip3,
        });
      }
      continue;
    }

    protocols.push({
      // Prefijo para que nunca choque con el id de un venue que leemos directo.
      id: `llama:${clave(nombre)}`,
      label: nombre,
      oiUsd: oi,
      defillamaId: llamaId,
      chains,
      category,
      instrument,
      convention: hip3 ? 'double' : 'single',
      conventionFromVenue: hip3,
    });
  }

  // Se comprueba que haya salido ALGO de la respuesta, contando tambien los
  // descartados. Mirar solo `protocols` confundiria dos cosas distintas: que
  // DefiLlama devuelva una lista que no sabemos leer, que es un fallo, y que
  // todo lo que trae sean venues que ya leemos directos, que no lo es.
  if (protocols.length === 0 && respaldo.size === 0) throw new Error('llama-oi: 0 protocolos');
  return { protocols, excluded, idsDeLosNuestros, respaldoDeLosNuestros: respaldo, at: now };
}

/** El texto que acompana a estas filas. Se repite en la pantalla, no se deduce. */
export const COBERTURA_LLAMA =
  'One side, per DefiLlama normalisation for this dimension. Reported once a day, '
  + 'not read from the venue API, and with no per asset breakdown.';

/** La de un HIP-3, que es la excepcion y por tanto se dice aparte. */
export const COBERTURA_HIP3 =
  'Both sides. Builder deployed perp on Hyperliquid, with its own book and funding. '
  + 'Matches the venue API exactly.';

/** Convierte un protocolo de DefiLlama en una fuente con la forma de las demas. */
export function comoVenueOi(p: LlamaProtocolOi, at: number): VenueOi {
  return {
    venue: p.id,
    label: p.label,
    kind: 'dex',
    convention: p.convention,
    coverage: p.conventionFromVenue ? COBERTURA_HIP3 : COBERTURA_LLAMA,
    markets: [],
    at,
  };
}

const BASE_FEES = 'https://api.llama.fi/overview/fees'
  + '?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true&dataType=';
const URL_REV = BASE_FEES + 'dailyRevenue';
const URL_FEES = BASE_FEES + 'dailyFees';

/** Ingresos de un protocolo, en dolares. */
export interface LlamaRevenue {
  readonly label: string;
  readonly revenue24hUsd: number | null;
  readonly revenue30dUsd: number | null;
  /**
   * Comisiones cobradas al usuario, que NO son lo mismo que los ingresos.
   *
   * Los ingresos son lo que se queda el protocolo; las comisiones, todo lo que
   * paga quien opera. Van en su propia fila y no como relleno de la otra,
   * porque taparian una diferencia que importa: hay protocolos que cobran
   * mucho y se quedan poco. Se anaden porque DefiLlama cubre once protocolos
   * mas con comisiones que con ingresos.
   */
  readonly fees24hUsd: number | null;
  readonly fees30dUsd: number | null;
}

/**
 * Ingresos por protocolo, de DefiLlama.
 *
 * Es lo unico gratuito que queda de esta familia: el endpoint de volumen de
 * derivados paso a plan de pago y devuelve 402. Lo que si sigue abierto es
 * `overview/fees`, y con `dataType=dailyRevenue` da lo que se queda el
 * protocolo, no lo que cobra al usuario.
 *
 * **Se indexa por el identificador de DefiLlama, no por el nombre.** El mismo
 * identificador aparece en su respuesta de interes abierto, asi que el cruce
 * es exacto y no hay que adivinar nada. Medido el 25 de septiembre de 2026:
 * por identificador cruzan 62 de los 94 protocolos con interes abierto, y
 * adivinando por nombre dentro de la categoria Derivatives solo 51. Los que
 * gana son los que DefiLlama clasifica en otra categoria: tradeXYZ es
 * "Interface" con 2,24 M al mes y Polymarket es "Prediction Market" con 14,98.
 *
 * El indice por nombre se conserva como ultimo recurso para los pocos que no
 * traen identificador, y ahi SI se filtra a Derivatives: en una lista de 2.400
 * protocolos, cruzar "Bybit" a ciegas encuentra "Bybit Staked SOL".
 */
export async function fetchLlamaRevenue(now: number = Date.now()): Promise<{
  /** Por identificador de DefiLlama. Exacto. */
  readonly porId: ReadonlyMap<string, LlamaRevenue>;
  /** Por nombre normalizado y solo derivados. Para cuando no hay identificador. */
  readonly porProtocolo: ReadonlyMap<string, LlamaRevenue>;
  readonly at: number;
}> {
  // Dos peticiones, una por magnitud. DefiLlama las sirve en el mismo endpoint
  // con `dataType` distinto y no hay forma de pedir las dos a la vez.
  const [rev, fees] = await Promise.all([
    getJson(URL_REV),
    getJson(URL_FEES).catch(() => null),
  ]);
  if (!isRecord(rev) || !Array.isArray(rev['protocols'])) throw new Error('llama-rev: respuesta inesperada');

  const idDe = (fila: Record<string, unknown>): string | null =>
    typeof fila['defillamaId'] === 'string' ? fila['defillamaId']
      : typeof fila['defillamaId'] === 'number' ? String(fila['defillamaId'])
        : null;

  // Las comisiones se indexan primero para poder colgarlas de cada entrada.
  const comisionesPorId = new Map<string, { d24: number | null; d30: number | null }>();
  if (isRecord(fees) && Array.isArray(fees['protocols'])) {
    for (const fila of fees['protocols']) {
      if (!isRecord(fila)) continue;
      const id = idDe(fila);
      if (id !== null) comisionesPorId.set(id, { d24: num(fila['total24h']), d30: num(fila['total30d']) });
    }
  }

  const porId = new Map<string, LlamaRevenue>();
  const porProtocolo = new Map<string, LlamaRevenue>();
  const vistos = new Set<string>();

  const anadir = (fila: Record<string, unknown>, conIngresos: boolean) => {
    const nombre = typeof fila['name'] === 'string' ? fila['name'] : null;
    if (nombre === null) return;
    const id = idDe(fila);
    const com = id === null ? undefined : comisionesPorId.get(id);

    const entrada: LlamaRevenue = {
      label: nombre,
      revenue24hUsd: conIngresos ? num(fila['total24h']) : null,
      revenue30dUsd: conIngresos ? num(fila['total30d']) : null,
      fees24hUsd: com?.d24 ?? (conIngresos ? null : num(fila['total24h'])),
      fees30dUsd: com?.d30 ?? (conIngresos ? null : num(fila['total30d'])),
    };

    if (id !== null) { porId.set(id, entrada); vistos.add(id); }
    if (fila['category'] === 'Derivatives') porProtocolo.set(clave(nombre), entrada);
  };

  for (const fila of rev['protocols']) if (isRecord(fila)) anadir(fila, true);

  // Los que solo aparecen en comisiones entran igual: tendran su fila de
  // comisiones y un hueco en la de ingresos, que es la verdad.
  if (isRecord(fees) && Array.isArray(fees['protocols'])) {
    for (const fila of fees['protocols']) {
      if (!isRecord(fila)) continue;
      const id = idDe(fila);
      if (id !== null && vistos.has(id)) continue;
      anadir(fila, false);
    }
  }

  if (porId.size === 0 && porProtocolo.size === 0) throw new Error('llama-rev: 0 protocolos');
  return { porId, porProtocolo, at: now };
}

/** La misma normalizacion que usa el cruce por nombre, para reutilizarla. */
export const claveProtocolo = clave;

const URL_TVL = 'https://api.llama.fi/protocols';

/**
 * Capital depositado por protocolo, de DefiLlama.
 *
 * **El cruce no es directo y por eso lleva su propia funcion.** DefiLlama
 * reparte un mismo venue en varias entradas: "Hyperliquid Perps" no declara
 * TVL, y el dinero esta en "Hyperliquid Bridge" (7.135 M), "Hyperliquid HLP"
 * (183 M) y "Hyperliquid Spot Orderbook" (175 M), cada una con SU
 * identificador. Lo que las une es `parentProtocol`, que en las cuatro vale
 * `parent#hyperliquid`.
 *
 * Asi que el TVL de un venue es la suma de sus hermanas de padre, que es
 * justo lo que ensena la ficha del protocolo en su web. Sin padre, lo suyo.
 *
 * Para un perp esto es el colateral que respalda las posiciones, asi que
 * puesto al lado del interes abierto dice cuanto riesgo se lleva por cada
 * dolar depositado.
 */
export async function fetchLlamaTvl(now: number = Date.now()): Promise<{
  readonly porId: ReadonlyMap<string, number>;
  readonly at: number;
}> {
  const raw = await getJson(URL_TVL);
  if (!Array.isArray(raw)) throw new Error('llama-tvl: respuesta inesperada');

  // Primera pasada: cuanto suma cada familia.
  const porPadre = new Map<string, number>();
  const filas: { id: string; padre: string | null; tvl: number | null }[] = [];

  for (const fila of raw) {
    if (!isRecord(fila)) continue;
    const id = typeof fila['id'] === 'string' ? fila['id']
      : typeof fila['id'] === 'number' ? String(fila['id'])
        : null;
    if (id === null) continue;
    const padre = typeof fila['parentProtocol'] === 'string' ? fila['parentProtocol'] : null;
    const tvl = num(fila['tvl']);
    filas.push({ id, padre, tvl });
    if (padre !== null && tvl !== null) porPadre.set(padre, (porPadre.get(padre) ?? 0) + tvl);
  }

  // Segunda: cada identificador recibe el total de su familia.
  const porId = new Map<string, number>();
  for (const f of filas) {
    const valor = f.padre !== null ? porPadre.get(f.padre) ?? null : f.tvl;
    if (valor !== null) porId.set(f.id, valor);
  }

  if (porId.size === 0) throw new Error('llama-tvl: 0 protocolos con TVL');
  return { porId, at: now };
}
