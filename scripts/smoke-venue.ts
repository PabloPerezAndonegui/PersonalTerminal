/**
 * Verifica los adaptadores contra las APIs REALES.
 *
 * Un adaptador no se da por bueno con mocks: el mock lo escribe quien escribio
 * el parser, asi que solo demuestra que el codigo hace lo que el codigo dice.
 * Aqui se comprueban seis cosas que los tests unitarios no pueden ver:
 *
 *   1. Que la API responde y el parseo aguanta su forma actual.
 *   2. Que la cobertura de simbolos es la esperada, y que ningun simbolo pisa
 *      a otro al normalizar.
 *   3. Que el INTERVALO de funding es correcto. Este es el error caro: si un
 *      venue denomina su funding a 8 horas y lo tratamos como horario, su APR
 *      sale multiplicado por 8 y el scanner ve una oportunidad enorme donde no
 *      hay nada. Se comprueba por dos vias: MIDIENDO el tiempo real entre
 *      liquidaciones en el historico del venue, que es exacto, y comparando el
 *      mismo activo entre venues para los que no publican historico discreto.
 *   4. Que las COMISIONES declaradas coincidan con las que publica el venue,
 *      donde las publica. Entran directas en el APR neto y, a diferencia del
 *      funding, un numero desfasado no se ve raro al mirarlo: aqui habia un
 *      taker de 3.0 bps en Paradex cuando su API dice 2.0.
 *   5. Que la LECTURA DE POSICIONES devuelve algo coherente, contra cuentas
 *      publicas reales. Un multiplicador olvidado no rompe nada: sale un
 *      numero, y es mentira. Comprobado que salta — al quitarle el
 *      multiplicador al precio de entrada de Hyperliquid, PEPE aparece a
 *      999.1x su mid.
 *   6. Que la PROFUNDIDAD real del libro da un coste de ejecucion sensato.
 *
 * Cada comprobacion se ha probado rompiendo un adaptador a proposito. Un
 * detector que nunca se ha visto saltar no es un detector, es un adorno.
 *
 * Uso:  npm run smoke            (todos)
 *       npm run smoke -- dydx    (uno)
 */
import { fundingAprPct, buyCost } from '@defi/core';
import { REGISTRY, allVenueIds, activeVenueIds, createAdapters } from '@defi/venues';

const pedidos = process.argv.slice(2);
// Por defecto se verifican los ACTIVOS. Los demas siguen en el registro y se
// pueden pedir por nombre: `npm run smoke -- dydx`.
const ids = pedidos.length > 0 ? pedidos : activeVenueIds();
const desconocidos = ids.filter((id) => !REGISTRY.has(id));
if (desconocidos.length > 0) {
  console.error(`venues desconocidos: ${desconocidos.join(', ')}`);
  console.error(`disponibles: ${allVenueIds().join(', ')}`);
  process.exit(1);
}

/**
 * Simbolos con los que se sondea el intervalo. Hacen falta VARIOS: un
 * intervalo mal declarado desplaza a TODOS los simbolos de ese venue por el
 * mismo factor, mientras que una divergencia de mercado afecta a uno y no al
 * resto. Es lo unico que distingue un error real de la diferencia legitima que
 * esta app existe para explotar.
 */
const SONDAS = ['BTC', 'ETH', 'SOL'] as const;

/** Lo que QFEX declara liquidar. Se contrasta contra su propia anualizada. */
const QFEX_HORAS = 1;

const adapters = createAdapters(ids);
const resultados: {
  venue: string;
  simbolos: number;
  ms: number;
  intervalo: number;
  btcAprPct: number | null;
  /** APR por simbolo de sonda. null = ese venue no lo lista. */
  aprs: Map<string, number>;
  error: string | null;
}[] = [];

for (const adapter of adapters) {
  const t0 = Date.now();
  try {
    await adapter.refresh();
    const snap = adapter.snapshot();
    const btc = snap.get('BTC');
    const aprs = new Map<string, number>();
    for (const sonda of SONDAS) {
      const m = snap.get(sonda);
      if (m !== undefined) aprs.set(sonda, fundingAprPct(m.funding));
    }
    resultados.push({
      venue: adapter.meta.id,
      simbolos: snap.size,
      ms: Date.now() - t0,
      intervalo: adapter.meta.fundingIntervalHours,
      btcAprPct: btc ? fundingAprPct(btc.funding) : null,
      aprs,
      error: null,
    });
  } catch (err) {
    resultados.push({
      venue: adapter.meta.id,
      simbolos: 0,
      ms: Date.now() - t0,
      intervalo: adapter.meta.fundingIntervalHours,
      btcAprPct: null,
      aprs: new Map(),
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

console.log('\nVENUE          SIMBOLOS   MS   INTERVALO   BTC FUNDING APR');
console.log('-'.repeat(62));
for (const r of resultados) {
  if (r.error !== null) {
    console.log(`${r.venue.padEnd(14)} FALLO: ${r.error}`);
    continue;
  }
  const apr = r.btcAprPct === null ? '—' : `${r.btcAprPct >= 0 ? '+' : ''}${r.btcAprPct.toFixed(2)}%`;
  console.log(
    `${r.venue.padEnd(14)} ${String(r.simbolos).padStart(6)} ${String(r.ms).padStart(5)}` +
      `      ${String(r.intervalo).padStart(2)}h   ${apr.padStart(10)}`,
  );
}

// --- Intervalo MEDIDO en el historico de funding -----------------------------
//
// Lo de abajo compara venues entre si, que es una aproximacion: necesita una
// desviacion grande para no confundir un error con la divergencia normal del
// mercado. Esto de aqui no aproxima nada — mide cuanto tiempo pasa de verdad
// entre dos liquidaciones consecutivas de funding, que es lo que la constante
// dice. Si un venue liquida cada 8 h y lo tratamos como horario, aqui salta
// aunque su funding sea identico al de los demas.
//
// Paradex no aparece: publica un indice continuo, con muestras cada pocos
// segundos, en vez de liquidaciones discretas. A cambio declara
// `funding_period_hours` en cada mercado y el adaptador lo lee de ahi, que es
// mejor que medirlo.

/** Momentos de las ultimas liquidaciones de funding de BTC, en ms. */
async function liquidacionesDeFunding(venue: string): Promise<number[]> {
  try {
    if (venue === 'hyperliquid') {
      const r = await fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'fundingHistory', coin: 'BTC', startTime: Date.now() - 12 * 3_600_000 }),
      });
      const d = (await r.json()) as { time?: number }[];
      return d.map((x) => x.time ?? NaN);
    }
    if (venue === 'pacifica') {
      const r = await fetch('https://api.pacifica.fi/api/v1/funding_rate/history?symbol=BTC');
      const d = (await r.json()) as { data?: { created_at?: number }[] };
      return (d.data ?? []).slice(0, 12).map((x) => x.created_at ?? NaN);
    }
    if (venue === 'dydx') {
      const r = await fetch('https://indexer.dydx.trade/v4/historicalFunding/BTC-USD?limit=12');
      const d = (await r.json()) as { historicalFunding?: { effectiveAt?: string }[] };
      return (d.historicalFunding ?? []).map((x) => Date.parse(x.effectiveAt ?? ''));
    }
    if (venue === 'backpack') {
      const r = await fetch('https://api.backpack.exchange/api/v1/fundingRates?symbol=BTC_USDC_PERP&limit=12');
      const d = (await r.json()) as { intervalEndTimestamp?: string }[];
      // Sin zona horaria, pero solo se usan diferencias: da igual mientras sea
      // la misma para todas las entradas.
      return d.map((x) => Date.parse(x.intervalEndTimestamp ?? ''));
    }
  } catch {
    return [];
  }
  return [];
}

