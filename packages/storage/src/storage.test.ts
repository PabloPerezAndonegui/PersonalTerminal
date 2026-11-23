import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MarketSnapshot } from '@defi/core';
import { openDatabase } from './db.ts';
import { MIGRATIONS } from './schema.ts';
import { writeSnapshots, readSeries, readLatest, rollupHourly, purgeHourly, readVolumeAverages } from './market.ts';
import { addWallet, listWallets, removeWallet, validateAddress } from './wallets.ts';
import { SnapshotPersister, writeHealth, readUptime, runRetention, retentionPending } from './persistence.ts';
import {
  addFundingPosition, getFundingPosition, listFundingPositions, updateFundingPosition,
  positionMetrics, positionMetricsFromDb, estimateFundingFromHistory,
  addSizeChange, listSizeChanges, removeFundingPosition, type NewFundingPosition,
} from './fundingPositions.ts';
import {
  addIncomeEntry, listIncomeEntries, incomeTotals, setReferralLink, listReferralLinks,
} from './income.ts';
import {
  addPointsProgram, listPointsPrograms, removePointsProgram,
  addFarmingAction, listFarmingActions, actionMetrics, farmingPortfolio,
} from './farming.ts';
import { exportUserData, importUserData } from './backup.ts';

const HORA = 3_600_000;

const snap = (venue: string, symbol: string, at: number, over: Partial<MarketSnapshot> = {}): MarketSnapshot => ({
  venue,
  symbol,
  symbolNative: symbol,
  contractMultiplier: 1,
  mid: 100,
  bid: 100,
  ask: 100,
  funding: { rate: 0.0001, intervalHours: 1, predicted: null, nextFundingAt: null, kind: 'current', sourceField: 'test' },
  book: null,
  openInterestUsd: 1000,
  volume24hUsd: 5000,
  at,
  sourceAt: null,
  ...over,
});

const ciclo = (at: number, entradas: readonly [string, string, Partial<MarketSnapshot>?][]) => {
  const out = new Map<string, Map<string, MarketSnapshot>>();
  for (const [venue, symbol, over] of entradas) {
    const porSimbolo = out.get(venue) ?? new Map<string, MarketSnapshot>();
    porSimbolo.set(symbol, snap(venue, symbol, at, over ?? {}));
    out.set(venue, porSimbolo);
  }
  return out;
};

const db = () => openDatabase({ path: ':memory:' });

// --- Mercado -----------------------------------------------------------------

test('las migraciones se aplican y son idempotentes', () => {
  const d = db();
  const tablas = d
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as { name: string }[];
  const nombres = tablas.map((t) => t.name);
  for (const t of ['market_snapshot', 'market_hourly', 'source_health', 'wallet', 'funding_position']) {
    assert.ok(nombres.includes(t), t);
  }
  // Se compara con la longitud de la lista, no con un numero escrito a mano:
  // asi anadir una migracion no obliga a tocar este test, que es justo cuando
  // se cae en actualizarlo sin mirar si de verdad se aplico.
  const version = d.prepare('PRAGMA user_version').get() as { user_version: number };
  assert.equal(version.user_version, MIGRATIONS.length);
});

test('un ciclo se guarda entero y se relee', () => {
  const d = db();
  const escritas = writeSnapshots(d, 1000, ciclo(1000, [['hl', 'BTC'], ['hl', 'ETH'], ['dydx', 'BTC']]));
  assert.equal(escritas, 3);

  const serie = readSeries(d, { symbol: 'BTC', from: 0, to: 2000 });
  assert.equal(serie.length, 2);
  assert.deepEqual(serie.map((p) => p.venue).sort(), ['dydx', 'hl']);
});

test('el funding se guarda normalizado a horario, no en crudo', () => {
  const d = db();
  // Mismo funding real expresado a 1 h y a 8 h: al leerlos deben coincidir.
  writeSnapshots(d, 1000, ciclo(1000, [
    ['a', 'BTC', { funding: { rate: 0.0001, intervalHours: 1, predicted: null, nextFundingAt: null, kind: 'current', sourceField: 'test' } }],
    ['b', 'BTC', { funding: { rate: 0.0008, intervalHours: 8, predicted: null, nextFundingAt: null, kind: 'current', sourceField: 'test' } }],
  ]));

  const serie = readSeries(d, { symbol: 'BTC', from: 0, to: 2000 });
  const [a, b] = [serie.find((p) => p.venue === 'a'), serie.find((p) => p.venue === 'b')];
  assert.ok(Math.abs((a?.fundingHourly ?? 0) - (b?.fundingHourly ?? 0)) < 1e-12);
});

test('un dato ausente sigue siendo null al releerlo, nunca 0', () => {
  const d = db();
  writeSnapshots(d, 1000, ciclo(1000, [['hl', 'BTC', { openInterestUsd: null, volume24hUsd: null }]]));
  const [p] = readSeries(d, { symbol: 'BTC', from: 0, to: 2000 });
  assert.equal(p?.openInterestUsd, null);
  assert.equal(p?.volume24hUsd, null);
});

test('readSeries filtra por venue y por rango', () => {
  const d = db();
  writeSnapshots(d, 1000, ciclo(1000, [['hl', 'BTC'], ['dydx', 'BTC']]));
  writeSnapshots(d, 5000, ciclo(5000, [['hl', 'BTC'], ['dydx', 'BTC']]));

  assert.equal(readSeries(d, { symbol: 'BTC', from: 0, to: 9000, venues: ['hl'] }).length, 2);
  assert.equal(readSeries(d, { symbol: 'BTC', from: 2000, to: 9000 }).length, 2);
});

