import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AccountSnapshot } from '@defi/core';
import { openDatabase, addTrader, updateTrader, removeTrader } from '@defi/storage';
import { TraderTracker, traderStatus } from './traderTracker.ts';

const DIR_A = '0x1111111111111111111111111111111111111111';
const DIR_B = '0x2222222222222222222222222222222222222222';

const cuenta = (address: string, posiciones = 1): AccountSnapshot => ({
  venue: 'hyperliquid',
  address,
  equityUsd: 1000,
  marginUsedUsd: 100,
  positions: Array.from({ length: posiciones }, () => ({
    venue: 'hyperliquid',
    symbol: 'BTC',
    symbolNative: 'BTC',
    side: 'long' as const,
    sizeBase: 1,
    notionalUsd: 80_000,
    entryPrice: 79_000,
    markPrice: 80_000,
    unrealizedPnlUsd: 1_000,
    leverage: 5,
    liquidationPrice: null,
  })),
  at: 1,
});

/** Reloj de mentira: el tiempo aqui lo mueve el test, no el sistema. */
function reloj(inicio = 1_000_000) {
  let t = inicio;
  return { ahora: () => t, avanza: (ms: number) => { t += ms; } };
}

function base() {
  const db = openDatabase({ path: ':memory:' });
  return db;
}

test('conserva la ultima foto buena cuando falla, y no la convierte en "sin posiciones"', async () => {
  const db = base();
  const t = addTrader(db, { address: DIR_A });
  const c = reloj();
  let fallar = false;

  const tracker = new TraderTracker({
    db,
    clock: c.ahora,
    fetchPositions: async (a) => {
      if (fallar) throw new Error('timeout');
      return cuenta(a, 3);
    },
  });

  await tracker.tick();
  assert.equal(tracker.state(t.id)?.account?.positions.length, 3);
  assert.equal(traderStatus(t, tracker.state(t.id), tracker.staleAfterMs, c.ahora()), 'ok');

  fallar = true;
  c.avanza(60_000);
  await tracker.tick();

  const e = tracker.state(t.id);
  assert.equal(e?.account?.positions.length, 3, 'la foto buena SIGUE ahi');
  assert.equal(e?.error, 'timeout', 'y el fallo se ve');
  assert.equal(e?.failures, 1);
});

test('la espera se dobla con cada fallo seguido', async () => {
  const db = base();
  const t = addTrader(db, { address: DIR_A });
  const c = reloj();
  const tracker = new TraderTracker({
    db,
    clock: c.ahora,
    intervalMs: 60_000,
    fetchPositions: async () => { throw new Error('429'); },
  });

  const esperas: number[] = [];
  for (let i = 0; i < 3; i++) {
    c.avanza(60 * 60_000); // Se pasa de sobra el tiempo de espera anterior.
    await tracker.tick();
    const e = tracker.state(t.id)!;
    esperas.push(e.nextAttemptAt - c.ahora());
  }

  assert.deepEqual(esperas, [60_000, 120_000, 240_000], '1, 2 y 4 vueltas');
});

test('pausar impide nuevas consultas', async () => {
  const db = base();
  const t = addTrader(db, { address: DIR_A });
  const c = reloj();
  let llamadas = 0;
  const tracker = new TraderTracker({
    db,
    clock: c.ahora,
    fetchPositions: async (a) => { llamadas++; return cuenta(a); },
  });

  await tracker.tick();
  assert.equal(llamadas, 1);

  updateTrader(db, t.id, { active: false });
  c.avanza(60_000);
  await tracker.tick();
  assert.equal(llamadas, 1, 'pausado no se vuelve a consultar');
  // Pero lo ultimo que se le vio SE CONSERVA. Borrarlo haria que la fila
  // pasase sola de tener posiciones a no tener ninguna sin que ocurriese
  // nada, que es justo lo que no puede hacer esta pantalla.
  assert.equal(tracker.state(t.id)?.account?.positions.length, 1, 'conserva la ultima lectura');
});

