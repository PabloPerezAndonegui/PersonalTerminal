import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MarketSnapshot, VenueMeta } from '@defi/core';
import { scanGross, withDepth, type ScanOptions } from './scan.ts';
import { fundingMatrix } from './matrix.ts';

const meta = (id: string, takerBps: number | null, over: Partial<VenueMeta['fees']> = {}): VenueMeta => ({
  id,
  label: id,
  kind: 'perp-dex',
  chain: null,
  collateral: 'USDC',
  fundingIntervalHours: 1,
  fees: { makerBps: 0, takerBps, freeClose: false, ...over },
  capabilities: { predictedFunding: false, orderBook: true, trading: true, publicPositions: false },
});

const snap = (
  venue: string,
  symbol: string,
  rate: number,
  intervalHours = 1,
  mid = 100,
): MarketSnapshot => ({
  venue,
  symbol,
  symbolNative: symbol,
  contractMultiplier: 1,
  mid,
  bid: mid,
  ask: mid,
  funding: { rate, intervalHours, predicted: null, nextFundingAt: null, kind: 'current', sourceField: 'test' },
  book: null,
  openInterestUsd: null,
  volume24hUsd: null,
  at: 1000,
  sourceAt: null,
});

const mapa = (entradas: readonly MarketSnapshot[]) => {
  const out = new Map<string, Map<string, MarketSnapshot>>();
  for (const s of entradas) {
    const porSimbolo = out.get(s.venue) ?? new Map<string, MarketSnapshot>();
    porSimbolo.set(s.symbol, s);
    out.set(s.venue, porSimbolo);
  }
  return out;
};

const metas = (...ms: VenueMeta[]) => new Map(ms.map((m) => [m.id, m]));

const OPCIONES: ScanOptions = {
  notionalPerLegUsd: 10_000,
  holdHours: 24 * 7,
  feeMode: 'taker',
  clock: () => 1000,
};

// --- Direccion y magnitud ----------------------------------------------------

test('el corto va siempre en el venue que paga mas: es la pata que cobra', () => {
  const [op] = scanGross(
    mapa([snap('a', 'BTC', 0.0003), snap('b', 'BTC', 0.0001)]),
    metas(meta('a', 0), meta('b', 0)),
    OPCIONES,
  );
  assert.equal(op?.shortVenue, 'a');
  assert.equal(op?.longVenue, 'b');
  assert.ok((op?.fundingSpreadHourly ?? -1) > 0, 'el diferencial nunca es negativo');
});

test('da igual el orden en que lleguen los venues', () => {
  const m = metas(meta('a', 0), meta('b', 0));
  const [x] = scanGross(mapa([snap('a', 'BTC', 0.0001), snap('b', 'BTC', 0.0003)]), m, OPCIONES);
  const [y] = scanGross(mapa([snap('b', 'BTC', 0.0003), snap('a', 'BTC', 0.0001)]), m, OPCIONES);
  assert.equal(x?.shortVenue, y?.shortVenue);
  assert.equal(x?.longVenue, y?.longVenue);
});

test('compara venues con intervalos distintos normalizando a horario', () => {
  // 0.0008 cada 8 h es EXACTAMENTE lo mismo que 0.0001 cada hora: no hay
  // oportunidad. Tratar el 0.0008 como horario inventaria un 8x de spread.
  const ops = scanGross(
    mapa([snap('a', 'BTC', 0.0008, 8), snap('b', 'BTC', 0.0001, 1)]),
    metas(meta('a', 0), meta('b', 0)),
    OPCIONES,
  );
  assert.equal(ops.length, 0);
});

test('el APR bruto anualiza el diferencial horario', () => {
  const [op] = scanGross(
    mapa([snap('a', 'BTC', 0.0002), snap('b', 'BTC', 0.0001)]),
    metas(meta('a', 0), meta('b', 0)),
    OPCIONES,
  );
  // 0.0001/h * 8760 h * 100 = 87.6 %
  assert.ok(Math.abs((op?.grossAprPct ?? 0) - 87.6) < 1e-9);
});

