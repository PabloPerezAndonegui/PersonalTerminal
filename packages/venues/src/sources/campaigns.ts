import { getJson, isRecord, num } from '../http.ts';

/**
 * Campanas leidas en vivo: competiciones y programas de puntos.
 *
 * `points.ts` explica por que no se copian a mano fechas ni premios: caducan
 * sin que nadie se entere. Lo que si se puede es LEERLOS de quien los publica,
 * y entonces no caducan. Comprobado venue a venue el 17 de noviembre de 2026,
 * solo Perpl los publica sin clave: `/api/v1/pub/context` trae `competitions`
 * (nombre, fechas, bote, volumen minimo) y `rewards` (puntos por epoca). Es la
 * misma llamada que ya hace su adaptador para los mercados.
 *
 * Los importes vienen en la unidad minima del token de colateral (AUSD, 6
 * decimales). Los decimales se leen de la propia respuesta, no se suponen.
 */

const URL_PERPL = 'https://app.perpl.xyz/api/v1/pub/context';

export interface Campana {
  readonly id: string;
  readonly venue: string;
  readonly name: string;
  readonly kind: 'competition' | 'points';
  readonly startsAt: number | null;
  /** null en un programa de puntos que no tiene fin anunciado. */
  readonly endsAt: number | null;
  /** Bote de la competicion, en USD. null si no aplica o no se publica. */
  readonly poolUsd: number | null;
  /** Volumen minimo para entrar en el reparto, en USD. */
  readonly minVolumeUsd: number | null;
  /** Puntos por epoca, en un programa de puntos. */
  readonly pointsPerEpoch: number | null;
  readonly epochDays: number | null;
  /** true cuando el venue ha cerrado los resultados. */
  readonly finalized: boolean;
  readonly url: string;
}

export async function fetchPerplCampaigns(): Promise<Campana[]> {
  const raw = await getJson(URL_PERPL, { timeoutMs: 20_000 });
  if (!isRecord(raw)) throw new Error('perpl pub/context: unexpected shape');

  const token = Array.isArray(raw['tokens']) && isRecord(raw['tokens'][0]) ? raw['tokens'][0] : null;
  const decimales = token === null ? null : num(token['decimals']);
  if (decimales === null) throw new Error('perpl pub/context: no collateral decimals');
  const escala = 10 ** decimales;
  const importe = (v: unknown): number | null => {
    const n = num(v);
    return n === null ? null : n / escala;
  };

  const out: Campana[] = [];
  if (Array.isArray(raw['competitions'])) {
    for (const c of raw['competitions']) {
      if (!isRecord(c) || typeof c['slug'] !== 'string' || typeof c['name'] !== 'string') continue;
      // El minimo que cuenta es el de volumen; si no lo hay, el de PSV.
      const minimo = importe(c['vol_min_volume']) || importe(c['psv_min_volume']) || null;
      out.push({
        id: `perpl:${c['slug']}`,
        venue: 'Perpl',
        name: c['name'],
        kind: 'competition',
        startsAt: num(c['starts_at']),
        endsAt: num(c['ends_at']),
        poolUsd: importe(c['pool_amount']),
        minVolumeUsd: minimo,
        pointsPerEpoch: null,
        epochDays: null,
        finalized: c['results_finalized'] === true,
        url: 'https://app.perpl.xyz/competitions',
      });
    }
  }

  const r = raw['rewards'];
  if (isRecord(r)) {
    const puntos = importe(r['points_per_epoch']);
    const duracion = num(r['points_epoch_duration_sec']);
    if (puntos !== null && duracion !== null) {
      out.push({
        id: 'perpl:points',
        venue: 'Perpl',
        name: 'Weekly points',
        kind: 'points',
        startsAt: num(r['points_epoch_starts_at']),
        endsAt: null,
        poolUsd: null,
        minVolumeUsd: null,
        pointsPerEpoch: puntos,
        epochDays: duracion / 86_400,
        finalized: false,
        url: 'https://app.perpl.xyz/rewards',
      });
    }
  }

  if (out.length === 0) throw new Error('perpl pub/context: no competitions nor rewards');
  return out;
}

/** En que punto esta una campana ahora. */
export function estadoCampana(c: Campana, ahora: number): 'live' | 'upcoming' | 'ended' {
  if (c.startsAt !== null && ahora < c.startsAt) return 'upcoming';
  if (c.finalized || (c.endsAt !== null && ahora >= c.endsAt)) return 'ended';
  return 'live';
}