test('readLatest devuelve la ultima foto de cada venue', () => {
  const d = db();
  writeSnapshots(d, 1000, ciclo(1000, [['hl', 'BTC', { mid: 10 }], ['dydx', 'BTC', { mid: 11 }]]));
  writeSnapshots(d, 5000, ciclo(5000, [['hl', 'BTC', { mid: 20 }]]));

  const ultimas = readLatest(d, 'BTC');
  assert.equal(ultimas.length, 2);
  assert.equal(ultimas.find((p) => p.venue === 'hl')?.mid, 20);
  // dydx no reporto en el segundo ciclo: se conserva su ultima foto conocida.
  assert.equal(ultimas.find((p) => p.venue === 'dydx')?.mid, 11);
});

test('rollupHourly promedia por hora y borra el detalle', () => {
  const d = db();
  const base = 10 * HORA;
  writeSnapshots(d, base + 60_000, ciclo(base, [['hl', 'BTC', { mid: 100 }]]));
  writeSnapshots(d, base + 120_000, ciclo(base, [['hl', 'BTC', { mid: 200 }]]));

  const res = rollupHourly(d, base + HORA);
  assert.equal(res.agregadas, 1);
  assert.equal(res.borradas, 2);

  const fila = d.prepare('SELECT mid_avg, samples FROM market_hourly').get() as { mid_avg: number; samples: number };
  assert.equal(fila.mid_avg, 150);
  assert.equal(fila.samples, 2);
  assert.equal(readSeries(d, { symbol: 'BTC', from: 0, to: base + HORA }).length, 0);
});

test('rollupHourly no toca lo que aun esta dentro de la resolucion completa', () => {
  const d = db();
  writeSnapshots(d, 5 * HORA, ciclo(5 * HORA, [['hl', 'BTC']]));
  const res = rollupHourly(d, 2 * HORA);
  assert.equal(res.borradas, 0);
  assert.equal(readSeries(d, { symbol: 'BTC', from: 0, to: 10 * HORA }).length, 1);
});

test('purgeHourly limpia agregados viejos', () => {
  const d = db();
  const base = 10 * HORA;
  writeSnapshots(d, base, ciclo(base, [['hl', 'BTC']]));
  rollupHourly(d, base + HORA);
  assert.equal(purgeHourly(d, base + HORA), 1);
});

// --- Wallets -----------------------------------------------------------------

test('se guarda y se lista una wallet', () => {
  const d = db();
  const w = addWallet(d, { address: '0xAbC123', chain: 'Arbitrum', label: 'principal' }, 1000);
  assert.equal(w.chain, 'arbitrum', 'la red se normaliza a minusculas');
  assert.equal(w.address, '0xAbC123', 'la direccion conserva su capitalizacion');
  assert.equal(listWallets(d).length, 1);
});

test('la misma direccion y red no se duplica: actualiza la etiqueta', () => {
  const d = db();
  addWallet(d, { address: '0xabc', chain: 'base', label: 'vieja' }, 1000);
  addWallet(d, { address: '0xabc', chain: 'base', label: 'nueva' }, 2000);
  const todas = listWallets(d);
  assert.equal(todas.length, 1);
  assert.equal(todas[0]?.label, 'nueva');
});

test('la misma direccion en redes distintas son wallets distintas', () => {
  const d = db();
  addWallet(d, { address: '0xabc', chain: 'base' }, 1000);
  addWallet(d, { address: '0xabc', chain: 'arbitrum' }, 1000);
  assert.equal(listWallets(d).length, 2);
});

test('una seed phrase pegada por error se rechaza', () => {
  // El peor fallo posible de esta aplicacion seria guardar esto en claro.
  assert.throws(
    () => validateAddress('witch collapse practice feed shame open despair creek road again ice least'),
    /seed phrase/,
  );
});

test('se rechazan direcciones vacias o absurdamente largas', () => {
  assert.throws(() => validateAddress('   '), /is empty/);
  assert.throws(() => validateAddress('0x' + 'a'.repeat(200)), /too long/);
});

test('se puede borrar una wallet', () => {
  const d = db();
  const w = addWallet(d, { address: '0xabc', chain: 'base' }, 1000);
  assert.equal(removeWallet(d, w.id), true);
  assert.equal(removeWallet(d, w.id), false);
  assert.equal(listWallets(d).length, 0);
});

// --- Persistencia y retencion ------------------------------------------------

test('el primer ciclo escribe sin esperar al intervalo', () => {
  const d = db();
  const reloj = { t: 1_000_000 };
  const p = new SnapshotPersister({ db: d, intervalMs: 300_000, clock: () => reloj.t });
  // Si esperase cinco minutos, la base estaria vacia todo ese rato al arrancar.
  assert.equal(p.maybePersist(ciclo(reloj.t, [['hl', 'BTC']])), 1);
});

test('no se escribe hasta que pasa el intervalo', () => {
  const d = db();
  const reloj = { t: 1_000_000 };
  const p = new SnapshotPersister({ db: d, intervalMs: 300_000, clock: () => reloj.t });

  p.maybePersist(ciclo(reloj.t, [['hl', 'BTC']]));
  reloj.t += 60_000;
  assert.equal(p.maybePersist(ciclo(reloj.t, [['hl', 'BTC']])), 0, 'un minuto despues no toca');
  reloj.t += 240_000;
  assert.equal(p.maybePersist(ciclo(reloj.t, [['hl', 'BTC']])), 1, 'a los cinco minutos si');
});