test('sin diferencial no hay oportunidad', () => {
  assert.equal(
    scanGross(mapa([snap('a', 'BTC', 0.0001), snap('b', 'BTC', 0.0001)]), metas(meta('a', 0), meta('b', 0)), OPCIONES)
      .length,
    0,
  );
});

test('un simbolo en un solo venue no genera nada', () => {
  assert.equal(scanGross(mapa([snap('a', 'BTC', 0.0005)]), metas(meta('a', 0)), OPCIONES).length, 0);
});

// --- Cobertura de pares ------------------------------------------------------

test('con tres venues se evaluan los tres pares, no solo el mejor en bruto', () => {
  // Importa porque las fees difieren: el mejor par en bruto puede no serlo en
  // neto, asi que el scanner no puede quedarse solo con el maximo y el minimo.
  const ops = scanGross(
    mapa([snap('a', 'BTC', 0.0003), snap('b', 'BTC', 0.0002), snap('c', 'BTC', 0.0001)]),
    metas(meta('a', 0), meta('b', 0), meta('c', 0)),
    OPCIONES,
  );
  assert.equal(ops.length, 3);
});

test('las oportunidades salen ordenadas de mayor a menor APR bruto', () => {
  const ops = scanGross(
    mapa([snap('a', 'BTC', 0.0003), snap('b', 'BTC', 0.0002), snap('c', 'BTC', 0.0001)]),
    metas(meta('a', 0), meta('b', 0), meta('c', 0)),
    OPCIONES,
  );
  for (let i = 1; i < ops.length; i++) {
    assert.ok((ops[i - 1]?.grossAprPct ?? 0) >= (ops[i]?.grossAprPct ?? 0));
  }
});

test('minGrossAprPct filtra antes de ordenar', () => {
  const ops = scanGross(
    mapa([snap('a', 'BTC', 0.0003), snap('b', 'BTC', 0.0002), snap('c', 'BTC', 0.0001)]),
    metas(meta('a', 0), meta('b', 0), meta('c', 0)),
    { ...OPCIONES, minGrossAprPct: 100 },
  );
  for (const op of ops) assert.ok(op.grossAprPct >= 100);
});

test('se ignoran los venues sin metadatos en vez de reventar', () => {
  const ops = scanGross(
    mapa([snap('a', 'BTC', 0.0003), snap('desconocido', 'BTC', 0.0001)]),
    metas(meta('a', 0)),
    OPCIONES,
  );
  assert.equal(ops.length, 0);
});

// --- Fees --------------------------------------------------------------------

test('una fee desconocida deja el coste y el neto en null, nunca en 0', () => {
  const [op] = scanGross(
    mapa([snap('a', 'BTC', 0.0003), snap('b', 'BTC', 0.0001)]),
    metas(meta('a', null), meta('b', 0)),
    OPCIONES,
  );
  assert.equal(op?.feesPct, null);

  const conLibro = withDepth(op!, 0.01, false, OPCIONES);
  assert.equal(conLibro.totalCostPct, null);
  assert.equal(conLibro.netAprPct, null, 'sin fees no se puede afirmar un APR neto');
  assert.equal(conLibro.slippagePct, 0.02, 'el slippage si se conoce y se muestra');
});

test('las fees cuentan cuatro patas: abrir y cerrar en los dos venues', () => {
  // 5 bps por pata = 0.05 % -> 0.20 % en total.
  const [op] = scanGross(
    mapa([snap('a', 'BTC', 0.0003), snap('b', 'BTC', 0.0001)]),
    metas(meta('a', 5), meta('b', 5)),
    OPCIONES,
  );
  assert.ok(Math.abs((op?.feesPct ?? 0) - 0.2) < 1e-12);
});

