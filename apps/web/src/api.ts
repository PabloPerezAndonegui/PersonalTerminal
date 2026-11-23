/**
 * Cliente de la API y estado compartido.
 *
 * Sin libreria de estado: lo que hace falta es una suscripcion a los datos en
 * vivo y unas cuantas cargas puntuales. Un store de 40 lineas cubre eso sin
 * anadir una dependencia mas.
 */

/**
 * Donde vive la API.
 *
 * En desarrollo la web la sirve Vite en el 5173 y la API es otro proceso en el
 * 8080, asi que una ruta relativa NO llega a la API: la responde Vite. Se
 * exporta para que nadie vuelva a escribir `fetch('/api/…')` a secas y se
 * encuentre con que el GET funciona y el POST no hace nada.
 */
export const BASE = import.meta.env['DEV'] ? 'http://127.0.0.1:8080' : '';

export interface Section {
  readonly id: string;
  readonly label: string;
  readonly area: string;
}

/** Un area de la aplicacion: DeFi o Trading. */
export interface Area {
  readonly id: string;
  readonly label: string;
  readonly tagline: string;
  /** Seccion a la que se entra al pulsar el area. */
  readonly defaultSection: string;
}

/** Navegacion completa: la sirve el backend, areas y secciones juntas. */
export interface Menu {
  readonly areas: readonly Area[];
  readonly sections: readonly Section[];
}

export type TrafficLight = 'green' | 'yellow' | 'red';

export interface SourceRow {
  readonly id: string;
  readonly label: string;
  readonly provider: string;
  readonly kind: string;
  readonly cadence: string;
  readonly docsUrl: string | null;
  readonly light: TrafficLight | null;
  readonly health: {
    readonly status: string;
    readonly reason: string | null;
    readonly lastOkAt: number | null;
    readonly symbolCount: number;
    readonly coverageRatio: number | null;
    readonly latencyP50Ms: number | null;
    readonly latencyP95Ms: number | null;
    readonly errorRatePct: number;
  } | null;
  readonly sections: readonly { id: string; label: string; criticality: 'critical' | 'partial' }[];
}

export interface SectionImpact {
  readonly section: string;
  readonly label: string;
  readonly light: TrafficLight;
  readonly brokenCritical: readonly string[];
  readonly degraded: readonly string[];
}

export interface SourcesResponse {
  /** Hallazgos del ultimo ciclo: lo que la barra cuenta como "data issues". */
  readonly findings?: readonly {
    readonly venue: string;
    readonly symbol: string | null;
    readonly rule: string;
    readonly severity: string;
    readonly message: string;
  }[];
  readonly sources: readonly SourceRow[];
  readonly impact: readonly SectionImpact[];
}

export async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

