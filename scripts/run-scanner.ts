/**
 * Scanner de funding contra los venues reales.
 *
 * Reproduce en terminal lo que sera la pestana Funding Scanner: fase 1 sobre
 * los snapshots en memoria y fase 2 pidiendo libros solo a los candidatos que
 * superan el umbral.
 *
 * Uso:  npm run scan
 *       npm run scan -- --notional 50000 --dias 3 --maker
 */
import { Collector } from '@defi/collector';
import { activeVenueIds, createAdapters, REGISTRY } from '@defi/venues';
import { scanGross, withDepth, type ScanOptions } from '@defi/scanner';
import { buyCost, sellCost } from '@defi/core';

const arg = (nombre: string, pordefecto: number): number => {
  const i = process.argv.indexOf(`--${nombre}`);
  if (i === -1) return pordefecto;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : pordefecto;
};

const NOTIONAL = arg('notional', 10_000);
const DIAS = arg('dias', 7);
const CANDIDATOS = 12;

const options: ScanOptions = {
  notionalPerLegUsd: NOTIONAL,
  holdHours: DIAS * 24,
  feeMode: process.argv.includes('--maker') ? 'maker' : 'taker',
  minGrossAprPct: 1,
};

const adapters = createAdapters(activeVenueIds());
const collector = new Collector({
  adapters,
  budget: { maxWebsockets: 8, maxRequestsPerMinute: 240 },
  intervalMs: 120_000,
});

console.log(`nocional ${NOTIONAL.toLocaleString('es')} USD por pata · horizonte ${DIAS} d · fees ${options.feeMode}`);
await collector.runCycle();

const metas = new Map([...REGISTRY].map(([id, e]) => [id, e.meta]));
const t0 = Date.now();
const brutas = scanGross(collector.snapshots(), metas, options);
console.log(`fase 1: ${brutas.length} oportunidades en ${Date.now() - t0} ms\n`);

// --- Fase 2: libros solo para los candidatos --------------------------------
const porAdaptador = new Map(adapters.map((a) => [a.meta.id, a]));
const candidatos = brutas.slice(0, CANDIDATOS);
const completas = [];

for (const op of candidatos) {
  const largo = porAdaptador.get(op.longVenue);
  const corto = porAdaptador.get(op.shortVenue);
  if (largo?.fetchBook === undefined || corto?.fetchBook === undefined) {
    // Sin libro no se puede afirmar un neto: se deja la oportunidad en bruto.
    completas.push(op);
    continue;
  }

  const [libroLargo, libroCorto] = await Promise.all([
    largo.fetchBook(op.symbol).catch(() => null),
    corto.fetchBook(op.symbol).catch(() => null),
  ]);
  const midLargo = largo.snapshot().get(op.symbol)?.mid;
  const midCorto = corto.snapshot().get(op.symbol)?.mid;

  if (!libroLargo || !libroCorto || midLargo === undefined || midCorto === undefined) {
    completas.push(op);
    continue;
  }

  // Abrir: comprar en el largo, vender en el corto.
  const costeLargo = buyCost(libroLargo, midLargo, NOTIONAL);
  const costeCorto = sellCost(libroCorto, midCorto, NOTIONAL);
  const sinFondo = costeLargo.insufficientDepth || costeCorto.insufficientDepth;
  const slippageAperturaPct = sinFondo ? 0 : (costeLargo.slippageBps + costeCorto.slippageBps) / 100;

  completas.push(withDepth(op, slippageAperturaPct, sinFondo, options));
}

// El orden final es por neto: es el unico numero sobre el que se decide.
completas.sort((a, b) => (b.netAprPct ?? -Infinity) - (a.netAprPct ?? -Infinity));

const pct = (v: number | null, d = 1) => (v === null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`);

console.log('ACTIVO      LARGO         CORTO         BRUTO      NETO    COSTE  BREAKEVEN');
console.log('-'.repeat(78));
for (const op of completas) {
  const neto = op.insufficientDepth ? 'sin fondo' : pct(op.netAprPct);
  const be = op.breakevenHours === null ? '—' : `${op.breakevenHours.toFixed(1)} h`;
  console.log(
    `${op.symbol.padEnd(11)} ${op.longVenue.padEnd(13)} ${op.shortVenue.padEnd(13)} ` +
      `${pct(op.grossAprPct).padStart(8)} ${neto.padStart(9)} ` +
      `${(op.totalCostPct === null ? '—' : op.totalCostPct.toFixed(3) + '%').padStart(8)} ${be.padStart(9)}`,
  );
}

collector.stop();
