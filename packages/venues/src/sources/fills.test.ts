import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchHyperliquidFills } from './fills.ts';

/**
 * Las ejecuciones de Hyperliquid, con las tres trampas que tiene su formato.
 * Los recortes tienen la forma REAL de `userFills`, tomados el 13 de
 * noviembre de 2026.
 */

function servir(cuerpo: unknown) {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(cuerpo), {
    status: 200, headers: { 'content-type': 'application/json' },
  })) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

const CUENTA = '0x0000000000000000000000000000000000000000';
const FILL = {
  coin: 'ETH', px: '3000', sz: '2', side: 'B', time: 1_790_000_000_000,
  dir: 'Open Long', closedPnl: '0.0', fee: '0.9', tid: 1,
};

test('cerrar un largo NO es ponerse corto', async () => {
  // La trampa de este endpoint: cerrar un largo es una VENTA, asi que `side`
  // viene como "A". Leyendo el lado de ahi, una salida se convierte en una
  // entrada del lado contrario. Manda `dir`, que lo declara el venue.
  const restaurar = servir([
    { ...FILL, tid: 1, side: 'B', dir: 'Open Long' },
    { ...FILL, tid: 2, side: 'A', dir: 'Close Long' },
    { ...FILL, tid: 3, side: 'A', dir: 'Open Short' },
    { ...FILL, tid: 4, side: 'B', dir: 'Close Short' },
  ]);
  try {
    const { fills } = await fetchHyperliquidFills(CUENTA);
    assert.deepEqual(fills.map((f) => f.side), ['long', 'long', 'short', 'short']);
  } finally { restaurar(); }
});

test('un lote de mil se normaliza y el nocional no cambia', async () => {
  // kPEPE: precio por lote de mil. Por unidad es mil veces menor y el tamano
  // mil veces mayor. El nocional se calcula ANTES de normalizar y no se toca.
  const restaurar = servir([{ ...FILL, coin: 'kPEPE', px: '0.004', sz: '50000' }]);
  try {
    const { fills } = await fetchHyperliquidFills(CUENTA);
    const f = fills[0];
    assert.equal(f?.symbol, 'PEPE');
    assert.equal(f?.symbolNative, 'kPEPE');
    assert.ok(Math.abs((f?.px ?? 0) - 0.000004) < 1e-12);
    assert.equal(f?.sz, 50_000_000);
    assert.equal(f?.notionalUsd, 200, 'px por sz en unidades del venue: 0,004 por 50.000');
  } finally { restaurar(); }
});

test('2.000 justas significa que puede haber mas', async () => {
  const lleno = Array.from({ length: 2000 }, (_v, i) => ({ ...FILL, tid: i + 1 }));
  let restaurar = servir(lleno);
  try {
    assert.equal((await fetchHyperliquidFills(CUENTA)).completo, false);
  } finally { restaurar(); }
  restaurar = servir(lleno.slice(0, 1999));
  try {
    assert.equal((await fetchHyperliquidFills(CUENTA)).completo, true);
  } finally { restaurar(); }
});

test('una fila sin precio, sin tamano o sin identificador no entra', async () => {
  const restaurar = servir([
    { ...FILL, tid: 1 },
    { ...FILL, tid: 2, px: null },
    { ...FILL, tid: 3, sz: 'abc' },
    { ...FILL, tid: undefined },
    { ...FILL, tid: 5, px: '0' },
    'basura',
  ]);
  try {
    const { fills } = await fetchHyperliquidFills(CUENTA);
    assert.deepEqual(fills.map((f) => f.tid), ['1']);
  } finally { restaurar(); }
});

test('una respuesta que no es una lista es un error, no cero ejecuciones', async () => {
  // Cero ejecuciones es "no ha operado". Un error del venue no es eso, y
  // confundirlos callaria a una wallet que si esta operando.
  const restaurar = servir({ error: 'rate limited' });
  try {
    await assert.rejects(() => fetchHyperliquidFills(CUENTA));
  } finally { restaurar(); }
});
