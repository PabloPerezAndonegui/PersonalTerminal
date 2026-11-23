import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conHuecos } from './chartGaps.ts';
test('OI: paso horario normal continuo, hora perdida rompe el trazo', () => {
  const result = conHuecos([{ time: 0, value: 10 }, { time: 3600, value: 20 }, { time: 10800, value: 30 }], 5760);
  assert.deepEqual(result, [{ time: 0, value: 10 }, { time: 3600, value: 20 }, { time: 3601 }, { time: 10800, value: 30 }]);
});
test('el umbral original de funding sigue en veinte minutos', () => {
  assert.equal(conHuecos([{ time: 0, value: 1 }, { time: 1800, value: 2 }]).length, 3);
});

test('con paso, el hueco se rellena y el eje queda proporcional al tiempo', () => {
  // Paso de una hora y tres horas sin datos: dos marcas vacias en medio.
  const r = conHuecos([{ time: 0, value: 1 }, { time: 3 * 3600, value: 2 }], 5760, { pasoSeconds: 3600 });
  assert.deepEqual(r, [{ time: 0, value: 1 }, { time: 3600 }, { time: 7200 }, { time: 10800, value: 2 }]);
});

test('con inicio de rango, el eje empieza ahi aunque los datos empiecen despues', () => {
  const r = conHuecos([{ time: 7200, value: 1 }], 5760, { pasoSeconds: 3600, desdeSeconds: 0 });
  assert.deepEqual(r, [{ time: 0 }, { time: 3600 }, { time: 7200, value: 1 }]);
});

test('el ultimo punto antes de un hueco es transparente: el tramo que cruza no se ve', async () => {
  const { ocultarSaltos } = await import('./chartGaps.ts');
  const r = ocultarSaltos([{ time: 0 }, { time: 1, value: 5 }, { time: 2 }, { time: 3, value: 6 }, { time: 4, value: 7 }, { time: 5 }], true);
  assert.equal(r[1]?.lineColor, 'transparent', 'el tramo de 1 a 3 cruza el hueco');
  assert.equal(r[3]?.lineColor, undefined, 'el de 3 a 4 es normal');
  assert.equal(r[4]?.lineColor, undefined, 'tras el ultimo no hay tramo que esconder');
  assert.equal(ocultarSaltos([{ time: 0, value: 1 }, { time: 1 }, { time: 2, value: 2 }], false)[0]?.color, 'transparent');
});