/** POST, PUT o DELETE con cuerpo JSON. El error del servidor llega tal cual. */
export async function writeJson<T>(method: 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) {
    const b = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(b.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Suscripcion al flujo de eventos del servidor.
 *
 * `EventSource` reconecta solo, asi que no hay logica de reintento aqui. Lo que
 * si hace falta es saber si el flujo esta vivo: si se corta, la UI tiene que
 * decir que lo que se ve puede estar congelado, en vez de aparentar frescura.
 */
export function subscribe(onCycle: () => void, onLive: (live: boolean) => void): () => void {
  const es = new EventSource(`${BASE}/api/stream`);
  es.addEventListener('open', () => onLive(true));
  es.addEventListener('cycle', () => { onLive(true); onCycle(); });
  es.addEventListener('ping', () => onLive(true));
  es.addEventListener('error', () => onLive(false));
  return () => es.close();
}

/** Formatea sin inventar nada: un dato ausente es "—", nunca 0. */
export { usd, usdExact } from './formato.ts';

export const fmt = {
  pct(v: number | null, decimals = 1): string {
    if (v === null || !Number.isFinite(v)) return '—';
    return `${v >= 0 ? '+' : ''}${v.toFixed(decimals)}%`;
  },
  ms(v: number | null): string {
    return v === null || !Number.isFinite(v) ? '—' : `${Math.round(v)} ms`;
  },
  int(v: number | null): string {
    return v === null || !Number.isFinite(v) ? '—' : v.toLocaleString('en-US');
  },
  ago(at: number | null, now: number = Date.now()): string {
    if (at === null) return '—';
    const s = Math.max(0, Math.round((now - at) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    // A partir de dos dias, en dias: "1656h ago" no se lee de un vistazo.
    if (s < 48 * 3600) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86_400)}d ago`;
  },
};

export interface VenueMeta {
  readonly id: string;
  readonly label: string;
  readonly kind: string;
  readonly chain: string | null;
  readonly collateral: string;
  readonly fundingIntervalHours: number;
  readonly fees: { makerBps: number | null; takerBps: number | null; freeClose: boolean };
}

/** Que representaba el numero de funding en la respuesta del venue. */
export type FundingKind = 'current' | 'predicted' | 'settled';

/**
 * De donde sale el funding de una pata.
 *
 * Es lo que permite abrir una fila y llegar hasta la respuesta cruda del venue
 * sin mirar el codigo.
 */
export interface FundingProvenance {
  readonly venue: string;
  readonly kind: FundingKind;
  readonly sourceField: string;
  readonly nativeRate: number;
  readonly intervalHours: number;
  readonly hourlyRate: number;
  readonly observedAt: number;
  /** null = el venue no sella sus datos, asi que su edad real no se sabe. */
  readonly sourceAt: number | null;
  readonly nextFundingAt: number | null;
}

export interface Opportunity {
  readonly symbol: string;
  readonly longVenue: string;
  readonly shortVenue: string;
  readonly longFundingHourly: number;
  readonly shortFundingHourly: number;
  readonly grossAprPct: number;
  readonly netAprPct: number | null;
  readonly totalCostPct: number | null;
  readonly feesPct: number | null;
  readonly slippagePct: number | null;
  readonly breakevenHours: number | null;
  readonly insufficientDepth: boolean;
  readonly notionalPerLegUsd: number;
  /** false = con este tamano y este horizonte no llega a amortizar. */
  readonly amortizesWithinHold: boolean | null;
  readonly provenance: {
    readonly long: FundingProvenance;
    readonly short: FundingProvenance;
    readonly books: {
      readonly longAgeMs: number;
      readonly shortAgeMs: number;
      readonly skewMs: number;
    } | null;
  };
}

export interface ScannerResponse {
  readonly total: number;
  readonly totalUnfiltered: number;
  readonly shown: number;
  readonly opportunities: readonly Opportunity[];
  readonly stats: {
    readonly totalOiUsd: number;
    readonly venues: number;
    readonly symbols: number;
    readonly listings: number;
    readonly bestNetAprPct: number | null;
  };
}

/** Clase de activo, la misma lista que `CLASES` en `@defi/core`. */
export type AssetClass = 'crypto' | 'equity' | 'index' | 'commodity' | 'fx' | 'etf';

export interface VolumeResponse {
  readonly period: {
    readonly days: number;
    /** true = medido. false = estimado a partir del historico. */
    readonly measured: boolean;
    /** Dias con historico que respaldan la estimacion. null si es medido. */
    readonly coverageDays: number | null;
  };
  readonly assetClass: AssetClass | null;
  /** Mercados vivos de cada clase, sumando venues. */
  readonly marketsByClass: Readonly<Partial<Record<AssetClass, number>>>;
  readonly totalUsd: number;
  /** Volumen apartado porque el precio dice que el ticker es otro activo. */
  readonly keptOutUsd: number;
  readonly pairCount: number;
  readonly pairs: readonly {
    readonly symbol: string;
    readonly assetClass: AssetClass;
    readonly totalUsd: number;
    readonly venueCount: number;
    readonly keptOut: readonly { readonly venue: string; readonly volumeUsd: number }[];
    readonly venues: readonly {
      readonly venue: string;
      readonly volumeUsd: number;
      readonly share: number;
      readonly openInterestUsd: number | null;
    }[];
  }[];
}

/** Una semana de volumen, sumando todos los venues. Siempre estimado. */
export interface VolumeWeek {
  /** Lunes 00:00 UTC, en ms. */
  readonly weekStart: number;
  readonly inProgress: boolean;
  /** null si no hay ni un dia con dato: no se sabe, no es cero. */
  readonly totalUsd: number | null;
  /** Media por dia con dato: lo comparable entre semanas con huecos. */
  readonly avgDailyUsd: number | null;
  readonly daysWithData: number;
  /** Dias transcurridos de la semana: 7, o menos si esta en curso. */
  readonly daysElapsed: number;
  readonly venueCount: number;
  readonly complete: boolean;
  /** Solo entre dos semanas completas. */
  readonly changePct: number | null;
}

export interface VolumeWeeklyResponse {
  readonly assetClass: AssetClass | null;
  readonly estimated: true;
  /** De la mas reciente a la mas antigua. */
  readonly weeks: readonly VolumeWeek[];
}

export interface ExplorerResponse {
  readonly query: string;
  readonly total: number;
  /** Familias a las que apunta la busqueda ("SPY" -> S&P 500). */
  readonly families: readonly string[];
  /** Cobertura declarada: perps, swaps donde los hay, sin spot. */
  readonly coverage: { readonly perpVenues: number; readonly swapVenues: number; readonly spotVenues: number };
  readonly assets: readonly {
    readonly symbol: string;
    readonly assetClass: AssetClass;
    /** Lo que sigue ("S&P 500", "Gold"), o null. */
    readonly tracks: string | null;
    /** Otros simbolos que siguen lo mismo y hoy cotizan. */
    readonly related: readonly string[];
    readonly perpVenues: number;
    readonly swapVenues: number;
    readonly spotVenues: number;
    readonly price: number | null;
    readonly volume24hUsd: number | null;
    readonly priceSpreadPct: number | null;
    readonly listings: readonly {
      readonly venue: string;
      readonly label: string;
      readonly venueKind: 'dex' | 'cex';
      readonly url: string | null;
      readonly instrument: 'perp' | 'swap';
      readonly symbolNative: string;
      readonly contractMultiplier: number;
      readonly mid: number;
      readonly vsMedianPct: number | null;
      /** null en un swap: no tiene funding. */
      readonly fundingAprPct: number | null;
      readonly fundingIntervalHours: number | null;
      readonly volume24hUsd: number | null;
      readonly openInterestUsd: number | null;
      readonly makerBps: number | null;
      readonly takerBps: number | null;
    }[];
  }[];
}

export interface SeriesResponse {
  readonly symbol: string;
  readonly from: number;
  readonly to: number;
  readonly points: readonly {
    readonly ts: number;
    readonly venue: string;
    readonly symbol: string;
    readonly mid: number;
    readonly fundingHourly: number;
    readonly openInterestUsd: number | null;
    readonly volume24hUsd: number | null;
  }[];
}

export interface PoolsResponse {
  /** false = DefiLlama aun no ha respondido. La UI lo declara, no pinta vacio. */
  readonly available: boolean;
  readonly reason?: string;
  /** Cuando se descargo la copia que se sirve, en ms. */
  readonly asOf?: number | null;
  /** true si la fuente ya no responde a su cadencia: la copia puede estar vieja. */
  readonly stale?: boolean;
  readonly total: number;
  readonly totalUnfiltered: number;
  readonly shown: number;
  readonly hiddenVolatile: number;
  readonly chains: readonly string[];
  /** Venues (protocolos de DefiLlama) de mayor a menor TVL. */
  readonly projects: readonly { readonly id: string; readonly tvlUsd: number }[];
  /** Historico propio que respalda las medias de 7 y 15 dias. */
  readonly history?: { readonly daysRecorded: number; readonly minDays7d: number; readonly minDays15d: number };
  readonly pools: readonly {
    readonly id: string;
    readonly chain: string;
    readonly project: string;
    readonly symbol: string;
    readonly poolMeta: string | null;
    readonly tvlUsd: number;
    readonly apy: number | null;
    readonly apyBase: number | null;
    readonly apyReward: number | null;
    readonly apyMean30d: number | null;
    /** Medias propias. null hasta tener los dias minimos. */
    readonly apyMean7d: number | null;
    readonly apyMean15d: number | null;
    readonly stablecoin: boolean;
    readonly ilRisk: string | null;
    readonly exposure: string | null;
    readonly volatileApy: boolean;
    readonly url: string;
  }[];
}

export interface BridgesResponse {
  readonly available: boolean;
  readonly reason?: string;
  readonly asOf?: number | null;
  readonly stale?: boolean;
  readonly total?: number;
  readonly chains: readonly string[];
  readonly from?: string;
  readonly to?: string;
  readonly routes: readonly {
    readonly id: string;
    readonly name: string;
    readonly type: string;
    readonly tvlUsd: number | null;
    readonly url: string | null;
    readonly description: string | null;
    readonly networks: number;
    /**
     * Quien confirma la ruta: 'lifi' o 'debridge' la enrutan de verdad;
     * 'liquidity' solo dice que DefiLlama le ve liquidez en las dos redes.
     */
    readonly via: readonly ('lifi' | 'debridge' | 'liquidity')[];
  }[];
  /** Rutas que no salen en una lista por liquidez porque no bloquean fondos. */
  readonly alwaysConsider: readonly { name: string; reason: string; url: string }[];
  readonly aggregators: {
    readonly available: boolean;
    readonly asOf: number | null;
    readonly stale: boolean;
    readonly rows: readonly {
      readonly slug: string;
      readonly name: string;
      readonly volume24hUsd: number | null;
      readonly volume7dUsd: number | null;
      readonly volume30dUsd: number | null;
      readonly change7dPct: number | null;
    }[];
  };
}

/** Una tarjeta del tablero de Points: lo que se farmea, por prioridad. */
export interface FarmingProgram {
  readonly id: string;
  readonly venue: string;
  readonly pointsPerEpoch: number | null;
  readonly epochLabel: string;
  readonly epochVolumeUsd: number | null;
  readonly priority: number | null;
  readonly note: string | null;
  readonly createdAt: number;
}

export interface Campaign {
  readonly id: string;
  readonly venue: string;
  readonly name: string;
  readonly kind: 'competition' | 'points';
  readonly status: 'live' | 'upcoming' | 'ended';
  readonly startsAt: number | null;
  readonly endsAt: number | null;
  readonly poolUsd: number | null;
  readonly minVolumeUsd: number | null;
  readonly pointsPerEpoch: number | null;
  readonly epochDays: number | null;
  readonly url: string;
}

export interface PointsResponse {
  readonly campaigns: {
    readonly available: boolean;
    readonly asOf: number | null;
    readonly stale: boolean;
    readonly rows: readonly Campaign[];
  };
  readonly programs: readonly {
    readonly venueId: string;
    readonly venue: string;
    readonly url: string;
    readonly apiStatus: string;
    readonly apiNote: string | null;
    readonly verifiedAt: string;
    readonly daysSinceCheck: number | null;
  }[];
  readonly staleAfterDays: number;
  readonly stale: readonly string[];
  readonly oldestCheckDays: number | null;
  /** Cuantos venues exponen puntos sin autenticacion. Hoy: 0. */
  readonly livePrograms: number;
}

export interface Wallet {
  readonly id: string;
  readonly address: string;
  readonly chain: string;
  readonly label: string | null;
  readonly notes: string | null;
  readonly createdAt: number;
}

export interface PositionsResponse {
  readonly address: string;
  readonly addressKind: string;
  readonly equityUsd: number | null;
  readonly venues: readonly {
    readonly venue: string;
    /** ok | wrong-chain | unsupported | error. Los tres ultimos son huecos. */
    readonly status: string;
    readonly reason: string | null;
    readonly equityUsd: number | null;
    readonly positionCount: number;
  }[];
  readonly positions: readonly {
    readonly venue: string;
    readonly symbol: string;
    readonly symbolNative: string;
    readonly side: string;
    readonly sizeBase: number;
    readonly notionalUsd: number;
    readonly entryPrice: number | null;
    readonly markPrice: number | null;
    readonly unrealizedPnlUsd: number | null;
    readonly leverage: number | null;
    readonly liquidationPrice: number | null;
  }[];
  readonly exposure: readonly {
    readonly symbol: string;
    readonly longUsd: number;
    readonly shortUsd: number;
    readonly netUsd: number;
    readonly grossUsd: number;
  }[];
}

export interface FundingPositionsResponse {
  readonly positions: readonly {
    readonly id: string;
    readonly symbol: string;
    readonly longVenue: string;
    readonly shortVenue: string;
    readonly notionalUsd: number;
    readonly openedAt: number;
    readonly closedAt: number | null;
    readonly feesPaidUsd: number | null;
    readonly fundingCollectedUsd: number | null;
    readonly notes: string | null;
    readonly metrics: {
      readonly hours: number;
      readonly oiHours: number;
      readonly netUsd: number | null;
      readonly costPer1kOiHours: number | null;
    };
    /** Aumentos y reducciones, en orden. Vacio = tamano constante. */
    readonly sizeChanges: readonly {
      readonly id: string;
      readonly at: number;
      readonly notionalUsd: number;
      readonly note: string | null;
    }[];
    /** Contraste contra nuestro historico. `coverage` decide si vale algo. */
    readonly estimate: {
      readonly estimatedUsd: number;
      readonly coverage: number;
      readonly samples: number;
    };
  }[];
  readonly byVenue: readonly {
    readonly venue: string;
    readonly oiHours: number;
    readonly feesUsd: number | null;
    readonly netUsd: number | null;
    readonly posiciones: number;
    readonly costPer1kOiHours: number | null;
  }[];
}

export interface IncomeResponse {
  readonly entries: readonly {
    readonly id: string;
    readonly kind: 'referral' | 'competition';
    readonly venue: string;
    readonly amountUsd: number;
    readonly receivedAt: number;
    readonly competition: string | null;
    readonly placement: string | null;
    readonly period: string | null;
    readonly note: string | null;
  }[];
  readonly totals: {
    /** null sin ninguna entrada: no se afirma un ingreso de 0. */
    readonly referralUsd: number | null;
    readonly competitionUsd: number | null;
    readonly totalUsd: number | null;
    readonly byVenue: readonly {
      readonly venue: string;
      readonly referralUsd: number;
      readonly competitionUsd: number;
      readonly totalUsd: number;
    }[];
  };
  readonly referralLinks: readonly { venue: string; url: string; createdAt: number }[];
  readonly liveCompetitions: readonly unknown[];
  /** false = ningun venue publica competiciones sin autenticacion. */
  readonly liveCompetitionsSupported: boolean;
}

/**
 * Farmeo de puntos.
 *
 * `metrics.pointsEstimated` es la pieza importante: distingue un punto contado
 * de uno deducido de tu cuota de volumen, y la pantalla lo marca. Si falta
 * cualquiera de los datos del epoch, `points` viene null y no se estima nada.
 */
export interface FarmingResponse {
  readonly programs: readonly {
    readonly id: string;
    readonly venue: string;
    readonly pointsPerEpoch: number | null;
    readonly epochLabel: string;
    readonly epochVolumeUsd: number | null;
    readonly createdAt: number;
  }[];
  readonly actions: readonly {
    readonly id: string;
    readonly programId: string;
    readonly venue: string | null;
    readonly description: string | null;
    readonly volumeUsd: number | null;
    readonly feesPaidUsd: number | null;
    readonly pnlUsd: number | null;
    readonly pointsEarned: number | null;
    readonly occurredAt: number;
    readonly metrics: {
      readonly points: number | null;
      readonly pointsEstimated: boolean;
      readonly costPerPoint: number | null;
      readonly netCostPerPoint: number | null;
    };
  }[];
  readonly portfolio: {
    readonly totalPoints: number | null;
    readonly estimatedPoints: number;
    readonly totalFeesUsd: number | null;
    readonly totalPnlUsd: number | null;
    readonly netResultUsd: number | null;
    readonly avgCostPerPoint: number | null;
    readonly avgNetCostPerPoint: number | null;
  };
}

/** Una celda de la matriz de funding: un simbolo en un venue. */
export interface MatrixCell {
  /** Tasa por hora ya normalizada: la base comparable entre venues. */
  readonly hourlyRate: number;
  /** Precio medio. Es lo que delata que dos venues no hablan del mismo activo. */
  readonly mid: number;
  readonly nativeRate: number;
  readonly intervalHours: number;
  readonly kind: FundingKind;
  readonly volume24hUsd: number | null;
  readonly openInterestUsd: number | null;
}

export interface FundingMatrixResponse {
  readonly at: number;
  readonly lastCycleAt: number | null;
  readonly collectIntervalMs: number;
  readonly venues: readonly {
    readonly id: string;
    readonly label: string;
    readonly selected: boolean;
    readonly status: 'ok' | 'degraded' | 'down' | null;
    readonly intervalHours: number | null;
    readonly kind: FundingKind | null;
    readonly venueKind: 'dex' | 'cex';
    /** Web oficial, comprobada. null si no hay una. */
    readonly url: string | null;
    readonly symbols: number;
  }[];
  /** Venue al que se ancla la comparacion, si solo hay uno elegido. */
  readonly anchor: string | null;
  readonly total: number;
  readonly rows: readonly {
    readonly symbol: string;
    readonly cells: Readonly<Record<string, MatrixCell>>;
    readonly longVenue: string | null;
    readonly shortVenue: string | null;
    /** Diferencial BRUTO por hora, sin fees ni slippage. */
    readonly spreadHourly: number | null;
    /** Venues apartados porque ese ticker es otro activo en ellos. */
    readonly conflicts: readonly string[];
    /** Lo sostenido que ha sido ESTE cruce. null = todavia sin calcular. */
    readonly sustained: Sustained | null;
  }[];
}

/** Una ventana de medicion del historico de un cruce. */
export interface SustainedWindow {
  /** Horas de datos SEGUIDOS. Los huecos del collector no cuentan. */
  readonly coveredHours: number;
  /** Parte del tiempo a favor, de 0 a 1. null sin datos suficientes. */
  readonly uptime: number | null;
  /** Lo que habria pagado aguantando, anualizado y en porcentaje. */
  readonly holdApr: number | null;
  readonly samples: number;
}

/**
 * Nota de sostenibilidad de un cruce.
 *
 * La letra sale de las dos ventanas y se queda con la PEOR. Es bruta: sin
 * comisiones, sin spread de ejecucion y sin el coste de entrar.
 */
export interface Sustained {
  readonly grade: 'A' | 'B' | 'C' | 'D' | null;
  readonly days7: SustainedWindow;
  readonly days14: SustainedWindow;
  readonly largo: string;
  readonly corto: string;
}

/** Estado con el que llega cada trader seguido. Ver traderStatus en la API. */
export type TraderStatus = 'paused' | 'waiting' | 'ok' | 'stale' | 'failing';

export interface TrackedTrader {
  readonly id: string;
  readonly venue: string;
  readonly address: string;
  readonly alias: string | null;
  readonly color: string | null;
  readonly group: string | null;
  readonly notes: string | null;
  readonly active: boolean;
  readonly createdAt: number;
  /** Los pares que interesan de esta wallet. null = todos. */
  readonly symbols: readonly string[] | null;
  /** Solo operaciones que muevan al menos este % de su cuenta. null = sin minimo. */
  readonly minAccountPct: number | null;
  readonly status: TraderStatus;
  /** De cuando es la ultima lectura buena. null = aun no ha habido ninguna. */
  readonly updatedAt: number | null;
  readonly error: string | null;
  readonly errorAt: number | null;
  readonly failures: number;
  readonly equityUsd: number | null;
  readonly marginUsedUsd: number | null;
  /** Vacia no significa "fallo": significa que no tiene posiciones abiertas. */
  readonly positions: readonly {
    readonly symbol: string;
    readonly side: 'long' | 'short';
    readonly sizeBase: number;
    readonly notionalUsd: number;
    readonly entryPrice: number | null;
    readonly markPrice: number | null;
    readonly unrealizedPnlUsd: number | null;
    readonly leverage: number | null;
    readonly liquidationPrice: number | null;
  }[];
}

export interface TradersResponse {
  /** false = nadie esta refrescando la lista. La pantalla lo declara. */
  readonly tracking: boolean;
  readonly intervalMs: number | null;
  readonly staleAfterMs: number | null;
  readonly traders: readonly TrackedTrader[];
}

/** Un cambio de posicion detectado entre dos lecturas. */
export interface AlertEvent {
  readonly id: number;
  readonly traderId: string;
  readonly venue: string;
  readonly address: string;
  readonly symbol: string;
  readonly kind: 'opened' | 'closed' | 'increased' | 'reduced' | 'flipped';
  readonly side: 'long' | 'short';
  readonly sizeBase: number;
  readonly prevSizeBase: number;
  readonly notionalUsd: number;
  readonly deltaUsd: number;
  readonly markPrice: number | null;
  readonly at: number;
  /** null = se detecto pero NO salio por Telegram. */
  readonly notifiedAt: number | null;
}

/** Estado del bot. Aqui NUNCA viaja el token ni el chat. */
export interface TelegramStatus {
  readonly configured: boolean;
  readonly dryRun: boolean;
  readonly group: boolean;
  readonly lastOkAt: number | null;
  readonly lastError: string | null;
  readonly lastErrorAt: number | null;
  readonly sent: number;
  readonly failed: number;
  readonly queued: number;
}

export interface AlertsResponse {
  readonly available: boolean;
  readonly telegram?: TelegramStatus;
  /** Por debajo de este tamano un cambio no genera aviso. */
  readonly minNotionalUsd?: number;
  /** Con mas hueco que esto entre dos lecturas no se avisa de nada. */
  readonly maxGapMs?: number;
  readonly detected?: number;
  readonly unsent?: number;
  readonly events: readonly AlertEvent[];
}

/** Un venue con su interes abierto. Ver openInterest.ts en la API. */
export interface OiVenue {
  readonly id: string;
  readonly label: string;
  readonly kind: 'cex' | 'dex';
  /** `unverified` = no se ha podido demostrar si cuenta una pata o dos. */
  readonly convention: 'single' | 'double' | 'unverified';
  /**
   * Si la convencion se ha medido contra el propio venue o solo descansa en
   * que DefiLlama declara normalizar a una pata.
   */
  readonly conventionProven: boolean;
  /** Que instrumento es. Solo los perps entran en el total de perps. */
  readonly instrument: 'perp' | 'option' | 'prediction' | 'rates' | 'other';
  /** Que parte del venue entra en la cifra. Ninguna fuente lo cubre entero. */
  readonly coverage: string;
  /** false = solo total, sin reparto por activo. Filtrar por uno lo deja fuera. */
  readonly breakdown: boolean;
  readonly volume24hUsd: number | null;
  /** null = la fuente no da el dato. NUNCA es cero por defecto. */
  readonly oiUsd: number | null;
  readonly markets: number;
  readonly asOf: number | null;
  readonly stale: boolean;
  readonly error: string | null;
  /** Solo al filtrar por simbolo: si ese venue lo lista. */
  readonly listed?: boolean;
}

export interface OpenInterestResponse {
  /** Cambio del OI que se mira, a dos patas y con los mismos venues en las dos fotos. */
  readonly change?: {
    readonly h24: { readonly pct: number | null; readonly venues: number };
    readonly d7: { readonly pct: number | null; readonly venues: number };
  };
  /** De cuando son los ingresos y comisiones de DefiLlama. */
  readonly revenueAsOf?: number | null;
  readonly revenueStale?: boolean;
  readonly storageError?: string | null;
  readonly available: boolean;
  readonly range: '1d' | '7d' | '30d';
  readonly asOf: number;
  readonly intervalMs: number;
  readonly symbol: string | null;
  readonly venues: readonly OiVenue[];
  readonly current: readonly OiVenue[];
  readonly total: {
    readonly oiUsd: number | null;
    readonly venues: number;
    /** El total mezcla convenciones: no es una medida, es una suma provisional. */
    readonly provisional: boolean;
    /** Suma de los venues cuya convencion se ha medido contra el venue. */
    readonly verifiedUsd: number | null;
    readonly verifiedVenues: number;
    /** Lo que suman los venues cuya convencion solo la declara DefiLlama. */
    readonly llamaUsd?: number | null;
    readonly llamaVenues?: number;
    /** Lo que reportan los venues que no dicen si cuentan una pata o dos. */
    readonly unverifiedUsd: number | null;
    readonly unverifiedVenues?: number;
    /** El total a DOS patas, solo con los venues cuya convencion se conoce. */
    readonly globalUsd: number | null;
    readonly globalVenues: number;
    /** Los que no entran en el global porque no se sabe su convencion. */
    readonly withoutConvention: readonly string[];
    /** Interes abierto que NO es de perps. Se lista y nunca se suma. */
    readonly otherInstrumentsUsd: number | null;
    readonly otherInstruments: number;
    /** Falta algun venue elegido: el total no es de todos. */
    readonly partial: boolean;
    readonly missing: readonly string[];
    /** Elegidos que no listan el simbolo. Su cero es real, no un hueco. */
    readonly notListed: readonly string[];
    /**
     * Apartados porque su precio dice que ese ticker es OTRO activo. No es un
     * hueco de datos: listan el simbolo, pero de otra cosa.
     */
    readonly tickerConflict?: readonly string[];
    /** Listan el simbolo pero no publican precio con el que comprobarlo. */
    readonly withoutPrice?: number;
    readonly unverified: readonly string[];
  };
  readonly series: readonly { readonly venue: string; readonly points: readonly { t: number; v: number }[] }[];
  readonly symbols: readonly { readonly symbol: string; readonly oiUsd: number }[];
  /** Donde se concentra el interes abierto: los mayores activos y su reparto. */
  readonly concentration: readonly {
    readonly symbol: string;
    readonly oiUsd: number;
    readonly venues: number;
    readonly topVenue: string | null;
    /** Parte que se lleva el exchange mayor, de 0 a 1. */
    readonly topShare: number | null;
    readonly cexUsd: number;
    readonly dexUsd: number;
    /** Cambio del OI en 24 h, con los mismos venues en las dos fotos. */
    readonly change24hPct?: number | null;
    /** Funding por hora medio, ponderado por el OI de cada venue. */
    readonly fundingHourly?: number | null;
  }[];
  /** Un protocolo por fila, para comparar dos de frente. */
  readonly protocols: readonly {
    readonly id: string;
    readonly label: string;
    readonly kind: "cex" | "dex";
    /** true = su cifra la publica DefiLlama, no la API del venue. */
    readonly fromDefillama: boolean;
    /** Web oficial, comprobada. null si no hay una. */
    readonly url?: string | null;
    readonly oiUsd: number | null;
    readonly volume24hUsd: number | null;
    readonly revenue24hUsd: number | null;
    readonly revenue30dUsd: number | null;
    /** Comisiones cobradas al usuario. NO es lo mismo que los ingresos. */
    readonly fees24hUsd: number | null;
    readonly fees30dUsd: number | null;
    /** Capital depositado, sumando las entradas hermanas de DefiLlama. */
    readonly tvlUsd: number | null;
    readonly convention: "single" | "double" | "unverified";
    readonly coverage: string;
    /** Del registro propio. null en los CEX, que no son venues del registro. */
    readonly chain: string | null;
    readonly collateral: string | null;
    readonly fundingIntervalHours: number | null;
    readonly makerBps: number | null;
    readonly takerBps: number | null;
    readonly markets: number;
  }[];
  readonly history: {
    readonly from: number | null;
    readonly to: number | null;
    readonly resolutionMs: number;
    readonly minSymbolUsd: number;
  };
}