// --- Que representa el funding que leemos ------------------------------------
//
// Mezclar una estimacion con un pago ya realizado hace inservible cualquier
// analisis: se comparan dos cosas distintas creyendo que son la misma. Cada
// adaptador DECLARA que lee (`kind`, `sourceField`); aqui se contrasta esa
// declaracion con la realidad, comparando el valor del snapshot contra la
// ultima liquidacion del historico del propio venue.
//
// Lo que se vigila es que un venue no cambie el significado de su campo sin
// que nos enteremos: si algo declarado `current` pasa a coincidir siempre con
// lo liquidado, o al reves, hay que volver a mirarlo.

console.log('\n--- Que es el funding que leemos ---');

for (const adapter of adapters) {
  const btc = adapter.snapshot().get('BTC');
  if (btc === undefined) continue;

  const f = btc.funding;
  const horario = f.intervalHours > 0 ? f.rate / f.intervalHours : 0;
  const liquidado = await ultimaLiquidacion(adapter.meta.id);
  const coincide = liquidado === null ? null : Math.abs(horario - liquidado / f.intervalHours) < 1e-15;

  const sello = btc.sourceAt === null
    ? 'la fuente no sella'
    : `sellado hace ${Math.round((Date.now() - btc.sourceAt) / 1000)} s`;

  console.log(
    `${adapter.meta.id.padEnd(14)} ${f.kind.padEnd(10)} ${horario.toExponential(3).padStart(11)}/h  |  ` +
      `liquidado ${liquidado === null ? '—' : (liquidado / f.intervalHours).toExponential(3)}  ` +
      `${coincide === null ? '' : coincide ? '(coinciden)' : '(distintos)'}  |  ${sello}`,
  );
  console.log(`${' '.repeat(14)} de: ${f.sourceField}`);

  // Un venue que declara publicar la tasa del proximo periodo y resulta dar
  // exactamente la ultima liquidada esta declarando mal lo que hace.
  //
  // Con las DOS a cero no se concluye nada: cero coincide con cero siempre, y
  // avisar ahi era acusar a dYdX de declarar mal su funding cada vez que BTC
  // pasaba por una hora plana. Un detector que salta sin motivo deja de
  // mirarse, que es peor que no tenerlo.
  const ambasCero = horario === 0 && (liquidado === null || liquidado === 0);
  if (f.kind === 'predicted' && coincide === true && !ambasCero) {
    console.log(`${' '.repeat(14)} REVISAR: se declara 'predicted' pero coincide con lo ya liquidado`);
    process.exitCode = 1;
  }
}

/** Ultima tasa LIQUIDADA segun el historico del venue, en su propia ventana. */
async function ultimaLiquidacion(venue: string): Promise<number | null> {
  try {
    if (venue === 'hyperliquid') {
      const r = await fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'fundingHistory', coin: 'BTC', startTime: Date.now() - 6 * 3_600_000 }),
      });
      const d = (await r.json()) as { fundingRate?: string }[];
      const u = d.at(-1);
      return u === undefined ? null : Number(u.fundingRate);
    }
    if (venue === 'pacifica') {
      const r = await fetch('https://api.pacifica.fi/api/v1/funding_rate/history?symbol=BTC');
      const d = (await r.json()) as { data?: { funding_rate?: string }[] };
      const u = d.data?.[0];
      return u === undefined ? null : Number(u.funding_rate);
    }
    if (venue === 'backpack') {
      const r = await fetch('https://api.backpack.exchange/api/v1/fundingRates?symbol=BTC_USDC_PERP&limit=1');
      const d = (await r.json()) as { fundingRate?: string }[];
      const u = d[0];
      return u === undefined ? null : Number(u.fundingRate);
    }
    if (venue === 'dydx') {
      const r = await fetch('https://indexer.dydx.trade/v4/historicalFunding/BTC-USD?limit=1');
      const d = (await r.json()) as { historicalFunding?: { rate?: string }[] };
      const u = d.historicalFunding?.[0];
      return u === undefined ? null : Number(u.rate);
    }
  } catch {
    return null;
  }
  // Paradex publica un indice continuo, no liquidaciones discretas.
  return null;
}

console.log('\n--- Intervalo de funding: medido contra el que usamos ---');

for (const adapter of adapters) {
  const id = adapter.meta.id;
  const usado = adapter.snapshot().get('BTC')?.funding.intervalHours ?? null;

  const momentos = (await liquidacionesDeFunding(id)).filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
  if (momentos.length < 3 || usado === null) {
    console.log(`${id.padEnd(14)} usamos ${usado ?? '—'}h — sin liquidaciones discretas que medir`);
    continue;
  }

  // Mediana de los huecos: un reinicio o un hueco suelto no desplaza el juicio.
  const huecos = momentos.slice(1).map((t, i) => (t - (momentos[i] ?? 0)) / 3_600_000).sort((a, b) => a - b);
  const medido = huecos[Math.floor(huecos.length / 2)] ?? 0;

  const descuadra = Math.abs(medido - usado) / usado > 0.05;
  console.log(
    `${id.padEnd(14)} usamos ${usado}h  |  medido ${medido.toFixed(2)}h ` +
      `(${momentos.length} liquidaciones)${descuadra ? '  DESCUADRA' : '  OK'}`,
  );
  if (descuadra) process.exitCode = 1;
}

// --- Comprobacion del intervalo declarado -----------------------------------
//
// El error caro: si un venue denomina su funding a 8 h y lo tratamos como
// horario, su APR sale x8 y el scanner ve una oportunidad enorme donde no hay
// nada.
//
// Se detecta comparando cada venue con la mediana del resto, pero **en varios
// simbolos a la vez**. Esa es la clave: un intervalo mal declarado desplaza
// todos los simbolos del venue por el MISMO factor, porque el error es
// exactamente el cociente entre el intervalo real y el declarado. Una
// divergencia de mercado no: mueve un simbolo y deja los demas donde estaban.
//
// La version anterior miraba solo BTC y marcaba a cualquiera que se desviase,
// con una tolerancia del 25 % alrededor de 2x — o sea, cualquier ratio entre
// 0.375 y 0.625. Ahi cae la diferencia normal entre dos venues, y marco a dydx
// primero y a hyperliquid despues sin que ninguno tuviese nada mal. Un detector
// que da la alarma con datos correctos acaba ignorado, que es peor que no
// tenerlo.

/** Factores que produce un intervalo mal declarado (1h/4h/8h/12h/24h). */
const FACTORES_DE_INTERVALO = [2, 3, 4, 6, 8, 12, 24];

/**
 * Intervalos de funding que existen de verdad, en horas.
 *
 * Sirven de ultimo filtro: una desviacion solo acusa al intervalo si el
 * intervalo que la explicaria es uno que alguien usaria. Sin esto, perpl salia
 * marcado con un 3.16x — su funding se despega porque mueve 2 M USD al dia, no
 * porque el intervalo este mal. El intervalo que haria falta para explicarlo
 * seria 0.7167 x 3 = 2.15 h, que no lo liquida nadie; el suyo esta MEDIDO
 * contra su propia cadena y contra la cuenta atras de su web.
 */