test('freeClose descuenta la pata de cierre de ese venue', () => {
  const [op] = scanGross(
    mapa([snap('a', 'BTC', 0.0003), snap('b', 'BTC', 0.0001)]),
    metas(meta('a', 5, { freeClose: true }), meta('b', 5)),
    OPCIONES,
  );
  // a: solo apertura (0.05). b: apertura y cierre (0.10). Total 0.15 %.
  assert.ok(Math.abs((op?.feesPct ?? 0) - 0.15) < 1e-12);
});

test('el modo maker usa las fees de maker', () => {
  const conMaker = meta('a', 100);
  const [op] = scanGross(
    mapa([snap('a', 'BTC', 0.0003), snap('b', 'BTC', 0.0001)]),
    metas(conMaker, meta('b', 100)),
    { ...OPCIONES, feeMode: 'maker' },
  );
  assert.equal(op?.feesPct, 0, 'makerBps es 0 en estos dobles');
});

// --- Profundidad y neto ------------------------------------------------------

test('withDepth asume que cerrar cuesta lo mismo que abrir', () => {
  const [op] = scanGross(
    mapa([snap('a', 'BTC', 0.0003), snap('b', 'BTC', 0.0001)]),
    metas(meta('a', 0), meta('b', 0)),
    OPCIONES,
  );
  assert.equal(withDepth(op!, 0.03, false, OPCIONES).slippagePct, 0.06);
});

test('sin profundidad suficiente no se inventa un neto', () => {
  const [op] = scanGross(
    mapa([snap('a', 'BTC', 0.0003), snap('b', 'BTC', 0.0001)]),
    metas(meta('a', 5), meta('b', 5)),
    OPCIONES,
  );
  const sinFondo = withDepth(op!, 0, true, OPCIONES);
  assert.equal(sinFondo.insufficientDepth, true);
  assert.equal(sinFondo.slippagePct, null);
  assert.equal(sinFondo.netAprPct, null);
});

test('el breakeven son las horas de funding que cubren el coste', () => {
  const [op] = scanGross(
    mapa([snap('a', 'BTC', 0.0002), snap('b', 'BTC', 0.0001)]),
    metas(meta('a', 5), meta('b', 5)),
    OPCIONES,
  );
  // Coste 0.20 % de fees + 0 de slippage. Spread 0.0001/h = 0.01 %/h.
  // 0.20 / 0.01 = 20 horas.
  const conLibro = withDepth(op!, 0, false, OPCIONES);
  assert.ok(Math.abs((conLibro.breakevenHours ?? 0) - 20) < 1e-9);
});

test('un horizonte corto castiga el neto mucho mas que uno largo', () => {
  const [op] = scanGross(
    mapa([snap('a', 'BTC', 0.0002), snap('b', 'BTC', 0.0001)]),
    metas(meta('a', 5), meta('b', 5)),
    OPCIONES,
  );
  // 87.6 % bruto, 0.2 % de coste: a un dia el neto baja a 14.6 %, a un mes
  // queda en 85.2 %. El coste no cambia; lo que cambia es entre cuanto tiempo
  // se reparte.
  const unDia = withDepth(op!, 0, false, { ...OPCIONES, holdHours: 24 });
  const unMes = withDepth(op!, 0, false, { ...OPCIONES, holdHours: 24 * 30 });
  assert.ok(Math.abs((unDia.netAprPct ?? 0) - 14.6) < 1e-6);
  assert.ok(Math.abs((unMes.netAprPct ?? 0) - 85.17) < 0.01);
});

