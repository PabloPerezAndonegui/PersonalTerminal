/**
 * Normalizacion de simbolos entre venues.
 *
 * Comparar funding entre venues exige que 'BTC-PERP', 'BTCUSDT' y 'BTC' sean el
 * mismo activo. Y ojo con los multiplicadores: 'kPEPE' son 1000 'PEPE'. El
 * ratio de funding no cambia, pero el TAMANO de la orden si, asi que el
 * multiplicador viaja en el snapshot y no se pierde aqui.
 */
export interface NormalizedSymbol {
  readonly symbol: string;
  readonly contractMultiplier: number;
}

/** Sufijos de par que se eliminan, del mas largo al mas corto. */
const SUFFIXES = [
  '-USDC-PERP', '-USDT-PERP', '-USD-PERP',
  '-PERP', '_PERP', 'PERP',
  '-USDC', '-USDT', '-USD',
  'USDT', 'USDC', 'USD',
];

/**
 * Prefijo con digitos: inequivoco, porque ningun ticker empieza por numero.
 * Cubre '1000PEPE', '1000000MOG', '10000SATS'.
 */
const NUMERIC_PREFIX = /^(\d+)([A-Z].*)$/;

/** Multiplicadores admitidos. Cualquier otro numero es parte del ticker. */
const VALID_MULTIPLIERS = new Set([10, 100, 1000, 10_000, 100_000, 1_000_000]);

/**
 * El prefijo 'k' NO se puede detectar por heuristica: KAITO, KSM, KAS y KAVA
 * son tickers legitimos que empiezan por K. Se usa lista explicita.
 * Fuente: activos con multiplicador en Hyperliquid y venues que copian su
 * nomenclatura. Anadir aqui al detectar uno nuevo, nunca relajar la regla.
 */
const K_PREFIXED = new Set([
  'KPEPE', 'KSHIB', 'KBONK', 'KFLOKI', 'KLUNC', 'KDOGS',
  'KNEIRO', 'KAPU', 'KRATS', 'KSATS', 'KBABYDOGE', 'KWEN',
  // De Extended, comprobados uno a uno contra su lista de mercados: NOT es
  // Notcoin, XEC eCash, BOME Book of Meme, HMSTR Hamster Kombat y PTB es su
  // propio listado. Ninguno de los cinco existe como ticker por si mismo.
  'KNOT', 'KXEC', 'KPTB', 'KBOME', 'KHMSTR',
]);

/**
 * El mismo activo TradFi con el nombre de cada venue, llevado a uno solo.
 *
 * Sin esto el S&P 500 eran cuatro filas (`US500`, `US500S`, `SPX500M`,
 * `SPX500`), el oro cuatro y Nvidia tres, y ningun arbitraje entre ellas
 * aparecia porque para la app eran activos distintos. Medido el 17 de
 * noviembre de 2026 sobre los quince venues.
 *
 * Es una tabla EXPLICITA a proposito, no un patron. `SPX` a secas es el
 * memecoin SPX6900 en Hyperliquid y en Aster, y unirlo al S&P por parecido
 * mezclaria dos activos que se separan por un factor de diez mil. Lo que no
 * esta aqui se queda como esta.
 *
 * Y aun estando aqui, una equivalencia mal puesta no se cuela: la comprobacion
 * por precio entre venues aparta al que no cuadra, igual que con CAT.
 */