const INTERVALOS_PLAUSIBLES = [0.25, 0.5, 2580 / 3600, 1, 2, 4, 6, 8, 12, 24];

/** Si el candidato se acerca a un intervalo real. 3 % de margen. */
const esIntervaloPlausible = (h: number): boolean =>
  INTERVALOS_PLAUSIBLES.some((p) => Math.abs(h - p) / p < 0.03);

/**
 * El mercado tiene que estar dando funding para poder juzgar nada. Se exige
 * sobre la MEDIANA, no sobre el valor del venue: un venue con el intervalo
 * sobredeclarado tiene todos sus APR encogidos, y filtrar por su propio valor
 * descartaria justo los simbolos que delatan el error. Con el umbral puesto en
 * el venue, un 8x real en pacifica pasaba entero sin que saltase nada.
 */
const APR_MINIMO = 1;

/**
 * Desviacion minima para dar la alarma. El funding legitimo difiere entre
 * venues —es la premisa de esta app— pero no en un orden de magnitud. Por
 * debajo de 3x no se distingue un error de la diferencia normal, asi que no se
 * intenta: mas vale no detectar un 2x que dar la alarma con datos correctos.
 */
const DESVIACION_MINIMA = 3;

/** Mediana de |APR| de un simbolo entre los venues que lo listan. */
function medianaDe(simbolo: string): number | null {
  const vals = resultados
    .map((r) => r.aprs.get(simbolo))
    .filter((v): v is number => v !== undefined)
    .map(Math.abs)
    .sort((a, b) => a - b);
  if (vals.length < 3) return null;
  return vals[Math.floor(vals.length / 2)] ?? null;
}

const medianas = new Map<string, number>();
for (const sonda of SONDAS) {
  const m = medianaDe(sonda);
  if (m !== null && m >= APR_MINIMO) medianas.set(sonda, m);
}

if (medianas.size === 0) {
  console.log('\nFunding demasiado plano para juzgar los intervalos en este momento.');
} else {
  console.log(
    '\nMediana |APR| — ' +
      [...medianas].map(([s, m]) => `${s}: ${m.toFixed(2)}%`).join('  |  '),
  );

  const sospechosos: {
    venue: string;
    intervalo: number;
    factor: number;
    candidato: number;
    dispersion: number;
    ratios: string;
  }[] = [];

  for (const r of resultados) {
    if (r.error !== null) continue;

    const ratios: { simbolo: string; ratio: number }[] = [];
    for (const [simbolo, mediana] of medianas) {
      const apr = r.aprs.get(simbolo);
      if (apr === undefined) continue;
      // Un cero exacto no lo produce ningun intervalo: dividir un funding no
      // nulo por 8 nunca da 0. Es un venue sin prima, como dydx en la mayoria
      // de sus mercados, y meterlo arrastraria la media a cero.
      if (apr === 0) continue;
      ratios.push({ simbolo, ratio: Math.abs(apr) / mediana });
    }

    // Con un solo simbolo no se puede distinguir un error de una divergencia.
    if (ratios.length < 2) continue;

    // Media geometrica: los ratios son multiplicativos, y asi 2x y 0.5x pesan
    // lo mismo en vez de que el grande arrastre la media.
    const media = Math.exp(
      ratios.reduce((acc, x) => acc + Math.log(x.ratio), 0) / ratios.length,
    );

    // Desviacion grande, y en la MISMA direccion en todas las sondas. Lo
    // segundo es lo que separa un intervalo mal declarado (empuja todo el
    // venue hacia el mismo lado) de la divergencia de mercado (mueve un
    // simbolo y deja los otros donde estaban).
    const alza = media > 1;
    if (alza ? media < DESVIACION_MINIMA : media > 1 / DESVIACION_MINIMA) continue;
    const mismaDireccion = ratios.every((x) => (alza ? x.ratio > 1.5 : x.ratio < 1 / 1.5));
    if (!mismaDireccion) continue;

    // Y explicable por un intervalo. Un venue sin apenas prima se desvia
    // muchisimo pero de forma arbitraria: 0.001x no lo produce ningun
    // cociente de horas, y si no encaja con ninguno, no es esto.
    // Y explicable por un cociente de horas, quedandose con el que MEJOR lo
    // explica y no con el primero que entra dentro del margen. Buscando "el
    // primero" el detector se rompio solo: con hyperliquid declarado a 8 h
    // adrede, la desviacion de 0.125x la atribuia a un factor 6 antes de
    // llegar al 8, y el intervalo candidato salia 1.33 h en vez de 1 h.
    let mejor: { k: number; err: number; alza: boolean } | null = null;
    for (const k of FACTORES_DE_INTERVALO) {
      for (const arriba of [true, false]) {
        const esperado = arriba ? k : 1 / k;
        // El error se mide en logaritmo: los factores son multiplicativos, y
        // asi 8x y 1/8x se juzgan con la misma vara.
        const err = Math.abs(Math.log(media / esperado));
        if (mejor === null || err < mejor.err) mejor = { k, err, alza: arriba };
      }
    }
    // Un venue casi sin prima se desvia muchisimo pero de forma arbitraria:
    // 0.001x no lo produce ningun cociente de horas.
    if (mejor === null || mejor.err > Math.log(1.4)) continue;

    // Ultimo filtro: el intervalo que haria falta para explicar la desviacion
    // tiene que ser uno que alguien liquide de verdad. ratio = APR nuestro /
    // APR real = intervalo real / intervalo declarado, asi que el candidato es
    // el declarado multiplicado por el factor.
    const candidato = mejor.alza ? r.intervalo * mejor.k : r.intervalo / mejor.k;
    if (!esIntervaloPlausible(candidato)) continue;

    // Se informa de lo dispersos que estan los ratios entre si porque es la
    // firma que distingue las dos causas: un intervalo mal declarado desplaza
    // todas las sondas por el MISMO factor, asi que su dispersion es ~1x,
    // mientras que el mercado mueve cada simbolo por su cuenta.
    const orden = ratios.map((x) => x.ratio).sort((a, b) => a - b);
    const menor = orden[0] ?? 1;
    const mayor = orden[orden.length - 1] ?? 1;

    sospechosos.push({
      venue: r.venue,
      intervalo: r.intervalo,
      factor: media,
      candidato,
      dispersion: menor === 0 ? Infinity : mayor / menor,
      ratios: ratios.map((x) => `${x.simbolo} ${x.ratio.toFixed(2)}x`).join(', '),
    });
  }

  if (sospechosos.length === 0) {
    console.log('Todos los intervalos de funding son coherentes entre si.');
  } else {
    console.log('\nINTERVALO SOSPECHOSO — revisar fundingIntervalHours:');
    for (const s of sospechosos) {
      console.log(
        `  ${s.venue}: ${s.factor.toFixed(2)}x la mediana en TODAS las sondas ` +
          `(declarado ${s.intervalo}h, cuadraria con ${s.candidato.toFixed(4)}h) — ${s.ratios}`,
      );
      console.log(
        `    dispersion entre sondas ${s.dispersion.toFixed(2)}x` +
          (s.dispersion > 1.5
            ? ' — dispersas: un intervalo mal declarado las desplazaria por igual, mirar el mercado antes'
            : ' — parejas, la firma de un intervalo mal declarado'),
      );
    }

    // Solo falla cuando las sondas van PAREJAS, que es la firma de un intervalo
    // mal declarado: el factor se aplica a todos los simbolos del venue por
    // igual. Si van dispersas, lo que hay es divergencia de mercado y fallar
    // seria gritar por algo que el propio aviso acaba de descartar.
    //
    // El caso que lo motivo: el 9 de octubre de 2026 Aster salia a 0,12x la
    // mediana, que habria cuadrado con 1h en vez de las 8h declaradas, pero con
    // las sondas a 10,14x de dispersion (BTC 0,22x, ETH 0,28x, SOL 0,03x).
    // Medido despues contra su propio historico de liquidaciones, `fundingRate`
    // de los tres simbolos daba ONCE huecos seguidos de 8,000 h exactas. Las 8h
    // eran correctas y lo que pasaba es que su funding estaba plano ese dia.
    const parejas = sospechosos.filter((x) => x.dispersion <= 1.5);
    if (parejas.length > 0) process.exitCode = 1;
  }
}