test('con fees de venue caro, un horizonte corto vuelve negativa la oportunidad', () => {
  // 20 bps por pata son 0.8 % de coste. Amortizado en 24 h son 292 % anuales,
  // contra un bruto de 87.6 %: entrar y salir el mismo dia destruye dinero
  // aunque el funding parezca estupendo. Es el numero que la pantalla tiene
  // que dejar ver antes de que alguien abra la posicion.
  const [op] = scanGross(
    mapa([snap('a', 'BTC', 0.0002), snap('b', 'BTC', 0.0001)]),
    metas(meta('a', 20), meta('b', 20)),
    OPCIONES,
  );
  const unDia = withDepth(op!, 0, false, { ...OPCIONES, holdHours: 24 });
  const unMes = withDepth(op!, 0, false, { ...OPCIONES, holdHours: 24 * 30 });
  assert.ok((unDia.netAprPct ?? 0) < 0, 'a un dia destruye dinero');
  assert.ok((unMes.netAprPct ?? 0) > 0, 'a un mes compensa');
});

test('el neto descuenta el coste anualizado sobre el horizonte', () => {
  const [op] = scanGross(
    mapa([snap('a', 'BTC', 0.0002), snap('b', 'BTC', 0.0001)]),
    metas(meta('a', 5), meta('b', 5)),
    OPCIONES,
  );
  // Bruto 87.6 %. Coste 0.2 % amortizado en 168 h -> 0.2 * 8760/168 = 10.43 %.
  const conLibro = withDepth(op!, 0, false, OPCIONES);
  assert.ok(Math.abs((conLibro.netAprPct ?? 0) - (87.6 - 10.428571428571429)) < 1e-6);
});

// --- Procedencia y amortizacion ----------------------------------------------

test('la procedencia conserva el numero nativo, no solo el horario', () => {
  // Sin el nativo y su intervalo no se puede rehacer la division a mano, y toda
  // la comparacion entre venues depende justo de esa division.
  const a = snap('paradex', 'BTC', 0.0008, 8);
  const b = snap('hl', 'BTC', 0.00001, 1);
  const op = scanGross(mapa([a, b]), new Map([['paradex', meta('paradex', 2)], ['hl', meta('hl', 4.5)]]), OPCIONES)[0];

  const corto = op!.provenance.short;
  assert.equal(corto.venue, 'paradex');
  assert.equal(corto.nativeRate, 0.0008, 'el numero tal cual lo publica el venue');
  assert.equal(corto.intervalHours, 8, 'y la ventana que dice cubrir');
  assert.ok(Math.abs(corto.hourlyRate - 0.0001) < 1e-12, '0.0008 en 8 h son 0.0001/h');
  assert.equal(op!.provenance.long.venue, 'hl');
});

test('la procedencia dice si el funding es vigente o previsto', () => {
  // dydx publica la tasa del PROXIMO periodo; los demas la del actual. Mezclar
  // las dos sin decirlo hace inservible cualquier analisis de estrategia.
  const previsto = snap('dydx', 'BTC', 0.0002, 1);
  const vigente = snap('hl', 'BTC', 0.00001, 1);
  const op = scanGross(
    mapa([{ ...previsto, funding: { ...previsto.funding, kind: 'predicted' as const, sourceField: 'perpetualMarkets -> nextFundingRate' } }, vigente]),
    new Map([['dydx', meta('dydx', 5)], ['hl', meta('hl', 4.5)]]),
    OPCIONES,
  )[0];

  assert.equal(op!.provenance.short.kind, 'predicted');
  assert.match(op!.provenance.short.sourceField, /nextFundingRate/);
  assert.equal(op!.provenance.long.kind, 'current');
});

test('se dice si el coste NO se recupera en el horizonte elegido', () => {
  const a = snap('a', 'BTC', 0.00001, 1);
  const b = snap('b', 'BTC', 0.000005, 1);
  const metas = new Map([['a', meta('a', 5)], ['b', meta('b', 5)]]);

  // Diferencial de 0.000005/h = 0.0005 %/h. Con 0.2 % de coste total hacen
  // falta 400 h para amortizar.
  const corto: ScanOptions = { ...OPCIONES, holdHours: 24 };
  const opCorto = withDepth(scanGross(mapa([a, b]), metas, corto)[0]!, 0, false, corto);
  assert.ok((opCorto.breakevenHours ?? 0) > 24);
  assert.equal(opCorto.amortizesWithinHold, false, 'en un dia no da tiempo');
  assert.ok((opCorto.netAprPct ?? 0) < 0, 'y el neto lo refleja');

  const largo: ScanOptions = { ...OPCIONES, holdHours: 30 * 24 };
  const opLargo = withDepth(scanGross(mapa([a, b]), metas, largo)[0]!, 0, false, largo);
  assert.equal(opLargo.amortizesWithinHold, true, 'en un mes si');
});

