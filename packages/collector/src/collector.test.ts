import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MarketSnapshot, VenueMeta } from '@defi/core';
import type { VenueAdapter, AdapterCost } from '@defi/venues';
import { Collector } from './collector.ts';

// --- Dobles de prueba --------------------------------------------------------

const meta = (id: string): VenueMeta => ({
  id,
  label: id,
  kind: 'perp-dex',
  chain: null,
  collateral: 'USDC',
  fundingIntervalHours: 1,
  fees: { makerBps: 0, takerBps: 0, freeClose: false },
  capabilities: { predictedFunding: false, orderBook: false, trading: false, publicPositions: false },
});

const snap = (venue: string, symbol: string, at: number): MarketSnapshot => ({
  venue,
  symbol,
  symbolNative: symbol,
  contractMultiplier: 1,
  mid: 100,
  bid: 100,
  ask: 100,
  funding: { rate: 0.0001, intervalHours: 1, predicted: null, nextFundingAt: null, kind: 'current', sourceField: 'test' },
  book: null,
  openInterestUsd: null,
  volume24hUsd: null,
  at,
  sourceAt: null,
});

/** Adaptador controlable: decide cuantos simbolos devuelve y cuando falla. */
class FakeAdapter implements VenueAdapter {
  readonly meta: VenueMeta;
  readonly cost: AdapterCost;
  symbols = 3;
  failWith: string | null = null;
  /** Para probar la validacion de plausibilidad. */
  volumeUsd: number | null = null;
  /** Reloj compartido con el collector, para sellar los snapshots. */
  clock: () => number;

  constructor(id: string, clock: () => number, cost: AdapterCost = { websockets: 0, requestsPerMinute: 1 }) {
    this.meta = meta(id);
    this.cost = cost;
    this.clock = clock;
  }

  #data = new Map<string, MarketSnapshot>();

  async refresh(): Promise<void> {
    if (this.failWith !== null) throw new Error(this.failWith);
    const at = this.clock();
    const next = new Map<string, MarketSnapshot>();
    for (let i = 0; i < this.symbols; i++) {
      const s = snap(this.meta.id, `S${i}`, at);
      next.set(`S${i}`, this.volumeUsd === null ? s : { ...s, volume24hUsd: this.volumeUsd });
    }
    this.#data = next;
  }

  snapshot(): ReadonlyMap<string, MarketSnapshot> {
    return this.#data;
  }
}

const BUDGET = { maxWebsockets: 10, maxRequestsPerMinute: 100 };

/** Collector con reloj manual. */
function build(adapters: FakeAdapter[], reloj: { t: number }, thresholds?: Partial<{ staleAfterMs: number; downAfterFailures: number; coverageDegradedBelow: number; windowSize: number }>) {
  return new Collector({
    adapters,
    budget: BUDGET,
    intervalMs: 1000,
    clock: () => reloj.t,
    thresholds: {
      staleAfterMs: 90_000,
      downAfterFailures: 3,
      coverageDegradedBelow: 0.8,
      windowSize: 50,
      ...thresholds,
    },
  });
}

// --- Pruebas -----------------------------------------------------------------

test('un ciclo correcto deja la fuente en ok con sus simbolos', async () => {
  const reloj = { t: 1_000_000 };
  const a = new FakeAdapter('uno', () => reloj.t);
  const c = build([a], reloj);

  const cycle = await c.runCycle();
  assert.equal(cycle.ok, 1);
  assert.equal(cycle.failed, 0);
  assert.equal(cycle.freshSymbols, 3);

  const [h] = c.health();
  assert.equal(h?.status, 'ok');
  assert.equal(h?.reason, null);
  assert.equal(h?.symbolCount, 3);
});

test('un venue que falla no impide que los demas completen el ciclo', async () => {
  const reloj = { t: 1_000_000 };
  const bueno = new FakeAdapter('bueno', () => reloj.t);
  const malo = new FakeAdapter('malo', () => reloj.t);
  malo.failWith = 'ECONNRESET';
  const c = build([bueno, malo], reloj);

  const cycle = await c.runCycle();
  assert.equal(cycle.ok, 1);
  assert.equal(cycle.failed, 1);
  // El bueno sigue aportando sus datos.
  assert.equal(c.snapshots().get('bueno')?.size, 3);
  assert.equal(c.snapshots().has('malo'), false);

  const malaSalud = c.health().find((h) => h.venue === 'malo');
  assert.equal(malaSalud?.status, 'down'); // nunca tuvo un ciclo correcto
  assert.match(malaSalud?.reason ?? '', /ECONNRESET/);
});

test('cae a down solo tras varios fallos seguidos, no al primero', async () => {
  const reloj = { t: 1_000_000 };
  const a = new FakeAdapter('uno', () => reloj.t);
  const c = build([a], reloj);

  await c.runCycle(); // ok, para que tenga un lastOkAt
  a.failWith = 'timeout';

  await c.runCycle();
  assert.equal(c.health()[0]?.status, 'degraded', 'un fallo aislado es degradacion');
  await c.runCycle();
  await c.runCycle();
  assert.equal(c.health()[0]?.status, 'down', 'tres seguidos ya es caida');
});

