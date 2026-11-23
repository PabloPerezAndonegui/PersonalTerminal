import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { getJson, fmt, type OpenInterestResponse, usd } from '../api.ts';
import { Chart, SERIE_COLORS, type Serie } from '../components/Chart.tsx';
import { apilar, type Banda } from './openInterestStack.ts';
import { useFavoritos, Estrella } from '../components/favoritos.tsx';
import { useTipoVenue, deTipo, FiltroTipo } from '../components/tipoVenue.tsx';

/**
 * Open Interest.
 *
 * Cuanto riesgo abierto hay, por activo y por exchange, y donde se concentra.
 *
 * **De donde sale cada numero.** Los DEX los lee el collector en cada ciclo y
 * cada CEX es UNA peticion por vuelta con todos sus mercados dentro. Encima de
 * eso, DefiLlama aporta los protocolos que no leemos directos. Cada fila
 * declara que parte del exchange cubre y de donde viene su cifra.
 *
 * **Lo que no se mezcla.** DefiLlama y la API de un venue NO miden lo mismo:
 * para Hyperliquid, la primera da entre 8.100 y 9.000 millones y la segunda
 * 12.230, un dia tras otro, y la causa sigue sin averiguarse. Por eso los
 * protocolos que leemos directos se excluyen de la aportacion de DefiLlama:
 * no para tapar el desacuerdo, sino para no contarlos dos veces.
 *
 * **Filtrar no descarga.** Cambiar de simbolo o de exchange se resuelve con lo
 * que la API ya tiene en memoria y con el historico guardado.
 *
 * La pantalla va por bloques separados, uno por pregunta. La version anterior
 * era un muro de tablas pegadas donde no se sabia donde empezaba cada cosa.
 */

const CLAVES = {
  symbol: 'oi.symbol',
  venues: 'oi.venues',
  range: 'oi.range',
  lado: 'oi.side',
};

type Rango = '1d' | '7d' | '30d' | '90d' | '1y';

const RANGO_MS: Readonly<Record<Rango, number>> = {
  '1d': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000, '90d': 90 * 86_400_000, '1y': 365 * 86_400_000,
};

/**
 * Hasta donde se une un punto con el siguiente y se arrastra el valor de un
 * venue. En 1 d, tres pasos; desde 7 d, un dia y pico, porque lo rellenado de
 * DefiLlama es un punto diario y con tres pasos cada dia quedaria suelto.
 */
const umbralMs = (rango: Rango, resolucion: number) =>
  Math.max(resolucion * 3, rango === '1d' ? 45 * 60_000 : 26 * 3_600_000);

/**
 * Como se presenta el interes abierto.
 *
 * `one` es una pata: lo que de verdad se guarda y lo unico comparable sin
 * suposiciones. `both` es la cifra global, que es como la ensenan la mayoria
 * de los venues en su propia web y los agregadores.
 *
 * **Es una decision de PRESENTACION, nunca de almacenamiento.** En la base de
 * datos solo entra la cifra de una pata; doblarla es una multiplicacion que se
 * hace al pintar. Guardar el doble convertiria una suposicion de hoy en un
 * historico irreversible.
 */
type Lado = 'one' | 'both';

/** Centinela: la lista vacia significa "todos", asi que hace falta otro valor. */
const NINGUNO = '__none__';

/** Cuantos exchanges se ensenan antes de tener que pedir el resto. */
const FILAS_VISIBLES = 12;

function leer<T>(clave: string, porDefecto: T): T {
  try {
    const v = localStorage.getItem(clave);
    return v === null ? porDefecto : (JSON.parse(v) as T);
  } catch {
    return porDefecto;
  }
}

function guardar(clave: string, valor: unknown): void {
  try {
    localStorage.setItem(clave, JSON.stringify(valor));
  } catch {
    // Sin almacenamiento la pantalla funciona igual, solo no se recuerda.
  }
}


const pct = (v: number | null): string => (v === null ? '—' : `${(v * 100).toFixed(0)}%`);

