/**
 * Corta la linea donde faltan datos.
 *
 * lightweight-charts une dos puntos consecutivos con una recta sin mirar
 * cuanto tiempo hay entre ellos: un apagon de tres dias se dibujaba como una
 * linea limpia entre el ultimo dato de antes y el primero de despues. Eso es
 * continuidad inventada, y lleva a leer una tendencia donde solo hubo silencio.
 *
 * Un punto sin `value` (whitespace, en su terminologia) ocupa su sitio en el
 * eje. El trazo NO lo corta: eso lo hace `ocultarSaltos`, mas abajo.
 *
 * `gapSeconds` es lo que puede separar a dos puntos sin que eso sea un hueco,
 * y va POR SERIE porque cada pantalla guarda a su ritmo: los volcados de
 * funding van cada 5 minutos y 20 de margen sobran, pero el interes abierto
 * guarda el desglose por simbolo una vez por hora, y con el mismo umbral cada
 * intervalo normal se habria pintado como un corte.
 */
/** Tope de marcas vacias por serie: un rango de 30 dias a 15 min son 2.880. */
const MAX_RELLENO = 4000;

export function conHuecos(
  puntos: readonly { time: number; value: number }[],
  gapSeconds = 20 * 60,
  opciones: {
    /**
     * Paso de la serie. Con el, el hueco se RELLENA de marcas vacias a ese paso
     * y el eje queda proporcional al tiempo. lightweight-charts reparte el eje
     * por puntos, no por tiempo: con una sola marca, tres dias sin datos
     * ocupaban lo mismo que un paso, y la caida de antes a despues parecia un
     * desplome de minutos.
     */
    readonly pasoSeconds?: number;
    /** Inicio del rango pedido: el eje empieza aqui aunque no haya datos. */
    readonly desdeSeconds?: number;
  } = {},
): { time: number; value?: number }[] {
  const out: { time: number; value?: number }[] = [];
  const paso = opciones.pasoSeconds;
  let restantes = MAX_RELLENO;
  const rellenar = (desde: number, hasta: number) => {
    if (paso === undefined || paso <= 0) {
      // Sin paso, una marca basta para partir la linea.
      out.push({ time: desde + 1 });
      return;
    }
    for (let t = desde + paso; t < hasta && restantes > 0; t += paso, restantes--) out.push({ time: t });
  };

  const primero = puntos[0];
  if (opciones.desdeSeconds !== undefined && primero !== undefined && paso !== undefined
    && primero.time - opciones.desdeSeconds > gapSeconds) {
    rellenar(opciones.desdeSeconds - paso, primero.time);
  }

  let anterior: number | null = null;
  for (const p of puntos) {
    if (anterior !== null && p.time - anterior > gapSeconds) rellenar(anterior, p.time);
    out.push({ time: p.time as number, value: p.value });
    anterior = p.time;
  }
  return out;
}

/**
 * Hace invisible el tramo que cruza un hueco.
 *
 * Las marcas vacias de `conHuecos` reservan el sitio en el eje, pero
 * lightweight-charts NO corta una serie de linea o de area en ellas: une el
 * ultimo punto de antes con el primero de despues, y un apagon de tres dias se
 * dibujaba como una pendiente suave. Lo que si respeta es el color por punto,
 * y el color de un punto pinta el tramo que SALE de el (`walkLine` cambia de
 * estilo despues de trazar hasta el punto). Asi que el ultimo punto real antes
 * de un hueco lleva color transparente y el hueco se ve vacio. Comprobado en
 * pantalla el 17 nov 2026 con un hueco de 68 h en Open Interest.
 */
export function ocultarSaltos(
  datos: readonly { time: number; value?: number }[],
  area: boolean,
): { time: number; value?: number; color?: string; lineColor?: string; topColor?: string; bottomColor?: string }[] {
  const out: { time: number; value?: number; color?: string; lineColor?: string; topColor?: string; bottomColor?: string }[] = [...datos];
  // De atras adelante: un punto real va seguido de hueco si el siguiente es
  // una marca vacia y despues todavia hay algun punto real al que unirse.
  let realDespues = false;
  let siguienteVacio = false;
  for (let i = datos.length - 1; i >= 0; i--) {
    const d = datos[i];
    if (d === undefined) continue;
    if (d.value === undefined) {
      siguienteVacio = true;
      continue;
    }
    if (siguienteVacio && realDespues) {
      out[i] = area
        ? { ...d, lineColor: 'transparent', topColor: 'transparent', bottomColor: 'transparent' }
        : { ...d, color: 'transparent' };
    }
    realDespues = true;
    siguienteVacio = false;
  }
  return out;
}
