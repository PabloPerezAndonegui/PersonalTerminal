import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchLlamaOi } from './llamaOi.ts';

/**
 * Lo que DefiLlama aporta y lo que hay que corregirle.
 *
 * Su dimension de interes abierto no es una lista de perps a una pata, aunque
 * se parezca. Trae tres cosas mezcladas y las tres se han visto dar un numero
 * equivocado antes de arreglarlas:
 *
 *   1. Normaliza a UNA pata, salvo en los perps HIP-3 de Hyperliquid, donde
 *      pasa el campo crudo, que viene a dos. Tratarlos igual deja a tradeXYZ
 *      contado al doble o a la mitad segun por donde se mire.
 *   2. Mete opciones y mercados de prediccion en la misma lista. Son 4,1 B de
 *      los 18,5 que publica, y no son perps.
 *   3. De algunos venues publica varias filas. De Paradex publica las opciones
 *      con 127 M y los perps con 9: quedarse con la mayor pone las opciones
 *      donde iban los perps.
 *
 * Los recortes tienen la forma REAL de su respuesta, tomados el 2 de octubre
 * de 2026.
 */

/** Sirve una respuesta fija sin tocar la red. */
function servir(cuerpo: unknown) {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(cuerpo), {
    status: 200, headers: { 'content-type': 'application/json' },
  })) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

const PROTOCOLO = {
  defillamaId: '1', name: 'X', total24h: 1, category: 'Derivatives', chains: ['Ethereum'],
};

test('un perp normal hereda la convencion de una pata que declara DefiLlama', async () => {
  const restaurar = servir({
    protocols: [{ ...PROTOCOLO, name: 'Grvt Perps', total24h: 599_000_000 }],
  });
  try {
    const r = await fetchLlamaOi(1_790_000_000_000);
    const p = r.protocols[0];
    assert.equal(p?.convention, 'single');
    assert.equal(p?.instrument, 'perp');
    // Y se marca que NO esta medido contra el venue: sale de que ellos digan
    // que normalizan, no de haberlo comprobado en GRVT.
    assert.equal(p?.conventionFromVenue, false);
  } finally { restaurar(); }
});

test('un HIP-3 de Hyperliquid va a DOS patas, que es la excepcion', async () => {
  const restaurar = servir({
    protocols: [
      { ...PROTOCOLO, name: 'tradeXYZ', total24h: 3_854_300_000, category: 'Interface', chains: ['Hyperliquid L1'] },
      { ...PROTOCOLO, name: 'Paragon', total24h: 20_300_000, category: 'Interface', chains: ['Hyperliquid L1'] },
    ],
  });
  try {
    const r = await fetchLlamaOi(1_790_000_000_000);
    assert.equal(r.protocols.length, 2);
    for (const p of r.protocols) {
      assert.equal(p.convention, 'double', `${p.label} tiene que ir a dos patas`);
      // Aqui SI esta medido: su cifra es la de la API de Hyperliquid, y
      // coincide exacta leyendo `metaAndAssetCtxs` con su `dex`.
      assert.equal(p.conventionFromVenue, true);
      // Y siguen siendo perps: tienen su propio libro y su propio funding, asi
      // que entran en el total en vez de quedarse fuera por la etiqueta.
      assert.equal(p.instrument, 'perp');
    }
  } finally { restaurar(); }
});

test('un "Interface" que NO es de Hyperliquid no se dobla', async () => {
  const restaurar = servir({
    protocols: [
      { ...PROTOCOLO, name: 'Vibe Trading', total24h: 700_000, category: 'Interface', chains: ['Arbitrum', 'Base'] },
    ],
  });
  try {
    const r = await fetchLlamaOi(1_790_000_000_000);
    assert.equal(r.protocols[0]?.convention, 'single');
    assert.equal(r.protocols[0]?.conventionFromVenue, false);
  } finally { restaurar(); }
});

