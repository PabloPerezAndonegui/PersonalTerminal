import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSymbol } from './symbols.ts';

test('quita los sufijos de par mas comunes', () => {
  for (const native of ['BTC', 'BTC-PERP', 'BTCUSDT', 'BTC-USDC-PERP', 'btc_perp', 'BTC-USD']) {
    assert.equal(normalizeSymbol(native).symbol, 'BTC', native);
  }
});

test('los prefijos numericos son multiplicadores', () => {
  assert.deepEqual(normalizeSymbol('1000PEPE'), { symbol: 'PEPE', contractMultiplier: 1000 });
  assert.deepEqual(normalizeSymbol('1000000MOG'), { symbol: 'MOG', contractMultiplier: 1_000_000 });
});

test('el prefijo k se aplica solo a la lista conocida', () => {
  assert.deepEqual(normalizeSymbol('kPEPE'), { symbol: 'PEPE', contractMultiplier: 1000 });
  assert.deepEqual(normalizeSymbol('kBONK'), { symbol: 'BONK', contractMultiplier: 1000 });
});

test('NO destroza tickers legitimos que empiezan por K', () => {
  // El bug que casi meto: una heuristica de prefijo convertia KAITO en AITO.
  for (const ticker of ['KAITO', 'KSM', 'KAS', 'KAVA', 'KNC']) {
    assert.deepEqual(normalizeSymbol(ticker), { symbol: ticker, contractMultiplier: 1 }, ticker);
  }
});

test('no vacia un simbolo que coincide entero con un sufijo', () => {
  // 'USDC' es un activo, no un sufijo suelto.
  assert.equal(normalizeSymbol('USDC').symbol, 'USDC');
  assert.equal(normalizeSymbol('PERP').symbol, 'PERP');
});

test('los prefijos numericos solo cuentan si son potencias de diez', () => {
  // '2Z' es un ticker real de Hyperliquid. Aceptar cualquier numero como
  // multiplicador lo convertia en 'Z' x2, que es un activo distinto.
  assert.deepEqual(normalizeSymbol('2Z'), { symbol: '2Z', contractMultiplier: 1 });
  assert.deepEqual(normalizeSymbol('3LONG'), { symbol: '3LONG', contractMultiplier: 1 });
  // Y los legitimos siguen funcionando.
  assert.deepEqual(normalizeSymbol('10000SATS'), { symbol: 'SATS', contractMultiplier: 10_000 });
});

test('el mismo activo TradFi con el nombre de cada venue queda en uno', () => {
  // Sin esto el S&P eran cuatro filas, el oro cuatro y Nvidia tres, y ningun
  // cruce entre ellas aparecia porque para la app eran activos distintos.
  const casos: [string, string][] = [
    ['US500S', 'US500'], ['SPX500m', 'US500'], ['SPX500', 'US500'],
    ['NAS100', 'US100'], ['US100S', 'US100'],
    ['XAUS', 'XAU'], ['GOLD', 'XAU'], ['XAU (GOLD)', 'XAU'], ['XAG (SILVER)', 'XAG'],
    ['CL', 'WTI'], ['WTIOIL', 'WTI'],
    ['NVDA.US', 'NVDA'], ['NVDA_24_5', 'NVDA'], ['US100-USD', 'US100'],
  ];
  for (const [nativo, esperado] of casos) assert.equal(normalizeSymbol(nativo).symbol, esperado, nativo);
});

test('SPX a secas NO es el S&P: es el memecoin SPX6900', () => {
  // La razon de que los alias sean una tabla y no un patron. Unirlos mezclaria
  // dos activos separados por un factor de diez mil.
  assert.equal(normalizeSymbol('SPX').symbol, 'SPX');
  assert.equal(normalizeSymbol('SPXUSDT').symbol, 'SPX');
});

test('el prefijo de dex HIP-3 no forma parte del activo', () => {
  // entropy.io manda `io:NVDA`. Con el prefijo dentro, su NVDA no se cruzaba
  // con el de ningun otro venue.
  assert.equal(normalizeSymbol('io:NVDA').symbol, 'NVDA');
  assert.equal(normalizeSymbol('io:OAI').symbol, 'OPENAI', 'prefijo fuera y luego el alias');
  assert.equal(normalizeSymbol('xyz:XYZ100').symbol, 'US100', 'prefijo fuera y luego el alias');
  assert.equal(normalizeSymbol('xyz:SP500').symbol, 'US500');
  assert.equal(normalizeSymbol('BTC').symbol, 'BTC');
});

test('segunda tanda de alias: mismo contrato, otro ticker', () => {
  const casos: [string, string][] = [
    ['BZUSDT', 'BRENT'], ['XBR-USD', 'BRENT'], ['BRENTOIL', 'BRENT'], ['BRENT-USD', 'BRENT'],
    ['NG-USD-PERP', 'NATGAS'], ['XNG-USD', 'NATGAS'],
    ['BRKBUSDT', 'BRK.B'], ['BRK.B-USD', 'BRK.B'],
    ['VISA', 'V'], ['VANATOKEN', 'VANA'],
    ['CL (WTI Crude Oil)', 'WTI'], ['io:SKHX', 'SKHYNIX'], ['io:ANTH', 'ANTHROPIC'],
  ];
  for (const [nativo, esperado] of casos) assert.equal(normalizeSymbol(nativo).symbol, esperado, nativo);
});

test('las dos escalas de Anthropic no se juntan', () => {
  // ~1.686 $ y ~96,6 $: mismo emisor, contratos distintos.
  assert.equal(normalizeSymbol('ANTHROP-USD').symbol, 'ANT');
  assert.equal(normalizeSymbol('ANTHROPIC-USD').symbol, 'ANTHROPIC');
});