test('una hora de ciclos a 60 s deja 12 volcados, no 60', () => {
  const d = db();
  const reloj = { t: 1_000_000 };
  const p = new SnapshotPersister({ db: d, intervalMs: 300_000, clock: () => reloj.t });

  // 60 ciclos = una hora. Se escribe en los minutos 0, 5, 10 ... 55.
  // Es la razon de ser de esta clase: 60 escrituras por hora contra 12.
  for (let i = 0; i < 60; i++) {
    p.maybePersist(ciclo(reloj.t, [['hl', 'BTC']]));
    reloj.t += 60_000;
  }
  const filas = d.prepare('SELECT COUNT(*) AS n FROM market_snapshot').get() as { n: number };
  assert.equal(filas.n, 12);
});

test('el uptime sale de las muestras de salud guardadas', () => {
  const d = db();
  writeHealth(d, 1000, [
    { source: 'hl', status: 'ok', reason: null, symbolCount: 100, latencyP50Ms: 50 },
    { source: 'paradex', status: 'down', reason: 'timeout', symbolCount: null, latencyP50Ms: null },
  ]);
  writeHealth(d, 2000, [
    { source: 'hl', status: 'ok', reason: null, symbolCount: 100, latencyP50Ms: 50 },
    { source: 'paradex', status: 'ok', reason: null, symbolCount: 60, latencyP50Ms: 900 },
  ]);

  const uptime = readUptime(d, 0, 9000);
  assert.equal(uptime.find((u) => u.source === 'hl')?.okRatio, 1);
  assert.equal(uptime.find((u) => u.source === 'paradex')?.okRatio, 0.5);
});

test('una fuente sin muestras no aparece: su uptime es desconocido, no 0%', () => {
  const d = db();
  writeHealth(d, 1000, [{ source: 'hl', status: 'ok', reason: null, symbolCount: 1, latencyP50Ms: 1 }]);
  const uptime = readUptime(d, 0, 9000);
  assert.deepEqual(uptime.map((u) => u.source), ['hl']);
});

test('la retencion comprime y purga mercado pero NO toca los datos del usuario', () => {
  const d = db();
  const ahora = 100 * 24 * 3_600_000;
  addWallet(d, { address: '0xabc', chain: 'base', label: 'mia' }, ahora);
  writeSnapshots(d, ahora - 30 * 24 * 3_600_000, ciclo(0, [['hl', 'BTC']]));
  writeSnapshots(d, ahora, ciclo(ahora, [['hl', 'BTC']]));

  const res = runRetention(d, { fullDays: 14, hourlyDays: 365 }, ahora);
  assert.equal(res.borradas, 1, 'la foto de hace 30 dias se comprime');
  assert.equal(res.agregadas, 1);
  assert.equal(readSeries(d, { symbol: 'BTC', from: 0, to: ahora + 1 }).length, 1, 'la reciente sigue');

  // Lo importante: los datos irreemplazables no se tocan jamas.
  assert.equal(listWallets(d).length, 1);
});

test('readVolumeAverages promedia y dice cuanto historico la respalda', () => {
  const d = db();
  const base = 100 * HORA;
  writeSnapshots(d, base, ciclo(base, [['hl', 'BTC', { volume24hUsd: 100 }]]));
  writeSnapshots(d, base + 2 * HORA, ciclo(base, [['hl', 'BTC', { volume24hUsd: 300 }]]));

  const [m] = readVolumeAverages(d, 0, base + 10 * HORA);
  assert.equal(m?.avgVolume24hUsd, 200);
  assert.equal(m?.samples, 2);
  // 2 horas entre la primera y la ultima muestra: es lo que la pantalla usa
  // para decir si la estimacion vale algo.
  assert.ok(Math.abs((m?.coverageHours ?? 0) - 2) < 1e-9);
});

test('un volumen desconocido no arrastra la media a la baja', () => {
  const d = db();
  const base = 100 * HORA;
  writeSnapshots(d, base, ciclo(base, [['hl', 'BTC', { volume24hUsd: 100 }]]));
  writeSnapshots(d, base + HORA, ciclo(base, [['hl', 'BTC', { volume24hUsd: null }]]));

  // El NULL se excluye del promedio en vez de contar como cero: si contase,
  // un venue con huecos pareceria tener la mitad de volumen del que tiene.
  const [m] = readVolumeAverages(d, 0, base + 10 * HORA);
  assert.equal(m?.avgVolume24hUsd, 100);
  assert.equal(m?.samples, 1);
});

// --- Arbitrajes de funding ---------------------------------------------------

const abrir = (d: ReturnType<typeof db>, over: Partial<NewFundingPosition> = {}) =>
  addFundingPosition(d, {
    symbol: 'BTC', longVenue: 'hl', shortVenue: 'dydx',
    notionalUsd: 10_000, openedAt: 100 * HORA, ...over,
  }, 100 * HORA);

test('una posicion se guarda y se lista, abiertas primero', () => {
  const d = db();
  abrir(d, { openedAt: 90 * HORA, closedAt: 95 * HORA });
  abrir(d, { symbol: 'ETH' });
  const todas = listFundingPositions(d);
  assert.equal(todas.length, 2);
  assert.equal(todas[0]?.closedAt, null, 'la abierta va primero');
});

test('no se admite un arbitraje contra el mismo venue', () => {
  assert.throws(() => abrir(db(), { shortVenue: 'hl' }), /same venue/);
});

test('no se admite un cierre anterior a la apertura', () => {
  assert.throws(() => abrir(db(), { closedAt: 50 * HORA }), /before the open date/);
});