test('las opciones y la prediccion se etiquetan para poder dejarlas fuera del total', async () => {
  const restaurar = servir({
    protocols: [
      { ...PROTOCOLO, name: 'Derive Options', total24h: 1_895_700_000, category: 'Options' },
      { ...PROTOCOLO, name: 'Kalshi', total24h: 1_466_100_000, category: 'Prediction Market' },
      { ...PROTOCOLO, name: 'Boros', total24h: 79_800_000, category: 'Interest Rate Derivatives' },
      { ...PROTOCOLO, name: 'Grvt Perps', total24h: 599_000_000 },
    ],
  });
  try {
    const r = await fetchLlamaOi(1_790_000_000_000);
    const porNombre = new Map(r.protocols.map((p) => [p.label, p.instrument]));
    assert.equal(porNombre.get('Derive Options'), 'option');
    assert.equal(porNombre.get('Kalshi'), 'prediction');
    assert.equal(porNombre.get('Boros'), 'rates');
    assert.equal(porNombre.get('Grvt Perps'), 'perp');
    // Ninguno se descarta: el dato esta y se puede mirar. Lo que no hace es
    // sumarse a un total de perps, y de eso se encarga quien lo suma.
    assert.equal(r.protocols.length, 4);
  } finally { restaurar(); }
});

test('una categoria que no conocemos NO se cuela como perp', async () => {
  const restaurar = servir({
    protocols: [{ ...PROTOCOLO, name: 'Algo Nuevo', total24h: 10_000_000, category: 'Insurance' }],
  });
  try {
    const r = await fetchLlamaOi(1_790_000_000_000);
    // El dia que inventen una categoria, la cifra no entra en el total sola.
    assert.equal(r.protocols[0]?.instrument, 'other');
  } finally { restaurar(); }
});

test('el respaldo de un venue nuestro coge los PERPS, no las opciones', async () => {
  const restaurar = servir({
    protocols: [
      // Paradex lo leemos directo, asi que su interes abierto no entra en la
      // lista. Pero las dos filas quedan como respaldo, y hay que elegir bien.
      { ...PROTOCOLO, name: 'Paradex Options', total24h: 127_500_000, category: 'Options' },
      { ...PROTOCOLO, name: 'Paradex Perps', total24h: 9_200_000 },
      { ...PROTOCOLO, name: 'Aster Perps', total24h: 1_421_000_000 },
    ],
  });
  try {
    const r = await fetchLlamaOi(1_790_000_000_000);
    // Ninguno entra en la lista: los tres son venues que leemos directos.
    assert.equal(r.protocols.length, 0);
    assert.equal(r.excluded, 3);

    const paradex = r.respaldoDeLosNuestros.get('paradex');
    assert.equal(paradex?.oiUsd, 9_200_000, 'tienen que ser los perps, no las opciones');
    assert.equal(paradex?.instrument, 'perp');

    // Aster es el motivo de que exista el respaldo: su API publica el interes
    // abierto simbolo a simbolo y nuestro adaptador no lo pide.
    assert.equal(r.respaldoDeLosNuestros.get('aster')?.oiUsd, 1_421_000_000);
  } finally { restaurar(); }
});

test('el orden de llegada no decide cual es el respaldo', async () => {
  const restaurar = servir({
    protocols: [
      { ...PROTOCOLO, name: 'Paradex Perps', total24h: 9_200_000 },
      { ...PROTOCOLO, name: 'Paradex Options', total24h: 127_500_000, category: 'Options' },
    ],
  });
  try {
    const r = await fetchLlamaOi(1_790_000_000_000);
    assert.equal(r.respaldoDeLosNuestros.get('paradex')?.oiUsd, 9_200_000);
  } finally { restaurar(); }
});

test('sin categoria no se supone que sea un perp', async () => {
  const restaurar = servir({
    protocols: [{ defillamaId: '9', name: 'Sin Categoria', total24h: 5_000_000, chains: [] }],
  });
  try {
    const r = await fetchLlamaOi(1_790_000_000_000);
    assert.equal(r.protocols[0]?.category, null);
    assert.equal(r.protocols[0]?.instrument, 'other');
  } finally { restaurar(); }
});

test('Lighter se cruza exacto: su despliegue en Robinhood no es el que leemos', async () => {
  const { venueDeNombre } = await import('./llamaOi.ts');
  assert.equal(venueDeNombre('Lighter Perps'), 'lighter');
  assert.equal(venueDeNombre('Lighter Robinhood Perps'), null, 'sin esto se perderian sus 177 M');
  assert.equal(venueDeNombre('Hyperliquid Perps'), 'hyperliquid', 'los demas siguen por contenido');
});
