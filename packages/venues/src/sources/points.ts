/**
 * Puntos y competiciones.
 *
 * Decision de fondo, heredada de la version anterior de la app y conservada a
 * proposito: **no se copian datos que caducan**. Fechas, premios y requisitos
 * de una campana cambian cada semana, y una tabla con esos datos copiados esta
 * mal a los pocos dias sin que nadie se entere. Se enlaza a la pagina oficial,
 * que siempre esta al dia.
 *
 * Lo que si se guarda aqui es lo comprobable y estable: si el venue expone o no
 * sus puntos por API publica, y cuando se comprobo. Eso caduca solo.
 */

/** Que devuelve la API publica de puntos del venue, comprobado a mano. */
export type PointsApiStatus =
  /** Expone puntos sin autenticacion: se pueden leer en vivo. */
  | 'public'
  /** Existe pero exige login (401/403). */
  | 'auth-required'
  /**
   * El endpoint existe y no pide login, pero delante hay un muro anti-bot que
   * responde con un desafio de navegador. No se saltan esos muros, asi que el
   * dato no se puede leer desde aqui aunque tecnicamente sea publico.
   */
  | 'blocked'
  /** No hay endpoint publico de puntos. */
  | 'none';

export interface PointsProgram {
  readonly venueId: string;
  readonly venue: string;
  /** Pagina oficial del programa. Es la unica fuente de fechas y premios. */
  readonly url: string;
  readonly apiStatus: PointsApiStatus;
  /** Codigo HTTP observado al comprobarlo, cuando aplica. */
  readonly apiNote: string | null;
  /** YYYY-MM-DD de la ultima comprobacion manual. */
  readonly verifiedAt: string;
}

/**
 * Comprobado endpoint a endpoint el 2026-09-09. Los codigos son los que
 * devolvieron de verdad, no una suposicion.
 *
 * Al revisar esto hay que actualizar `verifiedAt`, porque la pantalla avisa
 * cuando una entrada se queda vieja.
 */
export const POINTS_PROGRAMS: readonly PointsProgram[] = [
  {
    venueId: 'perpl',
    venue: 'Perpl',
    url: 'https://app.perpl.xyz/rewards',
    // El unico de todos que si los publica: `/api/v1/pub/context` trae
    // `rewards` con los puntos por epoca y `competitions` con los torneos, sus
    // fechas y como se reparte el bote. Sin clave y en la misma llamada que ya
    // se hace para los mercados.
    apiStatus: 'public',
    apiNote: 'rewards and competitions in /api/v1/pub/context, no key',
    verifiedAt: '2026-09-20',
  },
  {
    venueId: 'variational',
    venue: 'Variational',
    url: 'https://omni.variational.io/points',
    // Su propia web pide /api/points/next_drop_ts y /api/metadata/tiers sin
    // sesion, asi que el dato es publico, pero desde fuera del navegador
    // Cloudflare devuelve su desafio. Saltarlo no es una opcion.
    apiStatus: 'blocked',
    apiNote: '403 Cloudflare challenge on /api/points/*',
    verifiedAt: '2026-09-20',
  },
  {
    venueId: 'aster',
    venue: 'Aster',
    url: 'https://www.asterdex.com/en/referral',
    // La API de mercados (fapi) no tiene nada de puntos: 404 en /points y en
    // /rewards. Y su web no se deja mirar desde aqui para ver que llama, asi
    // que esto se queda a medias y hay que volver.
    apiStatus: 'blocked',
    apiNote: '404 on fapi /points and /rewards; the site itself blocks us',
    verifiedAt: '2026-09-20',
  },
  {
    venueId: 'hyperliquid',
    venue: 'Hyperliquid',
    url: 'https://app.hyperliquid.xyz/points',
    apiStatus: 'none',
    apiNote: 'no public points endpoint',
    verifiedAt: '2026-09-09',
  },
  {
    venueId: 'pacifica',
    venue: 'Pacifica',
    url: 'https://app.pacifica.fi/points',
    apiStatus: 'none',
    apiNote: '404 on /points and /info/leaderboard',
    verifiedAt: '2026-09-09',
  },
  {
    venueId: 'backpack',
    venue: 'Backpack',
    url: 'https://backpack.exchange/rewards',
    apiStatus: 'none',
    apiNote: '404 on /points',
    verifiedAt: '2026-09-09',
  },
  {
    venueId: 'paradex',
    venue: 'Paradex',
    url: 'https://app.paradex.trade/points',
    apiStatus: 'auth-required',
    apiNote: '401 INVALID_TOKEN, requires a signed session',
    verifiedAt: '2026-09-09',
  },
  {
    venueId: 'dydx',
    venue: 'dYdX',
    url: 'https://dydx.trade/trading-rewards',
    apiStatus: 'none',
    apiNote: '404 on /rewards',
    verifiedAt: '2026-09-09',
  },
  {
    venueId: 'lighter',
    venue: 'Lighter',
    url: 'https://app.lighter.xyz/points',
    apiStatus: 'auth-required',
    apiNote: '403, requires login',
    verifiedAt: '2026-09-09',
  },
];

/** Dias transcurridos desde una fecha YYYY-MM-DD. */
export function daysSince(iso: string, now: number = Date.now()): number | null {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor((now - t) / 86_400_000) : null;
}

/** A partir de aqui una comprobacion manual deja de considerarse vigente. */
export const POINTS_STALE_AFTER_DAYS = 30;

export interface PointsFreshness {
  /** Entradas cuya comprobacion ha caducado. */
  readonly stale: readonly PointsProgram[];
  /** Dias de la comprobacion mas antigua, o null si no hay entradas. */
  readonly oldestDays: number | null;
}

/**
 * Estado de frescura del catalogo.
 *
 * Es lo que hace que esta fuente se ponga amarilla sola: un dato verificado
 * hace tres meses no es un dato vivo, aunque siga escrito.
 */
export function pointsFreshness(
  programs: readonly PointsProgram[] = POINTS_PROGRAMS,
  now: number = Date.now(),
): PointsFreshness {
  let oldest: number | null = null;
  const stale: PointsProgram[] = [];

  for (const p of programs) {
    const d = daysSince(p.verifiedAt, now);
    if (d === null) continue;
    if (oldest === null || d > oldest) oldest = d;
    if (d > POINTS_STALE_AFTER_DAYS) stale.push(p);
  }

  return { stale, oldestDays: oldest };
}
