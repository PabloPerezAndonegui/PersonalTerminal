import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MarketSnapshot } from '@defi/core';
import { validateCycle, findingsByVenue, DEFAULT_THRESHOLDS } from './rules.ts';

const snap = (venue: string, symbol: string, over: Partial<MarketSnapshot> = {}): MarketSnapshot => ({
  venue,
  symbol,
  symbolNative: symbol,
  contractMultiplier: 1,
  mid: 100,
  bid: 99.9,
  ask: 100.1,
  funding: { rate: 0.0001, intervalHours: 1, predicted: null, nextFundingAt: null, kind: 'current', sourceField: 'test' },
  book: null,
  openInterestUsd: 1e6,
  volume24hUsd: 5e6,
  at: 1000,
  sourceAt: null,
  ...over,
});

const ciclo = (...ss: MarketSnapshot[]) => {
  const out = new Map<string, Map<string, MarketSnapshot>>();
  for (const s of ss) {
    const porSimbolo = out.get(s.venue) ?? new Map<string, MarketSnapshot>();
    porSimbolo.set(s.symbol, s);
    out.set(s.venue, porSimbolo);
  }
  return out;
};

const reglas = (fs: readonly { rule: string }[]) => fs.map((f) => f.rule);

// --- Caso sano ---------------------------------------------------------------

test('un ciclo normal no produce hallazgos', () => {
  const f = validateCycle(ciclo(snap('a', 'BTC'), snap('b', 'BTC'), snap('c', 'BTC')));
  assert.deepEqual(f, []);
});

test('diferencias de precio normales entre venues no molestan', () => {
  // Un 0.1 % de desviacion es lo habitual y es justo lo que mide la pestana
  // Parity: no puede generar ruido en la validacion.
  const f = validateCycle(
    ciclo(snap('a', 'BTC', { mid: 100 }), snap('b', 'BTC', { mid: 100.1 }), snap('c', 'BTC', { mid: 99.9 })),
  );
  assert.deepEqual(f, []);
});

// --- El bug de Paradex, ahora automatico -------------------------------------

test('caza el error de unidades que inflaba el volumen de Paradex', () => {
  // 3,7 millones de BTC x 78.500 USD = 290.000 millones. Es el numero exacto
  // que se colo en produccion y que solo se vio mirando la base a mano.
  const f = validateCycle(ciclo(snap('paradex', 'BTC', { volume24hUsd: 290e9 })));
  assert.ok(reglas(f).includes('volumen-imposible'));
  assert.equal(f[0]?.severity, 'error');
  assert.match(f[0]?.message ?? '', /unit error/);
});

test('caza un interes abierto con el mismo error de unidades', () => {
  const f = validateCycle(ciclo(snap('x', 'BTC', { openInterestUsd: 500e9 })));
  assert.ok(reglas(f).includes('oi-imposible'));
});

test('un volumen alto pero real no se marca', () => {
  // Hyperliquid mueve 2.300 millones al dia en BTC: es legitimo.
  assert.deepEqual(validateCycle(ciclo(snap('hl', 'BTC', { volume24hUsd: 2.3e9 }))), []);
});

// --- Coherencia de precios ---------------------------------------------------

test('un multiplicador mal aplicado se detecta por el precio', () => {
  // 'kPEPE' tratado como 'PEPE' da un precio mil veces mayor. El nombre NATIVO
  // con su prefijo es parte del caso: es lo que distingue nuestro fallo de dos
  // activos que comparten ticker y se llevan mil veces por casualidad.
  const f = validateCycle(
    ciclo(
      snap('a', 'PEPE', { mid: 0.00001, symbolNative: '1000PEPEUSDT' }),
      snap('b', 'PEPE', { mid: 0.00001, symbolNative: 'kPEPE' }),
      snap('malo', 'PEPE', { mid: 0.01, symbolNative: 'kPEPE-USD' }),
    ),
  );
  const incoherente = f.find((x) => x.rule === 'precio-incoherente');
  assert.equal(incoherente?.venue, 'malo');
  assert.equal(incoherente?.severity, 'error');
  assert.match(incoherente?.message ?? '', /multiplier/);
});

test('detecta el mismo ticker siendo activos distintos', () => {
  // El fallo peligroso: el scanner cruzaria el funding de dos cosas que no son
  // la misma, y eso es dinero perdido, no un numero feo en pantalla.
  const f = validateCycle(
    ciclo(snap('a', 'MOVE', { mid: 0.5 }), snap('b', 'MOVE', { mid: 0.51 }), snap('c', 'MOVE', { mid: 42 })),
  );
  const hallazgo = f.find((x) => x.rule === 'ticker-ambiguo');
  assert.equal(hallazgo?.venue, 'c');
  // 84x no lo produce ningun multiplicador, asi que no es un fallo nuestro y
  // no pone el venue en amarillo: se anota y la matriz lo aparta.
  assert.equal(hallazgo?.severity, 'warning');
});

