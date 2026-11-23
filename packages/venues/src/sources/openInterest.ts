import { getJson, isRecord, num } from '../http.ts';
import { normalizeSymbol } from '../symbols.ts';

/**
 * Interes abierto de los CEX.
 *
 * Los DEX ya los tenemos: el collector lee `openInterestUsd` de cada mercado
 * en cada ciclo y no hace falta pedir nada mas. Esto cubre lo que falta, que
 * son las bolsas centralizadas, y son las dos que publican el interes abierto
 * de TODOS sus mercados en una sola peticion: pedirlo simbolo a simbolo serian
 * cientos de peticiones por ciclo desde una IP que se comparte con otros bots.
 *
 * ## La convencion, que es lo que hace comparable un numero con otro
 *
 * Medido contra las dos APIs el 24 de septiembre de 2026:
 *
 * - **Bybit VERIFICADO.** Publica las dos convenciones a la vez en la misma
 *   respuesta y las distingue por nombre: `openInterestValue` y
 *   `singleOpenInterestValue`, y la segunda es exactamente la mitad de la
 *   primera (BTCUSDT: 5.045 M contra 2.523 M, 0,5000 clavado). Que el propio
 *   venue llame "single" a una de las dos y valga la mitad que la otra es
 *   prueba suficiente de cual es una pata. Se usa esa.
 * - **Gate VERIFICADO**, por el mismo metodo y comprobado el 1 de octubre de
 *   2026. `futures/usdt/contracts` da `position_size` 261.527.864 contratos de
 *   0,0001 BTC, o sea 2,212 B; y `futures/usdt/contract_stats` da
 *   `open_interest` 522.896.976 con `open_interest_usd` 4,422 B. La relacion
 *   entre las dos es **2,0** y la grande lleva el nombre generico, asi que la
 *   que usamos, `position_size`, es la de una pata.
 * - **OKX SIN VERIFICAR.** Su documentacion define las unidades de `oi`,
 *   `oiCcy` y `oiUsd` (contratos, moneda base y dolares) pero **no dice si
 *   cuenta una pata o las dos**, y no publica una segunda cifra con la que
 *   compararla. Lo unico parecido es el agregado por moneda de `rubik`, que da
 *   3,19 B para BTC frente a los 2,99 B que suman sus swaps, pero cubre mas
 *   contratos, asi que no sirve de prueba. Que su cifra se parezca a la de una
 *   pata de Bybit tampoco demuestra nada: dos venues pueden tener tamanos
 *   parecidos por mil motivos.
 * - **Bitget SIN VERIFICAR.** Tiene un endpoint dedicado, `mix/market/open-interest`,
 *   pero devuelve **el mismo numero** que `holdingAmount` del ticker (31.243
 *   contra 31.242,7), asi que no hay segunda cifra que comparar. Su glosario
 *   habla de "la suma de posiciones largas y cortas", pero es una frase sobre
 *   el concepto general y no una definicion del campo.
 * - **KuCoin SIN VERIFICAR.** Solo publica una cifra de interes abierto.
 *
 * Se declara `convention` en cada fuente para que la pantalla pueda decir cual
 * esta verificada y cual no. Un numero sin convencion conocida se ensena, pero
 * no se presenta como comparable ni se suma al subtotal verificado.
 */

