import { useEffect, useRef } from 'react';
import {
  createChart,
  createSeriesMarkers,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';

/**
 * Grafico de velas con volumen, indicadores, leyenda y marcas de ejecucion.
 *
 * Va aparte de `Chart` a proposito. Aquel dibuja N lineas comparables entre si,
 * con una escala compartida y colores que llegan por prop. Una vela no es eso:
 * tiene cuatro precios por punto, su color lo decide el dato y no quien llama,
 * y el volumen va en una escala distinta dentro del mismo panel.
 *
 * ## Lo que hace como TradingView, y por que
 *
 * **La leyenda sigue al cursor.** Arriba a la izquierda se leen apertura,
 * maximo, minimo y cierre de la vela bajo el cursor, y el valor de cada
 * indicador en ese mismo instante. Sin cursor, ensena la ultima vela. Un
 * grafico con medias que no dice cuanto vale la media obliga a estimarla a ojo
 * contra el eje.
 *
 * **Encender un indicador no recrea el grafico.** Se anade y se quita la serie,
 * y el alto se cambia con `resize`. Recrearlo perdia el zoom, y encender una
 * media es justo algo que se hace mirando un tramo concreto.
 *
 * **Los paneles se asignan en denso.** Cada grupo de indicador ('rsi', 'macd')
 * va al siguiente panel libre, en el orden en que se encienden. Antes los
 * indices eran fijos, y encender MACD sin RSI dejaba un panel vacio de 72 px
 * en medio.
 *
 * Los colores de vela salen de las custom properties del tema.
 */

export interface Vela {
  /** Apertura del intervalo, en epoch ms. */
  readonly t: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number | null;
}

/**
 * Un indicador ya calculado, listo para dibujar.
 *
 * `puntos` viene ALINEADO con las velas y con `null` donde el indicador todavia
 * no existe. Esos nulls se dibujan como hueco, no como cero: una EMA de 200 que
 * arrancase en cero bajaria la linea al suelo durante doscientas velas y eso se
 * lee como una senal que no existe.
 */
export interface Indicador {
  /** Clave estable. Al cambiar la lista solo se tocan los que entran y salen. */
  readonly id: string;
  readonly label: string;
  readonly tipo: 'linea' | 'histograma';
  readonly color: string;
  /**
   * null lo pone sobre el precio, que es donde van las medias y las bandas.
   * Un nombre le da panel propio debajo, compartido con los de su mismo grupo:
   * las tres series del MACD van juntas, y no con el RSI.
   */
  readonly grupo: string | null;
  readonly puntos: readonly (number | null)[];
  /** Decimales con los que se lee en la leyenda. Por defecto, los del precio. */
  readonly decimales?: number;
}

/** Una ejecucion (o varias de la misma vela) para marcar sobre el grafico. */
export interface Marca {
  /** Epoch ms de la VELA a la que pertenece, no del fill suelto. */
  readonly t: number;
  readonly lado: 'long' | 'short';
  readonly tipo: 'abre' | 'cierra';
  readonly texto: string;
}

/**
 * Como se ve el grafico: fondo, rejilla y colores de vela. Lo elige quien lo
 * mira (Terminal, menu Style). `fondo` vacio es el de la app.
 */
export interface Apariencia {
  readonly fondo: string;
  readonly rejilla: boolean;
  readonly subida: string;
  readonly bajada: string;
}

/** Si un color de fondo es claro: entonces el texto del grafico va oscuro. */
export function esClaro(color: string): boolean {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color.trim());
  if (m === null) return false;
  const [r, g, b] = [m[1], m[2], m[3]].map((x) => parseInt(x ?? '0', 16) / 255) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.55;
}

function token(nombre: string, porDefecto: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(nombre).trim();
  return v === '' ? porDefecto : v;
}

type SerieIndicador = ISeriesApi<'Line'> | ISeriesApi<'Histogram'>;

