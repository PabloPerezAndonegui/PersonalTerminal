import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AccountSnapshot, Position, PositionSide } from '@defi/core';
import { diffPositions } from './positionEvents.ts';

function pos(symbol: string, side: PositionSide, sizeBase: number, mark: number): Position {
  return {
    venue: 'hyperliquid', symbol, symbolNative: symbol, side, sizeBase,
    notionalUsd: sizeBase * mark, entryPrice: mark, markPrice: mark,
    unrealizedPnlUsd: 0, leverage: 5, liquidationPrice: null,
  };
}

function foto(positions: Position[], at = 1_000): AccountSnapshot {
  return {
    venue: 'hyperliquid', address: '0xabc', equityUsd: 1_000_000,
    marginUsedUsd: 100_000, positions, at,
  };
}

test('la primera lectura no genera ni un aviso', () => {
  // Lo contrario seria mandar 177 avisos de "posicion abierta" cada vez que se
  // reinicia la API, que es el error que convierte los avisos en ruido.
  assert.deepEqual(diffPositions(null, foto([pos('BTC', 'long', 1, 80_000)])), []);
});

test('abrir, cerrar y girar', () => {
  const antes = foto([pos('BTC', 'long', 1, 80_000), pos('ETH', 'short', 10, 3_000)]);
  const despues = foto([pos('ETH', 'long', 10, 3_000), pos('SOL', 'long', 100, 200)], 2_000);

  const e = diffPositions(antes, despues);
  const por = new Map(e.map((x) => [x.symbol, x]));

  assert.equal(por.get('BTC')?.kind, 'closed');
  assert.equal(por.get('BTC')?.notionalUsd, 0, 'cerrada es cero, no el valor de antes');
  assert.equal(por.get('BTC')?.side, 'long', 'el lado que TENIA');

  assert.equal(por.get('ETH')?.kind, 'flipped', 'un giro es un evento, no dos');
  assert.equal(por.get('ETH')?.side, 'long', 'el lado nuevo');
  assert.equal(por.get('ETH')?.deltaUsd, 60_000, 'cerrar 30k y abrir 30k mueve 60k');

  assert.equal(por.get('SOL')?.kind, 'opened');
  assert.equal(por.get('SOL')?.at, 2_000, 'sello de la lectura nueva');
});

test('EL PRECIO NO ES UN AVISO: la misma posicion a otro precio no dice nada', () => {
  // El caso que hace inservible avisar por nocional. BTC de 80k a 88k es un
  // 10 % mas de nocional sin que nadie haya tocado nada.
  const antes = foto([pos('BTC', 'long', 1, 80_000)]);
  const despues = foto([pos('BTC', 'long', 1, 88_000)], 2_000);
  assert.deepEqual(diffPositions(antes, despues), []);
});

test('subir y bajar se miden en tamano, y el importe va al precio de ahora', () => {
  const antes = foto([pos('BTC', 'long', 1, 80_000), pos('ETH', 'short', 10, 3_000)]);
  const despues = foto([pos('BTC', 'long', 1.5, 90_000), pos('ETH', 'short', 4, 3_000)], 2_000);

  const por = new Map(diffPositions(antes, despues).map((x) => [x.symbol, x]));

  assert.equal(por.get('BTC')?.kind, 'increased');
  assert.equal(por.get('BTC')?.deltaUsd, 45_000, 'medio BTC al precio de la lectura nueva');
  assert.equal(por.get('BTC')?.prevSizeBase, 1);

  assert.equal(por.get('ETH')?.kind, 'reduced', 'un corto que se achica es reduced');
  assert.equal(por.get('ETH')?.deltaUsd, 18_000);
});

test('un corto que se hace mas corto es "increased"', () => {
  // Con signo, -10 pasa a -20 y el numero BAJA. Lo que crece es la posicion.
  const e = diffPositions(
    foto([pos('ETH', 'short', 10, 3_000)]),
    foto([pos('ETH', 'short', 20, 3_000)], 2_000),
  );
  assert.equal(e[0]?.kind, 'increased');
});

test('el ruido de redondeo no avisa, el cambio de verdad si', () => {
  const antes = foto([pos('BTC', 'long', 1, 80_000)]);
  assert.deepEqual(diffPositions(antes, foto([pos('BTC', 'long', 1.005, 80_000)], 2_000)), [],
    'medio por ciento es redondeo');
  assert.equal(diffPositions(antes, foto([pos('BTC', 'long', 1.02, 80_000)], 2_000)).length, 1,
    'un dos por ciento ya es alguien operando');
});

