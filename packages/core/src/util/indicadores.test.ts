import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sma, ema, rsi, macd, bollinger, atr, vwap, type Vela } from './indicadores.ts';

/**
 * Los indicadores, con las cuentas hechas aparte.
 *
 * Lo que se prueba sobre todo son los bordes, que es donde un indicador miente
 * sin fallar: la ventana de calentamiento, la serie mas corta que el periodo y
 * la division por cero. Un indicador que devuelve cero donde deberia devolver
 * null dibuja una linea que cae al suelo, y eso en un grafico se lee como una
 * senal.
 */

/** Velas con cierre controlado. El resto de campos solo importan en ATR y VWAP. */
const velasDe = (cierres: readonly number[]): Vela[] =>
  cierres.map((c, i) => ({ t: i * 3_600_000, open: c, high: c, low: c, close: c, volume: 1 }));

test('la ventana de calentamiento es null, nunca cero', () => {
  const r = sma([1, 2, 3, 4, 5], 3);
  assert.deepEqual(r.slice(0, 2), [null, null], 'antes del periodo no hay dato');
  assert.equal(r[2], 2);
  assert.equal(r[3], 3);
  assert.equal(r[4], 4);
  assert.equal(r.length, 5, 'la serie sale alineada con la entrada');
});

test('una serie mas corta que el periodo sale entera a null', () => {
  assert.deepEqual(sma([1, 2], 5), [null, null]);
  assert.deepEqual(ema([1, 2], 5), [null, null]);
  assert.deepEqual(rsi([1, 2], 14), [null, null]);
  assert.deepEqual(atr(velasDe([1, 2]), 14), [null, null]);
});

test('la EMA arranca con la SMA del primer periodo, no con el primer cierre', () => {
  // Con [1,2,3,4,5] y periodo 3: la SMA de los tres primeros es 2.
  // Luego k = 2/4 = 0,5.  e4 = 4*0,5 + 2*0,5 = 3.  e5 = 5*0,5 + 3*0,5 = 4.
  const r = ema([1, 2, 3, 4, 5], 3);
  assert.deepEqual(r.slice(0, 2), [null, null]);
  assert.equal(r[2], 2);
  assert.equal(r[3], 3);
  assert.equal(r[4], 4);
});

test('una serie que solo sube da RSI 100, que no es un error', () => {
  // Sin ninguna bajada la division seria entre cero. El indicador vale 100 por
  // definicion, asi que devolver null aqui seria esconder una senal real.
  const r = rsi([1, 2, 3, 4, 5, 6, 7, 8], 3);
  assert.equal(r[3], 100);
  assert.equal(r[7], 100);
});

test('el RSI de una serie plana es 100 y no parte por cero', () => {
  // Plana: ni subidas ni bajadas. La rama de bajadas a cero lo resuelve.
  const r = rsi([5, 5, 5, 5, 5, 5], 3);
  assert.equal(r[3], 100);
  assert.ok(Number.isFinite(r[5] ?? NaN), 'no sale NaN ni Infinity');
});

test('el RSI se mueve entre 0 y 100 con datos de verdad', () => {
  const precios = [44, 44.3, 44.1, 44.8, 45.1, 45.4, 45.4, 45.2, 46.1, 46.3, 46.3, 46, 46.4, 46.2, 45.6, 46.3, 46.5];
  for (const v of rsi(precios, 14)) {
    if (v === null) continue;
    assert.ok(v >= 0 && v <= 100, `RSI fuera de rango: ${v}`);
  }
});

test('la senal del MACD NO cuenta los nulls como ceros', () => {
  // Es el fallo silencioso de este indicador: pasarle la linea con nulls
  // convertidos en cero arrastra la senal hacia abajo durante decenas de velas.
  // Aqui se comprueba que la senal empieza DESPUES que la linea y que, cuando
  // las dos existen, el histograma es exactamente su diferencia.
  const precios = Array.from({ length: 80 }, (_v, i) => 100 + Math.sin(i / 5) * 10);
  const r = macd(precios, 12, 26, 9);
  const iLinea = r.macd.findIndex((v) => v !== null);
  const iSenal = r.senal.findIndex((v) => v !== null);
  assert.ok(iLinea > 0, 'la linea tiene calentamiento');
  assert.ok(iSenal > iLinea, 'la senal arranca despues que la linea');

  for (let i = 0; i < precios.length; i++) {
    const a = r.macd[i];
    const b = r.senal[i];
    const h = r.histograma[i];
    if (a == null || b == null) { assert.equal(h ?? null, null, `histograma en ${i}`); continue; }
    assert.ok(Math.abs((h ?? 0) - (a - b)) < 1e-9);
  }
});