test('los datos obsoletos no salen por snapshots(), aunque el adaptador los conserve', async () => {
  const reloj = { t: 1_000_000 };
  const a = new FakeAdapter('uno', () => reloj.t);
  const c = build([a], reloj, { staleAfterMs: 10_000 });

  await c.runCycle();
  assert.equal(c.snapshots().get('uno')?.size, 3);

  // Pasa el tiempo sin refrescos correctos. El adaptador sigue teniendo los
  // datos en memoria, pero el collector deja de exponerlos: comparar un
  // funding de hace media hora contra uno de ahora inventa diferenciales.
  reloj.t += 30_000;
  assert.equal(c.snapshots().has('uno'), false);
  assert.equal(c.health()[0]?.status, 'degraded');
  assert.match(c.health()[0]?.reason ?? '', /stale data/);
});

test('una caida de cobertura degrada la fuente aunque la API responda 200', async () => {
  const reloj = { t: 1_000_000 };
  const a = new FakeAdapter('uno', () => reloj.t);
  a.symbols = 100;
  const c = build([a], reloj);

  // Varios ciclos sanos para fijar la media.
  for (let i = 0; i < 5; i++) {
    reloj.t += 1000;
    await c.runCycle();
  }
  assert.equal(c.health()[0]?.status, 'ok');

  // La API responde bien, pero devuelve la mitad de los simbolos. Este es el
  // fallo silencioso que motiva toda la seccion 6.
  a.symbols = 40;
  reloj.t += 1000;
  await c.runCycle();

  const h = c.health()[0];
  assert.equal(h?.status, 'degraded');
  assert.match(h?.reason ?? '', /coverage at/);
  assert.ok((h?.coverageRatio ?? 1) < 0.8);
});

test('la cobertura necesita varias muestras antes de juzgar', async () => {
  const reloj = { t: 1_000_000 };
  const a = new FakeAdapter('uno', () => reloj.t);
  a.symbols = 100;
  const c = build([a], reloj);

  await c.runCycle();
  a.symbols = 50;
  reloj.t += 1000;
  await c.runCycle();
  // Con dos muestras no hay media fiable: no se marca nada.
  assert.equal(c.health()[0]?.baselineSymbolCount, null);
  assert.equal(c.health()[0]?.status, 'ok');
});

test('el presupuesto rechaza venues y expone el motivo en vez de omitirlos', () => {
  const reloj = { t: 1_000_000 };
  const caro = new FakeAdapter('caro', () => reloj.t, { websockets: 9, requestsPerMinute: 1 });
  const barato = new FakeAdapter('barato', () => reloj.t, { websockets: 5, requestsPerMinute: 1 });

  const c = new Collector({
    adapters: [caro, barato],
    budget: { maxWebsockets: 10, maxRequestsPerMinute: 100 },
    intervalMs: 1000,
    clock: () => reloj.t,
  });

  assert.deepEqual(c.venues, ['caro']);
  assert.equal(c.rejected.length, 1);
  assert.equal(c.rejected[0]?.venue, 'barato');
  assert.match(c.rejected[0]?.reason ?? '', /WS/);
});

test('un fallo no borra la cobertura del ultimo ciclo bueno', async () => {
  const reloj = { t: 1_000_000 };
  const a = new FakeAdapter('uno', () => reloj.t);
  a.symbols = 50;
  const c = build([a], reloj);

  await c.runCycle();
  a.failWith = 'red caida';
  reloj.t += 1000;
  await c.runCycle();

  // symbolCount refleja el ultimo dato bueno, no cae a cero por un fallo de
  // red: si cayera, la cobertura se hundiria y ocultaria la causa real.
  assert.equal(c.health()[0]?.symbolCount, 50);
});

test('onCycle notifica y se puede dar de baja', async () => {
  const reloj = { t: 1_000_000 };
  const a = new FakeAdapter('uno', () => reloj.t);
  const c = build([a], reloj);

  let avisos = 0;
  const baja = c.onCycle(() => { avisos++; });
  await c.runCycle();
  assert.equal(avisos, 1);
  baja();
  await c.runCycle();
  assert.equal(avisos, 1);
});

// --- Validacion de plausibilidad en la ingesta -------------------------------

test('un venue que publica un volumen imposible se degrada solo', async () => {
  const reloj = { t: 1_000_000 };
  const a = new FakeAdapter('bueno', () => reloj.t);
  const malo = new FakeAdapter('malo', () => reloj.t);
  // El bug real de Paradex: 290.000 millones de volumen diario en un simbolo.
  malo.volumeUsd = 290e9;
  const c = build([a, malo], reloj);

  await c.runCycle();

  const salud = c.health().find((h) => h.venue === 'malo');
  assert.equal(salud?.status, 'degraded', 'responde perfecto pero el dato no vale');
  assert.match(salud?.reason ?? '', /implausible|unit error/);

  // Y no contagia al que esta bien.
  assert.equal(c.health().find((h) => h.venue === 'bueno')?.status, 'ok');
});

