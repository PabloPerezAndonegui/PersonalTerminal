import { precioDeReferencia } from './precios.ts';

/**
 * Que clase de activo es cada mercado: cripto, accion, indice, materia prima,
 * divisa o ETF.
 *
 * ## Por que no viene de los venues
 *
 * Ninguno lo publica. Comprobado el 17 de noviembre de 2026 sobre los quince:
 * Variational manda 590 mercados sin ningun campo de clase, y lo mismo el
 * resto. Pero los DEX cripto ya listan acciones: Nvidia esta en ocho de ellos.
 *
 * ## De donde sale entonces
 *
 * **QFEX es la referencia.** Solo lista TradFi, 234 mercados. Lo que esta en
 * QFEX es TradFi, y para decir de que tipo bastan cuatro listas cortas y
 * estables (indices, materias primas, divisas, ETFs); el resto de QFEX son
 * acciones.
 *
 * **Fuera de QFEX, el precio decide.** Un venue cripto que lista NVDA hereda la
 * clase de QFEX SOLO si su precio coincide con el de QFEX. Si no coincide, es
 * otro activo que se llama igual: PURR es un memecoin en Hyperliquid, QNT es
 * el token Quant, CAT es un memecoin en Aster. Sin la comprobacion, la mitad
 * de los memecoins de tres letras saldrian clasificados como acciones.
 *
 * **Los venues que solo listan TradFi cuentan como QFEX.** entropy.io nombra
 * distinto (`ANTH` es Anthropic) y sin esto su mercado mayor saldria como
 * cripto. El seguro es Hyperliquid, que solo lista cripto: si uno de esos
 * venues lista algo al mismo precio que Hyperliquid, es cripto.
 *
 * **Lo que no se puede comprobar es cripto.** Es la clase por defecto porque es
 * de lo que estan hechos estos venues; lo raro es lo contrario.
 */

export type ClaseActivo = 'crypto' | 'equity' | 'index' | 'commodity' | 'fx' | 'etf';

export const CLASES: readonly ClaseActivo[] = ['crypto', 'equity', 'index', 'commodity', 'fx', 'etf'];

/**
 * Las listas fijas, con los nombres YA normalizados (el S&P es `US500` en
 * todos los venues tras la tabla de alias).
 *
 * Son cortas a proposito: cubren lo que existe hoy en los quince venues y
 * cambian poco. Las acciones no tienen lista: son demasiadas y salen de QFEX.
 */