// --- Plausibilidad de volumen e interes abierto ------------------------------
// Los agregados mezclan convenciones: unos dan volumen en USD y otros en
// unidades del subyacente, y a veces AMBAS en el mismo objeto (Paradex da
// open_interest en base y volume_24h en USD). Multiplicar por el precio cuando
// no tocaba inflaba el volumen de BTC de Paradex a 290.000 millones diarios:
// mas que todo el mercado cripto, y equivalente al 17 % de los bitcoins que
// existen. Un techo absoluto lo caza al instante; comparar entre venues no
// serviria, porque entre ellos ya hay diferencias legitimas de 700x.
const TECHO_VOLUMEN_USD = 100e9;
const TECHO_OI_USD = 100e9;

const sospechosos: string[] = [];
for (const adapter of adapters) {
  const btc = adapter.snapshot().get('BTC');
  if (btc === undefined) continue;
  if (btc.volume24hUsd !== null && btc.volume24hUsd > TECHO_VOLUMEN_USD) {
    sospechosos.push(
      `${adapter.meta.id}: volumen 24h de BTC = $${(btc.volume24hUsd / 1e9).toFixed(0)}B`,
    );
  }
  if (btc.openInterestUsd !== null && btc.openInterestUsd > TECHO_OI_USD) {
    sospechosos.push(
      `${adapter.meta.id}: interes abierto de BTC = $${(btc.openInterestUsd / 1e9).toFixed(0)}B`,
    );
  }
}
if (sospechosos.length > 0) {
  console.log('\nMAGNITUD IMPOSIBLE — probable error de unidades (base contra USD):');
  for (const s of sospechosos) console.log(`  ${s}`);
  process.exitCode = 1;
}

// --- QFEX: una foto del socket, que es su unica fuente -----------------------
//
// No tiene REST de mercado, asi que para contrastarlo hay que abrir su canal
// publico igual que hace el adaptador. Se pide una sola vez y se reparte entre
// las comprobaciones que la necesiten.

interface FotoQfex {
  readonly marks: number;
  readonly fundings: number;
  /** Tasas distintas de cero, con su anualizada, para deducir el intervalo. */
  readonly noCero: { symbol: string; rate: number; anual: number }[];
}

let fotoCache: Promise<FotoQfex | null> | null = null;

function fotoQfex(): Promise<FotoQfex | null> {
  if (fotoCache !== null) return fotoCache;
  fotoCache = new Promise<FotoQfex | null>((resolve) => {
    const ws = new WebSocket('wss://mds.qfex.com');
    const salir = (v: FotoQfex | null) => {
      try { ws.close(); } catch { /* ya cerrado */ }
      resolve(v);
    };
    const reloj = setTimeout(() => salir(null), 20_000);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'subscribe', channels: ['market_stats'], symbols: ['*'] }));
    ws.onerror = () => { clearTimeout(reloj); salir(null); };
    ws.onmessage = (e) => {
      let d: unknown;
      try { d = JSON.parse(String(e.data)); } catch { return; }
      if (typeof d !== 'object' || d === null) return;
      const m = d as {
        mark_prices?: unknown[];
        funding_rates?: { symbol?: string; funding_rate?: string; annualised_funding_rate?: string }[];
      };
      if (!Array.isArray(m.mark_prices) || !Array.isArray(m.funding_rates)) return;
      clearTimeout(reloj);
      salir({
        marks: m.mark_prices.length,
        fundings: m.funding_rates.length,
        noCero: m.funding_rates
          .map((f) => ({
            symbol: f.symbol ?? '',
            rate: Number(f.funding_rate),
            anual: Number(f.annualised_funding_rate),
          }))
          .filter((f) => Number.isFinite(f.rate) && f.rate !== 0 && Number.isFinite(f.anual)),
      });
    };
  });
  return fotoCache;
}

// --- QFEX: su intervalo, deducido de su propia tasa anualizada ---------------
//
// QFEX publica la tasa del periodo Y la anualizada. El cociente entre las dos
// son los periodos que tiene un ano, asi que 8760 significa que el periodo es
// una hora. Es la unica forma de comprobar su escala sin esperar a ver un
// cobro, y no depende de compararlo con otros venues.
//
// El 20 de septiembre de 2026 las 188 tasas valian exactamente cero, que es lo
// que cabe esperar un domingo con la bolsa americana cerrada, y con ceros no se
// puede dividir. Mientras siga asi, lo dice en vez de callarse.

if (ids.includes('qfex')) {
  const foto = await fotoQfex();
  console.log('\n--- QFEX: intervalo deducido de su anualizada ---');
  if (foto === null) {
    console.log('no se pudo abrir el canal market_stats');
  } else if (foto.noCero.length === 0) {
    console.log(`las ${foto.fundings} tasas estan a cero: la escala sigue SIN COMPROBAR`);
  } else {
    // ANTES de creerse el resultado hay que mirar si los mercados COINCIDEN
    // entre ellos.
    //
    // Un intervalo es una propiedad del venue, asi que todos sus mercados
    // tienen que dar el mismo. Medido el 9 de octubre de 2026, los de QFEX
    // daban entre 3.160 y 7.960 periodos por ano, o sea entre 1,1 y 2,8 horas,
    // dentro del mismo venue y en la misma foto. Eso no es un intervalo.
    //
    // La causa es que `funding_rate` viene cuantizado: casi todas las tasas
    // caen en el escalon minimo de 1e-5, asi que dividir la anualizada, que si
    // varia, entre una tasa redondeada mide el redondeo. Con tasas de 1e-5 el
    // error relativo llega al 100 %.
    //
    // Asi que cuando los mercados no se ponen de acuerdo, esto NO concluye y lo
    // dice. Dar 'NO CUADRA' seria acusar al adaptador de un fallo que no tiene.
    // El intervalo de QFEX esta verificado por otra via, que es su
    // `time_remaining`: ninguna de sus 221 cuentas atras pasa de 57,6 minutos,
    // asi que el intervalo es de una hora. Esta escrito en su adaptador.
    const periodos = foto.noCero.map((f) => f.anual / f.rate).sort((a, b) => a - b);
    const menor = periodos[0] ?? 0;
    const mayor = periodos[periodos.length - 1] ?? 0;
    const dispersion = menor > 0 ? mayor / menor : Infinity;
    const escalon = Math.min(...foto.noCero.map((f) => Math.abs(f.rate)));

    if (dispersion > 1.3) {
      console.log(
        `${foto.noCero.length} tasas distintas de cero, pero sus mercados NO coinciden: `
        + `de ${menor.toFixed(0)} a ${mayor.toFixed(0)} periodos por ano `
        + `(${(8760 / mayor).toFixed(2)} h a ${(8760 / menor).toFixed(2)} h). `
        + `La tasa viene cuantizada al escalon ${escalon}, asi que su anualizada NO sirve `
        + 'para deducir el intervalo. No concluye: el intervalo se verifica por `time_remaining`.',
      );
    } else {
      const mediana = periodos[Math.floor(periodos.length / 2)] ?? 0;
      const horas = mediana === 0 ? 0 : 8760 / mediana;
      const ok = Math.abs(horas - QFEX_HORAS) / QFEX_HORAS < 0.02;
      console.log(
        `${foto.noCero.length} tasas distintas de cero | anual/tasa = ${mediana.toFixed(0)} periodos por ano -> ` +
          `${horas.toFixed(3)} h por periodo | declarado ${QFEX_HORAS} h  ${ok ? 'OK' : 'NO CUADRA'}`,
      );
      if (!ok) process.exitCode = 1;
    }
  }
}

