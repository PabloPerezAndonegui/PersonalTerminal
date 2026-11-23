import { conHuecos, ocultarSaltos } from './chartGaps.ts';
import { useEffect, useRef } from 'react';
import {
  createChart,
  AreaSeries,
  LineSeries,
  type AutoscaleInfo,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';

/**
 * Grafico de lineas.
 *
 * Componente unico para Parity y para la evolucion de DEX Volume: por eso los
 * colores llegan por prop en vez de decidirse aqui, y por eso no sabe nada de
 * funding ni de precios.
 *
 * Los colores se leen de las custom properties del tema, no se escriben en el
 * codigo (ver DESIGN.md: los tokens se definen una vez).
 */

export interface Serie {
  readonly id: string;
  readonly label: string;
  readonly color: string;
  /** Grosor en pixeles. Por defecto 1; se sube para la serie que manda. */
  readonly width?: number;
  readonly gapSeconds?: number;
  /** Paso de la serie: con el, los huecos se ven del tamano que tuvieron. */
  readonly stepSeconds?: number;
  /** Inicio del rango pedido, para que el eje lo cubra entero. */
  readonly fromSeconds?: number;
  /**
   * En la escala de la izquierda, con su propio rango. Para superponer una
   * magnitud distinta, como el precio sobre el interes abierto.
   */
  readonly leftScale?: boolean;
  /**
   * Relleno degradado bajo la linea, como en DefiLlama.
   *
   * Para una magnitud que SE ACUMULA, como el interes abierto, el area dice de
   * un vistazo cuanto hay; para una tasa que cruza el cero, como el funding,
   * rellenar bajo la linea no significa nada. Por eso va por serie.
   */
  readonly area?: boolean;
  /** Puntos ordenados por tiempo, en segundos epoch. */
  readonly points: readonly { time: number; value: number }[];
}

function token(nombre: string, porDefecto: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(nombre).trim();
  return v === '' ? porDefecto : v;
}

/**
 * El mismo color con transparencia, para el degradado del area.
 *
 * Se deriva del color de la serie en vez de pedir un segundo color: asi la
 * leyenda y el relleno no se pueden desincronizar, y quien llama sigue pasando
 * un unico color por serie.
 */
function conAlfa(color: string, alfa: number): string {
  const hex = color.trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return hex;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alfa})`;
}

export function Chart({
  series,
  height = 320,
  formatValue,
  baseline,
  readableAxes = false,
  fromZero = false,
}: {
  series: readonly Serie[];
  height?: number;
  /** Formateo del eje y del tooltip. Sin esto, un % y un precio se verian igual. */
  formatValue?: (v: number) => string;
  /**
   * Linea de referencia horizontal.
   *
   * En el funding el cero no es un numero mas: por encima cobras y por debajo
   * pagas. Sin la raya hay que ir mirando el eje para saber de que lado esta
   * cada tramo.
   */
  baseline?: number;
  /** Ejes destacados para el funding. */
  readableAxes?: boolean;
  /**
   * El eje vertical empieza en cero. Obligado en un area apilada: si empieza
   * en 5 B, la banda de abajo parece una rodaja y cualquier variacion parece
   * un desplome.
   */
  fromZero?: boolean;
}) {
  const contenedor = useRef<HTMLDivElement>(null);
  const grafico = useRef<IChartApi | null>(null);
  const lineas = useRef(new Map<string, ISeriesApi<'Line'> | ISeriesApi<'Area'>>());
  /** Si cada serie se dibujo como area, para saber cuando hay que recrearla. */
  const tipos = useRef(new Map<string, boolean>());
  const referencia = useRef<IPriceLine | null>(null);
  /**
   * El formateador vive en una ref, NO en las dependencias.
   *
   * Quien llama suele pasarlo como una flecha escrita en el propio JSX, o sea
   * una funcion nueva en cada repintado. Teniendolo como dependencia del
   * efecto que CREA el grafico, cualquier repintado del padre lo destruia y lo
   * volvia a crear. En el screener, donde una cuenta atras repinta cada
   * segundo, el grafico se recreaba una vez por segundo: parpadeaba y perdia
   * el zoom. Un formateador nuevo no es motivo para tirar un grafico.
   */
  const formateador = useRef(formatValue);
  formateador.current = formatValue;

  useEffect(() => {
    const el = contenedor.current;
    if (el === null) return;

    const chart = createChart(el, {
      height,
      layout: {
        background: { color: 'transparent' },
        textColor: token('--text', '#e5e7eb'),
        fontFamily: readableAxes ? 'ChartAxisBold, monospace' : token('--font-mono', 'monospace'),
        // Los numeros del eje se leen de lejos: son la escala de todo lo demas.
        fontSize: readableAxes ? 16 : 13,
      },
      grid: {
        vertLines: { color: token('--border', '#1b2433'), visible: !readableAxes },
        horzLines: { color: token('--border', '#1b2433') },
      },
      rightPriceScale: {
        borderColor: token('--border-strong', '#414e61'),
        scaleMargins: { top: 0.12, bottom: 0.12 },
      },
      timeScale: { borderColor: token('--border-strong', '#414e61'), timeVisible: true },
      crosshair: { mode: 0 },
      // Sin animaciones: los datos que se actualizan solos no deben saltar.
      handleScale: { axisPressedMouseMove: false },
    });

    // Se llama al de la ref, asi que cambiarlo no exige recrear nada.
    chart.applyOptions({
      localization: { priceFormatter: (v: number) => formateador.current?.(v) ?? String(v) },
    });

    grafico.current = chart;

    const observador = new ResizeObserver(() => {
      chart.applyOptions({ width: el.clientWidth });
    });
    observador.observe(el);
    chart.applyOptions({ width: el.clientWidth });

    return () => {
      observador.disconnect();
      chart.remove();
      grafico.current = null;
      lineas.current.clear();
    };
  }, [height, readableAxes]);

  useEffect(() => {
    const chart = grafico.current;
    if (chart === null) return;

    // Se retiran las series que ya no vienen, en vez de recrear el grafico
    // entero: recrearlo perdería el zoom que el usuario haya hecho.
    for (const [id, linea] of lineas.current) {
      if (!series.some((s) => s.id === id)) {
        chart.removeSeries(linea);
        lineas.current.delete(id);
      }
    }

    for (const s of series) {
      let linea = lineas.current.get(s.id);
      // Si una serie cambia de linea a area hay que recrearla: son dos tipos de
      // serie distintos y no se puede cambiar uno por otro con applyOptions.
      const tipo = tipos.current.get(s.id);
      if (linea !== undefined && tipo !== (s.area === true)) {
        chart.removeSeries(linea);
        lineas.current.delete(s.id);
        linea = undefined;
      }
      if (linea === undefined) {
        linea = s.area === true
          ? chart.addSeries(AreaSeries, {
            lineColor: s.color,
            lineWidth: (s.width ?? 2) as 1 | 2 | 3 | 4,
            topColor: conAlfa(s.color, 0.45),
            bottomColor: conAlfa(s.color, 0.02),
            priceLineVisible: false,
            lastValueVisible: false,
          })
          : chart.addSeries(LineSeries, {
            color: s.color,
            lineWidth: (s.width ?? 1) as 1 | 2 | 3 | 4,
            priceLineVisible: false,
            lastValueVisible: false,
          });
        lineas.current.set(s.id, linea);
        tipos.current.set(s.id, s.area === true);
      } else if (s.area === true) {
        linea.applyOptions({ lineColor: s.color, topColor: conAlfa(s.color, 0.45), bottomColor: conAlfa(s.color, 0.02) });
      } else {
        linea.applyOptions({ color: s.color, lineWidth: (s.width ?? 1) as 1 | 2 | 3 | 4 });
      }
      const conMarcas = conHuecos(s.points, s.gapSeconds, {
        ...(s.stepSeconds === undefined ? {} : { pasoSeconds: s.stepSeconds }),
        ...(s.fromSeconds === undefined ? {} : { desdeSeconds: s.fromSeconds }),
      });
      linea.applyOptions({
        priceScaleId: s.leftScale === true ? 'left' : 'right',
        // El precio con sus decimales, no con el formato en dolares compactos
        // de la magnitud principal ("$0" para una moneda de 0,0028).
        ...(s.leftScale === true
          ? { priceFormat: { type: 'custom' as const, minMove: 1e-8, formatter: (v: number) => (v >= 100 ? v.toFixed(1) : v.toPrecision(4)) } }
          : {}),
        // Desde cero solo la magnitud apilada; el precio, en su rango.
        autoscaleInfoProvider: fromZero && s.leftScale !== true
          ? (original: () => AutoscaleInfo | null) => {
            const r = original();
            return r === null ? null : { ...r, priceRange: { minValue: 0, maxValue: r.priceRange.maxValue } };
          }
          : undefined,
      });
      linea.setData(ocultarSaltos(conMarcas, s.area === true).map(p => ({ ...p, time: p.time as UTCTimestamp })));
    }

    // La referencia se cuelga de la primera serie, que es la que manda la
    // escala. Se quita y se vuelve a poner para que no se acumulen.
    const principal = lineas.current.values().next().value;
    if (referencia.current !== null) {
      try { principal?.removePriceLine(referencia.current); } catch { /* ya no estaba */ }
      referencia.current = null;
    }
    if (baseline !== undefined && principal !== undefined) {
      referencia.current = principal.createPriceLine({
        price: baseline,
        color: token('--border-strong', '#46566d'),
        lineWidth: readableAxes ? 2 : 1,
        lineStyle: 2,
        axisLabelVisible: false,
        title: '',
      });
    }

    chart.applyOptions({
      leftPriceScale: {
        visible: series.some((x) => x.leftScale === true),
        borderColor: token('--border-strong', '#414e61'),
        scaleMargins: { top: 0.12, bottom: 0.12 },
      },
    });
    chart.timeScale().fitContent();
  }, [series, baseline, height, readableAxes, fromZero]);

  return <div ref={contenedor} className="chart" />;
}

/**
 * Paleta para series categoricas.
 *
 * No usa el verde, el rojo ni el ambar del semaforo: en esta app esos colores
 * significan estado, y una linea verde en un grafico no significa "bien". El
 * primero es el acento, que es el que se lleva la serie principal.
 */
export const SERIE_COLORS = [
  '#4c9af8', '#c98bdb', '#5ed3e0', '#e0805c', '#9aa0e8', '#e888b0', '#c9bf6b',
];