test('las migajas no avisan', () => {
  // Restos de 20 dolares abriendose y cerrandose solos enterrarian lo demas.
  assert.deepEqual(diffPositions(foto([]), foto([pos('PURR', 'long', 1, 20)], 2_000)), []);
  assert.deepEqual(diffPositions(foto([pos('PURR', 'long', 1, 20)]), foto([], 2_000)), []);
});

test('el minimo se mide sobre LO QUE SE MUEVE, no sobre la posicion', () => {
  // Caso real de la primera prueba en vivo: el vault recorto BCH de 1,803 a
  // 1,234, o sea 192 dolares. La posicion valia 600, pero lo que se movio no
  // llega al minimo y no es una noticia.
  const antes = foto([pos('BCH', 'long', 1.803, 337.35)]);
  const despues = foto([pos('BCH', 'long', 1.234, 337.35)], 2_000);
  assert.deepEqual(diffPositions(antes, despues, { minNotionalUsd: 500 }), []);
  assert.equal(diffPositions(antes, despues, { minNotionalUsd: 100 }).length, 1,
    'con el minimo mas bajo si sale');
});

test('sin markPrice el precio se deduce del propio nocional, no de la resta', () => {
  // Hyperliquid no publica markPrice por posicion. Restar nocionales mezclaria
  // lo que ha operado el trader con lo que se ha movido el precio: aqui el
  // tamano baja a la mitad Y el precio sube un 25 %, y la resta diria 0.
  const sinPrecio = (sizeBase: number, mark: number): Position => ({
    venue: 'hyperliquid', symbol: 'BTC', symbolNative: 'BTC', side: 'long', sizeBase,
    notionalUsd: sizeBase * mark, entryPrice: null, markPrice: null,
    unrealizedPnlUsd: null, leverage: null, liquidationPrice: null,
  });
  const e = diffPositions(foto([sinPrecio(2, 80_000)]), foto([sinPrecio(1, 100_000)], 2_000));
  assert.equal(e[0]?.kind, 'reduced');
  assert.equal(e[0]?.deltaUsd, 100_000, 'un BTC al precio de ahora, no la resta de 60.000');
  assert.equal(e[0]?.markPrice, 100_000, 'y el precio queda anotado');
});

test('el que mueve mas dinero va primero', () => {
  const antes = foto([]);
  const despues = foto([
    pos('SOL', 'long', 10, 200),
    pos('BTC', 'long', 1, 80_000),
    pos('ETH', 'long', 2, 3_000),
  ], 2_000);
  assert.deepEqual(diffPositions(antes, despues).map((e) => e.symbol), ['BTC', 'ETH', 'SOL']);
});

test('una posicion con tamano cero no genera avisos', () => {
  // Sin tamano no hay ni porcentaje de cambio ni precio que deducir. Se deja
  // pasar en vez de dividir entre cero y publicar un Infinity.
  const cero: Position = {
    venue: 'hyperliquid', symbol: 'X', symbolNative: 'X', side: 'long', sizeBase: 0,
    notionalUsd: 0, entryPrice: null, markPrice: null, unrealizedPnlUsd: null,
    leverage: null, liquidationPrice: null,
  };
  assert.deepEqual(diffPositions(foto([cero]), foto([{ ...cero, sizeBase: 1, notionalUsd: 80_000 }], 2_000)), []);
});

test('el mismo activo en dos dexes HIP-3 son dos posiciones, no una', () => {
  // `xyz:NVDA` e `io:NVDA` comparten simbolo comun. Por simbolo, una pisaba
  // a la otra y cerrar la de io parecia no haber pasado.
  const xyz = { ...pos('NVDA', 'long', 1_000, 150), symbolNative: 'xyz:NVDA' };
  const io = { ...pos('NVDA', 'long', 500, 150), symbolNative: 'io:NVDA' };
  const eventos = diffPositions(foto([xyz, io]), foto([xyz], 2_000));
  assert.equal(eventos.length, 1);
  assert.equal(eventos[0]?.kind, 'closed');
  assert.equal(eventos[0]?.market, 'io:NVDA');
});