/** Un mercado con su interes abierto ya en dolares. */
export interface OiMarket {
  /** Simbolo normalizado, comparable entre venues. */
  readonly symbol: string;
  /** El identificador del contrato tal cual lo publica el venue. */
  readonly symbolNative: string;
  readonly openInterestUsd: number | null;
  /**
   * Volumen de 24 h en dolares, SOLO si venia en la misma respuesta.
   *
   * No se pide aparte: el presupuesto de esta seccion es una peticion por
   * bolsa. Bybit, Bitget y KuCoin lo traen al lado del interes abierto; OKX y
   * Gate no, y ahi se queda en null, que no es cero.
   */
  readonly volume24hUsd?: number | null;
  /**
   * Precio de referencia del mercado, cuando se puede saber.
   *
   * NO es para mostrarlo: es para detectar que dos venues que dicen listar el
   * mismo ticker en realidad listan activos distintos. CAT es Caterpillar a
   * 847 dolares en un venue y un memecoin a 0,0000023 en otro, y sin precio no
   * hay forma de verlo: los dos publican un interes abierto en dolares con
   * buena pinta y se suman como si fuesen el mismo activo.
   *
   * Opcional porque no todos lo publican junto al interes abierto, y pedirlo
   * aparte seria una peticion mas por bolsa y por vuelta.
   */
  readonly mid?: number | null;
  /** Sello de origen si el venue lo da. null si hay que fiarse del nuestro. */
  readonly sourceAt: number | null;
}

/**
 * Que convencion sigue un venue al publicar su interes abierto.
 *
 * `single` es una sola pata, que es la comparable. `double` cuenta las dos y
 * hay que dividir. `unverified` es que no se ha podido demostrar cual usa: el
 * dato se ensena, pero la pantalla lo marca.
 */
export type OiConvention = 'single' | 'double' | 'unverified';

export interface VenueOi {
  readonly venue: string;
  readonly label: string;
  readonly kind: 'cex' | 'dex';
  readonly convention: OiConvention;
  /**
   * QUE parte del venue entra en esta cifra, en una linea.
   *
   * Ninguna de estas fuentes cubre el exchange entero: cada una cubre una
   * familia de contratos. Sin decirlo, la tabla parece comparar exchanges
   * completos cuando compara trozos de distinto tamano.
   */
  readonly coverage: string;
  readonly markets: readonly OiMarket[];
  readonly at: number;
}

const BYBIT = 'https://api.bybit.com/v5/market/tickers?category=linear';
const OKX = 'https://www.okx.com/api/v5/public/open-interest?instType=SWAP';
const BITGET = 'https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES';
const GATE = 'https://api.gateio.ws/api/v4/futures/usdt/contracts';
const KUCOIN = 'https://api-futures.kucoin.com/api/v1/contracts/active';

/**
 * Bybit.
 *
 * `category=linear` trae 891 mercados, de los que 40 son futuros CON
 * VENCIMIENTO (`deliveryTime` distinto de cero) y no son perpetuos: se
 * descartan, porque mezclar un BTCUSDT-25DEC26 con el perpetuo cuenta dos
 * veces el mismo riesgo bajo el mismo simbolo. Quedan 851: 783 en USDT y 68 en
 * USDC, estos ultimos con el sufijo `PERP`.
 */
export async function fetchBybitOi(now: number = Date.now()): Promise<VenueOi> {
  const raw = await getJson(BYBIT);
  if (!isRecord(raw) || raw['retCode'] !== 0 || !isRecord(raw['result'])) throw new Error('bybit: respuesta inesperada');
  const lista = raw['result']['list'];
  if (!Array.isArray(lista)) throw new Error('bybit: sin lista de mercados');

  const markets: OiMarket[] = [];
  for (const fila of lista) {
    if (!isRecord(fila)) continue;
    const nativo = typeof fila['symbol'] === 'string' ? fila['symbol'] : null;
    if (nativo === null) continue;
    // Solo perpetuos. Los que entregan tienen fecha.
    if ((num(fila['deliveryTime']) ?? 0) > 0) continue;

    const oi = num(fila['singleOpenInterestValue']);
    if (oi !== null && oi < 0) throw new Error('negative open interest');

    const base = nativo.endsWith('USDT') ? nativo.slice(0, -4)
      : nativo.endsWith('PERP') ? nativo.slice(0, -4)
        : null;
    if (base === null || base === '') continue;

    const norm = normalizeSymbol(base);
    const porContrato = num(fila['markPrice']) ?? num(fila['lastPrice']);
    // El precio se normaliza por el MULTIPLICADOR del contrato antes de
    // compararlo. Bybit lista `1000PEPEUSDT` a 0,004485, que es el precio de
    // mil PEPE: compararlo contra el PEPE de otro venue daba un desajuste de
    // mil y apartaba a Bybit como si listase otro activo. El interes abierto
    // en dolares no sufre esto, porque tamano y precio van en las mismas
    // unidades de contrato y el multiplicador se cancela solo.
    markets.push({
      symbol: norm.symbol,
      symbolNative: nativo,
      openInterestUsd: oi,
      volume24hUsd: num(fila['turnover24h']),
      mid: porContrato === null || norm.contractMultiplier <= 0
        ? null : porContrato / norm.contractMultiplier,
      sourceAt: null,
    });
  }

  if (markets.length === 0) throw new Error('bybit: 0 mercados con interes abierto');
  return { venue: 'bybit', label: 'Bybit', kind: 'cex', convention: 'single',
    coverage: 'USDT and USDC perpetuals. Dated futures and inverse contracts excluded.',
    markets, at: now };
}

