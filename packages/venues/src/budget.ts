import type { VenueAdapter } from './types.ts';

export interface ResourceBudget {
  readonly maxWebsockets: number;
  readonly maxRequestsPerMinute: number;
}

export interface BudgetPlan {
  /** Adaptadores que caben, en el orden de prioridad recibido. */
  readonly admitted: readonly VenueAdapter[];
  /** Los que no caben, con el motivo, para poder mostrarlo en la UI. */
  readonly rejected: readonly { readonly adapter: VenueAdapter; readonly reason: string }[];
  readonly usedWebsockets: number;
  readonly usedRequestsPerMinute: number;
}

/**
 * Admite adaptadores por orden de prioridad hasta agotar el presupuesto.
 *
 * Es deliberadamente un algoritmo tonto (primero que llega, primero servido) y
 * no una mochila optimizada: quiero que el resultado sea predecible y que el
 * orden de prioridad que se configure se respete literalmente. Un venue que no
 * cabe se rechaza con motivo visible, nunca se cae en silencio.
 */
export function planBudget(
  adapters: readonly VenueAdapter[],
  budget: ResourceBudget,
): BudgetPlan {
  const admitted: VenueAdapter[] = [];
  const rejected: { adapter: VenueAdapter; reason: string }[] = [];
  let ws = 0;
  let rpm = 0;

  for (const adapter of adapters) {
    const nextWs = ws + adapter.cost.websockets;
    const nextRpm = rpm + adapter.cost.requestsPerMinute;

    if (nextWs > budget.maxWebsockets) {
      rejected.push({
        adapter,
        reason: `needs ${adapter.cost.websockets} WS, only ${budget.maxWebsockets - ws} left`,
      });
      continue;
    }
    if (nextRpm > budget.maxRequestsPerMinute) {
      rejected.push({
        adapter,
        reason: `needs ${adapter.cost.requestsPerMinute} req/min, only ${budget.maxRequestsPerMinute - rpm} left`,
      });
      continue;
    }

    admitted.push(adapter);
    ws = nextWs;
    rpm = nextRpm;
  }

  return { admitted, rejected, usedWebsockets: ws, usedRequestsPerMinute: rpm };
}
