import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchBitgetOi, fetchGateOi, fetchKucoinOi, fetchBybitOi } from './openInterest.ts';

/**
 * Las unidades de los CEX nuevos.
 *
 * Aqui esta el riesgo de verdad de esta seccion: los tres publican el tamano
 * en cosas distintas, y equivocarse no da un error, da una cifra plausible y
 * falsa. Gate en contratos de 0,0001 BTC, KuCoin en lotes de 0,001, y Bitget
 * en unidades del subyacente. Multiplicar mal por el multiplicador de Gate
 * daria diez mil veces el interes abierto del planeta.
 *
 * Las respuestas son recortes con la forma REAL de cada API, tomados el 24 de
 * septiembre de 2026.
 */

/** Sirve una respuesta fija sin tocar la red. */
function servir(cuerpo: unknown) {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(cuerpo), {
    status: 200, headers: { 'content-type': 'application/json' },
  })) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

test('Bitget: holdingAmount va en unidades del subyacente', async () => {
  const restaurar = servir({
    code: '00000',
    data: [{ symbol: 'BTCUSDT', holdingAmount: '32473.037', lastPr: '84441.7', ts: '1790285515690' }],
  });
  try {
    const r = await fetchBitgetOi(1_790_285_520_000);
    assert.equal(r.markets.length, 1);
    // 32.473,037 BTC por 84.441,7 dolares.
    assert.equal(Math.round(r.markets[0]?.openInterestUsd ?? 0), 2_742_078_448);
    assert.equal(r.markets[0]?.symbol, 'BTC');
    assert.equal(r.markets[0]?.symbolNative, 'BTCUSDT', 'se conserva el contrato nativo');
  } finally { restaurar(); }
});

test('Gate: SIN el multiplicador el numero sale diez mil veces mayor', async () => {
  const restaurar = servir([
    { name: 'BTC_USDT', type: 'direct', in_delisting: false,
      position_size: 281841843, quanto_multiplier: '0.0001', mark_price: '84420.9' },
  ]);
  try {
    const r = await fetchGateOi(1_790_285_520_000);
    const oi = r.markets[0]?.openInterestUsd ?? 0;
    // 281.841.843 contratos por 0,0001 son 28.184 BTC, no 281 millones.
    assert.equal(Math.round(oi), 2_379_334_204);
    assert.ok(oi < 1e10, `sin multiplicador saldrian ${281841843 * 84420.9} dolares`);
  } finally { restaurar(); }
});

test('Gate: un contrato inverso o en retirada no entra', async () => {
  const restaurar = servir([
    { name: 'A_USDT', type: 'inverse', in_delisting: false, position_size: 100, quanto_multiplier: '1', mark_price: '10' },
    { name: 'B_USDT', type: 'direct', in_delisting: true, position_size: 100, quanto_multiplier: '1', mark_price: '10' },
    { name: 'C_USDT', type: 'direct', in_delisting: false, position_size: 100, quanto_multiplier: '1', mark_price: '10' },
  ]);
  try {
    const r = await fetchGateOi(1);
    assert.deepEqual(r.markets.map((m) => m.symbol), ['C'], 'solo el lineal y vivo');
  } finally { restaurar(); }
});

test('KuCoin: lotes por multiplicador, y XBT es BTC', async () => {
  const restaurar = servir({
    code: '200000',
    data: [{ symbol: 'XBTUSDTM', type: 'FFWCSX', isInverse: false,
      openInterest: '11792506', multiplier: 0.001, markPrice: 84411.09 }],
  });
  try {
    const r = await fetchKucoinOi(1);
    assert.equal(r.markets[0]?.symbol, 'BTC', 'sin traducir, Bitcoin seria un activo aparte');
    // 11.792.506 lotes por 0,001 son 11.792,5 BTC.
    assert.equal(Math.round(r.markets[0]?.openInterestUsd ?? 0), 995_418_285);
  } finally { restaurar(); }
});

test('KuCoin: fuera los inversos y los futuros con vencimiento', async () => {
  const restaurar = servir({
    code: '200000',
    data: [
      { symbol: 'ETHUSDM', type: 'FFWCSX', isInverse: true, openInterest: '1', multiplier: 1, markPrice: 1 },
      { symbol: 'XBTMU26', type: 'FFICSX', isInverse: true, openInterest: '1', multiplier: 1, markPrice: 1 },
      { symbol: 'SOLUSDTM', type: 'FFWCSX', isInverse: false, openInterest: '1000', multiplier: 0.1, markPrice: 116 },
    ],
  });
  try {
    const r = await fetchKucoinOi(1);
    assert.deepEqual(r.markets.map((m) => m.symbol), ['SOL']);
  } finally { restaurar(); }
});