/**
 * OKX.
 *
 * `instType=SWAP` incluye los perpetuos lineales (BTC-USDT-SWAP) y los
 * inversos, margenados en moneda (BTC-USD-SWAP). Los dos son interes abierto
 * de verdad en ese venue y los dos cuentan: se suman despues por simbolo.
 * `oiUsd` ya viene en dolares, asi que no hay que multiplicar por nada ni
 * aplicar multiplicadores de contrato. Lo que su documentacion NO dice es si
 * esa cifra cuenta una pata o las dos, y por eso sale marcada.
 */
export async function fetchOkxOi(now: number = Date.now()): Promise<VenueOi> {
  const raw = await getJson(OKX);
  if (!isRecord(raw) || raw['code'] !== '0' || !Array.isArray(raw['data'])) throw new Error('okx: respuesta inesperada');

  const markets: OiMarket[] = [];
  for (const fila of raw['data']) {
    if (!isRecord(fila)) continue;
    const nativo = typeof fila['instId'] === 'string' ? fila['instId'] : null;
    if (nativo === null) continue;
    const oi = num(fila['oiUsd']);
    if (oi !== null && oi < 0) throw new Error('negative open interest');

    const base = nativo.split('-')[0];
    if (base === undefined || base === '') continue;

    const stamp = num(fila['ts']);
    if (stamp === null || now - stamp > 750_000 || stamp - now > 30_000) throw new Error('okx: stale or invalid source timestamp');
    // OKX no manda precio, pero publica el MISMO interes abierto en dolares y
    // en moneda base, asi que el precio implicito es el cociente. Solo sirve
    // para detectar colisiones de ticker, no para mostrarlo.
    const enMoneda = num(fila['oiCcy']);
    const implicito = oi !== null && enMoneda !== null && enMoneda > 0 ? oi / enMoneda : null;
    const normOkx = normalizeSymbol(base);
    markets.push({
      symbol: normOkx.symbol,
      symbolNative: nativo,
      openInterestUsd: oi,
      mid: implicito === null || normOkx.contractMultiplier <= 0
        ? null : implicito / normOkx.contractMultiplier,
      // OKX si sella el dato en origen, igual para toda la respuesta.
      sourceAt: num(fila['ts']),
    });
  }

  if (markets.length === 0) throw new Error('okx: 0 mercados con interes abierto');
  return { venue: 'okx', label: 'OKX', kind: 'cex', convention: 'unverified',
    coverage: 'All perpetual swaps, linear and inverse. Dated futures excluded.',
    markets, at: now };
}

/**
 * Bitget.
 *
 * `holdingAmount` viene en unidades del subyacente, asi que se multiplica por
 * el ultimo precio. Comprobado el 24 de septiembre de 2026: BTCUSDT declara
 * 32.473 BTC a 84.442 dolares, 2.742 M, y los 805 mercados suman 8,76 B.
 *
 * **Solo entra la familia USDT.** Bitget tiene ademas contratos en USDC y
 * margenados en moneda, cada uno con su `productType`, que serian una peticion
 * mas cada uno. Se declara en `coverage` para que su cifra no se lea como el
 * exchange entero.
 */