test('sin fees conocidas no se afirma que amortice', () => {
  const a = snap('a', 'BTC', 0.0003, 1);
  const b = snap('b', 'BTC', 0.0001, 1);
  const metas = new Map([['a', meta('a', null)], ['b', meta('b', 5)]]);
  const op = withDepth(scanGross(mapa([a, b]), metas, OPCIONES)[0]!, 0.01, false, OPCIONES);
  assert.equal(op.amortizesWithinHold, null);
  assert.equal(op.netAprPct, null);
});

test('la edad de los dos libros y su desfase quedan registrados', () => {
  const a = snap('a', 'BTC', 0.0003, 1);
  const b = snap('b', 'BTC', 0.0001, 1);
  const metas = new Map([['a', meta('a', 5)], ['b', meta('b', 5)]]);
  const op = withDepth(scanGross(mapa([a, b]), metas, OPCIONES)[0]!, 0.01, false, OPCIONES, {
    longAgeMs: 4000, shortAgeMs: 61_000, skewMs: 57_000,
  });
  assert.equal(op.provenance.books?.skewMs, 57_000);
  assert.equal(op.provenance.books?.shortAgeMs, 61_000);
});

test('sin profundidad se conserva la edad de los libros que si se pidieron', () => {
  const a = snap('a', 'BTC', 0.0003, 1);
  const b = snap('b', 'BTC', 0.0001, 1);
  const metas = new Map([['a', meta('a', 5)], ['b', meta('b', 5)]]);
  const op = withDepth(scanGross(mapa([a, b]), metas, OPCIONES)[0]!, 0, true, OPCIONES, {
    longAgeMs: 1000, shortAgeMs: 2000, skewMs: 1000,
  });
  assert.equal(op.insufficientDepth, true);
  assert.equal(op.slippagePct, null, 'no se inventa un slippage');
  assert.equal(op.provenance.books?.skewMs, 1000, 'pero si se sabe de cuando eran');
});

// --- Matriz de funding -------------------------------------------------------

test('la matriz pone el largo en el funding mas bajo y el corto en el mas alto', () => {
  const m = fundingMatrix(mapa([
    snap('a', 'KAS', -0.0004),
    snap('b', 'KAS', -0.0001),
    snap('c', 'KAS', -0.0003),
  ]), ['a', 'b', 'c']);

  const fila = m[0]!;
  assert.equal(fila.longVenue, 'a', 'el largo cobra donde el funding es mas negativo');
  assert.equal(fila.shortVenue, 'b');
  assert.ok(Math.abs((fila.spreadHourly ?? 0) - 0.0003) < 1e-12);
});

test('solo cuentan los venues elegidos', () => {
  const datos = mapa([
    snap('a', 'BTC', 0.0001),
    snap('b', 'BTC', 0.0009),
    snap('c', 'BTC', 0.0003),
  ]);
  // Con los tres, el cruce es a contra b.
  assert.equal(fundingMatrix(datos, ['a', 'b', 'c'])[0]?.shortVenue, 'b');
  // Quitando b, el corto pasa a c y el diferencial cambia. Es lo que tiene que
  // poder verse al elegir que venues comparar.
  const sinB = fundingMatrix(datos, ['a', 'c'])[0]!;
  assert.equal(sinB.shortVenue, 'c');
  assert.ok(Math.abs((sinB.spreadHourly ?? 0) - 0.0002) < 1e-12);
  assert.equal(sinB.cells['b'], undefined, 'el venue quitado no aparece en la fila');
});