// --- Cobertura: de lo que devuelve la API en crudo a lo que publicamos -------
//
// La regla del proyecto es que si el numero de simbolos baja respecto al crudo,
// hay que EXPLICAR la diferencia. Esto la comprueba con numeros, no de memoria:
// cuenta las filas de la API, resta los descartes uno a uno y exige que el
// resultado sea exactamente lo que tiene el adaptador.
//
// No es redundante con el propio adaptador aunque repita sus reglas: aqui se
// cuentan contra la API en crudo, asi que si el venue cambia algo — un estado
// nuevo, un campo que se vacia — la resta deja de cuadrar y sale por pantalla.
// Lo que se dio por bueno "porque el numero parecia razonable" fue Perpl con 6
// mercados: tenia 8, y los dos que faltaban eran BTC y MON, los de mas volumen.

interface Descarte {
  readonly motivo: string;
  readonly n: number;
}

interface Cobertura {
  readonly fuente: string;
  readonly crudo: number;
  readonly descartes: Descarte[];
}

async function coberturaDe(venue: string): Promise<Cobertura | null> {
  if (venue === 'phoenix') {
    const d = await fetch('https://perp-api.phoenix.trade/v1/view/markets', { signal: AbortSignal.timeout(15000) }).then(r => r.json()) as { markets: { marketStatus: string }[] };
    return { fuente: 'view/markets', crudo: d.markets.length, descartes: [{ motivo: 'no activos', n: d.markets.filter(m => m.marketStatus !== 'active').length }] };
  }
  if (venue === 'hyperliquid') {
    const r = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
    });
    const d = (await r.json()) as [{ universe?: { isDelisted?: boolean }[] }, unknown[]];
    const universe = d[0]?.universe ?? [];
    return {
      fuente: 'info:metaAndAssetCtxs -> universe',
      crudo: universe.length,
      descartes: [{ motivo: 'isDelisted', n: universe.filter((a) => a.isDelisted === true).length }],
    };
  }

  if (venue === 'variational') {
    const d = (await fetch(
      'https://omni-client-api.prod.ap-northeast-1.variational.io/metadata/stats',
    ).then((x) => x.json())) as { listings?: { mark_price?: unknown; funding_rate?: unknown }[] };
    const listings = d.listings ?? [];
    const sinDatos = listings.filter(
      (l) => !Number.isFinite(Number(l.mark_price)) || !Number.isFinite(Number(l.funding_rate)),
    ).length;
    return {
      fuente: 'metadata/stats -> listings',
      crudo: listings.length,
      descartes: [{ motivo: 'sin precio o sin funding', n: sinDatos }],
    };
  }

  if (venue === 'aster') {
    const [prem, info] = (await Promise.all([
      fetch('https://fapi.asterdex.com/fapi/v1/premiumIndex').then((x) => x.json()),
      fetch('https://fapi.asterdex.com/fapi/v1/exchangeInfo').then((x) => x.json()),
    ])) as [{ symbol?: string }[], { symbols?: { symbol?: string; status?: string; baseAsset?: string; quoteAsset?: string }[] }];

    const porNombre = new Map((info.symbols ?? []).map((s) => [s.symbol ?? '', s]));
    let retirados = 0;
    let noOperables = 0;
    const vivos: { base: string; quote: string }[] = [];
    for (const row of prem) {
      const s = porNombre.get(row.symbol ?? '');
      if (s === undefined) retirados++;
      else if (s.status !== 'TRADING') noOperables++;
      else vivos.push({ base: s.baseAsset ?? '', quote: s.quoteAsset ?? '' });
    }
    // Un activo con varios mercados vivos deja uno: el de la moneda preferida.
    const bases = new Set(vivos.map((v) => v.base));
    return {
      fuente: 'premiumIndex + exchangeInfo',
      crudo: prem.length,
      descartes: [
        { motivo: 'ya no estan en exchangeInfo', n: retirados },
        { motivo: 'status distinto de TRADING', n: noOperables },
        { motivo: 'misma base en otra moneda', n: vivos.length - bases.size },
      ],
    };
  }

  if (venue === 'pacifica') {
    const d = (await fetch('https://api.pacifica.fi/api/v1/info/prices').then((x) => x.json())) as {
      data?: { symbol?: string }[];
    };
    const filas = d.data ?? [];
    return {
      fuente: 'info/prices',
      crudo: filas.length,
      // El guion en el nombre es lo que separa el SPOT del perpetuo: mezcla
      // los dos en la misma lista sin ningun campo que los distinga.
      descartes: [{ motivo: 'mercados de SPOT', n: filas.filter((m) => (m.symbol ?? '').includes('-')).length }],
    };
  }

  if (venue === 'backpack') {
    // Se cuenta desde /markPrices, que es de donde LEE el adaptador, no desde
    // /markets. La diferencia importa: /markets lista 103 perpetuos y
    // /markPrices publica 92, porque Backpack deja de publicar la marca de los
    // que tienen el libro cerrado. O sea que esos 11 los descarta el propio
    // venue, no nosotros, y contarlos aqui daba un descuadre de uno.
    const filas = (await fetch('https://api.backpack.exchange/api/v1/markPrices').then((x) =>
      x.json(),
    )) as { symbol?: string; markPrice?: string; fundingRate?: string }[];
    const perps = filas.filter((m) => (m.symbol ?? '').endsWith('_PERP'));
    const sinDatos = perps.filter(
      (m) => !Number.isFinite(Number(m.markPrice)) || !Number.isFinite(Number(m.fundingRate)),
    ).length;
    return {
      fuente: 'api/v1/markPrices',
      crudo: filas.length,
      descartes: [
        { motivo: 'no son perpetuos', n: filas.length - perps.length },
        { motivo: 'sin marca o sin funding', n: sinDatos },
      ],
    };
  }

  if (venue === 'paradex') {
    const d = (await fetch('https://api.prod.paradex.trade/v1/markets/summary?market=ALL').then((x) =>
      x.json(),
    )) as { results?: { symbol?: string }[] };
    const filas = d.results ?? [];
    return {
      fuente: 'markets/summary',
      crudo: filas.length,
      // Lista opciones y spot en la misma respuesta que los perpetuos.
      descartes: [
        { motivo: 'opciones y spot', n: filas.filter((m) => !(m.symbol ?? '').endsWith('-PERP')).length },
      ],
    };
  }

  if (venue === 'dydx') {
    const d = (await fetch('https://indexer.dydx.trade/v4/perpetualMarkets').then((x) => x.json())) as {
      markets?: Record<string, { status?: string }>;
    };
    const filas = Object.values(d.markets ?? {});
    return {
      fuente: 'v4/perpetualMarkets',
      crudo: filas.length,
      descartes: [
        { motivo: 'status distinto de ACTIVE', n: filas.filter((m) => m.status !== 'ACTIVE').length },
      ],
    };
  }

  if (venue === 'qfex') {
    // Se cuenta desde el mismo sitio del que lee el adaptador: publica precio
    // de 219 mercados y funding de 188, y sin funding no se publica ninguno.
    const foto = await fotoQfex();
    if (foto === null) return null;
    return {
      fuente: 'mds market_stats',
      crudo: foto.marks,
      descartes: [{ motivo: 'sin funding publicado', n: foto.marks - foto.fundings }],
    };
  }

  if (venue === 'extended') {
    const d = (await fetch('https://api.starknet.extended.exchange/api/v1/info/markets').then((x) =>
      x.json(),
    )) as { data?: { type?: string; status?: string }[] };
    const filas = d.data ?? [];
    return {
      fuente: 'info/markets',
      crudo: filas.length,
      descartes: [
        { motivo: 'no son PERPETUAL (spot)', n: filas.filter((m) => m.type !== 'PERPETUAL').length },
        {
          motivo: 'status distinto de ACTIVE',
          n: filas.filter((m) => m.type === 'PERPETUAL' && m.status !== 'ACTIVE').length,
        },
      ],
    };
  }

  if (venue === 'orderly') {
    const d = (await fetch('https://api.orderly.org/v1/public/futures').then((x) => x.json())) as {
      data?: { rows?: { status?: string }[] };
    };
    const filas = d.data?.rows ?? [];
    return {
      fuente: 'public/futures',
      crudo: filas.length,
      descartes: [
        { motivo: 'status distinto de ACTIVE', n: filas.filter((m) => m.status !== 'ACTIVE').length },
      ],
    };
  }

  if (venue === 'perpl') {
    const d = (await fetch('https://app.perpl.xyz/api/v1/pub/context').then((x) => x.json())) as {
      markets?: { symbol?: string; name?: string; config?: { is_open?: boolean } }[];
    };
    const markets = d.markets ?? [];
    const sinNombre = markets.filter(
      (m) => (m.symbol ?? '').trim() === '' && (m.name ?? '').trim() === '',
    ).length;
    const cerrados = markets.filter((m) => m.config?.is_open === false).length;
    return {
      fuente: 'pub/context -> markets',
      crudo: markets.length,
      descartes: [
        { motivo: 'sin symbol ni name', n: sinNombre },
        { motivo: 'is_open false', n: cerrados },
      ],
    };
  }

  return null;
}

