/**
 * Apilar series para dibujarlas como bandas.
 *
 * lightweight-charts no sabe apilar: dibuja cada area desde cero hasta su
 * valor. El truco es pasarle SUMAS ACUMULADAS y pintarlas de la mayor a la
 * menor, de modo que cada una tape a la anterior y lo que queda a la vista es
 * el grosor de cada banda. Es lo que hace que un grafico apilado se lea como
 * "cuanto pone cada exchange" en vez de como veinte lineas cruzandose.
 *
 * Dos cosas que hay que hacer bien:
 *
 * 1. **Un exchange que no tiene punto en un instante no vale cero.** Si su
 *    ultima lectura conocida sigue dentro de la ventana, se arrastra; si nunca
 *    ha aparecido, ese instante no existe para el y su banda no empieza. Lo
 *    contrario dibuja escalones que no ha dado el mercado.
 * 2. **Los instantes tienen que ser comunes.** Cada fuente guarda a su ritmo,
 *    asi que se usa la union de sellos y se arrastra el ultimo valor de cada
 *    uno, que es lo que de verdad habia en ese momento.
 */

export interface SerieCruda {
  readonly venue: string;
  readonly points: readonly { readonly t: number; readonly v: number }[];
}

export interface Banda {
  readonly venue: string;
  readonly label: string;
  readonly color: string;
  /** El valor propio del exchange, NO el acumulado. Es lo que se lee. */
  readonly ultimoUsd: number | null;
  /** Acumulado hasta esta banda incluida, que es lo que se dibuja. */
  readonly points: readonly { readonly time: number; readonly value: number }[];
}

export interface OpcionesApilado {
  /** Cuantos exchanges llevan banda propia. El resto se juntan en una. */
  readonly maximo?: number;
  readonly colores: readonly string[];
  /** Nombre visible de cada venue. */
  readonly etiqueta: (venue: string) => string;
  /** Venues apagados por el usuario: no se dibujan ni suman. */
  readonly apagados?: readonly string[];
  /**
   * Cuanto tiempo se da por buena la ultima lectura de un venue.
   *
   * Por defecto, tres veces el paso tipico de la serie. Pasado ese tiempo sin
   * punto nuevo, el venue deja de sumar: su banda se corta en vez de seguir
   * recta hasta el final de la grafica.
   */
  readonly maxArrastreMs?: number;
}

const RESTO = '__resto__';

/**
 * De series por venue a bandas apiladas, de la mayor a la menor.
 *
 * El orden de vuelta es el de DIBUJO: primero la banda con el acumulado mas
 * alto, que es la de abajo del todo una vez pintadas las demas encima.
 */
export function apilar(series: readonly SerieCruda[], opciones: OpcionesApilado): Banda[] {
  const maximo = opciones.maximo ?? 8;
  const apagados = new Set(opciones.apagados ?? []);
  const vivas = series.filter((s) => !apagados.has(s.venue) && s.points.length > 0);
  if (vivas.length === 0) return [];

  // Se ordenan por su ultimo valor: lo que manda hoy va primero.
  const ultimo = (s: SerieCruda) => s.points[s.points.length - 1]?.v ?? 0;
  const ordenadas = [...vivas].sort((a, b) => ultimo(b) - ultimo(a));
  const propias = ordenadas.slice(0, maximo);
  const resto = ordenadas.slice(maximo);

  const grupos: { venue: string; label: string; series: SerieCruda[] }[] = [
    ...propias.map((s) => ({ venue: s.venue, label: opciones.etiqueta(s.venue), series: [s] })),
  ];
  if (resto.length > 0) {
    grupos.push({ venue: RESTO, label: `Other ${resto.length}`, series: resto });
  }

  // Union de sellos: cada fuente guarda a su ritmo y ninguna manda sobre el eje.
  const sellos = [...new Set(vivas.flatMap((s) => s.points.map((p) => p.t)))].sort((a, b) => a - b);

  /**
   * Hasta cuando vale la ultima lectura de un venue.
   *
   * Antes se arrastraba SIN LIMITE: un venue que dejaba de reportar, porque se
   * cayo o porque lo retiraron, seguia sumando su ultima cifra hasta el final
   * de la ventana, treinta dias enteros de interes abierto que ya no existia.
   * La cabecera de este fichero prometia lo contrario y el bucle no lo hacia.
   *
   * El limite sale de los propios datos: tres veces el paso tipico entre
   * sellos. Un paso fijo no valdria, porque la serie llega agregada a un cubo
   * distinto segun el rango: quince minutos en la vista de un dia y tres horas
   * en la de treinta.
   */
  const saltos: number[] = [];
  for (let i = 1; i < sellos.length; i++) saltos.push((sellos[i] ?? 0) - (sellos[i - 1] ?? 0));
  saltos.sort((a, b) => a - b);
  const pasoTipico = saltos[Math.floor(saltos.length / 2)] ?? 0;
  const maxArrastre = opciones.maxArrastreMs ?? Math.max(pasoTipico * 3, 45 * 60_000);

  // Por grupo, el valor en cada sello, arrastrando el ultimo conocido mientras
  // siga siendo reciente.
  const valores = grupos.map((g) => {
    const indices = g.series.map(() => 0);
    const ultimos: ({ v: number; t: number } | null)[] = g.series.map(() => null);
    return sellos.map((t) => {
      let suma: number | null = null;
      g.series.forEach((s, i) => {
        while ((indices[i] ?? 0) < s.points.length && (s.points[indices[i] ?? 0]?.t ?? 0) <= t) {
          const p = s.points[indices[i] ?? 0];
          ultimos[i] = p === undefined ? null : { v: p.v, t: p.t };
          indices[i] = (indices[i] ?? 0) + 1;
        }
        const u = ultimos[i];
        // Antes de su primer punto, ese exchange no existe todavia: no suma
        // cero, simplemente no esta. Y con la ultima lectura ya vieja, tampoco:
        // no se sabe cuanto tiene ahora, y repetir lo de hace dias es inventarlo.
        if (u !== null && u !== undefined && t - u.t <= maxArrastre) suma = (suma ?? 0) + u.v;
      });
      return suma;
    });
  });

  // Acumulado de abajo arriba y despues al reves para dibujar.
  const bandas: Banda[] = grupos.map((g, i) => {
    const points: { time: number; value: number }[] = [];
    sellos.forEach((t, j) => {
      let acumulado: number | null = null;
      for (let k = 0; k <= i; k++) {
        const v = valores[k]?.[j];
        if (v !== null && v !== undefined) acumulado = (acumulado ?? 0) + v;
      }
      if (acumulado !== null) points.push({ time: Math.floor(t / 1000), value: acumulado });
    });
    const propio = valores[i]?.[sellos.length - 1] ?? null;
    return {
      venue: g.venue,
      label: g.label,
      color: opciones.colores[i % opciones.colores.length] ?? '#4c9af8',
      ultimoUsd: propio,
      points,
    };
  });

  // De la mayor a la menor: la de arriba del todo se pinta primero y las de
  // abajo la van tapando, que es lo que crea las bandas.
  return bandas.reverse();
}
