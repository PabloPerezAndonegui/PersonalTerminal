/**
 * Indicadores tecnicos, como funciones puras sobre una serie de velas.
 *
 * ## Dos reglas que valen para todos
 *
 * **Devuelven un array de la MISMA longitud que la entrada**, con `null` en las
 * posiciones donde el indicador todavia no existe. Una EMA de 21 no tiene valor
 * en la vela 5, y eso no es cero ni es la primera vela repetida: es que no hay
 * dato. Es la misma regla que el resto del proyecto, y aqui importa el doble
 * porque un cero dibujado en un grafico es una linea que cae a cero y se lee
 * como una senal.
 *
 * **No hacen I/O y no saben de graficos.** Entran numeros y salen numeros, asi
 * que se pueden probar sin navegador y se pueden componer entre ellos. La capa
 * que los pinta decide colores, paneles y escalas.
 *
 * ## Por que a mano y no una libreria
 *
 * Son treinta lineas cada uno y una dependencia nueva hay que justificarla. Lo
 * que no es gratis es la correccion, asi que cada uno lleva test con valores
 * calculados aparte, y los casos que de verdad rompen: serie mas corta que el
 * periodo, periodo de 1, y huecos.
 */

/** Una vela, con lo minimo que necesitan los indicadores. */
export interface Vela {
  readonly t: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

/** Serie alineada con la entrada. `null` donde el indicador aun no existe. */
export type Serie = (number | null)[];

/**
 * Media movil simple.
 *
 * Se calcula con una suma corrediza en vez de resumar la ventana entera en cada
 * paso: con 1000 velas y una SMA de 200 son 1.000 operaciones en vez de 200.000.
 */
export function sma(valores: readonly number[], periodo: number): Serie {
  if (periodo < 1) return new Array<number | null>(valores.length).fill(null);
  const out: Serie = new Array<number | null>(valores.length).fill(null);
  let suma = 0;
  for (let i = 0; i < valores.length; i++) {
    suma += valores[i] ?? 0;
    if (i >= periodo) suma -= valores[i - periodo] ?? 0;
    if (i >= periodo - 1) out[i] = suma / periodo;
  }
  return out;
}

/**
 * Media movil exponencial.
 *
 * Arranca con la SMA del primer periodo, que es la convencion que usan
 * TradingView y casi todo el mundo. Arrancar con el primer cierre a secas deja
 * las primeras decenas de velas desviadas y luego converge, asi que dos
 * graficos del mismo activo no coincidirian al principio.
 */
export function ema(valores: readonly number[], periodo: number): Serie {
  if (periodo < 1 || valores.length < periodo) {
    return new Array<number | null>(valores.length).fill(null);
  }
  const k = 2 / (periodo + 1);
  const out: Serie = new Array<number | null>(valores.length).fill(null);
  let previo = 0;
  for (let i = 0; i < periodo; i++) previo += valores[i] ?? 0;
  previo /= periodo;
  out[periodo - 1] = previo;
  for (let i = periodo; i < valores.length; i++) {
    previo = (valores[i] ?? 0) * k + previo * (1 - k);
    out[i] = previo;
  }
  return out;
}

/**
 * Indice de fuerza relativa, con el suavizado de Wilder.
 *
 * Wilder y no una media simple: es lo que define el indicador y lo que hace que
 * coincida con el de cualquier otra plataforma. Con SMA sale un numero
 * parecido, que es lo peligroso.
 *
 * Sin ninguna bajada en la ventana el RSI es 100 por definicion, no un hueco:
 * la division por cero esta contemplada en el indicador, no es un error.
 */
export function rsi(valores: readonly number[], periodo = 14): Serie {
  const largo = valores.length;
  if (periodo < 1 || largo <= periodo) return new Array<number | null>(largo).fill(null);

  const out: Serie = new Array<number | null>(largo).fill(null);
  let subidas = 0;
  let bajadas = 0;
  for (let i = 1; i <= periodo; i++) {
    const d = (valores[i] ?? 0) - (valores[i - 1] ?? 0);
    if (d >= 0) subidas += d; else bajadas -= d;
  }
  subidas /= periodo;
  bajadas /= periodo;
  out[periodo] = bajadas === 0 ? 100 : 100 - 100 / (1 + subidas / bajadas);

  for (let i = periodo + 1; i < largo; i++) {
    const d = (valores[i] ?? 0) - (valores[i - 1] ?? 0);
    subidas = (subidas * (periodo - 1) + (d > 0 ? d : 0)) / periodo;
    bajadas = (bajadas * (periodo - 1) + (d < 0 ? -d : 0)) / periodo;
    out[i] = bajadas === 0 ? 100 : 100 - 100 / (1 + subidas / bajadas);
  }
  return out;
}

/** MACD: la diferencia de dos EMA, su senal y el histograma. */
export function macd(
  valores: readonly number[],
  rapida = 12,
  lenta = 26,
  senalPeriodo = 9,
): { macd: Serie; senal: Serie; histograma: Serie } {
  const r = ema(valores, rapida);
  const l = ema(valores, lenta);
  const linea: Serie = valores.map((_v, i) => {
    const a = r[i];
    const b = l[i];
    return a === null || a === undefined || b === null || b === undefined ? null : a - b;
  });

  // La senal es una EMA de la linea, que empieza mas tarde que los valores. Se
  // calcula solo sobre el tramo con dato y se vuelve a alinear, porque pasarle
  // los nulls como ceros arrastraria la media hacia abajo durante decenas de
  // velas sin que se note.
  const desde = linea.findIndex((v) => v !== null);
  const senal: Serie = new Array<number | null>(valores.length).fill(null);
  if (desde >= 0) {
    const tramo = linea.slice(desde).map((v) => v ?? 0);
    const s = ema(tramo, senalPeriodo);
    for (let i = 0; i < s.length; i++) senal[desde + i] = s[i] ?? null;
  }

  const histograma: Serie = valores.map((_v, i) => {
    const a = linea[i];
    const b = senal[i];
    return a === null || a === undefined || b === null || b === undefined ? null : a - b;
  });
  return { macd: linea, senal, histograma };
}

/** Bandas de Bollinger: una SMA y dos desviaciones tipicas a cada lado. */
export function bollinger(
  valores: readonly number[],
  periodo = 20,
  desviaciones = 2,
): { media: Serie; alta: Serie; baja: Serie } {
  const media = sma(valores, periodo);
  const alta: Serie = new Array<number | null>(valores.length).fill(null);
  const baja: Serie = new Array<number | null>(valores.length).fill(null);

  for (let i = periodo - 1; i < valores.length; i++) {
    const m = media[i];
    if (m === null || m === undefined) continue;
    let suma = 0;
    for (let j = i - periodo + 1; j <= i; j++) {
      const d = (valores[j] ?? 0) - m;
      suma += d * d;
    }
    // Poblacional, no muestral: la ventana ES la poblacion que se mide, no una
    // muestra de algo mayor. Es lo que hace TradingView.
    const sigma = Math.sqrt(suma / periodo);
    alta[i] = m + sigma * desviaciones;
    baja[i] = m - sigma * desviaciones;
  }
  return { media, alta, baja };
}

/** Rango verdadero medio, con suavizado de Wilder como el RSI. */
export function atr(velas: readonly Vela[], periodo = 14): Serie {
  const largo = velas.length;
  if (periodo < 1 || largo <= periodo) return new Array<number | null>(largo).fill(null);

  const tr: number[] = new Array<number>(largo).fill(0);
  for (let i = 0; i < largo; i++) {
    const v = velas[i];
    if (v === undefined) continue;
    const previo = i === 0 ? undefined : velas[i - 1];
    // La primera vela no tiene cierre anterior, asi que su rango verdadero es
    // el rango a secas. Usar su propio cierre daria siempre el mismo numero.
    tr[i] = previo === undefined
      ? v.high - v.low
      : Math.max(v.high - v.low, Math.abs(v.high - previo.close), Math.abs(v.low - previo.close));
  }

  const out: Serie = new Array<number | null>(largo).fill(null);
  let previo = 0;
  for (let i = 1; i <= periodo; i++) previo += tr[i] ?? 0;
  previo /= periodo;
  out[periodo] = previo;
  for (let i = periodo + 1; i < largo; i++) {
    previo = (previo * (periodo - 1) + (tr[i] ?? 0)) / periodo;
    out[i] = previo;
  }
  return out;
}

/**
 * Precio medio ponderado por volumen, acumulado desde el principio de la serie.
 *
 * OJO con lo que significa aqui. El VWAP de un intradia se reinicia cada
 * sesion, y un perpetuo no tiene sesion: cotiza sin parar. Asi que esto acumula
 * desde la primera vela que se este mirando, y por tanto **depende del rango
 * elegido**: con 500 velas de 1h no da lo mismo que con 500 de 1d. Se dice
 * aqui porque es la clase de numero que parece absoluto y no lo es.
 */
export function vwap(velas: readonly Vela[]): Serie {
  const out: Serie = new Array<number | null>(velas.length).fill(null);
  let pv = 0;
  let vol = 0;
  for (let i = 0; i < velas.length; i++) {
    const v = velas[i];
    if (v === undefined) continue;
    const tipico = (v.high + v.low + v.close) / 3;
    pv += tipico * v.volume;
    vol += v.volume;
    // Sin volumen acumulado no hay media ponderada. Pasa en mercados recien
    // listados y en velas vacias: es un hueco, no un cero.
    out[i] = vol > 0 ? pv / vol : null;
  }
  return out;
}
