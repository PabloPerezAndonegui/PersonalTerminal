import { getJson, isRecord } from '../http.ts';

/**
 * Calendario economico de la semana, de la exportacion publica de ForexFactory.
 *
 * Por que esta fuente: el widget de TradingView es un iframe y no se puede
 * agrupar por dias ni cambiar sus columnas. Esta exportacion es JSON publico,
 * sin clave, pensado para que otros lo lean. Comprobado el 17 nov 2026: 125
 * eventos, renovada ese mismo dia, `max-age` de 60 s.
 *
 * Lo que NO trae, y se dice en pantalla en vez de rellenarlo: el dato real
 * publicado (solo previsto y anterior) y la semana siguiente (`nextweek`
 * responde 404). Para el dato real sigue el widget de TradingView como segunda
 * vista.
 *
 * Se pide cada hora: el calendario de la semana cambia poco y la propia
 * ForexFactory pide no consultarlo a rafagas.
 */

const URL_SEMANA = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';

export type Impacto = 'high' | 'medium' | 'low' | 'holiday';

export interface EventoEconomico {
  readonly id: string;
  readonly title: string;
  /** Divisa afectada: USD, EUR... ForexFactory clasifica por divisa, no por pais. */
  readonly currency: string;
  /** Instante en ms (UTC). La pantalla lo pinta en la hora local del navegador. */
  readonly at: number;
  readonly impact: Impacto;
  /** Tal cual lo publica la fuente ("2.9%", "-0.1M"). null si viene vacio. */
  readonly forecast: string | null;
  readonly previous: string | null;
}

const IMPACTOS: Readonly<Record<string, Impacto>> = {
  High: 'high', Medium: 'medium', Low: 'low', Holiday: 'holiday',
};

const texto = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

export async function fetchEconomicCalendar(): Promise<EventoEconomico[]> {
  const raw = await getJson(URL_SEMANA, { timeoutMs: 20_000 });
  if (!Array.isArray(raw)) throw new Error('ff_calendar_thisweek: unexpected shape');
  const out: EventoEconomico[] = [];
  for (const e of raw) {
    if (!isRecord(e)) continue;
    const title = texto(e['title']);
    const currency = texto(e['country']);
    const fecha = texto(e['date']);
    const at = fecha === null ? Number.NaN : Date.parse(fecha);
    const impact = IMPACTOS[String(e['impact'])];
    if (title === null || currency === null || !Number.isFinite(at) || impact === undefined) continue;
    out.push({
      id: `${at}-${currency}-${title}`,
      title, currency, at, impact,
      forecast: texto(e['forecast']),
      previous: texto(e['previous']),
    });
  }
  if (out.length === 0) throw new Error('ff_calendar_thisweek: 0 events');
  return out.sort((a, b) => a.at - b.at);
}
