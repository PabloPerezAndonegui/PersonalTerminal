import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchCatalogoHl } from './hyperliquidMercados.ts';

/**
 * El catalogo de Hyperliquid con la forma real de sus respuestas (17 nov
 * 2026), recortada. Una respuesta por tipo de peticion.
 */
function servir(porTipo: (body: Record<string, unknown>) => unknown) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    return new Response(JSON.stringify(porTipo(body)), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

const CORE = [
  { universe: [
    { name: 'BTC', szDecimals: 5, maxLeverage: 40 },
    { name: 'OLD', szDecimals: 0, maxLeverage: 3, isDelisted: true },
  ] },
  [
    { funding: '0.0000125', openInterest: '100', prevDayPx: '60000', dayNtlVlm: '5000000', markPx: '63000', midPx: '63000', oraclePx: '62990' },
    { funding: '0', openInterest: '0', prevDayPx: '1', dayNtlVlm: '0', markPx: '1', midPx: '1', oraclePx: '1' },
  ],
];
const XYZ = [
  { universe: [{ name: 'xyz:SKHX', szDecimals: 2, maxLeverage: 10 }], collateralToken: 0 },
  [{ funding: '0.00000625', openInterest: '10', prevDayPx: '800', dayNtlVlm: '1000', markPx: '816', midPx: '816', oraclePx: '815' }],
];
const SPOT = [
  { tokens: [{ name: 'USDC', index: 0 }, { name: 'HYPE', index: 150 }],
    universe: [{ name: '@107', tokens: [150, 0], index: 107, isCanonical: false }] },
  [{ coin: '@107', prevDayPx: '66', dayNtlVlm: '65000000', markPx: '67.6', midPx: '67.6' }],
];

test('core, HIP-3 y spot, con los nombres de su web', async () => {
  const restaurar = servir((b) => (b['type'] === 'spotMetaAndAssetCtxs' ? SPOT : b['dex'] === 'xyz' ? XYZ : CORE));
  try {
    const anot = new Map([['xyz:SKHX', { category: 'stocks', displayName: 'SKHYNIX', keywords: ['memory'] }]]);
    const { mercados, dexesFallidos } = await fetchCatalogoHl([{ name: 'xyz', fullName: 'XYZ' }], anot);
    assert.deepEqual(dexesFallidos, []);
    const porCoin = new Map(mercados.map((m) => [m.coin, m]));
    // Lo retirado no se ensena, como en su web.
    assert.equal(porCoin.has('OLD'), false);
    assert.equal(porCoin.get('BTC')?.name, 'BTC-USDC');
    assert.equal(porCoin.get('BTC')?.openInterestUsd, 6_300_000, 'OI en monedas por el mark');
    // `xyz:SKHX` se ve como SKHYNIX, con su dex y su categoria.
    const sk = porCoin.get('xyz:SKHX');
    assert.equal(sk?.name, 'SKHYNIX-USDC');
    assert.equal(sk?.dex, 'xyz');
    assert.equal(sk?.category, 'stocks');
    // `@107` es HYPE/USDC.
    const hype = porCoin.get('@107');
    assert.equal(hype?.name, 'HYPE/USDC');
    assert.equal(hype?.kind, 'spot');
    assert.equal(hype?.fundingHourly, null, 'el spot no tiene funding');
  } finally { restaurar(); }
});

test('un dex que no responde se dice, y el resto sigue', async () => {
  const restaurar = servir((b) => (b['dex'] === 'xyz' ? { error: 'boom' } : b['type'] === 'spotMetaAndAssetCtxs' ? SPOT : CORE));
  try {
    const { mercados, dexesFallidos } = await fetchCatalogoHl([{ name: 'xyz', fullName: 'XYZ' }], new Map());
    assert.deepEqual(dexesFallidos, ['xyz']);
    assert.ok(mercados.some((m) => m.coin === 'BTC'));
  } finally { restaurar(); }
});
