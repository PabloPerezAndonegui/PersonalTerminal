import type { OiConvention } from './openInterest.ts';

/**
 * Lo que se sabe de un DEX en concreto, cuando se ha podido comprobar.
 *
 * Por defecto un DEX va como `unverified`. Aqui van los que SI se han podido
 * verificar, cada uno con su prueba en el comentario.
 *
 * **De donde salen las pruebas, que no todas valen lo mismo.**
 *
 * 1. La mejor: el propio venue publica las dos cifras y su relacion las
 *    identifica. Es el caso de Variational.
 * 2. Buena: DefiLlama publica el adaptador de cada venue en
 *    `DefiLlama/dimension-adapters` y en el codigo esta escrito si dividen
 *    entre dos y por que. Son integraciones medidas contra la misma API que
 *    leemos nosotros.
 * 3. La mas floja, y se marca como tal en el `coverage`: el cociente entre su
 *    cifra y la nuestra sobre el MISMO venue, sabiendo que ellos normalizan a
 *    una pata. Un 0,50 dice que dividieron y por tanto que la fuente da dos
 *    patas. Lo mide `npm run verify-oi`.
 *
 * Nada entra aqui por parecido entre las cifras de venues DISTINTOS. Eso no
 * probaria nada: dos exchanges tienen el interes abierto que tienen.
 */
export interface FichaOi {
  readonly convention: OiConvention;
  readonly coverage: string;
  /**
   * `true` si la convencion esta probada SOBRE ESTE VENUE: porque el venue
   * publica las dos cifras y su relacion las identifica, o porque el adaptador
   * de DefiLlama dice del campo concreto si cuenta una pata o las dos.
   *
   * `false` si solo se ha deducido del cociente contra DefiLlama. Vale igual
   * para convertir a global, pero no cuenta en el subtotal de verificado:
   * deducir no es medir, y ese subtotal existe para decir cuanto del total
   * descansa en algo medido.
   */
  readonly proven: boolean;
}

