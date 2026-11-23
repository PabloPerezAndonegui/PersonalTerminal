import type { DataSourceMeta, SectionId, SectionImpact, TrafficLight } from './types.ts';
import { SECTION_ORDER } from './types.ts';

/**
 * Estado de una fuente, tal y como llega desde el collector (venues) o desde
 * el verificador de fuentes manuales.
 *
 * Se recibe como dato plano a proposito: este paquete no depende del collector,
 * asi que la capa que los une es la API y no hay ciclo entre paquetes.
 */
export interface SourceState {
  readonly id: string;
  readonly light: TrafficLight;
}

/** `ok` -> verde, `degraded` -> amarillo, `down` -> rojo. */
export function statusToLight(status: 'ok' | 'degraded' | 'down'): TrafficLight {
  if (status === 'ok') return 'green';
  if (status === 'degraded') return 'yellow';
  return 'red';
}

/**
 * Cruza el catalogo con el estado actual y dice como esta cada pestana.
 *
 * La regla, en una linea: una fuente **critica** en rojo tumba la seccion; todo
 * lo demas la degrada. Es lo que permite responder de un vistazo a las dos
 * preguntas reales del usuario: "esto que veo raro, de donde viene" y "que me
 * estoy perdiendo ahora mismo".
 */
export function resolveImpact(
  sources: readonly DataSourceMeta[],
  states: readonly SourceState[],
): SectionImpact[] {
  const byId = new Map(states.map((s) => [s.id, s.light]));

  return SECTION_ORDER.map((section) => {
    const brokenCritical: string[] = [];
    const degraded: string[] = [];

    for (const source of sources) {
      const feed = source.feeds.find((f) => f.section === section);
      if (feed === undefined) continue;

      // Una fuente sin estado todavia no ha reportado. No se asume que este
      // bien: se trata como degradada, que es lo honesto mientras no haya dato.
      const light = byId.get(source.id) ?? 'yellow';
      if (light === 'green') continue;

      if (feed.criticality === 'critical' && light === 'red') brokenCritical.push(source.id);
      else degraded.push(source.id);
    }

    let light: TrafficLight = 'green';
    if (brokenCritical.length > 0) light = 'red';
    else if (degraded.length > 0) light = 'yellow';

    return { section, light, brokenCritical, degraded };
  });
}

/** Impacto de una sola seccion, para el aviso dentro de esa misma pantalla. */
export function impactForSection(
  sources: readonly DataSourceMeta[],
  states: readonly SourceState[],
  section: SectionId,
): SectionImpact {
  const found = resolveImpact(sources, states).find((i) => i.section === section);
  // SECTION_ORDER cubre todas las secciones, asi que esto no deberia ocurrir;
  // se devuelve algo coherente en vez de lanzar por un id mal escrito.
  return found ?? { section, light: 'green', brokenCritical: [], degraded: [] };
}