test('el ciclo informa de cuantos hallazgos hubo', async () => {
  const reloj = { t: 1_000_000 };
  const malo = new FakeAdapter('malo', () => reloj.t);
  malo.volumeUsd = 500e9;
  const c = build([malo], reloj);

  const cycle = await c.runCycle();
  assert.ok(cycle.findings > 0);
  assert.equal(c.findings[0]?.rule, 'volumen-imposible');
});

test('datos plausibles no generan ningun hallazgo', async () => {
  const reloj = { t: 1_000_000 };
  const c = build([new FakeAdapter('a', () => reloj.t)], reloj);
  const cycle = await c.runCycle();
  assert.equal(cycle.findings, 0);
  assert.equal(c.health()[0]?.status, 'ok');
});

test('un simbolo roto no se confunde con el venue entero roto', async () => {
  const sanos = { BTC: 78_000, ETH: 3_000, SOL: 100 };
  const c = new Collector({
    adapters: [
      adaptadorConPrecios('a', sanos),
      adaptadorConPrecios('b', sanos),
      adaptadorConPrecios('c', sanos),
      // Los desviados llevan el prefijo en el nombre nativo, que es lo que
      // convierte el desajuste en un fallo NUESTRO y no en dos activos que se
      // llaman igual. Sin el prefijo seria un aviso y no encenderia la luz.
      adaptadorConPrecios('unSimbolo', { ...sanos, ETH: 30_000 }, true),
      adaptadorConPrecios('todos', { BTC: 780_000, ETH: 30_000, SOL: 1_000 }, true),
    ] as never,
    budget: { maxWebsockets: 8, maxRequestsPerMinute: 240 },
    intervalMs: 60_000,
  });
  await c.runCycle();

  const uno = c.health().find((h) => h.venue === 'unSimbolo');
  // Antes el motivo no decia ni cuantos simbolos ni cual: "implausible value:
  // price 30000...". Con 178 simbolos, eso no permite decidir si el venue
  // sirve o no.
  assert.match(uno?.reason ?? '', /1 symbol \(ETH\)/);

  const todos = c.health().find((h) => h.venue === 'todos');
  assert.match(todos?.reason ?? '', /all 3 symbols/);
});

/** Adaptador de prueba con precios a medida, para las reglas de plausibilidad. */
function adaptadorConPrecios(id: string, precios: Record<string, number>, conPrefijo = false) {
  let snap = new Map<string, MarketSnapshot>();
  return {
    meta: {
      id, label: id, kind: 'perp-dex' as const, chain: null, collateral: 'USDC',
      fundingIntervalHours: 1,
      fees: { makerBps: 0, takerBps: 0, freeClose: false },
      capabilities: { predictedFunding: false, orderBook: false, trading: false, publicPositions: false },
    },
    cost: { websockets: 0, requestsPerMinute: 1 },
    async refresh() {
      snap = new Map(
        Object.entries(precios).map(([s, p]) => [
          s,
          {
            ...snap2(id, s),
            ...(conPrefijo ? { symbolNative: `1000${s}` } : {}),
            mid: p,
            bid: p,
            ask: p,
          },
        ]),
      );
    },
    snapshot() { return snap; },
  };
}

const snap2 = (venue: string, symbol: string): MarketSnapshot => ({
  venue, symbol, symbolNative: symbol, contractMultiplier: 1,
  mid: 100, bid: 100, ask: 100,
  funding: { rate: 0.0001, intervalHours: 1, predicted: null, nextFundingAt: null, kind: 'current', sourceField: 'test' },
  book: null, openInterestUsd: 1e6, volume24hUsd: 1e6, at: Date.now(), sourceAt: null,
});


test('la cadencia lenta no caduca datos entre ciclos y si los retira tras el margen', async () => {
  let at = 1_000_000;
  const adapter = new FakeAdapter('lento', () => at);
  const collector = new Collector({ adapters: [adapter], budget: BUDGET, intervalMs: 120_000, clock: () => at });
  await collector.runCycle();
  at += 119_000;
  assert.equal(collector.health()[0]?.status, 'ok');
  assert.equal(collector.snapshots().get('lento')?.size, 3);
  adapter.failWith = 'corte de red';
  await collector.runCycle();
  assert.equal(collector.health()[0]?.status, 'degraded');
  at += 182_000;
  assert.equal(collector.snapshots().size, 0);
  assert.equal(collector.health()[0]?.status, 'degraded');
  adapter.failWith = null;
  await collector.runCycle();
  assert.equal(collector.health()[0]?.status, 'ok');
  assert.equal(collector.snapshots().get('lento')?.size, 3);
});