test('los importes desconocidos son null y no cero', () => {
  const p = abrir(db());
  assert.equal(p.feesPaidUsd, null);
  assert.equal(p.fundingCollectedUsd, null);
  // Y sin ellos no hay neto: no se afirma un resultado que no se conoce.
  assert.equal(positionMetrics(p, 108 * HORA).netUsd, null);
});

test('OI·h es nocional por horas, y el coste por 1k sale del neto', () => {
  const d = db();
  const p = abrir(d);
  updateFundingPosition(d, p.id, { feesPaidUsd: 20, fundingCollectedUsd: 50 });
  const actualizada = getFundingPosition(d, p.id)!;

  const m = positionMetrics(actualizada, 110 * HORA);
  assert.equal(m.hours, 10);
  assert.equal(m.oiHours, 100_000, '10.000 USD x 10 h');
  assert.equal(m.netUsd, 30);
  // Neto positivo = coste NEGATIVO: te han pagado por generar esa actividad.
  assert.ok(Math.abs((m.costPer1kOiHours ?? 0) - -0.3) < 1e-12);
});

test('undefined no toca un campo, null lo pone en desconocido', () => {
  const d = db();
  const p = abrir(d);
  updateFundingPosition(d, p.id, { feesPaidUsd: 20 });
  updateFundingPosition(d, p.id, { fundingCollectedUsd: 5 });
  assert.equal(getFundingPosition(d, p.id)?.feesPaidUsd, 20, 'no se toco al no venir');

  // Se metio mal y hay que poder borrarlo, no solo sobrescribirlo.
  updateFundingPosition(d, p.id, { feesPaidUsd: null });
  assert.equal(getFundingPosition(d, p.id)?.feesPaidUsd, null);
});

test('el funding se estima del historico e informa de cuanto lo cubre', () => {
  const d = db();
  const p = abrir(d, { openedAt: 100 * HORA });

  // Dos fotos con las dos patas: el corto paga 0.0002/h y el largo 0.0001/h.
  for (const t of [100 * HORA, 101 * HORA]) {
    writeSnapshots(d, t, ciclo(t, [
      ['hl', 'BTC', { funding: { rate: 0.0001, intervalHours: 1, predicted: null, nextFundingAt: null, kind: 'current', sourceField: 'test' } }],
      ['dydx', 'BTC', { funding: { rate: 0.0002, intervalHours: 1, predicted: null, nextFundingAt: null, kind: 'current', sourceField: 'test' } }],
    ]));
  }

  const e = estimateFundingFromHistory(d, p, 102 * HORA);
  // Diferencial 0.0001/h x 10.000 USD x 2 h = 2 USD.
  assert.ok(Math.abs(e.estimatedUsd - 2) < 1e-9);
  assert.equal(e.samples, 2);
  assert.equal(e.coverage, 1);
});

test('sin las dos patas en la misma foto no se estima nada', () => {
  const d = db();
  const p = abrir(d, { openedAt: 100 * HORA });
  // Solo una pata registrada: no se puede calcular un diferencial.
  writeSnapshots(d, 100 * HORA, ciclo(100 * HORA, [['hl', 'BTC']]));

  const e = estimateFundingFromHistory(d, p, 102 * HORA);
  assert.equal(e.samples, 0);
  assert.equal(e.coverage, 0, 'la pantalla tiene que poder decir que no hay respaldo');
});

test('la cobertura parcial se refleja, no se disimula', () => {
  const d = db();
  const p = abrir(d, { openedAt: 100 * HORA });
  writeSnapshots(d, 100 * HORA, ciclo(100 * HORA, [
    ['hl', 'BTC'], ['dydx', 'BTC'],
  ]));

  // Una sola foto en un periodo de 10 h. Antes se estiraba hasta el final y
  // daba 100 %: una lectura respaldando diez horas. Una muestra habla de su
  // hora y de ninguna mas, asi que cubre una de diez.
  const e = estimateFundingFromHistory(d, p, 110 * HORA);
  assert.ok(Math.abs(e.coverage - 0.1) < 1e-9, `cobertura ${e.coverage}`);
  assert.equal(e.samples, 1);
});

test('una foto vieja no respalda una posicion que sigue abierta', () => {
  const d = db();
  const p = abrir(d, { openedAt: 100 * HORA });
  writeSnapshots(d, 100 * HORA, ciclo(100 * HORA, [
    ['hl', 'BTC', { funding: { rate: 0.0001, intervalHours: 1, predicted: null, nextFundingAt: null, kind: 'current', sourceField: 'test' } }],
    ['dydx', 'BTC', { funding: { rate: 0.0002, intervalHours: 1, predicted: null, nextFundingAt: null, kind: 'current', sourceField: 'test' } }],
  ]));

  // Posicion abierta hace una semana con una unica lectura, del primer dia.
  // Daba 168 USD estimados y 100 % de cobertura. El importe hay que darlo —es
  // lo unico que se sabe— pero la cobertura tiene que delatar de que va
  // respaldado, que es de una hora entre 168.
  const e = estimateFundingFromHistory(d, p, 268 * HORA);
  assert.ok(Math.abs(e.estimatedUsd - 1) < 1e-9, `estimado ${e.estimatedUsd}`);
  assert.ok(e.coverage < 0.01, `cobertura ${e.coverage}`);
});