const ALIAS: Readonly<Record<string, string>> = {
  US500S: 'US500', SPX500M: 'US500', SPX500: 'US500',
  US100S: 'US100', NAS100: 'US100',
  US30S: 'US30', US2KS: 'US2000', US400S: 'US400',
  XAUS: 'XAU', GOLD: 'XAU', 'XAU (GOLD)': 'XAU',
  XAGS: 'XAG', SILVER: 'XAG', 'XAG (SILVER)': 'XAG',
  WTIOIL: 'WTI', CL: 'WTI',
  // Pre-IPO de OpenAI: entropy.io 1.298 $, QFEX y Variational 1.248 $ (17 nov 2026).
  OAI: 'OPENAI',
  // Segunda tanda, 17 nov 2026: mismo precio y mismo nombre en origen, otro
  // ticker. Cada una contrastada contra el nombre que publica el venue.
  // Orderly manda su nombre visible, con parentesis y todo.
  'CL (WTI CRUDE OIL)': 'WTI',
  // Brent: Variational, Aster, Paradex, Orderly y RISEx `BZ`; Extended `XBR`;
  // Lighter `BRENTOIL`; QFEX `BRENT`. Todos a 90,7 $.
  BZ: 'BRENT', XBR: 'BRENT', BRENTOIL: 'BRENT',
  // Gas natural: Paradex `NG`, Extended `XNG` (que en su web es NATGAS-USD).
  NG: 'NATGAS', XNG: 'NATGAS',
  // Berkshire B: QFEX `BRK.B`, Variational y Aster `BRKB`.
  BRKB: 'BRK.B',
  // Visa es `V` en Aster y `VISA` en Variational ("Visa Inc.").
  VISA: 'V',
  // BlackBerry NO va aqui: es `BBX` en Variational y Aster, pero el `BB` de
  // Aster es otro token (0,0054 $), y con el alias comun su BlackBerry chocaba
  // con el y desaparecia. Se renombra solo en Variational, por su nombre.
  // Vana: `VANATOKEN` en Variational.
  VANATOKEN: 'VANA',
  // Anthropic cotiza en DOS escalas que no son el mismo contrato: ~1.686 $
  // (QFEX, Phoenix, Lighter `ANTHROPIC`, entropy `ANTH`) y ~96,6 $
  // (Variational, Aster, Orderly, Lighter `ANT`, Extended `ANTHROP`). Cada
  // nombre va con los de su escala; no se juntan.
  ANTH: 'ANTHROPIC', ANTHROP: 'ANT',
  // SK Hynix en entropy.io y en xyz.
  SKHX: 'SKHYNIX',
  // Los indices de los dexes HIP-3: xyz `SP500` (7.335 $) y `XYZ100`, su
  // Nasdaq 100 (26.883 $, "nasdaq, qqq" en sus palabras clave); Felix `USA500`.
  SP500: 'US500', USA500: 'US500', XYZ100: 'US100',
};

/**
 * Sufijos con los que algunos venues marcan una ACCION: Backpack `NVDA.US` y
 * Extended `NVDA_24_5` (la que cotiza 24 horas, 5 dias). Son la misma accion,
 * y el sufijo no aparece en ningun ticker cripto, asi que se puede quitar sin
 * tabla.
 */
const SUFIJO_ACCION = /(\.US|_24_5)$/;

/**
 * Prefijo de dex HIP-3: un perp desplegado sobre Hyperliquid nombra sus
 * mercados `dex:ACTIVO` (entropy.io manda `io:NVDA`). El prefijo dice DONDE
 * cotiza, y eso ya lo dice el venue; dejarlo en el simbolo hacia que el NVDA
 * de entropy no se cruzase nunca con el NVDA del resto en Funding Arb.
 */
const PREFIJO_HIP3 = /^[A-Za-z0-9]+:(?=\S)/;

export function normalizeSymbol(native: string): NormalizedSymbol {
  let s = native.trim().replace(PREFIJO_HIP3, '').toUpperCase();
  const alias = ALIAS[s];
  if (alias !== undefined) return { symbol: alias, contractMultiplier: 1 };

  for (const suffix of SUFFIXES) {
    if (s.length > suffix.length && s.endsWith(suffix)) {
      s = s.slice(0, -suffix.length);
      break;
    }
  }
  s = s.replace(/[-_/]+$/, '');
  // Despues de los sufijos de par: Backpack manda `NVDA.US_USDC_PERP`.
  s = s.replace(SUFIJO_ACCION, '');
  const aliasTrasSufijo = ALIAS[s];
  if (aliasTrasSufijo !== undefined) return { symbol: aliasTrasSufijo, contractMultiplier: 1 };

  if (K_PREFIXED.has(s)) {
    return { symbol: s.slice(1), contractMultiplier: 1000 };
  }

  const numeric = NUMERIC_PREFIX.exec(s);
  if (numeric?.[1] !== undefined && numeric[2] !== undefined) {
    const multiplier = Number(numeric[1]);
    // Solo potencias de diez conocidas. '2Z' es un ticker real de Hyperliquid:
    // aceptar cualquier numero lo convertia en 'Z' con multiplicador 2, el
    // mismo error que la heuristica del prefijo 'k' con KAITO.
    if (VALID_MULTIPLIERS.has(multiplier)) {
      return { symbol: numeric[2], contractMultiplier: multiplier };
    }
  }

  return { symbol: s, contractMultiplier: 1 };
}