test('un codigo de error del proveedor no se lee como respuesta vacia', async () => {
  // Devolver cero mercados seria peor que fallar: la pantalla lo pintaria como
  // un exchange sin interes abierto en vez de como una fuente caida.
  for (const [nombre, cuerpo, fn] of [
    ['bitget', { code: '40001', msg: 'error' }, fetchBitgetOi],
    ['kucoin', { code: '400', data: [] }, fetchKucoinOi],
  ] as const) {
    const restaurar = servir(cuerpo);
    try {
      await assert.rejects(() => fn(1), new RegExp(nombre));
    } finally { restaurar(); }
  }
});

test('un tamano negativo se rechaza en vez de restar del total', async () => {
  const restaurar = servir({
    code: '00000',
    data: [{ symbol: 'BTCUSDT', holdingAmount: '-5', lastPr: '100', ts: '1' }],
  });
  try {
    await assert.rejects(() => fetchBitgetOi(1), /negative open interest/);
  } finally { restaurar(); }
});

test('sin precio el mercado se conserva con el dato en hueco, no en cero', async () => {
  const restaurar = servir({
    code: '00000',
    data: [{ symbol: 'BTCUSDT', holdingAmount: '10', lastPr: null, ts: '1' }],
  });
  try {
    const r = await fetchBitgetOi(1);
    assert.equal(r.markets.length, 1, 'el simbolo sigue listado');
    assert.equal(r.markets[0]?.openInterestUsd, null, 'y su valor es desconocido, no cero');
  } finally { restaurar(); }
});

test('cada fuente declara que parte del exchange cubre', async () => {
  const restaurar = servir({
    code: '00000',
    data: [{ symbol: 'BTCUSDT', holdingAmount: '1', lastPr: '1', ts: '1' }],
  });
  try {
    const r = await fetchBitgetOi(1);
    assert.match(r.coverage, /USDT/, 'la cobertura no puede quedarse vacia');
    assert.equal(r.convention, 'unverified', 'Bitget no documenta si cuenta una pata o dos');
  } finally { restaurar(); }
});

/**
 * El precio que viaja para detectar colisiones de ticker va POR UNIDAD.
 *
 * Es la trampa de este campo: Bybit lista `1000PEPEUSDT` y su `markPrice` es
 * el precio de mil PEPE. Comparado contra el PEPE de otro venue da un
 * desajuste de mil y aparta a Bybit como si listase otro activo, con lo que su
 * interes abierto desaparece del total de PEPE.
 *
 * El interes abierto en dolares NO sufre esto, porque tamano y precio van en
 * las mismas unidades de contrato y el multiplicador se cancela. Por eso el
 * fallo no se ve mirando la cifra: solo se ve en el filtro.
 */
test('Bybit: el precio de un contrato de 1000 va dividido por mil', async () => {
  const restaurar = servir({
    retCode: 0,
    result: {
      list: [
        { symbol: '1000PEPEUSDT', singleOpenInterestValue: '5000000', markPrice: '0.0044850', turnover24h: '1000' },
        { symbol: 'BTCUSDT', singleOpenInterestValue: '1000000', markPrice: '84000', turnover24h: '1000' },
      ],
    },
  });
  try {
    const r = await fetchBybitOi(1_790_000_000_000);
    const pepe = r.markets.find((m) => m.symbol === 'PEPE');
    const btc = r.markets.find((m) => m.symbol === 'BTC');
    assert.ok(pepe !== undefined && btc !== undefined);
    // 0,004485 entre mil: el precio de UN pepe, no el del contrato.
    assert.ok(Math.abs((pepe.mid ?? 0) - 0.000004485) < 1e-12, `mid de PEPE: ${pepe.mid}`);
    // Sin multiplicador en el nombre, el precio se queda tal cual.
    assert.equal(btc.mid, 84_000);
    // Y el interes abierto no cambia: no pasa por el multiplicador.
    assert.equal(pepe.openInterestUsd, 5_000_000);
  } finally { restaurar(); }
});