test('el tope no toca la marcha normal', () => {
  const d = db();
  const p = abrir(d, { openedAt: 100 * HORA });
  // Fotos cada 5 minutos, que es la cadencia real del volcado.
  for (let i = 0; i < 12; i++) {
    const t = 100 * HORA + i * 5 * 60_000;
    writeSnapshots(d, t, ciclo(t, [['hl', 'BTC'], ['dydx', 'BTC']]));
  }
  const e = estimateFundingFromHistory(d, p, 101 * HORA);
  assert.equal(e.samples, 12);
  assert.ok(e.coverage > 0.99, `una hora bien muestreada esta cubierta entera: ${e.coverage}`);
});

// --- Ingresos ----------------------------------------------------------------

test('sin ninguna entrada los totales son null, no cero', () => {
  // "No he cobrado nada" y "no he apuntado nada" son cosas distintas.
  const t = incomeTotals([]);
  assert.equal(t.referralUsd, null);
  assert.equal(t.competitionUsd, null);
  assert.equal(t.totalUsd, null);
});

test('los totales separan referidos de competiciones', () => {
  const d = db();
  addIncomeEntry(d, { kind: 'referral', venue: 'hyperliquid', amountUsd: 120, receivedAt: 1000 });
  addIncomeEntry(d, { kind: 'competition', venue: 'hyperliquid', amountUsd: 500, receivedAt: 2000 });
  addIncomeEntry(d, { kind: 'referral', venue: 'pacifica', amountUsd: 30, receivedAt: 3000 });

  const t = incomeTotals(listIncomeEntries(d));
  assert.equal(t.referralUsd, 150);
  assert.equal(t.competitionUsd, 500);
  assert.equal(t.totalUsd, 650);
  assert.equal(t.byVenue[0]?.venue, 'hyperliquid', 'el de mas ingresos primero');
  assert.equal(t.byVenue[0]?.totalUsd, 620);
});

test('se admite un importe negativo: una comision revertida es un ingreso negativo', () => {
  const d = db();
  addIncomeEntry(d, { kind: 'referral', venue: 'x', amountUsd: 100, receivedAt: 1000 });
  addIncomeEntry(d, { kind: 'referral', venue: 'x', amountUsd: -40, receivedAt: 2000 });
  // Forzarlo a positivo falsearia el total.
  assert.equal(incomeTotals(listIncomeEntries(d)).referralUsd, 60);
});

test('se listan los cobros mas recientes primero', () => {
  const d = db();
  addIncomeEntry(d, { kind: 'referral', venue: 'a', amountUsd: 1, receivedAt: 1000 });
  addIncomeEntry(d, { kind: 'referral', venue: 'b', amountUsd: 1, receivedAt: 5000 });
  assert.equal(listIncomeEntries(d)[0]?.venue, 'b');
});

test('un enlace de referido debe ser http(s)', () => {
  const d = db();
  assert.throws(() => setReferralLink(d, 'x', 'javascript:alert(1)'), /http/);
  assert.throws(() => setReferralLink(d, 'x', 'ftp://algo'), /http/);
  assert.equal(setReferralLink(d, 'x', 'https://ref.example/abc').url, 'https://ref.example/abc');
});

test('guardar dos veces el enlace de un venue lo reemplaza', () => {
  const d = db();
  setReferralLink(d, 'hyperliquid', 'https://a.example');
  setReferralLink(d, 'hyperliquid', 'https://b.example');
  const todos = listReferralLinks(d);
  assert.equal(todos.length, 1);
  assert.equal(todos[0]?.url, 'https://b.example');
});

// --- Farmeo ------------------------------------------------------------------

test('los puntos se estiman por cuota de volumen del epoch', () => {
  const d = db();
  const prog = addPointsProgram(d, {
    venue: 'perpl', pointsPerEpoch: 50_000, epochLabel: 'per week', epochVolumeUsd: 1_000_000,
  });
  const accion = addFarmingAction(d, {
    programId: prog.id, volumeUsd: 100_000, feesPaidUsd: 45, pnlUsd: 0, occurredAt: 1000,
  });

  const m = actionMetrics(accion, prog);
  // 10 % del volumen del epoch = 10 % de los puntos.
  assert.equal(m.points, 5000);
  assert.equal(m.pointsEstimated, true);
  assert.ok(Math.abs((m.costPerPoint ?? 0) - 0.009) < 1e-12);
});

test('unos puntos conocidos mandan sobre la estimacion', () => {
  const d = db();
  const prog = addPointsProgram(d, {
    venue: 'x', pointsPerEpoch: 50_000, epochLabel: 'per week', epochVolumeUsd: 1_000_000,
  });
  const accion = addFarmingAction(d, {
    programId: prog.id, volumeUsd: 100_000, pointsEarned: 7200, feesPaidUsd: 36, occurredAt: 1000,
  });

  const m = actionMetrics(accion, prog);
  assert.equal(m.points, 7200, 'se usa el dato real, no el 5000 estimado');
  assert.equal(m.pointsEstimated, false);
});

test('sin los datos del epoch no se estima nada', () => {
  const d = db();
  // Falta el volumen del epoch: no hay cuota que calcular.
  const prog = addPointsProgram(d, { venue: 'x', pointsPerEpoch: 50_000, epochLabel: 'per week' });
  const accion = addFarmingAction(d, { programId: prog.id, volumeUsd: 100_000, occurredAt: 1000 });

  const m = actionMetrics(accion, prog);
  assert.equal(m.points, null, 'una estimacion con un hueco dentro es un numero inventado');
  assert.equal(m.costPerPoint, null);
});