export function CandleChart({
  velas,
  height = 420,
  priceFormat,
  indicadores = [],
  marcas = [],
  escalaLog = false,
  titulo,
  apariencia,
}: {
  readonly velas: readonly Vela[];
  readonly height?: number;
  /** Decimales del precio. Un activo a 0,0000022 y otro a 85.000 no se pintan igual. */
  readonly priceFormat?: { precision: number; minMove: number } | undefined;
  readonly indicadores?: readonly Indicador[];
  readonly marcas?: readonly Marca[];
  readonly escalaLog?: boolean;
  /** Lo que encabeza la leyenda: activo e intervalo. */
  readonly titulo?: string;
  /** Fondo, rejilla y colores. Sin ella, los de la app. */
  readonly apariencia?: Apariencia | undefined;
}) {
  const contenedor = useRef<HTMLDivElement>(null);
  const leyenda = useRef<HTMLDivElement>(null);
  const grafico = useRef<IChartApi | null>(null);
  const serieVelas = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const serieVolumen = useRef<ISeriesApi<'Histogram'> | null>(null);
  const serieMarcas = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  /** Series de indicador vivas, por id, con el grupo al que pertenecen. */
  const vivas = useRef(new Map<string, { serie: SerieIndicador; grupo: string | null }>());
  /**
   * Si ya se encuadro una vez.
   *
   * El encuadre automatico se hace UNA vez por montaje. Repetirlo en cada
   * refresco deshace el zoom del usuario cada pocos segundos. Al cambiar de
   * activo o de intervalo si hay que reencuadrar, y de eso se encarga la
   * pantalla dandole un `key` distinto: React lo remonta y esto vuelve a false.
   */
  const encuadrado = useRef(false);

  // Los colores de vela en vigor: el volumen los usa al pintar cada barra.
  const colores = useRef({ subida: '#3fb950', bajada: '#f85149' });
  colores.current = {
    subida: apariencia?.subida || token('--pos', '#3fb950'),
    bajada: apariencia?.bajada || token('--neg', '#f85149'),
  };
  const claro = apariencia !== undefined && apariencia.fondo !== '' && esClaro(apariencia.fondo);

  // Lo ultimo que llego por props, a mano para la leyenda. El manejador del
  // cursor se registra una vez y lee de aqui: si cerrase sobre las props,
  // enseñaria para siempre las velas del primer render.
  const datos = useRef({ velas, indicadores, priceFormat, titulo });
  datos.current = { velas, indicadores, priceFormat, titulo };

  /** Escribe la leyenda para una vela. Sin indice, la ultima. */
  const pintarLeyenda = useRef((_t: number | null) => { /* se asigna abajo */ });
  pintarLeyenda.current = (t: number | null) => {
    const el = leyenda.current;
    if (el === null) return;
    const { velas: vs, indicadores: inds, priceFormat: pf, titulo: tit } = datos.current;
    el.textContent = '';
    if (vs.length === 0) return;

    let i = vs.length - 1;
    if (t !== null) {
      const j = vs.findIndex((v) => Math.floor(v.t / 1000) === t);
      if (j >= 0) i = j;
    }
    const v = vs[i];
    if (v === undefined) return;
    const dec = pf?.precision ?? 2;
    const n = (x: number, d = dec) => x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

    const trozo = (texto: string, clase?: string, color?: string) => {
      const s = document.createElement('span');
      s.textContent = texto;
      if (clase !== undefined) s.className = clase;
      if (color !== undefined) s.style.color = color;
      el.appendChild(s);
    };

    const sube = v.close >= v.open;
    const cambio = v.open > 0 ? ((v.close - v.open) / v.open) * 100 : 0;
    if (tit !== undefined) trozo(tit, 'candle-legend-titulo');
    for (const [k, x] of [['O', v.open], ['H', v.high], ['L', v.low], ['C', v.close]] as const) {
      trozo(k, 'candle-legend-k');
      trozo(n(x), sube ? 'pos' : 'neg');
    }
    trozo(`${cambio >= 0 ? '+' : ''}${cambio.toFixed(2)}%`, sube ? 'pos' : 'neg');
    if (v.volume !== null) { trozo('Vol', 'candle-legend-k'); trozo(n(v.volume, 2)); }

    // Una linea por grupo: lo del precio junto, y cada panel el suyo.
    let grupoPrevio: string | null | undefined;
    for (const ind of inds) {
      if (ind.grupo !== grupoPrevio) { el.appendChild(document.createElement('br')); grupoPrevio = ind.grupo; }
      const y = ind.puntos[i];
      trozo(ind.label, 'candle-legend-k', ind.color);
      trozo(y === null || y === undefined || !Number.isFinite(y) ? '—' : n(y, ind.decimales ?? dec), undefined, ind.color);
    }
  };

  // El grafico se crea UNA vez por montaje. El alto y la escala van aparte,
  // para que cambiarlos no lo recree ni pierda el zoom.
  useEffect(() => {
    const el = contenedor.current;
    if (el === null) return;

    const chart = createChart(el, {
      height,
      layout: {
        background: { color: 'transparent' },
        textColor: token('--text', '#e5e7eb'),
        fontFamily: token('--font-mono', 'monospace'),
        fontSize: 13,
      },
      grid: {
        vertLines: { color: token('--border', '#1b2433') },
        horzLines: { color: token('--border', '#1b2433') },
      },
      rightPriceScale: {
        borderColor: token('--border-strong', '#414e61'),
        // Hueco abajo para el volumen, que vive en el mismo panel.
        scaleMargins: { top: 0.08, bottom: 0.24 },
      },
      timeScale: {
        borderColor: token('--border-strong', '#414e61'),
        timeVisible: true,
        secondsVisible: false,
      },
      crosshair: { mode: 0 },
    });

    const velasApi = chart.addSeries(CandlestickSeries, {
      upColor: token('--pos', '#3fb950'),
      downColor: token('--neg', '#f85149'),
      borderUpColor: token('--pos', '#3fb950'),
      borderDownColor: token('--neg', '#f85149'),
      wickUpColor: token('--pos', '#3fb950'),
      wickDownColor: token('--neg', '#f85149'),
    });

    const volumenApi = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'volumen',
      lastValueVisible: false,
      priceLineVisible: false,
    });
    // Escala propia, pegada abajo y sin etiquetas: el volumen aqui es forma,
    // no una cifra que se lea del eje. La cifra exacta va en la leyenda.
    chart.priceScale('volumen').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

    encuadrado.current = false;
    grafico.current = chart;
    serieVelas.current = velasApi;
    serieVolumen.current = volumenApi;
    serieMarcas.current = createSeriesMarkers(velasApi, []);

    chart.subscribeCrosshairMove((p) => {
      pintarLeyenda.current(typeof p.time === 'number' ? p.time : null);
    });

    const observador = new ResizeObserver(() => { chart.applyOptions({ width: el.clientWidth }); });
    observador.observe(el);
    chart.applyOptions({ width: el.clientWidth });

    return () => {
      observador.disconnect();
      chart.remove();
      grafico.current = null;
      serieVelas.current = null;
      serieVolumen.current = null;
      serieMarcas.current = null;
      vivas.current.clear();
    };
    // `height` NO va aqui a proposito: lo aplica el efecto de abajo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { grafico.current?.applyOptions({ height }); }, [height]);

  // El aspecto se aplica sin recrear el grafico: no se pierde el zoom.
  useEffect(() => {
    const chart = grafico.current;
    if (chart === null) return;
    const linea = claro ? '#e2e8f0' : token('--border', '#1b2433');
    chart.applyOptions({
      layout: {
        background: { color: apariencia?.fondo || 'transparent' },
        textColor: claro ? '#1f2937' : token('--text', '#e5e7eb'),
      },
      grid: {
        vertLines: { color: linea, visible: apariencia?.rejilla ?? true },
        horzLines: { color: linea, visible: apariencia?.rejilla ?? true },
      },
      rightPriceScale: { borderColor: claro ? '#cbd5e1' : token('--border-strong', '#414e61') },
      timeScale: { borderColor: claro ? '#cbd5e1' : token('--border-strong', '#414e61') },
    });
    const { subida, bajada } = colores.current;
    serieVelas.current?.applyOptions({
      upColor: subida, downColor: bajada,
      borderUpColor: subida, borderDownColor: bajada,
      wickUpColor: subida, wickDownColor: bajada,
    });
  }, [apariencia?.fondo, apariencia?.rejilla, apariencia?.subida, apariencia?.bajada, claro]);

  useEffect(() => {
    // 1 es logaritmica y 0 normal, segun `PriceScaleMode` de la libreria.
    grafico.current?.priceScale('right').applyOptions({ mode: escalaLog ? 1 : 0 });
  }, [escalaLog]);

  // Los decimales cambian con el activo, no con cada refresco.
  useEffect(() => {
    if (serieVelas.current === null || priceFormat === undefined) return;
    serieVelas.current.applyOptions({
      priceFormat: { type: 'price', precision: priceFormat.precision, minMove: priceFormat.minMove },
    });
  }, [priceFormat?.precision, priceFormat?.minMove]);

  useEffect(() => {
    const velasApi = serieVelas.current;
    const volumenApi = serieVolumen.current;
    const chart = grafico.current;
    if (velasApi === null || volumenApi === null || chart === null) return;

    const { subida, bajada } = colores.current;

    velasApi.setData(velas.map((v) => ({
      time: Math.floor(v.t / 1000) as UTCTimestamp,
      open: v.open,
      high: v.high,
      low: v.low,
      close: v.close,
    })));
    volumenApi.setData(velas.filter((v) => v.volume !== null).map((v) => ({
      time: Math.floor(v.t / 1000) as UTCTimestamp,
      value: v.volume!,
      // El volumen hereda el color de SU vela: asi se ve si el empuje vino de
      // compra o de venta sin tener que mirar arriba y abajo.
      color: v.close >= v.open ? subida : bajada,
    })));

    if (!encuadrado.current && velas.length > 0) {
      // Las ultimas ~180 velas y no todas: con mil velas encajadas en el
      // ancho, cada una mide dos pixeles y no se lee nada. El resto esta ahi,
      // arrastrando hacia la izquierda.
      const hasta = velas.length - 1;
      chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, hasta - 180), to: hasta + 6 });
      encuadrado.current = true;
    }
    pintarLeyenda.current(null);
  }, [velas, apariencia?.subida, apariencia?.bajada]);

  /**
   * Los indicadores: se crean, se actualizan y se retiran por id.
   *
   * El panel de cada uno se decide AQUI, mirando lo que hay vivo, y no viene
   * de fuera: si ya hay una serie de su grupo, va a su mismo panel; si no,
   * al siguiente libre. Al quitar la ultima serie de un panel la libreria lo
   * elimina sola y los de debajo suben, asi que nunca queda un hueco.
   */
  useEffect(() => {
    const chart = grafico.current;
    if (chart === null) return;
    const mapa = vivas.current;

    for (const [id, viva] of mapa) {
      if (!indicadores.some((i) => i.id === id)) {
        try { chart.removeSeries(viva.serie); } catch { /* ya no estaba */ }
        mapa.delete(id);
      }
    }

    for (const ind of indicadores) {
      let viva = mapa.get(ind.id);
      if (viva === undefined) {
        let panel = 0;
        if (ind.grupo !== null) {
          const hermana = [...mapa.values()].find((x) => x.grupo === ind.grupo);
          panel = hermana !== undefined ? hermana.serie.getPane().paneIndex() : chart.panes().length;
        }
        const serie: SerieIndicador = ind.tipo === 'histograma'
          ? chart.addSeries(HistogramSeries, { color: ind.color, priceLineVisible: false, lastValueVisible: false }, panel)
          : chart.addSeries(LineSeries, {
            color: ind.color,
            lineWidth: 2,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
          }, panel);
        viva = { serie, grupo: ind.grupo };
        mapa.set(ind.id, viva);
      } else {
        viva.serie.applyOptions({ color: ind.color });
      }

      // Un null va como punto EN BLANCO, que rompe la linea, y no como cero.
      viva.serie.setData(velas.map((v, i) => {
        const y = ind.puntos[i];
        const time = Math.floor(v.t / 1000) as UTCTimestamp;
        return y === null || y === undefined || !Number.isFinite(y) ? { time } : { time, value: y };
      }));
    }

    // Los paneles de indicador, a una fraccion del de precio: el precio manda.
    const paneles = chart.panes();
    for (let i = 1; i < paneles.length; i++) paneles[i]?.setStretchFactor(0.28);
    pintarLeyenda.current(null);
  }, [indicadores, velas]);

  // Marcas de ejecucion. Largo y corto llevan el verde y el rojo del SIGNO,
  // que es el uso que DESIGN.md reserva para esos dos colores.
  useEffect(() => {
    const plugin = serieMarcas.current;
    if (plugin === null) return;
    const pos = token('--pos', '#3fb950');
    const neg = token('--neg', '#f85149');
    // Con muchas marcas a la vista los textos se pisan y no se lee ninguno:
    // medido con una cuenta que hace cien operaciones por minuto, el grafico
    // quedaba tapado por una mancha de rotulos. Por encima de un umbral se
    // dejan solo las formas, y el detalle se lee en la tabla de debajo.
    const conTexto = marcas.length <= 40;
    const lista: SeriesMarker<Time>[] = [...marcas]
      .sort((a, b) => a.t - b.t)
      .map((m) => {
        const largo = m.lado === 'long';
        // Entrar larga o cerrar una corta son COMPRAS y van bajo la vela;
        // entrar corta o cerrar una larga son ventas y van encima. Las
        // entradas son flechas y las salidas circulos, para que una salida no
        // se lea como una entrada del lado contrario.
        const compra = (m.tipo === 'abre') === largo;
        return {
          time: Math.floor(m.t / 1000) as UTCTimestamp,
          position: compra ? 'belowBar' as const : 'aboveBar' as const,
          shape: m.tipo === 'abre' ? (largo ? 'arrowUp' as const : 'arrowDown' as const) : 'circle' as const,
          color: largo ? pos : neg,
          ...(conTexto ? { text: m.texto } : {}),
        };
      });
    plugin.setMarkers(lista);
  }, [marcas, velas]);

  return (
    <div className={claro ? 'candle-wrap candle-claro' : 'candle-wrap'}
      style={apariencia?.fondo ? { background: apariencia.fondo } : undefined}>
      <div ref={leyenda} className="candle-legend" aria-hidden="true" />
      <div ref={contenedor} className="candle-chart" />
    </div>
  );
}