console.log('\n--- Cobertura: crudo menos descartes contra lo publicado ---');
for (const r of resultados) {
  if (r.error !== null) {
    console.log(`${r.venue.padEnd(14)} no se pudo leer`);
    continue;
  }
  const c = await coberturaDe(r.venue).catch(() => null);
  if (c === null) {
    console.log(`${r.venue.padEnd(14)} ${String(r.simbolos).padStart(4)} publicados — sin contador de crudo`);
    continue;
  }
  const restados = c.descartes.reduce((acc, d) => acc + d.n, 0);
  const esperado = c.crudo - restados;
  const cuadra = esperado === r.simbolos;
  const detalle = c.descartes
    .filter((d) => d.n > 0)
    .map((d) => `-${d.n} ${d.motivo}`)
    .join(', ');
  console.log(
    `${r.venue.padEnd(14)} ${String(c.crudo).padStart(4)} en ${c.fuente}` +
      (detalle === '' ? '' : `  ${detalle}`) +
      `  =  ${esperado}  |  publicados ${r.simbolos}  ${cuadra ? 'OK' : 'NO CUADRA'}`,
  );
  if (!cuadra) process.exitCode = 1;
}

// --- Simbolos que chocan al normalizar ---------------------------------------
//
// Dos mercados distintos del mismo venue pueden acabar con el mismo nombre
// normalizado. Con un `Map.set` pelado el ultimo gana y nadie se entera: asi
// desaparecio el perpetuo SOL de Pacifica, pisado por su propio mercado de
// SPOT `SOL-USDC`, que no tiene funding. Ese cero se cruzaba luego contra el
// funding real de los demas venues.
//
// Vacio es lo normal. Que deje de estarlo significa que el venue ha listado
// algo nuevo que choca, y hay que mirarlo.
const conColisiones = adapters.filter((a) => (a.colisiones?.length ?? 0) > 0);
if (conColisiones.length === 0) {
  console.log('\nNingun simbolo choca al normalizar.');
} else {
  console.log('\nSIMBOLOS QUE CHOCAN — uno de los dos mercados se esta descartando:');
  for (const a of conColisiones) {
    for (const c of a.colisiones ?? []) console.log(`  ${a.meta.id}: ${c}`);
  }
  process.exitCode = 1;
}

// --- Comisiones declaradas contra las que publica el venue -------------------
//
// Las fees entran directas en el APR neto del scanner: una decima de punto
// basico de mas por lado se multiplica por dos patas y por abrir y cerrar, y
// cambia el orden del ranking. Y a diferencia del funding, no se ven raras al
// mirarlas — un numero desfasado se queda ahi para siempre.
//
// Paradex las publica por mercado y Pacifica publica su tabla de tramos. Donde
// el venue las publica, no hay excusa para tenerlas a mano sin contrastar: aqui
// estaba declarado un taker de 3.0 bps en Paradex cuando su API dice 2.0.

/** Los tipos vienen como texto y al pasarlos a bps salen 1.4999999999999998. */
const redondea = (v: number) => Math.round(v * 1000) / 1000;