test('si ganas operando mas que las fees, el punto sale gratis o te pagan', () => {
  const d = db();
  const prog = addPointsProgram(d, {
    venue: 'x', pointsPerEpoch: 10_000, epochLabel: 'per week', epochVolumeUsd: 100_000,
  });
  // 10 % del epoch = 1000 puntos. Fees 30, pero ganaste 50 operando.
  const accion = addFarmingAction(d, {
    programId: prog.id, volumeUsd: 10_000, feesPaidUsd: 30, pnlUsd: 50, occurredAt: 1000,
  });

  const m = actionMetrics(accion, prog);
  assert.equal(m.costPerPoint, 0.03);
  // (30 - 50) / 1000 = -0.02: negativo, te pagaron por farmear.
  assert.ok(Math.abs((m.netCostPerPoint ?? 0) - -0.02) < 1e-12);
});

test('el portafolio distingue lo estimado de lo conocido', () => {
  const d = db();
  const prog = addPointsProgram(d, {
    venue: 'x', pointsPerEpoch: 10_000, epochLabel: 'per week', epochVolumeUsd: 100_000,
  });
  addFarmingAction(d, { programId: prog.id, volumeUsd: 10_000, feesPaidUsd: 30, pnlUsd: 0, occurredAt: 1000 });
  addFarmingAction(d, { programId: prog.id, pointsEarned: 500, feesPaidUsd: 10, pnlUsd: 0, occurredAt: 2000 });

  const p = farmingPortfolio(listFarmingActions(d), listPointsPrograms(d));
  assert.equal(p.totalPoints, 1500);
  assert.equal(p.estimatedPoints, 1000, 'dos tercios vienen de una estimacion');
  assert.equal(p.totalFeesUsd, 40);
});

test('sin acciones los totales son null, no cero', () => {
  const p = farmingPortfolio([], []);
  assert.equal(p.totalPoints, null);
  assert.equal(p.totalFeesUsd, null);
  // 0 afirmaria que no has pagado fees; lo cierto es que no se sabe.
  assert.equal(p.avgCostPerPoint, null);
});

test('borrar un programa se lleva sus acciones', () => {
  const d = db();
  const prog = addPointsProgram(d, { venue: 'x', epochLabel: 'per week' });
  addFarmingAction(d, { programId: prog.id, occurredAt: 1000 });
  removePointsProgram(d, prog.id);
  // Quedarian contando puntos de un programa que ya no existe.
  assert.equal(listFarmingActions(d).length, 0);
});

test('no se admite una accion sobre un programa inexistente', () => {
  assert.throws(() => addFarmingAction(db(), { programId: 'no-existe', occurredAt: 1000 }), /does not exist/);
});

test('la hora que parte el corte no se pierde a medias', () => {
  const d = db();
  const base = 100 * HORA;
  const MIN = 60_000;

  // Tres fotos en la primera media hora y dos en la segunda.
  for (const m of [0, 10, 20]) writeSnapshots(d, base + m * MIN, ciclo(base, [['hl', 'BTC', { mid: 100 }]]));
  for (const m of [40, 50]) writeSnapshots(d, base + m * MIN, ciclo(base, [['hl', 'BTC', { mid: 200 }]]));

  // Corte a media hora, que es lo que pasa cada dia: la hora queda partida.
  // Antes, este pase agregaba las tres primeras y las borraba, y el pase
  // siguiente REESCRIBIA la fila con solo las dos ultimas: la hora acababa en
  // 200 con dos muestras, y las tres primeras se perdian del todo.
  rollupHourly(d, base + 30 * MIN);
  assert.equal(
    d.prepare('SELECT COUNT(*) AS n FROM market_hourly').get()?.n,
    0,
    'una hora incompleta no se agrega todavia',
  );
  assert.equal(
    d.prepare('SELECT COUNT(*) AS n FROM market_snapshot').get()?.n,
    5,
    'y sus fotos siguen enteras, sin borrar la mitad',
  );

  // Pase siguiente, con la hora ya cerrada.
  rollupHourly(d, base + 2 * HORA);
  const fila = d.prepare('SELECT mid_avg, samples FROM market_hourly').get() as { mid_avg: number; samples: number };
  assert.equal(fila.samples, 5, 'las cinco muestras de esa hora cuentan');
  assert.equal(fila.mid_avg, 140, 'tres a 100 y dos a 200');
});

test('un pase de retencion repetido no altera lo ya agregado', () => {
  const d = db();
  const base = 100 * HORA;
  writeSnapshots(d, base, ciclo(base, [['hl', 'BTC', { mid: 100 }]]));
  writeSnapshots(d, base + 30 * 60_000, ciclo(base, [['hl', 'BTC', { mid: 200 }]]));

  rollupHourly(d, base + 2 * HORA);
  const antes = d.prepare('SELECT mid_avg, samples FROM market_hourly').get();

  // Segundo pase: ya no quedan fotos que agregar, asi que no debe tocar nada.
  rollupHourly(d, base + 3 * HORA);
  assert.deepEqual(d.prepare('SELECT mid_avg, samples FROM market_hourly').get(), antes);
});

