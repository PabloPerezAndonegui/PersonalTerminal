import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PollingSource } from './polling.ts';

/**
 * Un reloj que se mueve a mano. Lo que se comprueba aqui es cuando una fuente
 * deja de estar fresca, y eso no se puede esperar de verdad: la de DefiLlama se
 * pide una vez por hora.
 */
function reloj(inicio = 1_000_000) {
  let t = inicio;
  return { ahora: () => t, avanza: (ms: number) => { t += ms; } };
}

const fuenteHoraria = (c: ReturnType<typeof reloj>) =>
  new PollingSource({
    id: 'horaria',
    intervalMs: 3_600_000,
    fetch: async () => [1, 2, 3],
    count: (d) => d.length,
    clock: c.ahora,
  });

test('una fuente horaria no se marca caduca a los 90 segundos', async () => {
  const c = reloj();
  const fuente = fuenteHoraria(c);
  await fuente.refreshNow();

  assert.equal(fuente.health().status, 'ok');

  // El umbral por defecto del collector. Con el aplicado a una fuente horaria,
  // los dos DefiLlama salian en amarillo permanente en Data Sources.
  c.avanza(91_000);
  assert.equal(fuente.health().status, 'ok');

  // Una hora y pico despues tampoco: ha perdido un ciclo, no dos.
  c.avanza(3_600_000);
  assert.equal(fuente.health().status, 'ok');
});

test('pero caduca al perder mas de dos ciclos suyos', async () => {
  const c = reloj();
  const fuente = fuenteHoraria(c);
  await fuente.refreshNow();

  c.avanza(2.5 * 3_600_000 + 1_000);
  const salud = fuente.health();
  assert.equal(salud.status, 'degraded');
  assert.match(salud.reason ?? '', /stale data/);
});

test('una fuente rapida conserva el suelo de 90 s y no uno nervioso', async () => {
  const c = reloj();
  const fuente = new PollingSource({
    id: 'rapida',
    intervalMs: 5_000,
    fetch: async () => [1],
    count: (d) => d.length,
    clock: c.ahora,
  });
  await fuente.refreshNow();

  // 2.5 ciclos suyos son 12,5 s. Sin el suelo, un hipo de red la pondria
  // amarilla constantemente.
  c.avanza(60_000);
  assert.equal(fuente.health().status, 'ok');

  c.avanza(31_000);
  assert.equal(fuente.health().status, 'degraded');
});

test('un umbral explicito manda sobre la cadencia', async () => {
  const c = reloj();
  const fuente = new PollingSource({
    id: 'explicita',
    intervalMs: 3_600_000,
    fetch: async () => [1],
    count: (d) => d.length,
    clock: c.ahora,
    thresholds: {
      staleAfterMs: 10_000,
      downAfterFailures: 3,
      coverageDegradedBelow: 0.8,
      windowSize: 50,
    },
  });
  await fuente.refreshNow();

  c.avanza(11_000);
  assert.equal(fuente.health().status, 'degraded');
});