/** Comisiones del tramo base segun el propio venue. null = no las publica. */
async function feesPublicadas(venue: string): Promise<{ makerBps: number; takerBps: number } | null> {
  try {
    if (venue === 'paradex') {
      const r = await fetch('https://api.prod.paradex.trade/v1/markets');
      const d = (await r.json()) as {
        results?: { asset_kind?: string; fee_config?: { api_fee?: { maker_fee?: { fee?: string }; taker_fee?: { fee?: string } } } }[];
      };
      // Solo perps: las opciones y el spot tienen otra tarifa y no los tocamos.
      const perp = (d.results ?? []).find((m) => m.asset_kind === 'PERP')?.fee_config?.api_fee;
      if (perp === undefined) return null;
      return {
        makerBps: Number(perp.maker_fee?.fee ?? NaN) * 10_000,
        takerBps: Number(perp.taker_fee?.fee ?? NaN) * 10_000,
      };
    }
    if (venue === 'qfex') {
      // Publica una tarifa POR MERCADO y hay tres tramos. Lo que declaramos es
      // el de las acciones, que son 193 de sus 216 mercados, asi que se
      // contrasta contra la MODA y no contra una cualquiera: comparar con la
      // primera que llegue haria saltar la alarma con los cuatro pares de
      // divisas, que legitimamente pagan menos.
      const d = (await fetch('https://api.qfex.com/fees').then((x) => x.json())) as {
        fees?: Record<string, { maker_fee?: number; taker_fee?: number }>;
      };
      const cuenta = new Map<string, { n: number; makerBps: number; takerBps: number }>();
      for (const v of Object.values(d.fees ?? {})) {
        if (typeof v.maker_fee !== 'number' || typeof v.taker_fee !== 'number') continue;
        const makerBps = v.maker_fee * 10_000;
        const takerBps = v.taker_fee * 10_000;
        const clave = `${makerBps}/${takerBps}`;
        const previo = cuenta.get(clave);
        cuenta.set(clave, { n: (previo?.n ?? 0) + 1, makerBps, takerBps });
      }
      let moda: { n: number; makerBps: number; takerBps: number } | null = null;
      for (const v of cuenta.values()) if (moda === null || v.n > moda.n) moda = v;
      return moda === null ? null : { makerBps: moda.makerBps, takerBps: moda.takerBps };
    }
    if (venue === 'perpl') {
      // Las publica por mercado en el propio contexto, en micros: 90 y 690 son
      // 0,9 y 6,9 bps. Se toma el primer mercado vivo porque son las mismas
      // para todos; los tramos por volumen van en `maker_fees`/`taker_fees` y
      // dependen de la cuenta, asi que el que se compara es el de partida.
      const d = (await fetch('https://app.perpl.xyz/api/v1/pub/context').then((x) => x.json())) as {
        markets?: { config?: { is_open?: boolean; maker_fee?: number; taker_fee?: number } }[];
      };
      const c = (d.markets ?? []).find((m) => m.config?.is_open === true)?.config;
      if (c?.maker_fee === undefined || c.taker_fee === undefined) return null;
      // Micros a puntos basicos: 1 bps = 100 micros.
      return { makerBps: c.maker_fee / 100, takerBps: c.taker_fee / 100 };
    }
    if (venue === 'hyperliquid') {
      // `userFees` necesita una direccion, pero el tramo base viene en
      // `feeSchedule` y es el mismo para todo el mundo: las tarifas propias de
      // esa cuenta van aparte, en userCrossRate/userAddRate. Se usa un vault
      // publico del protocolo solo para poder hacer la peticion.
      const r = await fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'userFees', user: '0x010461c14e146ac35fe42271bdc1134ee31c703a' }),
      });
      const d = (await r.json()) as { feeSchedule?: { add?: string; cross?: string } };
      if (d.feeSchedule?.add === undefined || d.feeSchedule.cross === undefined) return null;
      // `add` es maker (anade liquidez) y `cross` es taker (cruza el libro).
      return {
        makerBps: Number(d.feeSchedule.add) * 10_000,
        takerBps: Number(d.feeSchedule.cross) * 10_000,
      };
    }
    if (venue === 'dydx') {
      // La fuente autoritativa no es su documentacion, son los parametros de
      // la propia cadena. Aqui salio que el maker declarado (0.5 bps) era el
      // del tramo 3, no el de partida.
      const r = await fetch('https://dydx-rest.publicnode.com/dydxprotocol/v4/feetiers/perpetual_fee_params');
      const d = (await r.json()) as {
        params?: { tiers?: { absolute_volume_requirement?: string; total_volume_share_requirement_ppm?: number; maker_fee_ppm?: number; taker_fee_ppm?: number }[] };
      };
      const base = (d.params?.tiers ?? []).find(
        (t) => t.absolute_volume_requirement === '0' && t.total_volume_share_requirement_ppm === 0,
      );
      if (base === undefined) return null;
      // ppm a puntos basicos: 1 bps = 100 ppm.
      return { makerBps: (base.maker_fee_ppm ?? NaN) / 100, takerBps: (base.taker_fee_ppm ?? NaN) / 100 };
    }
    if (venue === 'pacifica') {
      const r = await fetch('https://api.pacifica.fi/api/v1/info/fees');
      const d = (await r.json()) as { data?: { level?: number; maker_fee_rate?: string; taker_fee_rate?: string }[] };
      // Tramo 0: el que paga quien empieza. Los demas dependen del volumen del
      // usuario, que es cosa de la seccion 2.
      const base = (d.data ?? []).find((x) => x.level === 0);
      if (base === undefined) return null;
      return {
        makerBps: Number(base.maker_fee_rate ?? NaN) * 10_000,
        takerBps: Number(base.taker_fee_rate ?? NaN) * 10_000,
      };
    }
  } catch {
    return null;
  }
  return null;
}

console.log('\n--- Comisiones declaradas contra las publicadas ---');

for (const adapter of adapters) {
  const id = adapter.meta.id;
  const publicadas = await feesPublicadas(id);
  const dichas = adapter.meta.fees;

  if (publicadas === null) {
    console.log(
      `${id.padEnd(14)} declaradas maker ${dichas.makerBps} / taker ${dichas.takerBps} bps ` +
        `— sin contraste implementado`,
    );
    continue;
  }

  // Media decima de punto basico de margen: por debajo es redondeo, por encima
  // es que la tarifa ha cambiado.
  const descuadra =
    Math.abs((dichas.makerBps ?? NaN) - publicadas.makerBps) > 0.05 ||
    Math.abs((dichas.takerBps ?? NaN) - publicadas.takerBps) > 0.05;

  console.log(
    `${id.padEnd(14)} declaradas maker ${dichas.makerBps} / taker ${dichas.takerBps} bps  |  ` +
      `publicadas maker ${redondea(publicadas.makerBps)} / taker ${redondea(publicadas.takerBps)} bps` +
      `${descuadra ? '  DESCUADRA' : '  OK'}`,
  );
  if (descuadra) process.exitCode = 1;
}

// --- Lectura de posiciones contra cuentas reales -----------------------------
//
// Los parsers de posiciones son la parte del Tracker que mas facil se rompe en
// silencio: si el tamano viene en otras unidades, o falta el multiplicador del
// contrato, o el precio de entrada esta en unidades del contrato y no del
// activo, no falla nada — sale un numero, y es mentira.
//
// Un mock no lo cazaria, porque el mock lo escribe quien escribio el parser.
// Asi que se prueba contra una cuenta REAL sacada del leaderboard publico de
// cada venue: siempre son cuentas visibles para cualquiera, y al venir del
// leaderboard el sondeo no caduca cuando esa cuenta cierre sus posiciones.
//
// Direcciones publicas de cuentas grandes, no de personas concretas: son las
// que el propio venue publica en su ranking.

/**
 * Candidatas del ranking publico del venue.
 *
 * Varias y no una: estar arriba del ranking no significa tener posiciones
 * abiertas en este instante, y con una sola candidata el sondeo se salta
 * cualquier dia que a esa cuenta le toque estar plana.
 */