test('la retencion se recupera tras un reinicio, sin temporizador', () => {
  const d = db();
  const ahora = 100 * 24 * HORA;
  const politica = { fullDays: 14, hourlyDays: 365 };

  // Dato de hace 20 dias: lleva pendiente desde antes del ultimo arranque.
  const viejo = ahora - 20 * 24 * HORA;
  writeSnapshots(d, viejo, ciclo(viejo, [['hl', 'BTC']]));
  // Y uno reciente, que no debe tocarse.
  writeSnapshots(d, ahora - HORA, ciclo(ahora - HORA, [['hl', 'BTC']]));

  // Antes esto dependia de `ultimaRetencion = Date.now()` en memoria: en una Pi
  // que se reinicia a diario, el contador volvia a cero cada vez y la retencion
  // no llegaba a ejecutarse NUNCA.
  assert.equal(retentionPending(d, politica, ahora), true, 'hay trabajo atrasado y se ve en los datos');

  runRetention(d, politica, ahora);
  assert.equal(retentionPending(d, politica, ahora), false, 'hecho el trabajo, ya no queda');

  // El reciente sigue a resolucion completa.
  assert.equal(readSeries(d, { symbol: 'BTC', from: ahora - 2 * HORA, to: ahora }).length, 1);
});

test('sin trabajo atrasado no se dispara un pase en balde', () => {
  const d = db();
  const ahora = 100 * 24 * HORA;
  writeSnapshots(d, ahora - HORA, ciclo(ahora - HORA, [['hl', 'BTC']]));
  // Se comprueba en cada ciclo, o sea cada 60 s: si diese true sin haber nada
  // que hacer, estaria reescribiendo la base entera un millar de veces al dia.
  assert.equal(retentionPending(d, { fullDays: 14, hourlyDays: 365 }, ahora), false);
});

test('repetir la retencion no duplica ni pierde', () => {
  const d = db();
  const ahora = 100 * 24 * HORA;
  const politica = { fullDays: 14, hourlyDays: 365 };
  const viejo = ahora - 20 * 24 * HORA;
  writeSnapshots(d, viejo, ciclo(viejo, [['hl', 'BTC', { mid: 100 }]]));
  writeSnapshots(d, viejo + 60_000, ciclo(viejo, [['hl', 'BTC', { mid: 200 }]]));

  runRetention(d, politica, ahora);
  const tras1 = d.prepare('SELECT mid_avg, samples FROM market_hourly').get();
  // Un reinicio en mitad del dia podria dispararla otra vez: tiene que ser
  // inocuo, no rehacer la media con la mitad de las muestras.
  runRetention(d, politica, ahora);
  assert.deepEqual(d.prepare('SELECT mid_avg, samples FROM market_hourly').get(), tras1);
  assert.equal(d.prepare('SELECT COUNT(*) AS n FROM market_hourly').get()?.n, 1, 'una sola fila por hora');
});

// --- Ciclo completo de una posicion ------------------------------------------

test('apertura, aumento, reduccion y cierre: el OI-hora integra los tramos', () => {
  const d = db();
  // 10k por pata durante 10 h, 30k durante 10 h, 5k durante 10 h.
  const p = abrir(d, { openedAt: 100 * HORA, notionalUsd: 10_000 });
  addSizeChange(d, { positionId: p.id, at: 110 * HORA, notionalUsd: 30_000, note: 'aumento' });
  addSizeChange(d, { positionId: p.id, at: 120 * HORA, notionalUsd: 5_000, note: 'reduccion' });
  updateFundingPosition(d, p.id, { closedAt: 130 * HORA, feesPaidUsd: 45, fundingCollectedUsd: 120 });

  const cerrada = getFundingPosition(d, p.id)!;
  const m = positionMetricsFromDb(d, cerrada, 200 * HORA);

  assert.equal(m.hours, 30);
  // 10.000x10 + 30.000x10 + 5.000x10 = 450.000 OI-h POR PATA.
  // Antes se calculaba 10.000 x 30 h = 300.000: un tercio de menos, y el coste
  // por 1k OI-h salia inflado en esa misma proporcion.
  assert.equal(m.oiHours, 450_000);
  assert.equal(m.netUsd, 75, '120 cobrados menos 45 de fees');
  // -75 / 450 = -0.1667: negativo, o sea que te pagaron por generar esa actividad.
  assert.ok(Math.abs((m.costPer1kOiHours ?? 0) - -75 / 450) < 1e-12);
});

test('sin cambios de tamano el calculo es el de siempre', () => {
  const d = db();
  const p = abrir(d, { openedAt: 100 * HORA, notionalUsd: 10_000 });
  const m = positionMetricsFromDb(d, p, 110 * HORA);
  assert.equal(m.oiHours, 100_000, '10.000 x 10 h');
});

test('un cambio posterior al cierre no alarga la posicion', () => {
  const d = db();
  const p = abrir(d, { openedAt: 100 * HORA, notionalUsd: 10_000 });
  updateFundingPosition(d, p.id, { closedAt: 110 * HORA });
  // Metido por error con fecha posterior al cierre.
  addSizeChange(d, { positionId: p.id, at: 150 * HORA, notionalUsd: 99_000 });

  const m = positionMetricsFromDb(d, getFundingPosition(d, p.id)!, 200 * HORA);
  assert.equal(m.oiHours, 100_000, 'solo cuentan las 10 h que estuvo abierta');
});

test('reducir a cero deja de acumular OI-hora', () => {
  const d = db();
  const p = abrir(d, { openedAt: 100 * HORA, notionalUsd: 10_000 });
  addSizeChange(d, { positionId: p.id, at: 105 * HORA, notionalUsd: 0 });
  // Sigue "abierta" en el registro pero sin tamano: no genera actividad.
  const m = positionMetricsFromDb(d, p, 200 * HORA);
  assert.equal(m.oiHours, 50_000, '10.000 x 5 h y nada mas');
});

