import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allSources, sourcesForSection, NON_VENUE_SOURCES } from './registry.ts';
import { resolveImpact, impactForSection, statusToLight } from './impact.ts';
import { SECTION_ORDER, SECTION_LABELS } from './types.ts';
import type { SourceState } from './impact.ts';

const VENUES = [
  { id: 'hyperliquid', label: 'Hyperliquid' },
  { id: 'paradex', label: 'Paradex' },
];
const CATALOGO = allSources(VENUES);

const estados = (m: Record<string, 'green' | 'yellow' | 'red'>): SourceState[] =>
  Object.entries(m).map(([id, light]) => ({ id, light }));

/** Todas las fuentes en verde, para partir de un caso sano. */
const todoVerde = (): SourceState[] =>
  CATALOGO.map((s) => ({ id: s.id, light: 'green' as const }));

test('el catalogo incluye un venue por adaptador mas las fuentes externas', () => {
  assert.equal(CATALOGO.length, VENUES.length + NON_VENUE_SOURCES.length);
  assert.ok(CATALOGO.some((s) => s.id === 'hyperliquid'));
  assert.ok(CATALOGO.some((s) => s.id === 'defillama-pools'));
});

test('cada seccion del menu tiene rotulo', () => {
  for (const s of SECTION_ORDER) {
    assert.equal(typeof SECTION_LABELS[s], 'string');
    assert.ok(SECTION_LABELS[s].length > 0, s);
  }
});

test('con todo en verde ninguna seccion esta afectada', () => {
  for (const impacto of resolveImpact(CATALOGO, todoVerde())) {
    assert.equal(impacto.light, 'green', impacto.section);
  }
});

test('una fuente critica caida tumba su seccion', () => {
  const states = [...todoVerde().filter((s) => s.id !== 'defillama-pools'), ...estados({ 'defillama-pools': 'red' })];
  const pools = impactForSection(CATALOGO, states, 'pools-yields');
  assert.equal(pools.light, 'red');
  assert.deepEqual(pools.brokenCritical, ['defillama-pools']);

  // Y no arrastra a las demas: el fallo esta acotado a quien depende de el.
  assert.equal(impactForSection(CATALOGO, states, 'funding-scanner').light, 'green');
});

test('un venue caido degrada, no tumba: los demas cruces siguen valiendo', () => {
  const states = [...todoVerde().filter((s) => s.id !== 'paradex'), ...estados({ paradex: 'red' })];
  const scanner = impactForSection(CATALOGO, states, 'funding-scanner');
  assert.equal(scanner.light, 'yellow');
  assert.deepEqual(scanner.degraded, ['paradex']);
  assert.deepEqual(scanner.brokenCritical, []);
});

test('una fuente critica en amarillo degrada pero no tumba', () => {
  const states = [...todoVerde().filter((s) => s.id !== 'defillama-pools'), ...estados({ 'defillama-pools': 'yellow' })];
  const pools = impactForSection(CATALOGO, states, 'pools-yields');
  assert.equal(pools.light, 'yellow');
  assert.deepEqual(pools.brokenCritical, []);
});

test('una fuente que aun no ha reportado cuenta como amarilla, no como sana', () => {
  // Al arrancar no hay estados todavia. Pintarlo verde seria afirmar algo que
  // no sabemos; en una herramienta de dinero eso es peor que un aviso de mas.
  const scanner = impactForSection(CATALOGO, [], 'funding-scanner');
  assert.equal(scanner.light, 'yellow');
  assert.ok(scanner.degraded.includes('hyperliquid'));
});

test('sourcesForSection devuelve solo lo que alimenta esa pestana', () => {
  const pools = sourcesForSection(CATALOGO, 'pools-yields');
  assert.deepEqual(pools.map((s) => s.id), ['defillama-pools']);

  const calendario = sourcesForSection(CATALOGO, 'calendar');
  // Dos: la tabla por dias (ForexFactory) y el widget, que trae el dato real.
  assert.deepEqual(calendario.map((s) => s.id), ['forexfactory-calendar', 'tradingview-calendar']);
});

test('todas las fuentes declaran al menos una seccion', () => {
  // Una fuente que no alimenta nada es codigo muerto o un olvido al anadirla.
  for (const s of CATALOGO) assert.ok(s.feeds.length > 0, s.id);
});

test('toda seccion declarada en un feed existe en el menu', () => {
  const validas = new Set<string>(SECTION_ORDER);
  for (const s of CATALOGO) {
    for (const f of s.feeds) assert.ok(validas.has(f.section), `${s.id} -> ${f.section}`);
  }
});

test('statusToLight traduce el estado del collector al semaforo', () => {
  assert.equal(statusToLight('ok'), 'green');
  assert.equal(statusToLight('degraded'), 'yellow');
  assert.equal(statusToLight('down'), 'red');
});