async function direccionesDePrueba(venue: string): Promise<string[]> {
  try {
    if (venue === 'hyperliquid') {
      // Vaults publicos del propio protocolo (HLP y sus subvaults). No se usa
      // su ranking: son 11 MB y la descarga se corta a medias, que en la Pi
      // seria absurdo pedir en cada smoke. Estas direcciones son del protocolo,
      // no de personas, y llevan cientos de posiciones abiertas de continuo.
      return [
        '0x010461c14e146ac35fe42271bdc1134ee31c703a',
        '0x31ca8395cf837de08b24da3f660e77761dfb974b',
        '0xdfc24b077bc1425ad1dea75bcb6f8158e10df303',
      ];
    }
    if (venue === 'pacifica') {
      const r = await fetch('https://api.pacifica.fi/api/v1/leaderboard');
      const d = (await r.json()) as { data?: { address?: string; oi_current?: string }[] };
      // Con interes abierto: sin posiciones no hay nada que verificar.
      return (d.data ?? [])
        .filter((x) => Number(x.oi_current ?? 0) > 0)
        .slice(0, 8)
        .map((x) => x.address)
        .filter((a): a is string => typeof a === 'string');
    }
  } catch {
    return [];
  }
  // dydx no publica ranking: su parser no se puede sondear asi, y decirlo es
  // mejor que dar por bueno lo que no se ha mirado.
  return [];
}

console.log('\n--- Lectura de posiciones (cuentas publicas de cada venue) ---');

for (const adapter of adapters) {
  const id = adapter.meta.id;
  if (adapter.fetchPositions === undefined) {
    console.log(`${id.padEnd(14)} ${adapter.noPositionsReason ?? 'lectura de posiciones no disponible'}`);
    continue;
  }

  const candidatas = await direccionesDePrueba(id);
  if (candidatas.length === 0) {
    console.log(`${id.padEnd(14)} sin ranking publico del que sacar una cuenta: NO verificado`);
    continue;
  }

  let cuenta = null;
  let fallo: string | null = null;
  for (const direccion of candidatas) {
    try {
      const c = await adapter.fetchPositions(direccion);
      if (c !== null && c.positions.length > 0) {
        cuenta = c;
        break;
      }
    } catch (err) {
      fallo = err instanceof Error ? err.message : String(err);
      break;
    }
  }

  if (fallo !== null) {
    console.log(`${id.padEnd(14)} FALLO: ${fallo}`);
    process.exitCode = 1;
    continue;
  }
  if (cuenta === null) {
    console.log(`${id.padEnd(14)} ninguna de las ${candidatas.length} cuentas del ranking tiene posiciones ahora`);
    continue;
  }

  const precios = adapter.snapshot();
  const fallos: string[] = [];

  for (const p of cuenta.positions) {
    // El tamano nunca es negativo: la direccion la lleva `side`. Un negativo
    // aqui significa que el signo se colo dos veces y el neto por simbolo del
    // Tracker saldria al reves.
    if (p.sizeBase <= 0) fallos.push(`${p.symbol}: tamano ${p.sizeBase}`);
    if (p.notionalUsd < 0) fallos.push(`${p.symbol}: nocional ${p.notionalUsd}`);

    // Entrada contra mid actual. Es la comprobacion que caza un multiplicador
    // mal aplicado: kPEPE contra PEPE son 1000x, y aqui salta. Un factor 10 es
    // holgado de sobra para cualquier movimiento de precio real.
    const mid = precios.get(p.symbol)?.mid ?? null;
    if (mid !== null && mid > 0 && p.entryPrice !== null && p.entryPrice > 0) {
      const ratio = p.entryPrice / mid;
      if (ratio > 10 || ratio < 0.1) {
        fallos.push(`${p.symbol}: entrada ${p.entryPrice} contra mid ${mid} (${ratio.toFixed(1)}x)`);
      }
    }
  }

  // Si el venue publica el saldo, el margen usado no puede superarlo.
  if (cuenta.equityUsd !== null && cuenta.marginUsedUsd !== null && cuenta.marginUsedUsd > cuenta.equityUsd) {
    fallos.push(`margen usado ${cuenta.marginUsedUsd} > equity ${cuenta.equityUsd}`);
  }

  const saldo = cuenta.equityUsd === null ? 'equity —' : `equity $${Math.round(cuenta.equityUsd).toLocaleString('en-US')}`;
  console.log(
    `${id.padEnd(14)} ${String(cuenta.positions.length).padStart(3)} posiciones, ${saldo}` +
      `${fallos.length === 0 ? '  OK' : ''}`,
  );
  if (fallos.length > 0) {
    console.log('  INCOHERENTE:');
    for (const f of fallos.slice(0, 5)) console.log(`    ${f}`);
    process.exitCode = 1;
  }
}

// --- Profundidad real, solo en el primer venue que la ofrezca ----------------
const conLibro = adapters.find((a) => a.fetchBook !== undefined && a.snapshot().has('BTC'));
if (conLibro?.fetchBook) {
  const btc = conLibro.snapshot().get('BTC');
  const t0 = Date.now();
  const book = await conLibro.fetchBook('BTC');
  if (book && btc) {
    console.log(
      `\nfetchBook BTC en ${conLibro.meta.id}: ${book.bids.length} bids / ${book.asks.length} asks (${Date.now() - t0} ms)`,
    );
    for (const notional of [10_000, 100_000, 1_000_000]) {
      const c = buyCost(book, btc.mid, notional);
      const txt = c.insufficientDepth ? 'sin profundidad suficiente' : `${c.slippageBps.toFixed(2)} bps`;
      console.log(`  comprar ${(notional / 1000).toString().padStart(5)}k USD: ${txt}`);
    }
  }
}

// Los adaptadores con WebSocket dejan el proceso vivo para siempre si nadie
// los cierra. QFEX es el primero, y sin esto `npm run smoke` no volvia al
// prompt: se quedaba colgado con la comprobacion ya terminada.
for (const adapter of adapters) adapter.stop?.();

if (ids.includes('phoenix')) {
  console.log('\n--- Phoenix: contraste WS con detalle REST ---');
  const adapter = adapters.find(a => a.meta.id === 'phoenix')!;
  for (const symbol of SONDAS) {
    const raw = await fetch('https://perp-api.phoenix.trade/v1/view/market/' + symbol, { signal: AbortSignal.timeout(15000) }).then(r => r.json()) as { market: {
      fundingIntervalSeconds: number; currentFundingRatePercentage: number; annualizedFundingRatePercentage: number;
      markPrice: { price: number }; openInterest: { ui: string };
    } };
    const m = raw.market;
    const snap = adapter.snapshot().get(symbol);
    const restApr = m.currentFundingRatePercentage * 8760;
    const priceOk = snap !== undefined && Math.abs(snap.mid / Number(m.markPrice.price) - 1) < 0.03;
    const oi = Number(m.openInterest.ui) * Number(m.markPrice.price);
    const oiOk = snap?.openInterestUsd !== null && snap?.openInterestUsd !== undefined && Math.abs(snap.openInterestUsd - oi) <= Math.max(1, oi * 0.1);
    const ok = m.fundingIntervalSeconds === 3600 && priceOk && oiOk && Math.abs(restApr - m.annualizedFundingRatePercentage) < 1e-6;
    console.log(symbol, { intervalSeconds: m.fundingIntervalSeconds, restApr, wsApr: snap ? fundingAprPct(snap.funding) : null, priceOk, oiOk, ok });
    if (!ok) process.exitCode = 1;
  }
}