const INDICES = new Set([
  'US500', 'US100', 'US30', 'US2000', 'US400', 'JP225', 'NIKKEI', 'KOSPI', 'HSI', 'GER40', 'UK100', 'DXY', 'VIX',
  // Swaps de Variational sin equivalente en otro venue: Taiwan, China 50 y
  // FANG+. Tickers suyos que no chocan con ninguno cripto.
  'TWIS', 'CNA50S', 'USFNGS',
]);
const MATERIAS = new Set([
  'XAU', 'XAG', 'XPT', 'XPD', 'WTI', 'BRENT', 'NATGAS', 'COPPER', 'URANIUM', 'PAXG', 'XAUT',
  // Swaps de Variational: gasoleo de calefaccion, gasolina y cacao.
  'HOILP', 'GASOLP', 'COCOAP',
]);
const DIVISAS = new Set(['EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'FXF', 'EURUSD', 'GBPUSD', 'USDJPY']);
const ETFS = new Set([
  'SPY', 'QQQ', 'TLT', 'SOXL', 'SOXS', 'EWZ', 'XLE', 'XLF', 'SMH', 'IGV', 'COPX', 'RSP', 'UVXY',
  'IBIT', 'BITU', 'ZROZ', 'BUG', 'BWET', 'EWY',
  // Los que solo lista un venue cripto (Arcus, Aster, Orderly) y por eso no
  // heredan clase de QFEX: oro, petroleo, Nasdaq y Russell apalancados.
  'GLD', 'SLV', 'USO', 'TQQQ', 'SQQQ', 'IWM', 'TNA', 'TZA', 'VOO', 'SPXL', 'SPXS', 'CPER', 'ETHA',
  // DXYZ es el fondo cotizado Destiny Tech100 (27 $ en QFEX), no el indice
  // del dolar (DXY, ~100). Va con los fondos.
  'DXYZ',
]);

/**
 * PAXG y XAUT son oro tokenizado: cotizan en venues cripto y siguen el precio
 * del oro. Van a materias primas aunque no esten en QFEX, porque quien filtra
 * por materias primas buscando oro los quiere ver.
 */
const SIEMPRE_TRADFI = new Set(['PAXG', 'XAUT', ...INDICES, ...MATERIAS, ...DIVISAS]);

/** La clase de un simbolo que se sabe TradFi, segun las listas cortas. */
function tipoTradfi(symbol: string): Exclude<ClaseActivo, 'crypto'> {
  if (INDICES.has(symbol)) return 'index';
  if (MATERIAS.has(symbol)) return 'commodity';
  if (DIVISAS.has(symbol)) return 'fx';
  if (ETFS.has(symbol)) return 'etf';
  return 'equity';
}

/** Un mercado de un venue, con lo minimo para clasificarlo. */
export interface MercadoAClasificar {
  readonly venue: string;
  readonly symbol: string;
  /** Precio por unidad. null si no se conoce, y entonces no se puede comprobar. */
  readonly mid: number | null;
}

/** Tolerancia de precio para decir que dos venues listan el mismo activo. */
const TOLERANCIA = 1.5;

/** Que venues sirven de referencia. Los valores por defecto son los de hoy. */
export interface ReferenciasDeClase {
  /** El venue cuyo precio TradFi manda: QFEX, 234 mercados, todos TradFi. */
  readonly tradfi: string;
  /**
   * Venues que SOLO listan TradFi. Sus mercados son TradFi aunque el nombre
   * no este en QFEX (entropy.io llama `ANTH` a Anthropic y `TCNT` a Tencent).
   * Comprobado el 17 de noviembre de 2026: los 15 de entropy lo son.
   */
  readonly soloTradfi: readonly string[];
  /**
   * El venue cuyo precio cripto manda: el dex principal de Hyperliquid, que
   * solo lista cripto. Es el seguro de la regla anterior: si un venue
   * solo-TradFi lista BTC algun dia, Hyperliquid lo tiene al mismo precio y
   * sale como cripto, no como accion.
   */
  readonly cripto: string;
}

const REFERENCIAS: ReferenciasDeClase = { tradfi: 'qfex', soloTradfi: ['qfex', 'entropy'], cripto: 'hyperliquid' };

const mismoPrecio = (a: number | null | undefined, b: number | null | undefined): boolean =>
  a !== null && a !== undefined && a > 0 && b !== null && b !== undefined && b > 0
  && precioDeReferencia([a, b], TOLERANCIA) !== null;

/**
 * Clasifica todos los mercados de una vez.
 *
 * De una vez y no uno a uno porque la clase de un mercado depende de los
 * demas: el NVDA de Arcus es accion porque su precio cuadra con el de QFEX, y
 * eso solo se sabe mirando los dos.
 *
 * Devuelve un mapa `venue -> simbolo -> clase`.
 */
export function clasificar(
  mercados: readonly MercadoAClasificar[],
  refs: ReferenciasDeClase = REFERENCIAS,
): Map<string, Map<string, ClaseActivo>> {
  const soloTradfi = new Set([refs.tradfi, ...refs.soloTradfi]);
  const precioCripto = new Map<string, number>();
  for (const m of mercados) {
    if (m.venue === refs.cripto && m.mid !== null && m.mid > 0) precioCripto.set(m.symbol, m.mid);
  }

  const out = new Map<string, Map<string, ClaseActivo>>();
  const poner = (venue: string, symbol: string, c: ClaseActivo) => {
    let porSimbolo = out.get(venue);
    if (porSimbolo === undefined) { porSimbolo = new Map(); out.set(venue, porSimbolo); }
    porSimbolo.set(symbol, c);
  };

  // Primero los venues solo-TradFi, que fijan el precio de referencia. El de
  // QFEX va primero y no se pisa: es la referencia declarada.
  const precioTradfi = new Map<string, number>();
  const ordenados = [...mercados].sort((a, b) => Number(b.venue === refs.tradfi) - Number(a.venue === refs.tradfi));
  for (const m of ordenados) {
    if (!soloTradfi.has(m.venue)) continue;
    const esCripto = m.venue !== refs.tradfi && mismoPrecio(m.mid, precioCripto.get(m.symbol));
    poner(m.venue, m.symbol, esCripto ? 'crypto' : tipoTradfi(m.symbol));
    if (!esCripto && m.mid !== null && m.mid > 0 && !precioTradfi.has(m.symbol)) precioTradfi.set(m.symbol, m.mid);
  }

  for (const m of mercados) {
    if (soloTradfi.has(m.venue)) continue;

    const ref = precioTradfi.get(m.symbol);
    if (ref !== undefined) {
      // Esta en un venue TradFi: es el mismo activo solo si el precio cuadra.
      poner(m.venue, m.symbol, mismoPrecio(ref, m.mid) ? tipoTradfi(m.symbol) : 'crypto');
      continue;
    }

    // Ningun venue TradFi lo lista. Los indices, materias primas, divisas y
    // ETFs de las listas cortas se reconocen por nombre, porque no chocan con
    // tickers cripto conocidos; las acciones no, porque si chocan (CAT, B, BB).
    poner(m.venue, m.symbol, SIEMPRE_TRADFI.has(m.symbol) || ETFS.has(m.symbol) ? tipoTradfi(m.symbol) : 'crypto');
  }
  return out;
}

/**
 * La clase de un simbolo en conjunto, para una fila que agrega varios venues.
 *
 * Gana la clase TradFi si algun venue la tiene, porque la cripto es la de por
 * defecto: que un venue no la pudiese comprobar no desmiente a otro que si.
 * Los venues cuyo activo es otro (CAT memecoin) se apartan antes por precio.
 */
export function claseDeSimbolo(porVenue: readonly ClaseActivo[]): ClaseActivo {
  return porVenue.find((c) => c !== 'crypto') ?? 'crypto';
}