test('un cambio anterior a la apertura se rechaza', () => {
  const d = db();
  const p = abrir(d, { openedAt: 100 * HORA });
  assert.throws(() => addSizeChange(d, { positionId: p.id, at: 50 * HORA, notionalUsd: 1000 }), /predate/);
});

test('borrar la posicion se lleva sus cambios de tamano', () => {
  const d = db();
  const p = abrir(d, { openedAt: 100 * HORA });
  addSizeChange(d, { positionId: p.id, at: 110 * HORA, notionalUsd: 20_000 });
  removeFundingPosition(d, p.id);
  assert.equal(listSizeChanges(d, p.id).length, 0);
});

test('ingresos, premios y puntos no se mezclan con el P&L de la posicion', () => {
  const d = db();
  // Una posicion con su resultado.
  const p = abrir(d, { openedAt: 100 * HORA, notionalUsd: 10_000 });
  updateFundingPosition(d, p.id, { closedAt: 110 * HORA, feesPaidUsd: 20, fundingCollectedUsd: 50 });

  // Y por otro lado un referido y un premio, que NO son resultado de operar.
  addIncomeEntry(d, { kind: 'referral', venue: 'hl', amountUsd: 500, receivedAt: 105 * HORA });
  addIncomeEntry(d, { kind: 'competition', venue: 'hl', amountUsd: 1000, receivedAt: 105 * HORA });

  // Y unos puntos farmeados, que son una tercera cosa.
  const prog = addPointsProgram(d, { venue: 'hl', pointsPerEpoch: 1000, epochLabel: 'per week', epochVolumeUsd: 100_000 });
  addFarmingAction(d, { programId: prog.id, volumeUsd: 10_000, feesPaidUsd: 20, pnlUsd: 0, occurredAt: 105 * HORA });

  // El neto de la posicion NO incluye ni el referido ni el premio ni los puntos:
  // sumarlos haria parecer rentable una estrategia que no lo es.
  const m = positionMetricsFromDb(d, getFundingPosition(d, p.id)!, 200 * HORA);
  assert.equal(m.netUsd, 30, 'solo funding menos fees');

  assert.equal(incomeTotals(listIncomeEntries(d)).totalUsd, 1500, 'los ingresos van por su lado');
  assert.equal(farmingPortfolio(listFarmingActions(d), listPointsPrograms(d)).totalPoints, 100);
});

// --- Copia de seguridad ------------------------------------------------------

test('la copia lleva los datos propios y NO los de mercado', () => {
  const d = db();
  addWallet(d, { address: '0xabc', chain: 'base' });
  writeSnapshots(d, 1000, ciclo(1000, [['hl', 'BTC']]));

  const copia = exportUserData(d, 5000);
  assert.equal(copia.tables['wallet']?.length, 1);
  // El mercado se vuelve a recoger; esto son cientos de miles de filas que no
  // pintan nada en una copia de lo irreemplazable.
  assert.equal(copia.tables['market_snapshot'], undefined);
  assert.equal(copia.createdAt, 5000);
});

test('una copia se restaura entera en una base vacia', () => {
  const origen = db();
  addWallet(origen, { address: '0xabc', chain: 'base', label: 'mia' });
  const p = addFundingPosition(origen, {
    symbol: 'BTC', longVenue: 'hl', shortVenue: 'dydx', notionalUsd: 10_000, openedAt: 100 * HORA,
  });
  addSizeChange(origen, { positionId: p.id, at: 110 * HORA, notionalUsd: 30_000 });
  addIncomeEntry(origen, { kind: 'referral', venue: 'hl', amountUsd: 250, receivedAt: 100 * HORA });

  const destino = db();
  const res = importUserData(destino, exportUserData(origen));

  assert.equal(res.total, 4);
  assert.equal(listWallets(destino)[0]?.label, 'mia');
  assert.equal(listSizeChanges(destino, p.id).length, 1, 'los cambios de tamano viajan con su posicion');
  assert.equal(incomeTotals(listIncomeEntries(destino)).totalUsd, 250);
});

test('restaurar se niega a pisar datos que ya existen', () => {
  const origen = db();
  addWallet(origen, { address: '0xabc', chain: 'base' });
  const copia = exportUserData(origen);

  const destino = db();
  addWallet(destino, { address: '0xotra', chain: 'base', label: 'la buena' });

  // Restaurar es justo cuando uno se equivoca de fichero. Perder los registros
  // buenos por encima de los malos es lo que la copia existe para evitar.
  assert.throws(() => importUserData(destino, copia), /already has user data/);
  assert.equal(listWallets(destino)[0]?.label, 'la buena', 'sigue intacta');
});

test('una restauracion a medias no deja la base a medio llenar', () => {
  const destino = db();
  // Copia con una fila valida y otra que viola la clave primaria de la segunda.
  const rota = {
    format: 'defi-terminal-user-backup' as const,
    version: 1 as const,
    createdAt: 0,
    schemaVersion: 5,
    tables: {
      wallet: [
        { id: 'a', address: '0x1', chain: 'base', label: null, notes: null, created_at: 1 },
        { id: 'a', address: '0x2', chain: 'base', label: null, notes: null, created_at: 1 },
      ],
    },
  };
  assert.throws(() => importUserData(destino, rota));
  assert.equal(listWallets(destino).length, 0, 'la transaccion se deshace entera');
});

test('un fichero que no es una copia se rechaza antes de tocar nada', () => {
  const destino = db();
  assert.throws(
    () => importUserData(destino, { format: 'otra-cosa', version: 1, createdAt: 0, schemaVersion: 1, tables: {} } as never),
    /not a user backup/,
  );
});