const duracion = (ms: number): string => {
  if (ms >= 86_400_000) return `${Math.round(ms / 86_400_000)}d`;
  if (ms >= 3_600_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 60_000)}m`;
};


/**
 * Verde mas o menos intenso segun lo que pese la celda en SU fila.
 *
 * El tono es relativo a la fila y no a la tabla entera porque la pregunta aqui
 * es quien manda en cada instante. Comparar dias entre si ya lo hace la
 * grafica de arriba, y un degradado global dejaria las filas viejas en negro
 * solo por ser de cuando habia menos dinero abierto.
 */
function tono(parte: number | null): string | undefined {
  if (parte === null || !Number.isFinite(parte) || parte <= 0) return undefined;
  // Se parte de un verde apagado y solo sube la opacidad: un arcoiris aqui
  // seria decoracion, y el color en esta aplicacion significa estado.
  const alfa = (0.08 + Math.min(1, parte) * 0.42).toFixed(3);
  // El verde del tema, no una copia suya: duplicar el valor aqui hacia que
  // cambiar `--ok` dejase este degradado con el color viejo.
  const v = getComputedStyle(document.documentElement).getPropertyValue('--ok').trim();
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(v);
  if (m === null) return `rgba(63, 185, 80, ${alfa})`;
  return `rgba(${parseInt(m[1] ?? '3f', 16)}, ${parseInt(m[2] ?? 'b9', 16)}, ${parseInt(m[3] ?? '50', 16)}, ${alfa})`;
}

interface Heatmap {
  readonly columnas: readonly { venue: string; label: string }[];
  readonly sellos: readonly number[];
  readonly filas: readonly {
    t: number;
    total: number | null;
    celdas: readonly { v: number | null; parte: number | null }[];
  }[];
}

/** Un bloque de la pantalla, con su titulo y su aire alrededor. */
function Bloque({ title, subtitle, children }: {
  title: string;
  subtitle?: string | undefined;
  children: ReactNode;
}) {
  return (
    <section className="oi-bloque">
      <header className="oi-bloque-cabecera">
        <h2>{title}</h2>
        {subtitle !== undefined && <span className="none">{subtitle}</span>}
      </header>
      {children}
    </section>
  );
}

export function OpenInterest({ refreshKey }: { refreshKey: number }) {
  const [symbol, setSymbol] = useState<string>(() => leer(CLAVES.symbol, ''));
  const [elegidos, setElegidos] = useState<string[]>(() => leer(CLAVES.venues, [] as string[]));
  const [rango, setRango] = useState<Rango>(() => leer(CLAVES.range, '7d' as Rango));
  // Por defecto la cifra global, que es como la ensenan los venues y los
  // agregadores: es la que se reconoce al mirar la pantalla.
  const [lado, setLado] = useState<Lado>(() => leer(CLAVES.lado, 'both' as Lado));
  const [todasLasFilas, setTodasLasFilas] = useState(false);
  /** Exchanges apagados EN LA GRAFICA. No cambian la seleccion ni el total. */
  const [apagados, setApagados] = useState<string[]>([]);
  const [copiado, setCopiado] = useState<string | null>(null);
  // Favoritos por lista: lo que se mira a diario sube arriba del desplegable.
  const favVenues = useFavoritos("oi.fav.venues");
  const favActivos = useFavoritos("oi.fav.assets");
  const [data, setData] = useState<OpenInterestResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [menuAbierto, setMenuAbierto] = useState(false);
  const [buscarVenue, setBuscarVenue] = useState('');
  const [tipo, setTipo] = useTipoVenue();
  const [menuSimbolo, setMenuSimbolo] = useState(false);
  const [buscarSimbolo, setBuscarSimbolo] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);
  const simboloRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuAbierto && !menuSimbolo) return;
    const fuera = (e: MouseEvent) => {
      const n = e.target as Node;
      if (menuRef.current !== null && !menuRef.current.contains(n)) setMenuAbierto(false);
      if (simboloRef.current !== null && !simboloRef.current.contains(n)) setMenuSimbolo(false);
    };
    document.addEventListener('mousedown', fuera);
    return () => document.removeEventListener('mousedown', fuera);
  }, [menuAbierto, menuSimbolo]);

  // Los venues viajan como cadena: un array nuevo en cada repintado volveria a
  // pedir la serie sin parar. Es el mismo motivo que en el screener.
  const venuesCsv = elegidos.join(',');

  useEffect(() => {
    let vivo = true;
    const q = new URLSearchParams({ range: rango });
    if (symbol !== '') q.set('symbol', symbol);
    if (venuesCsv !== '') q.set('venues', venuesCsv);
    getJson<OpenInterestResponse>(`/api/open-interest?${q}`)
      .then((d) => { if (vivo) { setData(d); setError(null); } })
      .catch((e: unknown) => { if (vivo) setError(e instanceof Error ? e.message : String(e)); });
    return () => { vivo = false; };
  }, [symbol, venuesCsv, rango, refreshKey]);

  const todos = data?.venues ?? [];
  const marcados = elegidos.length === 0
    ? todos.map((v) => v.id)
    : elegidos.filter((v) => v !== NINGUNO);

  /**
   * De partida, los DEX de perps.
   *
   * Es lo que se viene a mirar aqui: donde esta el riesgo abierto en cadena.
   * Los CEX siguen estando y se encienden desde el desplegable, pero no entran
   * en el primer vistazo.
   *
   * Las opciones y los mercados de prediccion tampoco. DefiLlama los publica
   * en la misma dimension, asi que sin esto Kalshi entraria en la grafica de
   * perps con 1,5 B. Se pueden encender igual desde el desplegable, pero no
   * salen apilados contra Hyperliquid por defecto.
   *
   * Solo se aplica cuando NO hay eleccion guardada: una vez que el usuario
   * toca el filtro, manda el suyo.
   */
  useEffect(() => {
    if (elegidos.length > 0 || todos.length === 0) return;
    const dex = todos.filter((v) => v.kind === 'dex' && v.instrument === 'perp').map((v) => v.id);
    if (dex.length === 0) return;
    setElegidos(dex);
    guardar(CLAVES.venues, dex);
  }, [todos, elegidos.length]);

  function aplicarVenues(ids: string[]) {
    const final = ids.length === 0 ? [NINGUNO] : ids;
    setElegidos(final);
    guardar(CLAVES.venues, final);
  }

  function alternarVenue(id: string) {
    aplicarVenues(marcados.includes(id) ? marcados.filter((v) => v !== id) : [...marcados, id]);
  }

  function elegirSimbolo(s: string) {
    setSymbol(s);
    guardar(CLAVES.symbol, s);
    setMenuSimbolo(false);
    setBuscarSimbolo('');
  }

  function cambiarLado(l: Lado) {
    setLado(l);
    guardar(CLAVES.lado, l);
  }

  function cambiarRango(r: Rango) {
    setRango(r);
    guardar(CLAVES.range, r);
  }



  const venuesFiltrados = useMemo(() => {
    const q = buscarVenue.trim().toLowerCase();
    const lista = todos.filter((v) => deTipo(v.kind, tipo)
      && (q === '' || v.label.toLowerCase().includes(q) || v.id.includes(q)));
    return favVenues.ordenar(lista, (v) => v.id);
  }, [todos, buscarVenue, favVenues.lista, tipo]);

  const simbolosFiltrados = useMemo(() => {
    const q = buscarSimbolo.trim().toUpperCase();
    const lista = data?.symbols ?? [];
    const filtrada = q === '' ? lista : lista.filter((s) => s.symbol.includes(q));
    // Los favoritos primero Y ademas siempre visibles: si el corte de 80 los
    // dejase fuera, marcarlos no serviria de nada.
    return favActivos.ordenar([...filtrada], (s) => s.symbol).slice(0, 80);
  }, [data, buscarSimbolo, favActivos.lista]);

  /**
   * Bandas apiladas, una por exchange, como en las herramientas del ramo.
   *
   * Apiladas y no superpuestas porque la pregunta es cuanto pone cada uno
   * dentro del total, no como se cruzan sus lineas. Los grandes llevan banda
   * propia y la cola se junta en una sola: con cien exchanges, cien bandas
   * serian cien tiras de un pixel.
   */
  /**
   * Por cuanto se multiplica la cifra de un venue para dibujarlo en la grafica.
   *
   * Solo manda en la grafica y en la tabla de concentracion, que no tienen
   * sitio para dos cifras por fila. La tabla de venues y el total de arriba
   * ensenan las dos y no pasan por aqui.
   *
   * Un venue sin convencion conocida se queda a 1 en los dos lados: se dibuja
   * tal como lo reporta. Doblarlo seria inventarse que publica una pata.
   */
  const factor = (convention: string): number => {
    if (lado === 'one' || convention === 'unverified') return 1;
    return convention === 'double' ? 1 : 2;
  };

  /**
   * Cuantos de los que se estan viendo se dibujan tal como los reporta el
   * venue, por no saber si eso es una pata o dos.
   *
   * En la tabla esos venues salen con "?" en las dos columnas, que es lo
   * honesto cuando hay sitio para decirlo. En la grafica no lo hay: o se
   * dibujan o desaparecen, y hacerlos desaparecer del historico por una
   * etiqueta que falta seria peor. Se dibujan, y debajo se dice cuantos son.
   */
  const supuestos = (data?.current ?? []).filter((v) => v.convention === 'unverified').length;

  /**
   * Las series ya en el lado elegido, y solo de perps.
   *
   * Lo que no es un perpetuo no se apila aunque este elegido: la grafica dice
   * "interes abierto" y apilar las opciones de Derive contra Hyperliquid daria
   * una suma que no mide nada. El dato sigue en la tabla de abajo, con su
   * instrumento a la vista.
   */
  const seriesEscaladas = useMemo(() => (data?.series ?? [])
    .filter((serie) => (todos.find((v) => v.id === serie.venue)?.instrument ?? 'perp') === 'perp')
    .map((serie) => {
      const f = factor(todos.find((v) => v.id === serie.venue)?.convention ?? "unverified");
      return f === 1 ? serie : { ...serie, points: serie.points.map((p) => ({ t: p.t, v: p.v * f })) };
    }), [data, todos, lado]);

  // La resolucion la dice el servidor, que es quien agrego la serie. Con ella
  // el limite de arrastre es exacto: tres cubos sin punto y el venue deja de
  // sumar. Sin ella `apilar` lo deduce de los sellos, que con pocos puntos no
  // distingue una cadencia lenta de una fuente muerta.
  const resolucion = data?.history.resolutionMs ?? null;
  /**
   * En rangos largos, solo se apilan los venues con historia en buena parte
   * del rango. Los que solo tienen lo medido mientras la app estaba encendida
   * (Hyperliquid: DefiLlama mezcla sus HIP-3 y no se puede rellenar) entrarian
   * y saldrian de la pila, y el total pareceria saltar de 5 a 25 B sin que el
   * mercado se moviese. Se dicen aparte.
   */
  const { apilables, sinHistoria } = useMemo(() => {
    if (rango === '1d') return { apilables: seriesEscaladas, sinHistoria: [] as string[] };
    const sellos = new Set(seriesEscaladas.flatMap((x) => x.points.map((p) => p.t))).size;
    const fuera = seriesEscaladas.filter((x) => x.points.length > 0 && x.points.length < sellos * 0.5);
    return {
      apilables: seriesEscaladas.filter((x) => !fuera.includes(x)),
      sinHistoria: fuera.map((x) => todos.find((t) => t.id === x.venue)?.label ?? x.venue),
    };
  }, [seriesEscaladas, rango, todos]);

  const bandas: Banda[] = useMemo(() => apilar(apilables, {
    colores: SERIE_COLORS,
    apagados,
    etiqueta: (v) => todos.find((x) => x.id === v)?.label ?? v,
    ...(resolucion === null ? {} : { maxArrastreMs: umbralMs(rango, resolucion) }),
  }), [apilables, todos, apagados, resolucion, rango]);

  // Precio del activo elegido, de las velas de Hyperliquid, para leer el OI
  // contra el precio: sube el precio y sube el OI, largos nuevos; baja el
  // precio y sube el OI, cortos nuevos; baja el OI, cierres.
  const [velasPrecio, setVelasPrecio] = useState<{ time: number; value: number }[] | null>(null);
  useEffect(() => {
    if (symbol === '') { setVelasPrecio(null); return undefined; }
    let vivo = true;
    const [intervalo, n] = ({ '1d': ['15m', 96], '7d': ['1h', 168], '30d': ['4h', 180], '90d': ['1d', 90], '1y': ['1d', 365] } as const)[rango];
    getJson<{ candles: { t: number; close: number }[] }>(
      `/api/candles?venue=hyperliquid&symbol=${encodeURIComponent(symbol)}&interval=${intervalo}&limit=${n}`,
    )
      .then((d) => { if (vivo) setVelasPrecio(d.candles.map((c) => ({ time: Math.floor(c.t / 1000), value: c.close }))); })
      // Un activo que Hyperliquid no lista no tiene precio que superponer.
      .catch(() => { if (vivo) setVelasPrecio(null); });
    return () => { vivo = false; };
  }, [symbol, rango]);

  const series: Serie[] = useMemo(() => [...bandas.map((b) => ({
    id: b.venue,
    label: b.label,
    color: b.color,
    width: 1,
    area: true,
    // El mismo umbral con el que `apilar` deja de sumar un venue: tres pasos.
    // Con 1,6 pasos se cortaban saltos normales de una hora entre guardados.
    gapSeconds: umbralMs(rango, data?.history.resolutionMs ?? 900_000) / 1000,
    // El eje es proporcional al tiempo y cubre el rango pedido entero: un
    // hueco de tres dias con la app apagada se ve de tres dias.
    stepSeconds: (data?.history.resolutionMs ?? 900_000) / 1000,
    fromSeconds: Math.floor((Date.now() - RANGO_MS[rango]) / 1000),
    points: b.points,
  })), ...(velasPrecio === null || velasPrecio.length === 0 ? [] : [{
    id: 'precio',
    label: `${symbol} price`,
    color: '#e5e7eb',
    width: 2 as const,
    leftScale: true,
    // Su propio umbral de hueco: tres velas. Con el de 20 minutos por defecto
    // cada tramo entre velas de una hora contaba como hueco y no se veia nada.
    gapSeconds: 3 * ({ '1d': 900, '7d': 3_600, '30d': 14_400, '90d': 86_400, '1y': 86_400 } as const)[rango],
    points: velasPrecio,
  }])], [bandas, data, rango, velasPrecio, symbol]);

  /**
   * La misma historia en tabla: un sello por fila y un exchange por columna.
   *
   * De lo mas reciente hacia atras, que es como se mira. Solo los exchanges
   * que de verdad tienen serie, para no abrir cien columnas vacias.
   */
  const heatmap: Heatmap = useMemo(() => {
    const conSerie = seriesEscaladas.filter((s) => s.points.length > 0);
    const orden = [...conSerie]
      .sort((a, b) => (b.points[b.points.length - 1]?.v ?? 0) - (a.points[a.points.length - 1]?.v ?? 0))
      .slice(0, 8);
    const columnas = orden.map((s) => ({ venue: s.venue, label: todos.find((v) => v.id === s.venue)?.label ?? s.venue }));
    const porVenue = new Map(orden.map((s) => [s.venue, new Map(s.points.map((p) => [p.t, p.v]))]));
    const sellos = [...new Set(orden.flatMap((s) => s.points.map((p) => p.t)))]
      .sort((a, b) => b - a)
      .slice(0, 48);

    const filas = sellos.map((t) => {
      const crudas = columnas.map((c) => porVenue.get(c.venue)?.get(t) ?? null);
      const conDato = crudas.filter((v): v is number => v !== null);
      const total = conDato.length === 0 ? null : conDato.reduce((a, b) => a + b, 0);
      const mayor = conDato.length === 0 ? 0 : Math.max(...conDato);
      return {
        t,
        total,
        celdas: crudas.map((v) => ({ v, parte: v === null || mayor <= 0 ? null : v / mayor })),
      };
    });

    return { columnas, sellos, filas };
  }, [seriesEscaladas, todos]);

  /** Copiar al portapapeles para llevarselo a una hoja de calculo. */
  async function copiar(h: Heatmap) {
    const TAB = '\t';
    const cabecera = ['timestamp_utc', ...h.columnas.map((c) => c.label), 'total'].join(TAB);
    const cuerpo = h.filas.map((f) => [
      new Date(f.t).toISOString(),
      // Vacio y no cero: en una hoja de calculo un cero se promedia y un hueco
      // se salta, que es lo que corresponde a un dato que no tenemos.
      ...f.celdas.map((c) => (c.v === null ? '' : String(Math.round(c.v)))),
      f.total === null ? '' : String(Math.round(f.total)),
    ].join(TAB));
    try {
      await navigator.clipboard.writeText([cabecera, ...cuerpo].join('\n'));
      setCopiado(`${h.filas.length} rows copied`);
    } catch {
      setCopiado('Could not copy: the browser blocked the clipboard');
    }
  }


  /**
   * Las DOS cifras de cada venue, porque las dos se miran.
   *
   * La de una pata es la comparable y la que publica DefiLlama. La de las dos
   * es la que casi todos los venues ensenan en su propia web, y es la que se
   * suele tener en la cabeza. Ensenar solo una obliga a multiplicar o dividir
   * de memoria sabiendo ademas que convencion usa cada uno.
   *
   * Un venue cuya convencion NO se sabe no va en ninguna de las dos: su cifra
   * es una de ellas y no sabemos cual. Se dice aparte, con su numero, en vez de
   * meterla en una columna a medias.
   */
  // Web oficial de cada exchange, de la lista de protocolos.
  const enlaces = new Map((data?.protocols ?? []).map((p) => [p.id, p.url ?? null]));
  const filas = [...(data?.current ?? [])]
    .map((v) => ({
      ...v,
      oneUsd: v.oiUsd === null || v.convention === 'unverified' ? null
        : v.convention === 'double' ? v.oiUsd / 2 : v.oiUsd,
      bothUsd: v.oiUsd === null || v.convention === 'unverified' ? null
        : v.convention === 'single' ? v.oiUsd * 2 : v.oiUsd,
      // La cifra escalada al lado que pinta la grafica.
      oiUsd: v.oiUsd === null ? null : v.oiUsd * factor(v.convention),
    }))
    .sort((a, b) => (b.oiUsd ?? -1) - (a.oiUsd ?? -1));
  const visibles = todasLasFilas ? filas : filas.slice(0, FILAS_VISIBLES);
  // Solo tiene sentido con todos los activos a la vista: filtrando por uno,
  // la lista se quedaria en una fila y no diria nada que no diga la de arriba.
  // La concentracion llega del servidor en una pata. Se escala con el factor
  // del venue mayor de cada activo, que es el unico que la respuesta identifica.
  const concentracion = symbol !== '' ? [] : (data?.concentration ?? []).map((c) => {
    const f = factor(todos.find((v) => v.id === c.topVenue)?.convention ?? 'unverified');
    return f === 1 ? c : {
      ...c, oiUsd: c.oiUsd * f, cexUsd: c.cexUsd * f, dexUsd: c.dexUsd * f,
    };
  });
  /**
   * El total y sus subtotales, ya en el lado elegido.
   *
   * Se recalcula aqui en vez de doblar el que manda la API: el servidor sirve
   * siempre una pata, y cada venue lleva su propio factor segun su convencion.
   * Doblar el total entero daria mal en cuanto un venue declare dos patas.
   */
  const total = data?.total === undefined ? undefined : (() => {
    const suma = (l: typeof filas) => l.reduce((acc, v) => acc + (v.oiUsd ?? 0), 0);
    // Solo perps. La API ya los separa y aqui hay que respetarlo: el total se
    // recalcula en el cliente, asi que sin este filtro volverian a entrar los
    // 4,1 B de opciones y mercados de prediccion por la puerta de atras.
    const conDato = filas.filter((v) => v.oiUsd !== null && v.listed !== false && v.instrument === 'perp');
    // Tres grupos, porque hay tres grados de certeza y juntarlos los esconde:
    // la convencion medida contra el venue, la que solo descansa en que
    // DefiLlama declara normalizar a una pata, y la que no se sabe.
    const probados = conDato.filter((v) => v.conventionProven);
    const porLlama = conDato.filter((v) => !v.conventionProven && v.convention !== 'unverified');
    const sinSaber = conDato.filter((v) => v.convention === 'unverified');
    const conLado = conDato.filter((v) => v.oneUsd !== null);
    const unaPata = conLado.reduce((acc, v) => acc + (v.oneUsd ?? 0), 0);
    return {
      ...data.total,
      oiUsd: conDato.length === 0 ? null : suma(conDato),
      // Las dos patas son exactamente el doble de una: lo que cambia de un
      // venue a otro es cual de las dos publica el, no la relacion.
      oneUsd: conLado.length === 0 ? null : unaPata,
      bothUsd: conLado.length === 0 ? null : unaPata * 2,
      ladoVenues: conLado.length,
      verifiedUsd: probados.length === 0 ? null : suma(probados),
      llamaUsd: porLlama.length === 0 ? null : suma(porLlama),
      llamaVenues: porLlama.length,
      unverifiedUsd: sinSaber.length === 0 ? null : suma(sinSaber),
      unverifiedVenues: sinSaber.length,
      sinLado: sinSaber.map((v) => ({ label: v.label, oiUsd: v.oiUsd })),
      // Que parte esta en DEX y cual es el exchange mayor, sobre lo que tiene
      // convencion conocida (lo mismo que suma la cifra de arriba).
      dexShare: unaPata <= 0 ? null : conLado.filter((v) => v.kind === 'dex').reduce((a, v) => a + (v.oneUsd ?? 0), 0) / unaPata,
      top: (() => {
        const mayor = [...conLado].sort((a, b) => (b.oneUsd ?? 0) - (a.oneUsd ?? 0))[0];
        return mayor === undefined || unaPata <= 0 ? null : { label: mayor.label, share: (mayor.oneUsd ?? 0) / unaPata };
      })(),
    };
  })();

  // Los avisos que antes eran cinco recuadros, en trozos cortos.
  const avisos: { texto: string; detalle: string }[] = total === undefined ? [] : [
    ...(total.partial === true && total.missing.length > 0
      ? [{ texto: `${total.missing.length} without data`, detalle: 'Exchanges selected that sent no data in the last cycle' }] : []),
    ...((total.tickerConflict ?? []).length > 0
      ? [{ texto: `kept out: ${(total.tickerConflict ?? []).join(', ')}`, detalle: 'Their price says this ticker is a different asset there' }] : []),
    ...((total.withoutPrice ?? 0) > 0
      ? [{ texto: `${total.withoutPrice} without price`, detalle: 'Listed without a price, so it could not be checked they mean the same asset' }] : []),
    ...((total.sinLado ?? []).length > 0
      ? [{ texto: `unknown side: ${(total.sinLado ?? []).map((v) => v.label).join(', ')}`, detalle: 'Out of both figures: they do not state whether they publish one side or both' }] : []),
    ...((total.otherInstrumentsUsd ?? null) !== null
      ? [{ texto: `${usd(total.otherInstrumentsUsd ?? null)} in options and prediction markets held out`, detalle: 'Listed below but not perpetuals' }] : []),
  ];
  // Los que mas OI ganan y pierden en 24 h, con dato en las dos fotos.
  const movers = (() => {
    const conCambio = concentracion.filter((c) => c.change24hPct != null);
    const orden = [...conCambio].sort((x, y) => (y.change24hPct ?? 0) - (x.change24hPct ?? 0));
    return {
      sube: orden.filter((c) => (c.change24hPct ?? 0) > 0).slice(0, 6),
      baja: orden.filter((c) => (c.change24hPct ?? 0) < 0).reverse().slice(0, 6),
    };
  })();
  const pctCambio = (v: number | null) => (v === null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`);
  const signoPct = (v: number | null) => (v === null ? 'none' : v >= 0 ? 'pos' : 'neg');


  return (
    <div className="oi-pantalla">
      <div className="controls">
        <div className="control-group menu-anclaje" ref={simboloRef}>
          <span className="label">Asset</span>
          <button className="seg seg-menu"
            onClick={() => { setMenuSimbolo((v) => !v); setBuscarSimbolo(''); }}>
            {symbol === '' ? 'All assets' : symbol} {menuSimbolo ? '▴' : '▾'}
          </button>
          {menuSimbolo && (
            <div className="menu">
              <input className="menu-buscar" type="search" autoFocus value={buscarSimbolo}
                placeholder="Filter assets" onChange={(e) => setBuscarSimbolo(e.target.value)} />
              <div className="menu-acciones">
                <button className="seg" onClick={() => elegirSimbolo('')}>All assets</button>
              </div>
              {simbolosFiltrados.length === 0 && <div className="menu-vacio">No asset matches.</div>}
              {simbolosFiltrados.map((s) => (
                <div key={s.symbol} className="menu-fila">
                  <Estrella marcado={favActivos.es(s.symbol)} que={s.symbol}
                    onClick={() => favActivos.alternar(s.symbol)} />
                  <button
                    className={s.symbol === symbol ? 'menu-item menu-item-on' : 'menu-item'}
                    onClick={() => elegirSimbolo(s.symbol)}>
                    <span className="menu-check">{s.symbol === symbol ? '×' : ''}</span>
                    <span className="menu-label">{s.symbol}</span>
                    <span className="menu-cifra">{usd(s.oiUsd)}</span>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="control-group menu-anclaje" ref={menuRef}>
          <span className="label">Exchanges</span>
          <button className="seg seg-menu"
            onClick={() => { setMenuAbierto((v) => !v); setBuscarVenue(''); }}>
            {todos.length === 0 ? 'Loading…' : `${marcados.length} of ${todos.length}`} {menuAbierto ? '▴' : '▾'}
          </button>
          {menuAbierto && (
            <div className="menu">
              <input className="menu-buscar" type="search" autoFocus value={buscarVenue}
                placeholder="Filter exchanges" onChange={(e) => setBuscarVenue(e.target.value)} />
              <FiltroTipo tipo={tipo} onCambiar={setTipo} />
              <div className="menu-acciones">
                <button className="seg" onClick={() => aplicarVenues(todos.map((v) => v.id))}>Select all</button>
                <button className="seg" onClick={() => aplicarVenues([])}>Deselect all</button>
              </div>
              <div className="menu-acciones">
                <button className="seg"
                  onClick={() => aplicarVenues(todos.filter((v) => v.kind === 'cex').map((v) => v.id))}>
                  Select CEX
                </button>
                <button className="seg"
                  onClick={() => aplicarVenues(todos.filter((v) => v.kind === 'dex').map((v) => v.id))}>
                  Select DEX
                </button>
              </div>
              {venuesFiltrados.length === 0 && <div className="menu-vacio">No exchange matches.</div>}
              {venuesFiltrados.map((v) => (
                <div key={v.id} className="menu-fila">
                  <Estrella marcado={favVenues.es(v.id)} que={v.label}
                    onClick={() => favVenues.alternar(v.id)} />
                  <button
                    className={marcados.includes(v.id) ? 'menu-item menu-item-on' : 'menu-item'}
                    title={v.coverage}
                    onClick={() => alternarVenue(v.id)}>
                    <span className="menu-check">{marcados.includes(v.id) ? '×' : ''}</span>
                    <span className="menu-label">{v.label}</span>
                    <span className="menu-cifra">{v.kind.toUpperCase()}</span>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="control-group">
          <span className="label">Chart</span>
          <div className="segmented">
            {([["both","Global"],["one","One side"]] as const).map(([v,etiqueta]) => (
              <button key={v} type="button" aria-pressed={lado === v}
                className={lado === v ? "seg seg-active" : "seg"}
                onClick={() => cambiarLado(v)}>{etiqueta}</button>
            ))}
          </div>
        </div>

        <div className="control-group">
          <span className="label">Range</span>
          <div className="segmented">
            {(['1d', '7d', '30d', '90d', '1y'] as const).map((r) => (
              <button key={r} type="button" aria-pressed={rango === r}
                className={rango === r ? 'seg seg-active' : 'seg'}
                onClick={() => cambiarRango(r)}>{r}</button>
            ))}
          </div>
        </div>
      </div>

      {error !== null && <p className="light light-red">{error}</p>}
      {data?.available === false && <p className="light light-yellow">Open interest is not running.</p>}

      <Bloque
        title={symbol === '' ? 'Total open interest' : `${symbol} open interest`}
        subtitle={total === undefined ? undefined
          : `perpetuals on ${total.ladoVenues ?? 0} exchanges`}
      >
        {/* Cuatro cifras, las que sirven para operar. El detalle de convenciones
            de patas sigue en la tabla por exchange y al pasar el raton. */}
        <div className="stats">
          <div className="stat" title={`One side ${usd(total?.oneUsd ?? null)} · convention measured ${usd(total?.verifiedUsd ?? null)} · per DefiLlama ${usd(total?.llamaUsd ?? null)}`}>
            <div className="label">Open interest, both sides</div>
            <div className="stat-value">{usd(total?.bothUsd ?? null)}</div>
          </div>
          <div className="stat" title={data?.change === undefined ? undefined : `Same ${data.change.h24.venues} exchanges in both readings`}>
            <div className="label">24h change</div>
            <div className={`stat-value ${signoPct(data?.change?.h24.pct ?? null)}`}>{pctCambio(data?.change?.h24.pct ?? null)}</div>
          </div>
          <div className="stat" title={data?.change === undefined ? undefined : `Same ${data.change.d7.venues} exchanges in both readings`}>
            <div className="label">7d change</div>
            <div className={`stat-value ${signoPct(data?.change?.d7.pct ?? null)}`}>{pctCambio(data?.change?.d7.pct ?? null)}</div>
          </div>
          <div className="stat" title={total?.top === null || total?.top === undefined ? undefined : `Largest: ${total.top.label}, ${(total.top.share * 100).toFixed(0)}%`}>
            <div className="label">DEX share</div>
            <div className="stat-value">
              {total?.dexShare == null ? '—' : `${(total.dexShare * 100).toFixed(0)}%`}
              {total?.top != null && <span className="none oi-top"> · {total.top.label} {(total.top.share * 100).toFixed(0)}%</span>}
            </div>
          </div>
        </div>

        {/* Todos los avisos en una linea. Apartar o suponer en silencio seria
            tan malo como sumar en silencio, pero cinco recuadros se comian la
            pantalla; el detalle va en el titulo de cada trozo. */}
        {total !== undefined && avisos.length > 0 && (
          <p className="none oi-avisos">
            {avisos.map((a, i) => (
              <span key={a.texto} title={a.detalle}>{i > 0 && ' · '}{a.texto}</span>
            ))}
          </p>
        )}
      </Bloque>

      <Bloque title="History"
        subtitle={data === null ? undefined
          : `${lado === 'both' ? 'both sides' : 'one side'}, one point every ${duracion(data.history.resolutionMs)}`}>
        {(supuestos > 0 || sinHistoria.length > 0) && (
          <p className="none oi-avisos">
            {sinHistoria.length > 0 && (
              <span title="Only measured while this app was running; their outside history does not measure the same thing">
                not drawn, no history in this range: {sinHistoria.slice(0, 6).join(', ')}{sinHistoria.length > 6 ? ` +${sinHistoria.length - 6}` : ''}
              </span>
            )}
            {sinHistoria.length > 0 && supuestos > 0 && ' · '}
            {supuestos > 0 && (
              <span title="Their side convention is not known, so their line is not scaled">{supuestos} drawn as reported</span>
            )}
          </p>
        )}
        {series.length === 0 ? (
          <p className="none">
            {data === null ? 'Loading…' : `No history yet. Points are stored every ${duracion(data.history.resolutionMs)} from now on.`}
          </p>
        ) : (
          <div className="chart-wrap">
            <Chart series={series} height={300} formatValue={(v) => usd(v)} fromZero />
            {/* La leyenda apaga bandas de la GRAFICA, no de la seleccion: el
                total de arriba y las tablas no se mueven. Van en el orden en
                que se apilan, de mayor a menor, que es como se leen. */}
            {velasPrecio !== null && velasPrecio.length > 0 && (
              <div className="legend"><span className="legend-item"><span className="legend-dot" style={{ background: '#e5e7eb' }} />{symbol} price, left scale</span></div>
            )}
            <div className="legend oi-leyenda">
              {[...bandas].reverse().map((b) => (
                <button key={b.venue} type="button"
                  className={apagados.includes(b.venue) ? 'legend-item legend-off' : 'legend-item'}
                  title={apagados.includes(b.venue) ? 'Show in the chart' : 'Hide from the chart'}
                  onClick={() => setApagados((a) => (a.includes(b.venue)
                    ? a.filter((x) => x !== b.venue)
                    : [...a, b.venue]))}>
                  <span className="legend-dot" style={{ background: b.color }} />
                  {b.label}
                  <span className="none"> {usd(b.ultimoUsd)}</span>
                </button>
              ))}
              {apagados.length > 0 && (
                <button type="button" className="seg seg-clear" onClick={() => setApagados([])}>
                  Show all
                </button>
              )}
            </div>
            <div className="legend">
              Stacked by exchange
              {symbol !== '' && ` · assets under ${usd(data?.history.minSymbolUsd ?? null)} have no history of their own`}
            </div>
          </div>
        )}
      </Bloque>

      {heatmap.sellos.length > 0 && (
        <Bloque title="Open interest by exchange" subtitle="one row per stored point">
          <div className="table-wrap oi-heatmap">
            <table>
              <thead>
                <tr>
                  <th>Timestamp (UTC)</th>
                  {heatmap.columnas.map((c) => (
                    <th key={c.venue} className="num">{c.label}</th>
                  ))}
                  <th className="num">Total</th>
                </tr>
              </thead>
              <tbody>
                {heatmap.filas.map((f) => (
                  <tr key={f.t}>
                    <td className="none">{new Date(f.t).toISOString().slice(0, 16).replace('T', ' ')}</td>
                    {f.celdas.map((c, i) => (
                      // El tono es RELATIVO A SU FILA: lo que se busca aqui es
                      // quien manda en cada instante, no comparar un dia con
                      // otro, que es lo que hace la grafica de arriba.
                      <td key={heatmap.columnas[i]?.venue ?? i} className="num"
                        style={c.v === null ? undefined : { background: tono(c.parte) }}>
                        {c.v === null ? '—' : usd(c.v)}
                      </td>
                    ))}
                    <td className="num">{usd(f.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* Un boton suelto, no un panel de controles entero para el: y el
              resultado de copiar en texto normal, no con la letra de rotulo. */}
          <div className="oi-copiar">
            <button type="button" className="seg" onClick={() => copiar(heatmap)}>Copy as TSV</button>
            {copiado !== null && <span className="none">{copiado}</span>}
          </div>
        </Bloque>
      )}

      <Bloque title="By exchange" subtitle={`${filas.length} tracked`}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Exchange</th>
                <th>Type</th>
                <th className="num">One side</th>
                <th className="num">Both sides</th>
                <th className="num">Share</th>
                <th className="num">Markets</th>
                <th>Convention</th>
                <th>Age</th>
              </tr>
            </thead>
            <tbody>
              {visibles.length === 0 && (
                <tr><td colSpan={8} className="none">Pick at least one exchange.</td></tr>
              )}
              {visibles.map((v) => (
                <tr key={v.id}>
                  <td className="asset" title={v.coverage}>
                    {enlaces.get(v.id) == null ? v.label : (
                      <a href={enlaces.get(v.id) ?? undefined} target="_blank" rel="noreferrer noopener">{v.label} ↗</a>
                    )}
                  </td>
                  <td className={v.instrument === 'perp' ? 'none' : 'warn-text'}
                      title={v.instrument === 'perp' ? undefined
                        : 'Not a perpetual, so it is listed but never added to the total'}>
                    {v.kind.toUpperCase()}
                    {v.instrument !== 'perp' && ` · ${v.instrument}`}
                  </td>
                  {/* Tres cosas distintas que no se pueden pintar igual: no se
                      sabe, no lista ese activo, y no tiene desglose por activo
                      aunque si tenga total. */}
                  {/* Cuatro cosas distintas que no se pueden pintar igual: no
                      se sabe el dato, el venue no lista ese activo, no tiene
                      desglose por activo aunque si total, y no se sabe si lo
                      que publica es una pata o dos. */}
                  {([v.oneUsd, v.bothUsd] as const).map((cifra, i) => (
                    <td className="num" key={i}>
                      {v.oiUsd === null
                        ? '—'
                        : v.listed === false
                          ? <span className="none">{v.breakdown ? 'not listed' : 'no breakdown'}</span>
                          : cifra === null
                            ? <span className="warn-text" title={`Reported as ${usd(v.oiUsd)}, but the venue does not state whether that counts one side or both`}>?</span>
                            : usd(cifra)}
                    </td>
                  ))}
                  {/* Sobre la misma base que las columnas, que es una pata.
                      Sobre las dos saldria identico, porque unas son el doble
                      de las otras. Un venue fuera del total no tiene reparto. */}
                  <td className="num none">
                    {v.listed === false || v.oneUsd === null || v.instrument !== 'perp'
                      || total?.oneUsd == null || total.oneUsd === 0
                      ? '—'
                      : `${((v.oneUsd / total.oneUsd) * 100).toFixed(1)}%`}
                  </td>
                  <td className="num none">{v.markets === 0 ? '—' : fmt.int(v.markets)}</td>
                  {/* La convencion y de donde sale saberla. Un venue medido
                      contra su propia API y otro que solo hereda la
                      normalizacion de DefiLlama no valen lo mismo, asi que no
                      se pintan igual. */}
                  <td className={v.convention === 'unverified' ? 'warn-text' : 'none'}
                      title={v.conventionProven
                        ? 'Measured against the venue API'
                        : v.convention === 'unverified'
                          ? 'The venue does not state it and it has not been measured'
                          : 'Per DefiLlama normalisation, not measured against the venue'}>
                    {v.convention === 'single' ? 'one side' : v.convention === 'double' ? 'both sides' : 'unverified'}
                    {v.convention !== 'unverified' && !v.conventionProven && <span className="none"> *</span>}
                  </td>
                  <td className={v.stale ? 'warn-text' : 'none'}>
                    {v.oiUsd === null ? (v.error ?? 'no data') : `${fmt.ago(v.asOf)}${v.stale ? ' · stale' : ''}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {filas.length > FILAS_VISIBLES && (
          <div className="controls">
            <button type="button" onClick={() => setTodasLasFilas((v) => !v)}>
              {todasLasFilas ? `Show top ${FILAS_VISIBLES}` : `Show all ${filas.length}`}
            </button>
          </div>
        )}
      </Bloque>

      {/* Donde se esta formando posicion: los activos con mas OI anadido y
          retirado en 24 h, entre los treinta mayores. Con el precio al lado se
          lee si son largos o cortos nuevos, o cierres. */}
      {movers.sube.length + movers.baja.length > 0 && (
        <Bloque title="OI movers" subtitle="24h, among the 30 largest assets">
          <div className="oi-movers">
            {([['Adding', movers.sube], ['Leaving', movers.baja]] as const).map(([titulo, filasM]) => (
              <div key={titulo} className="table-wrap">
                <table>
                  <thead>
                    <tr><th>{titulo}</th><th className="num">24h</th><th className="num">Open interest</th><th className="num">Funding / 8h</th></tr>
                  </thead>
                  <tbody>
                    {filasM.map((c) => (
                      <tr key={c.symbol}>
                        <td className="asset clickable" title="Filter by this asset" onClick={() => elegirSimbolo(c.symbol)}>{c.symbol}</td>
                        <td className={`num ${signoPct(c.change24hPct ?? null)}`}>{pctCambio(c.change24hPct ?? null)}</td>
                        <td className="num">{usd(c.oiUsd)}</td>
                        <td className={`num ${signoPct(c.fundingHourly ?? null)}`}>
                          {c.fundingHourly == null ? '—' : `${(c.fundingHourly * 8 * 100).toFixed(4)}%`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        </Bloque>
      )}

      {concentracion.length > 0 && (
        <Bloque title="Where it concentrates" subtitle="click an asset to filter the screen">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Asset</th>
                  <th className="num">Open interest</th>
                  <th className="num">Exchanges</th>
                  <th>Most of it on</th>
                  <th className="num">Its share</th>
                  <th className="num">CEX</th>
                  <th className="num">DEX</th>
                  <th className="num">24h</th>
                  <th className="num" title="Average funding weighted by each exchange's open interest">Funding / 8h</th>
                </tr>
              </thead>
              <tbody>
                {concentracion.map((c) => (
                  <tr key={c.symbol}>
                    <td className="asset clickable" title="Filter by this asset"
                      onClick={() => elegirSimbolo(c.symbol)}>
                      {c.symbol}
                    </td>
                    <td className="num">{usd(c.oiUsd)}</td>
                    <td className="num none">{c.venues}</td>
                    <td className="none">
                      {c.topVenue === null ? '—' : todos.find((v) => v.id === c.topVenue)?.label ?? c.topVenue}
                    </td>
                    <td className="num">{pct(c.topShare)}</td>
                    <td className="num none">{c.oiUsd <= 0 ? '—' : pct(c.cexUsd / c.oiUsd)}</td>
                    <td className="num none">{c.oiUsd <= 0 ? '—' : pct(c.dexUsd / c.oiUsd)}</td>
                    <td className={`num ${signoPct(c.change24hPct ?? null)}`}>{pctCambio(c.change24hPct ?? null)}</td>
                    <td className={`num ${signoPct(c.fundingHourly ?? null)}`}>
                      {c.fundingHourly == null ? '—' : `${(c.fundingHourly * 8 * 100).toFixed(4)}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Bloque>
      )}

    </div>
  );
}