test('la matriz compara en horario aunque un venue liquide cada 8 h', () => {
  // 0.0008 a 8 h y 0.0001 a 1 h son la MISMA tasa: no hay cruce.
  const fila = fundingMatrix(mapa([snap('px', 'BTC', 0.0008, 8), snap('hl', 'BTC', 0.0001, 1)]), ['px', 'hl'])[0]!;
  assert.ok(Math.abs(fila.spreadHourly ?? 1) < 1e-15);
  assert.equal(fila.longVenue, null, 'tasas iguales: no se senala ni largo ni corto');
  assert.equal(fila.cells['px']?.nativeRate, 0.0008, 'y se conserva el numero nativo');
});

test('un simbolo en un solo venue elegido no entra', () => {
  const m = fundingMatrix(mapa([snap('a', 'SOLO', 0.0001), snap('a', 'BTC', 0.0001), snap('b', 'BTC', 0.0002)]), ['a', 'b']);
  assert.deepEqual(m.map((f) => f.symbol), ['BTC']);
});

test('la matriz sale ordenada de mayor a menor diferencial', () => {
  const m = fundingMatrix(mapa([
    snap('a', 'X', 0.0001), snap('b', 'X', 0.0002),
    snap('a', 'Y', 0.0001), snap('b', 'Y', 0.0009),
  ]), ['a', 'b']);
  assert.deepEqual(m.map((f) => f.symbol), ['Y', 'X']);
});

// --- Tickers que significan dos cosas ---------------------------------------
//
// Con venues de acciones al lado de los de cripto esto deja de ser teorico:
// CAT es Caterpillar a 807 USD en QFEX y un memecoin a 0,0000020 en Aster, BB
// es BlackBerry y BounceBit, y PURR es el memecoin de Hyperliquid y otra cosa
// en QFEX. Se detectan por el PRECIO, que entre venues de verdad no se mueve
// ni un 1 %, mientras que el funding si diverge y por eso existe esta app.

test('un venue con un precio imposible se aparta de la comparacion', () => {
  const fila = fundingMatrix(mapa([
    snap('qfex', 'CAT', 0.0001, 1, 807.5),
    snap('variational', 'CAT', 0.0002, 1, 807.6),
    snap('aster', 'CAT', 0.0009, 1, 0.0000020442),
  ]), ['qfex', 'variational', 'aster'])[0]!;

  assert.deepEqual(fila.conflicts, ['aster']);
  assert.equal(fila.cells['aster'], undefined, 'no se compara contra el memecoin');
  assert.equal(fila.shortVenue, 'variational', 'el cruce es entre los dos que si son Caterpillar');
  assert.ok(Math.abs((fila.spreadHourly ?? 0) - 0.0001) < 1e-12);
});

test('con solo dos venues que no cuadran se apartan los dos', () => {
  // Con dos precios distintos no hay mayoria: no se puede saber cual de los
  // dos es el activo bueno, asi que no se compara ninguno.
  const filas = fundingMatrix(mapa([
    snap('aster', 'RTX', 0.0001, 1, 0.707),
    snap('qfex', 'RTX', 0.0009, 1, 192.72),
  ]), ['aster', 'qfex']);

  assert.equal(filas.length, 0, 'el simbolo desaparece en vez de dar una senal falsa');
});

test('una diferencia de precio normal entre venues NO se aparta', () => {
  // Medio punto porcentual es lo que se ve de verdad entre venues.
  const fila = fundingMatrix(mapa([
    snap('a', 'BTC', 0.0001, 1, 80_000),
    snap('b', 'BTC', 0.0009, 1, 80_400),
  ]), ['a', 'b'])[0]!;

  assert.deepEqual(fila.conflicts, []);
  assert.equal(Object.keys(fila.cells).length, 2);
});