export async function fetchBitgetOi(now: number = Date.now()): Promise<VenueOi> {
  const raw = await getJson(BITGET);
  if (!isRecord(raw) || raw['code'] !== '00000' || !Array.isArray(raw['data'])) {
    throw new Error('bitget: respuesta inesperada');
  }

  const markets: OiMarket[] = [];
  for (const fila of raw['data']) {
    if (!isRecord(fila)) continue;
    const nativo = typeof fila['symbol'] === 'string' ? fila['symbol'] : null;
    if (nativo === null || !nativo.endsWith('USDT')) continue;

    const base = num(fila['holdingAmount']);
    const precio = num(fila['lastPr']);
    if (base !== null && base < 0) throw new Error('negative open interest');
    // Sin precio no hay conversion posible, y el tamano en moneda no se puede
    // comparar con el de otro activo: se conserva el mercado con el dato a
    // null, que no es lo mismo que un cero.
    const oi = base === null || precio === null ? null : base * precio;

    const normBitget = normalizeSymbol(nativo.slice(0, -4));
    markets.push({
      symbol: normBitget.symbol,
      symbolNative: nativo,
      openInterestUsd: oi,
      volume24hUsd: num(fila['usdtVolume']),
      // Por unidad, no por contrato. Ver la nota en el parser de Bybit.
      mid: precio === null || normBitget.contractMultiplier <= 0
        ? null : precio / normBitget.contractMultiplier,
      sourceAt: num(fila['ts']),
    });
  }

  if (markets.length === 0) throw new Error('bitget: 0 mercados');
  return { venue: 'bitget', label: 'Bitget', kind: 'cex', convention: 'unverified',
    coverage: 'USDT-margined perpetuals only. USDC and coin-margined families excluded.',
    markets, at: now };
}

/**
 * Gate.
 *
 * Aqui el tamano viene en CONTRATOS (`position_size`) y cada contrato vale
 * `quanto_multiplier` unidades del subyacente. En BTC_USDT son 281.841.843
 * contratos por 0,0001, o sea 28.184 BTC, que a 84.421 dolares dan 2.378 M.
 * Multiplicar sin el multiplicador daria 23.790 billones, que es el error
 * clasico de esta API.
 *
 * Los 1.013 contratos son todos `direct`, es decir lineales. Los que estan en
 * `in_delisting` se descartan.
 */
export async function fetchGateOi(now: number = Date.now()): Promise<VenueOi> {
  const raw = await getJson(GATE);
  if (!Array.isArray(raw)) throw new Error('gate: respuesta inesperada');

  const markets: OiMarket[] = [];
  for (const fila of raw) {
    if (!isRecord(fila)) continue;
    const nativo = typeof fila['name'] === 'string' ? fila['name'] : null;
    if (nativo === null) continue;
    if (fila['in_delisting'] === true) continue;
    // `inverse` invertiria la formula. Hoy no hay ninguno en esta familia,
    // pero si aparece uno no se cuela con la aritmetica equivocada.
    if (fila['type'] !== 'direct') continue;

    const contratos = num(fila['position_size']);
    const multiplicador = num(fila['quanto_multiplier']);
    const precio = num(fila['mark_price']);
    if (contratos !== null && contratos < 0) throw new Error('negative open interest');
    const oi = contratos === null || multiplicador === null || precio === null
      ? null
      : contratos * multiplicador * precio;

    const base = nativo.split('_')[0];
    if (base === undefined || base === '') continue;

    const normGate = normalizeSymbol(base);
    markets.push({
      symbol: normGate.symbol,
      symbolNative: nativo,
      openInterestUsd: oi,
      // Por unidad, no por contrato. Ver la nota en el parser de Bybit.
      mid: precio === null || normGate.contractMultiplier <= 0
        ? null : precio / normGate.contractMultiplier,
      sourceAt: null,
    });
  }

  if (markets.length === 0) throw new Error('gate: 0 mercados');
  return { venue: 'gate', label: 'Gate', kind: 'cex', convention: 'single',
    coverage: 'One side, verified. USDT-margined perpetuals only; BTC-margined family excluded.',
    markets, at: now };
}