test('una respuesta que llega tarde NO resucita a un trader pausado', async () => {
  // El caso delicado: se pausa mientras una peticion esta en el
  // aire. Sin el testigo, al resolverse volveria a escribir estado y el
  // trader apareceria como seguido y con datos frescos.
  const db = base();
  const t = addTrader(db, { address: DIR_A });
  const c = reloj();

  let resolver: ((v: AccountSnapshot) => void) | null = null;
  const enVuelo = new Promise<AccountSnapshot>((r) => { resolver = r; });

  const tracker = new TraderTracker({ db, clock: c.ahora, fetchPositions: () => enVuelo });

  const pendiente = tracker.tick();
  updateTrader(db, t.id, { active: false });
  // La pausa se aplica en el siguiente barrido de la lista.
  await tracker.tick();
  resolver!(cuenta(DIR_A));
  await pendiente;

  // Nunca hubo lectura buena, asi que la tardia no puede haber dejado uno.
  assert.equal(tracker.state(t.id)?.account, null, 'la respuesta tardia se descarta');
  assert.equal(tracker.state(t.id)?.updatedAt, null);
});

test('borrar a un trader lo saca del seguimiento', async () => {
  const db = base();
  const t = addTrader(db, { address: DIR_A });
  const c = reloj();
  let llamadas = 0;
  const tracker = new TraderTracker({
    db, clock: c.ahora,
    fetchPositions: async (a) => { llamadas++; return cuenta(a); },
  });

  await tracker.tick();
  removeTrader(db, t.id);
  c.avanza(60_000);
  await tracker.tick();

  assert.equal(llamadas, 1);
  assert.equal(tracker.state(t.id), null, 'borrado si se olvida del todo');
});

test('reparte: en cada vuelta consulta a uno, no a todos', async () => {
  const db = base();
  addTrader(db, { address: DIR_A });
  addTrader(db, { address: DIR_B });
  const c = reloj();
  const pedidas: string[] = [];
  const tracker = new TraderTracker({
    db, clock: c.ahora,
    fetchPositions: async (a) => { pedidas.push(a); return cuenta(a); },
  });

  await tracker.tick();
  assert.equal(pedidas.length, 1, 'una peticion por tick');
  c.avanza(1_000);
  await tracker.tick();
  assert.deepEqual([...pedidas].sort(), [DIR_A, DIR_B], 'y le toca al otro');
});

test('los cuatro estados que hay que distinguir', () => {
  const db = base();
  const t = addTrader(db, { address: DIR_A });
  const pausado = { ...t, active: false };
  const ahora = 1_000_000;

  assert.equal(traderStatus(pausado, null, 150_000, ahora), 'paused');
  assert.equal(traderStatus(t, null, 150_000, ahora), 'waiting', 'todavia sin datos');
  assert.equal(
    traderStatus(t, { account: null, updatedAt: null, error: 'boom', errorAt: ahora, failures: 1, nextAttemptAt: ahora, lastAttemptAt: ahora }, 150_000, ahora),
    'failing',
    'falla y nunca hubo datos',
  );
  assert.equal(
    traderStatus(t, { account: cuenta(DIR_A), updatedAt: ahora - 200_000, error: null, errorAt: null, failures: 0, nextAttemptAt: ahora, lastAttemptAt: ahora }, 150_000, ahora),
    'stale',
    'hay datos pero ya no valen como actuales',
  );
  // "Sin posiciones" NO es un estado: es ok con la lista vacia.
  const vacia = { ...cuenta(DIR_A), positions: [] };
  assert.equal(
    traderStatus(t, { account: vacia, updatedAt: ahora, error: null, errorAt: null, failures: 0, nextAttemptAt: ahora, lastAttemptAt: ahora }, 150_000, ahora),
    'ok',
  );
});
