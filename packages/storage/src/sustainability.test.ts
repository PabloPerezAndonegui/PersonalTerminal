import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from './db.ts';
import { pairSustainability } from './sustainability.ts';

const HORA = 3_600_000;
const T0 = 1_800_000_000_000;

function base() {
  return openDatabase({ path: ':memory:' });
}

/** Mete una muestra de funding de un venue. */
function muestra(db: ReturnType<typeof base>, ts: number, venue: string, symbol: string, hourly: number) {
  db.prepare(
    `INSERT OR REPLACE INTO market_snapshot (ts, venue, symbol, mid, funding_hourly)
     VALUES (?, ?, ?, 100, ?)`,
  ).run(ts, venue, symbol, hourly);
}

/** Serie de un par: mismo sello en los dos venues, cada 5 minutos. */
function serie(db: ReturnType<typeof base>, spreads: number[], pasoMs = 5 * 60_000, desde = T0) {
  spreads.forEach((s, i) => {
    muestra(db, desde + i * pasoMs, 'largo', 'X', 0);
    muestra(db, desde + i * pasoMs, 'corto', 'X', s);
  });
}

const PAR = [{ symbol: 'X', largo: 'largo', corto: 'corto' }];
const ahora = T0 + 20 * HORA;

test('mide el tiempo a favor, no el numero de muestras', () => {
  const db = base();
  // Tres tramos a favor y uno en contra: 75 % del tiempo.
  serie(db, [1e-4, 1e-4, 1e-4, 1e-4, -1e-4]);
  const [r] = pairSustainability(db, PAR, { now: ahora });

  assert.equal(r?.long.coveredMs, 4 * 5 * 60_000, 'cuatro tramos de cinco minutos');
  // El ultimo tramo cruza de positivo a negativo y cuenta a medias.
  assert.equal(r?.long.favourableMs, 3.5 * 5 * 60_000);
});

test('UN HUECO NO CUENTA como tiempo, ni a favor ni en contra', () => {
  const db = base();
  // Dos muestras seguidas, un agujero de seis horas, y dos mas.
  serie(db, [1e-4, 1e-4]);
  serie(db, [1e-4, 1e-4], 5 * 60_000, T0 + 6 * HORA);

  const [r] = pairSustainability(db, PAR, { now: ahora, maxGapMs: 15 * 60_000 });
  assert.equal(r?.long.coveredMs, 2 * 5 * 60_000, 'solo los dos tramos seguidos');
});

test('la tasa media va ponderada por tiempo', () => {
  const db = base();
  // Un tramo corto muy alto y uno largo bajo: la media tiene que parecerse
  // al bajo, que es el que dura. Contando muestras saldria la media simple.
  muestra(db, T0, 'largo', 'X', 0);
  muestra(db, T0, 'corto', 'X', 1e-3);
  muestra(db, T0 + 60_000, 'largo', 'X', 0);
  muestra(db, T0 + 60_000, 'corto', 'X', 1e-3);
  muestra(db, T0 + 11 * 60_000, 'largo', 'X', 0);
  muestra(db, T0 + 11 * 60_000, 'corto', 'X', 1e-5);

  const [r] = pairSustainability(db, PAR, { now: ahora, maxGapMs: 15 * 60_000 });
  const media = r?.long.meanHourly ?? 0;
  assert.ok(media < 6e-4, `la media ponderada es ${media}, deberia irse hacia el tramo largo`);
  assert.ok(media > 4e-4);
});

test('la ventana corta solo mira sus dias', () => {
  const db = base();
  // Diez dias atras, a favor. Dentro de los ultimos siete, en contra.
  serie(db, [1e-4, 1e-4, 1e-4], 5 * 60_000, ahora - 10 * 24 * HORA);
  serie(db, [-1e-4, -1e-4, -1e-4], 5 * 60_000, ahora - 2 * 24 * HORA);

  const [r] = pairSustainability(db, PAR, { now: ahora });
  assert.ok((r?.long.meanHourly ?? 0) < 1e-9 && (r?.long.meanHourly ?? 0) > -1e-9,
    'catorce dias: se compensan');
  assert.ok((r?.short.meanHourly ?? 0) < 0, 'siete dias: solo lo reciente, que va en contra');
});

test('un sello sin pareja en el otro venue no entra', () => {
  const db = base();
  serie(db, [1e-4, 1e-4]);
  // Una muestra suelta del corto, sin su pareja del largo.
  muestra(db, T0 + 10 * 60_000, 'corto', 'X', 5e-3);

  const [r] = pairSustainability(db, PAR, { now: ahora });
  assert.equal(r?.long.samples, 1, 'solo el tramo con las dos patas');
});

test('sin pares no se consulta nada', () => {
  assert.deepEqual(pairSustainability(base(), [], { now: ahora }), []);
});


test('cruce asimetrico: +9 a -1 permanece favorable el 90% del tramo', () => {
  const db = base();
  try {
    serie(db, [9, -1]);
    const [r] = pairSustainability(db, PAR, { now: ahora });
    assert.equal(r?.long.favourableMs, 270_000);
    assert.equal(r?.long.meanHourly, 4);
  } finally { db.close(); }
});

test('recorta el tramo en el limite de cada ventana, interpolando la tasa', () => {
  const db = base();
  try {
    const now = T0 + 14 * 24 * HORA;
    serie(db, [9, -1], 600_000, T0 - 300_000);
    serie(db, [9, -1], 600_000, now - 7 * 24 * HORA - 300_000);
    const [r] = pairSustainability(db, PAR, { now });
    assert.equal(r?.long.coveredMs, 900_000);
    assert.equal(r?.short.coveredMs, 300_000);
    assert.equal(r?.short.favourableMs, 240_000);
    assert.equal(r?.short.meanHourly, 1.5);
  } finally { db.close(); }
});

test('no incluye muestras futuras ni extiende la ultima lectura hasta ahora', () => {
  const db = base();
  try {
    serie(db, [1, 1, 100], 300_000);
    const [r] = pairSustainability(db, PAR, { now: T0 + 400_000 });
    assert.equal(r?.long.coveredMs, 300_000);
    assert.equal(r?.long.meanHourly, 1);
  } finally { db.close(); }
});