/**
 * KuCoin.
 *
 * Tambien en contratos: `openInterest` por `multiplier` da el subyacente. En
 * XBTUSDTM son 11.792.506 lotes por 0,001, o sea 11.792 BTC.
 *
 * Dos filtros. `type` distingue el perpetuo (`FFWCSX`) del futuro con
 * vencimiento (`FFICSX`), y solo entra el primero. Y los inversos se quedan
 * fuera: ahi el multiplicador esta en dolares y no en moneda, asi que la misma
 * formula daria un numero sin sentido. De 690 contratos quedan 684.
 *
 * `XBT` es el nombre de KuCoin para BTC. Sin traducirlo, Bitcoin apareceria
 * como un activo aparte que solo existe en este exchange.
 */
export async function fetchKucoinOi(now: number = Date.now()): Promise<VenueOi> {
  const raw = await getJson(KUCOIN);
  if (!isRecord(raw) || raw['code'] !== '200000' || !Array.isArray(raw['data'])) {
    throw new Error('kucoin: respuesta inesperada');
  }

  const markets: OiMarket[] = [];
  for (const fila of raw['data']) {
    if (!isRecord(fila)) continue;
    const nativo = typeof fila['symbol'] === 'string' ? fila['symbol'] : null;
    if (nativo === null) continue;
    if (fila['type'] !== 'FFWCSX') continue;
    if (fila['isInverse'] === true) continue;

    const lotes = num(fila['openInterest']);
    const multiplicador = num(fila['multiplier']);
    const precio = num(fila['markPrice']);
    if (lotes !== null && lotes < 0) throw new Error('negative open interest');
    const oi = lotes === null || multiplicador === null || precio === null
      ? null
      : lotes * multiplicador * precio;

    // Los perpetuos lineales acaban en `M` (de "margin"), y el resto del
    // nombre es la base mas la moneda de cotizacion.
    const sinSufijo = nativo.endsWith('M') ? nativo.slice(0, -1) : nativo;
    const base = sinSufijo.endsWith('USDT') ? sinSufijo.slice(0, -4)
      : sinSufijo.endsWith('USDC') ? sinSufijo.slice(0, -4)
        : null;
    if (base === null || base === '') continue;

    const normKucoin = normalizeSymbol(base === 'XBT' ? 'BTC' : base);
    markets.push({
      symbol: normKucoin.symbol,
      symbolNative: nativo,
      openInterestUsd: oi,
      volume24hUsd: num(fila['volumeOf24h']) === null || precio === null ? null : num(fila['volumeOf24h'])! * precio,
      // Por unidad, no por contrato. Ver la nota en el parser de Bybit.
      mid: precio === null || normKucoin.contractMultiplier <= 0
        ? null : precio / normKucoin.contractMultiplier,
      sourceAt: null,
    });
  }

  if (markets.length === 0) throw new Error('kucoin: 0 mercados');
  return { venue: 'kucoin', label: 'KuCoin', kind: 'cex', convention: 'unverified',
    coverage: 'Linear perpetuals only. Inverse contracts and dated futures excluded.',
    markets, at: now };
}

/** Las fuentes CEX integradas. No se promete ninguna que no este aqui. */
export const FUENTES_CEX = [
  { id: 'bybit', label: 'Bybit', fetch: fetchBybitOi },
  { id: 'okx', label: 'OKX', fetch: fetchOkxOi },
  { id: 'bitget', label: 'Bitget', fetch: fetchBitgetOi },
  { id: 'gate', label: 'Gate', fetch: fetchGateOi },
  { id: 'kucoin', label: 'KuCoin', fetch: fetchKucoinOi },
] as const;
