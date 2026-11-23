import type { BookLevel, OrderBook } from '../types/market.ts';
import type { ExecCost } from '../types/opportunity.ts';

/**
 * Pasea el libro para estimar que cuesta ejecutar `notionalUsd` como taker.
 *
 * Devuelve la desviacion media respecto al mid en bps, que ya incluye el medio
 * spread y el impacto de mercado. Es la unica forma honesta de estimar el coste
 * de entrada: usar solo el spread del top of book subestima siempre en los
 * venues pequenos, que es justo donde estan los funding altos.
 *
 * Si el libro no cubre el tamano, lo marca en vez de devolver un numero
 * optimista. Un par sin profundidad no es una oportunidad.
 */
export function walkBook(levels: readonly BookLevel[], mid: number, notionalUsd: number): ExecCost {
  if (levels.length === 0 || mid <= 0 || notionalUsd <= 0) {
    return { slippageBps: Infinity, insufficientDepth: true };
  }

  let remainingUsd = notionalUsd;
  let weightedCostUsd = 0;

  for (const level of levels) {
    if (remainingUsd <= 0) break;
    const levelUsd = level.price * level.size;
    const takenUsd = Math.min(levelUsd, remainingUsd);
    weightedCostUsd += (Math.abs(level.price - mid) / mid) * takenUsd;
    remainingUsd -= takenUsd;
  }

  // Tolerancia del 1%: los libros normalizados pierden algo de precision al
  // truncar niveles, y fallar por 0.3 USD en 500 seria ruido.
  if (remainingUsd > 0.01 * notionalUsd) {
    return { slippageBps: Infinity, insufficientDepth: true };
  }

  return { slippageBps: (weightedCostUsd / notionalUsd) * 10_000, insufficientDepth: false };
}

/** Coste de abrir un largo (cruza contra asks). */
export const buyCost = (book: OrderBook, mid: number, notionalUsd: number): ExecCost =>
  walkBook(book.asks, mid, notionalUsd);

/** Coste de abrir un corto (cruza contra bids). */
export const sellCost = (book: OrderBook, mid: number, notionalUsd: number): ExecCost =>
  walkBook(book.bids, mid, notionalUsd);