test('mil veces SIN prefijo en el nombre no es culpa nuestra', () => {
  // Caso real: el BB de Aster es BounceBit a 0,00806 y el de Extended es
  // BlackBerry a 8,06. Son 999,9x de pura casualidad y no hay ningun
  // multiplicador de por medio, asi que no puede poner el venue en amarillo.
  const f = validateCycle(
    ciclo(
      snap('extended', 'BB', { mid: 8.06, symbolNative: 'BB-USD' }),
      snap('qfex', 'BB', { mid: 8.07, symbolNative: 'BB-USD' }),
      snap('aster', 'BB', { mid: 0.00806, symbolNative: 'BBUSDT' }),
    ),
  );
  const hallazgo = f.find((x) => x.venue === 'aster' && x.symbol === 'BB');
  assert.equal(hallazgo?.rule, 'ticker-ambiguo');
  assert.equal(hallazgo?.severity, 'warning');
});

test('una desviacion moderada es aviso, no error', () => {
  const f = validateCycle(
    ciclo(snap('a', 'X', { mid: 100 }), snap('b', 'X', { mid: 100 }), snap('c', 'X', { mid: 115 })),
  );
  const aviso = f.find((x) => x.rule === 'precio-incoherente');
  assert.equal(aviso?.severity, 'warning');
});

test('con solo dos venues no se juzga el precio: no se sabe cual miente', () => {
  const f = validateCycle(ciclo(snap('a', 'X', { mid: 100 }), snap('b', 'X', { mid: 1000 })));
  assert.equal(f.filter((x) => x.rule === 'precio-incoherente').length, 0);
});

test('el venue senalado es el que se desvia, no los sanos', () => {
  const f = validateCycle(
    ciclo(
      snap('bueno1', 'X', { mid: 10 }),
      snap('bueno2', 'X', { mid: 10 }),
      snap('bueno3', 'X', { mid: 10 }),
      snap('malo', 'X', { mid: 1000 }),
    ),
  );
  const senalados = f
    .filter((x) => x.rule === 'precio-incoherente' || x.rule === 'ticker-ambiguo')
    .map((x) => x.venue);
  assert.deepEqual(senalados, ['malo']);
});

// --- Otras reglas ------------------------------------------------------------

test('un libro con los lados cruzados es un error', () => {
  const f = validateCycle(ciclo(snap('a', 'BTC', { bid: 101, ask: 99 })));
  assert.ok(reglas(f).includes('libro-invertido'));
});

test('un precio no valido corta el resto de comprobaciones de ese simbolo', () => {
  // Sin precio, el volumen o el funding no significan nada: un solo hallazgo.
  const f = validateCycle(ciclo(snap('a', 'BTC', { mid: 0, volume24hUsd: 999e9 })));
  assert.deepEqual(reglas(f), ['precio-invalido']);
});

test('un funding imposible delata un error de intervalo', () => {
  const f = validateCycle(
    ciclo(snap('a', 'BTC', { funding: { rate: 0.05, intervalHours: 1, predicted: null, nextFundingAt: null, kind: 'current', sourceField: 'test' } })),
  );
  assert.ok(reglas(f).includes('funding-imposible'));
  assert.match(f[0]?.message ?? '', /wrong funding interval/);
});

test('un funding alto pero real no se marca', () => {
  // La app ha mostrado 1716 % reales: el techo busca lo imposible, no lo raro.
  const rate = 1716 / 100 / (24 * 365);
  assert.deepEqual(
    validateCycle(ciclo(snap('a', 'X', { funding: { rate, intervalHours: 1, predicted: null, nextFundingAt: null, kind: 'current', sourceField: 'test' } }))),
    [],
  );
});

test('un intervalo de funding invalido se marca', () => {
  const f = validateCycle(
    ciclo(snap('a', 'BTC', { funding: { rate: 0.0001, intervalHours: 0, predicted: null, nextFundingAt: null, kind: 'current', sourceField: 'test' } })),
  );
  assert.ok(reglas(f).includes('intervalo-invalido'));
});

test('los errores salen antes que los avisos', () => {
  const f = validateCycle(
    ciclo(
      snap('a', 'X', { mid: 100 }),
      snap('b', 'X', { mid: 100 }),
      snap('c', 'X', { mid: 115 }),
      snap('d', 'BTC', { volume24hUsd: 500e9 }),
    ),
  );
  assert.equal(f[0]?.severity, 'error');
});

test('findingsByVenue agrupa para que el collector degrade a quien toca', () => {
  const f = validateCycle(ciclo(snap('malo', 'BTC', { volume24hUsd: 500e9 }), snap('bueno', 'ETH')));
  const porVenue = findingsByVenue(f);
  assert.deepEqual([...porVenue.keys()], ['malo']);
  assert.equal(porVenue.get('bueno'), undefined);
});

test('los umbrales se pueden ajustar sin tocar las reglas', () => {
  const estricto = { ...DEFAULT_THRESHOLDS, maxNotionalUsd: 1e6 };
  assert.equal(validateCycle(ciclo(snap('a', 'BTC', { volume24hUsd: 5e6 })), estricto).length, 1);
});