export const FICHA_DEX: Record<string, FichaOi> = {
  /**
   * Variational, VERIFICADO el 25 de septiembre de 2026.
   *
   * Publica DOS cifras a la vez: un `open_interest` global de 1,956 B y, por
   * mercado, `long_open_interest` y `short_open_interest`, que sumados dan
   * 0,978 B. La relacion es **2,0000 clavada**, medida sobre sus 553 mercados.
   * Que el propio venue publique las dos con esa proporcion exacta dice cual
   * es cual: la global cuenta las dos patas y la suma por mercado es una.
   * Se usa la de una pata, que es la comparable.
   *
   * De ahi que aqui salga la mitad de lo que ensena su propia web.
   */
  /**
   * Lighter, VERIFICADO el 17 de noviembre de 2026, igual que Variational:
   * `open_interest_usd` suma 769,9 M y `open_interest` por el mark 385,0 M, el
   * doble clavado, y DefiLlama (que normaliza a una pata) publica 391 M. El
   * adaptador usa unidades por mark, que es la de una pata.
   */
  lighter: {
    convention: 'single',
    coverage: 'One side. The venue USD figure counts both sides and is exactly twice this.',
    proven: true,
  },
  variational: {
    convention: 'single',
    coverage: 'One side. The venue headline figure counts both sides and is exactly twice this.',
    proven: true,
  },
  /**
   * Hyperliquid: DOS PATAS, y con esto se cierra la discrepancia que llevaba
   * semanas abierta.
   *
   * El adaptador de DefiLlama lo dice en su codigo, y ademas explica como lo
   * midieron: "Hyperliquid's openInterest counts both sides of each contract
   * (measured at exactly 2x CMC's one-sided figure), so halve it here".
   *
   * Y las cifras cuadran por fin. Nuestro perp principal da 12,97 B a dos
   * patas, o sea 6,49 a una. DefiLlama suma ademas los perps desplegados por
   * terceros (HIP-3), que son otros 4,01 B a dos patas, o sea 2,0 a una. Total
   * 8,5 B contra los 8,23 que publican. Lo que antes parecia un desacuerdo del
   * 47 % eran dos cosas: que ellos dividen entre dos y que ellos incluyen los
   * HIP-3.
   *
   * Aqui NO se suman los HIP-3: son venues distintos, con su libro y su
   * funding, y el mayor, `xyz`, es tradeXYZ, que ya tiene su propia fila.
   */
  hyperliquid: {
    convention: 'double',
    coverage: 'Both sides. Main perp only; builder deployed perps are separate rows.',
    proven: true,
  },
  /** entropy.io es un HIP-3 sobre el mismo motor y el mismo campo. */
  entropy: {
    convention: 'double',
    coverage: 'Both sides, same field and engine as Hyperliquid.',
    proven: true,
  },
  /**
   * Pacifica: DOS PATAS. Su adaptador en DefiLlama lo dice y divide:
   * "open_interest is double-sided (long+short)".
   */
  pacifica: { convention: 'double', coverage: 'Both sides, as the venue publishes it.', proven: true },
  /** Paradex: DOS PATAS. Su adaptador en DefiLlama divide entre dos. */
  paradex: { convention: 'double', coverage: 'Both sides, as the venue publishes it.', proven: true },
  /**
   * RISEx: DOS PATAS. Su adaptador lo dice: "getOpenInterest returns long+short
   * summed, halve it for the one-sided convention". Explica el doble que
   * mediamos contra DefiLlama al integrarlo.
   */
  risex: { convention: 'double', coverage: 'Both sides, as the venue publishes it.', proven: true },
  /** Perpl: UNA PATA. Su adaptador habla de "one-sided total". */
  perpl: { convention: 'single', coverage: 'One side, as the venue publishes it.', proven: true },
  /**
   * Phoenix: UNA PATA. Su adaptador lo dice con todas las letras: "Phoenix API
   * reports one-sided open interest, so no need to divide by 2".
   */
  phoenix: { convention: 'single', coverage: 'One side, as the venue publishes it.', proven: true },
  /** Arcus: UNA PATA. Su adaptador: "/v1/markets openInterest is one-sided". */
  arcus: { convention: 'single', coverage: 'One side, as the venue publishes it.', proven: true },
  /**
   * QFEX: DOS PATAS, por cociente. Medido el 2 de octubre de 2026 con
   * `npm run verify-oi`: nosotros 276,5 M y DefiLlama 138,1, cociente 0,499.
   *
   * La prueba es MAS DEBIL que las de arriba y conviene saberlo. No viene del
   * venue ni de un comentario de su adaptador: viene de que DefiLlama declara
   * normalizar esta dimension a una pata y de que su cifra sea justo la mitad
   * de la nuestra. Eso dice que ellos dividieron, y dividir solo tiene sentido
   * sobre una fuente de dos patas. Lo que sostiene el razonamiento es que esa
   * normalizacion cuadra en los siete venues donde ya la sabiamos por otra via.
   */
  qfex: {
    convention: 'double',
    coverage: 'Both sides. Inferred from DefiLlama publishing exactly half this, not from the venue.',
    proven: false,
  },
  /**
   * Extended: DOS PATAS, por cociente. Nosotros 191,6 M y ellos 93,7, cociente
   * 0,489. Mismo metodo y misma reserva que QFEX.
   */
  extended: {
    convention: 'double',
    coverage: 'Both sides. Inferred from DefiLlama publishing exactly half this, not from the venue.',
    proven: false,
  },
  /**
   * dYdX v4: UNA PATA, por cociente. Nosotros 41,2 M y ellos 41,2, cociente
   * 1,002: no dividieron, asi que la fuente ya venia a una pata.
   *
   * Aqui el razonamiento tiene un agujero que en los de 0,50 no esta: un 1,00
   * tambien sale si su adaptador se OLVIDO de dividir una fuente de dos patas.
   * Es lo que pasa con los HIP-3, y por eso estan declarados aparte. Para dYdX
   * no hay indicio de que sea el caso, pero tampoco prueba de que no.
   */
  dydx: {
    convention: 'single',
    coverage: 'One side. Inferred from DefiLlama publishing the same figure, not from the venue.',
    proven: false,
  },
};

/**
 * Los venues nuestros que son perps HIP-3 sobre Hyperliquid.
 *
 * Se declara porque son la excepcion que invalida el metodo del cociente
 * contra DefiLlama. Al resto de su dimension le aplican una pata; a estos les
 * pasan el campo crudo de Hyperliquid, que viene a dos. Asi que un cociente de
 * 1,00 aqui NO significa "una pata": significa que no dividieron. Su
 * convencion se comprueba leyendo `metaAndAssetCtxs` con su `dex` contra la
 * API de Hyperliquid, que es de donde sale el dato en los dos lados.
 */
export const HIP3_DE_HYPERLIQUID: readonly string[] = ['entropy'];