test('las bandas de Bollinger encierran a su media', () => {
  const precios = [10, 12, 11, 13, 15, 14, 16, 18, 17, 19, 21, 20, 22, 24, 23];
  const r = bollinger(precios, 5, 2);
  for (let i = 0; i < precios.length; i++) {
    const m = r.media[i];
    if (m == null) { assert.equal(r.alta[i] ?? null, null); assert.equal(r.baja[i] ?? null, null); continue; }
    assert.ok((r.alta[i] ?? 0) >= m, 'la alta nunca baja de la media');
    assert.ok((r.baja[i] ?? 0) <= m, 'la baja nunca sube de la media');
  }
});

test('con precios planos las bandas colapsan sobre la media', () => {
  const r = bollinger([7, 7, 7, 7, 7, 7], 3, 2);
  assert.equal(r.media[5], 7);
  assert.equal(r.alta[5], 7, 'desviacion cero');
  assert.equal(r.baja[5], 7);
});

test('el ATR de la primera vela usa su rango, no su propio cierre', () => {
  // Sin cierre anterior, el rango verdadero es high menos low. Usando el cierre
  // propio saldria siempre lo mismo y el ATR arrancaria sesgado.
  const velas: Vela[] = [
    { t: 0, open: 10, high: 12, low: 8, close: 11, volume: 1 },
    { t: 1, open: 11, high: 13, low: 10, close: 12, volume: 1 },
    { t: 2, open: 12, high: 14, low: 11, close: 13, volume: 1 },
    { t: 3, open: 13, high: 15, low: 12, close: 14, volume: 1 },
  ];
  const r = atr(velas, 2);
  assert.equal(r[0], null);
  assert.equal(r[1], null);
  assert.ok((r[2] ?? 0) > 0);
});

test('el VWAP queda entre el minimo y el maximo de lo visto', () => {
  const velas: Vela[] = [
    { t: 0, open: 10, high: 12, low: 8, close: 10, volume: 100 },
    { t: 1, open: 10, high: 14, low: 10, close: 12, volume: 300 },
    { t: 2, open: 12, high: 16, low: 12, close: 14, volume: 200 },
  ];
  const r = vwap(velas);
  for (let i = 0; i < velas.length; i++) {
    const v = r[i];
    assert.ok(v != null && v >= 8 && v <= 16, `VWAP fuera de rango en ${i}: ${v}`);
  }
  // Pondera: la segunda vela trae la mitad del volumen, asi que tira de la media.
  assert.ok((r[1] ?? 0) > (r[0] ?? 0));
});

test('sin volumen el VWAP es un hueco, no un cero', () => {
  const velas: Vela[] = [
    { t: 0, open: 10, high: 10, low: 10, close: 10, volume: 0 },
    { t: 1, open: 10, high: 10, low: 10, close: 10, volume: 5 },
  ];
  const r = vwap(velas);
  assert.equal(r[0] ?? null, null, 'sin volumen acumulado no hay media ponderada');
  assert.equal(r[1], 10);
});

test('un periodo invalido no revienta: devuelve la serie a null', () => {
  assert.deepEqual(sma([1, 2, 3], 0), [null, null, null]);
  assert.deepEqual(ema([1, 2, 3], 0), [null, null, null]);
  assert.deepEqual(rsi([1, 2, 3], 0), [null, null, null]);
});

test('ninguna serie se sale de la longitud de la entrada', () => {
  const precios = Array.from({ length: 60 }, (_v, i) => 100 + i);
  const velas = velasDe(precios);
  assert.equal(sma(precios, 10).length, 60);
  assert.equal(ema(precios, 10).length, 60);
  assert.equal(rsi(precios, 14).length, 60);
  assert.equal(atr(velas, 14).length, 60);
  assert.equal(vwap(velas).length, 60);
  const m = macd(precios);
  assert.equal(m.macd.length, 60);
  assert.equal(m.senal.length, 60);
  assert.equal(m.histograma.length, 60);
  const b = bollinger(precios, 20);
  assert.equal(b.media.length, 60);
  assert.equal(b.alta.length, 60);
  assert.equal(b.baja.length, 60);
});
