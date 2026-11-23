import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { getJson, type FundingMatrixResponse, type SeriesResponse, type Sustained } from '../api.ts';
import { Chart, SERIE_COLORS, type Serie } from '../components/Chart.tsx';
import { useFavoritos, Estrella } from '../components/favoritos.tsx';
import { useTipoVenue, deTipo, FiltroTipo } from '../components/tipoVenue.tsx';

/**
 * Funding screener: un simbolo por fila, un venue por columna.
 *
 * El usuario elige que venues entran en la comparacion. El diferencial maximo y
 * los papeles de largo y corto se calculan en el servidor SOLO entre esos, asi
 * que quitar un venue cambia la fila. La escala (bps a 1 h, a 8 h o APR) es una
 * multiplicacion y se hace aqui.
 *
 * Es la vista barata: tasas brutas, sin fees ni libros. El APR neto con costes
 * reales esta en la otra vista de esta misma pestana.
 */

type Unidad = 'bps1h' | 'bps8h' | 'apr';

const UNIDADES: Record<Unidad, { label: string; factor: number; sufijo: string }> = {
  bps1h: { label: '1h bps', factor: 10_000, sufijo: '' },
  bps8h: { label: '8h bps', factor: 8 * 10_000, sufijo: '' },
  apr: { label: 'APR', factor: 8760 * 100, sufijo: '%' },
};

/**
 * Centinela para "ninguno".
 *
 * La lista vacia ya significa "todos", que es el valor de partida. Sin un
 * centinela no habria forma de guardar la eleccion de no comparar ninguno, y
 * deseleccionar todos volveria a seleccionarlos.
 */
const NINGUNO = '__none__';

/** Preferencias que sobreviven a recargar la pagina. */
const CLAVES = { venues: 'screener.venues', unidad: 'screener.unit', favoritos: 'screener.favorites' };

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
    // Sin almacenamiento (modo privado, bloqueado): la preferencia no se
    // recuerda, pero la pantalla funciona igual.
  }
}

function valor(hourly: number, u: Unidad): string {
  const v = hourly * UNIDADES[u].factor;
  const texto = Math.abs(v) < 0.05 ? '0.0' : `${v > 0 ? '+' : ''}${v.toFixed(1)}`;
  return texto + UNIDADES[u].sufijo;
}

function cuentaAtras(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

type Orden = { clave: 'arb' | 'symbol' | string; desc: boolean };

const PESO_NOTA: Record<'A' | 'B' | 'C' | 'D', number> = { A: 3, B: 2, C: 1, D: 0 };

const AYUDA_SOSTENIDO = 'How sustained this pair has been, held without closing. '
  + 'A needs it positive most of the time AND paying well. Worst of the 7 and 14 day windows. '
  + 'Gross: before fees and execution spread.';

/**
 * La nota, en una columna fina.
 *
 * Una letra y nada mas, porque lo que se busca de un vistazo es "este aguanta
 * y este no". Los numeros que la sustentan van en el titulo: si la letra no se
 * puede comprobar, no vale de nada.
 *
 * Sin datos suficientes se pinta un hueco. Una nota sacada de cuatro horas de
 * historico seria peor que no tener nota.
 */
function Sostenido({ s }: { s: Sustained | null }) {
  if (s?.grade == null) {
    const horas = s?.days14.coveredHours ?? 0;
    return <span className="none" title={horas > 0
      ? `Not enough history: ${horas.toFixed(1)}h of gap free data`
      : 'No history for this pair yet'}>—</span>;
  }

  const pct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(0)}%`);
  const apr = (v: number | null) => (v === null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`);
  const detalle = [
    `${s.corto.toUpperCase()} short / ${s.largo.toUpperCase()} long`,
    `7d: ${pct(s.days7.uptime)} of the time in favour, ${apr(s.days7.holdApr)} APR held`,
    `14d: ${pct(s.days14.uptime)} of the time in favour, ${apr(s.days14.holdApr)} APR held`,
    `Measured on ${s.days14.coveredHours.toFixed(0)}h of gap free data. Gross.`,
  ].join('\n');

  return <span className={`sust sust-${s.grade.toLowerCase()}`} title={detalle}>{s.grade}</span>;
}

export function FundingMatrix({ refreshKey }: { refreshKey: number }) {
  const [elegidos, setElegidos] = useState<string[]>(() => leer(CLAVES.venues, [] as string[]));
  const [unidad, setUnidad] = useState<Unidad>(() => leer(CLAVES.unidad, 'bps8h' as Unidad));
  const [favoritos, setFavoritos] = useState<string[]>(() => leer(CLAVES.favoritos, [] as string[]));
  const [buscar, setBuscar] = useState('');
  const [orden, setOrden] = useState<Orden>({ clave: 'arb', desc: true });
  const [data, setData] = useState<FundingMatrixResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ahora, setAhora] = useState(Date.now());
  const [menuAbierto, setMenuAbierto] = useState(false);
  /** Filtra la lista del desplegable. No se guarda: es de este rato. */
  const [buscarVenue, setBuscarVenue] = useState('');
  const [tipo, setTipo] = useTipoVenue();
  // Los venues que se usan a diario, arriba del desplegable.
  const favVenues = useFavoritos('screener.fav.venues');
  const menuRef = useRef<HTMLDivElement>(null);
  /** Simbolo con el historico desplegado, o null. */
  const [abierto, setAbierto] = useState<string | null>(null);

  // Un clic fuera cierra el desplegable. Sin esto se queda abierto tapando la
  // tabla hasta que vuelves a darle al boton.
  useEffect(() => {
    if (!menuAbierto) return;
    const fuera = (e: MouseEvent) => {
      if (menuRef.current !== null && !menuRef.current.contains(e.target as Node)) setMenuAbierto(false);
    };
    document.addEventListener('mousedown', fuera);
    return () => document.removeEventListener('mousedown', fuera);
  }, [menuAbierto]);

  // Reloj para las cuentas atras. Solo repinta textos, no pide nada.
  useEffect(() => {
    const t = setInterval(() => setAhora(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let vivo = true;
    const q = elegidos.length > 0 ? `?venues=${encodeURIComponent(elegidos.join(','))}` : '';
    getJson<FundingMatrixResponse>(`/api/funding-matrix${q}`)
      .then((d) => { if (vivo) { setData(d); setError(null); } })
      .catch((e: unknown) => { if (vivo) setError(e instanceof Error ? e.message : String(e)); });
    return () => { vivo = false; };
  }, [elegidos, refreshKey]);

  const todos = data?.venues ?? [];
  const activos = todos.filter((v) => v.selected);

  // Busca por nombre y por identificador: son distintos en varios venues.
  const venuesFiltrados = useMemo(() => {
    const q = buscarVenue.trim().toLowerCase();
    const lista = todos.filter((v) => deTipo(v.venueKind, tipo)
      && (q === '' || v.label.toLowerCase().includes(q) || v.id.toLowerCase().includes(q)));
    return favVenues.ordenar(lista, (v) => v.id);
  }, [todos, buscarVenue, favVenues.lista, tipo]);

  /**
   * Los que el usuario tiene MARCADOS, que no siempre son las columnas.
   *
   * Con un solo venue elegido la comparacion se ancla a el y la tabla ensena
   * todas las columnas, porque si no no se ve quien es la contraparte. El
   * desplegable tiene que seguir diciendo uno.
   */
  const marcados = data?.anchor != null ? [data.anchor] : activos.map((v) => v.id);

  /**
   * Las columnas, en el orden en que se leen.
   *
   * Anclado, la del venue elegido va LA PRIMERA y las contrapartes a su
   * derecha: la fila se lee entonces como "esto pago aqui, y contra esto otro",
   * que es el orden de la pregunta. Dejandola en su sitio del registro, la
   * columna que importa salia en mitad de la tabla y habia que buscarla.
   */
  const columnas = data?.anchor == null
    ? activos
    : [
      ...activos.filter((v) => v.id === data.anchor),
      ...activos.filter((v) => v.id !== data.anchor),
    ];

  /**
   * Los venues elegidos como UNA CADENA, no como lista.
   *
   * Esto no es cosmetico. La cuenta atras repinta esta pantalla cada segundo,
   * y `activos.map(...)` devolvia un array nuevo en cada repintado. Como el
   * historico lo recibia por props y lo tenia en las dependencias de su
   * efecto, se volvia a pedir la serie CADA SEGUNDO: la grafica se desmontaba,
   * aparecia "Loading…" y volvia a montarse. Eso era el parpadeo.
   *
   * Una cadena se compara por valor, asi que mientras la eleccion no cambie,
   * el efecto no se entera de los repintados.
   */
  const idsActivos = useMemo(
    () => (data?.venues ?? []).filter((v) => v.selected).map((v) => v.id).join(','),
    [data],
  );

  function alternarVenue(id: string) {
    // Se parte de lo que hay marcado AHORA. Ojo: la lista vacia no significa
    // "todos", significa "los que el servidor elige por defecto", que son los
    // que el usuario opera. Partiendo de todos, quitar uno daria diez venues
    // marcados donde se veian cinco.
    const base = elegidos.length === 0
      ? marcados
      : elegidos.filter((v) => v !== NINGUNO);
    const siguiente = base.includes(id) ? base.filter((v) => v !== id) : [...base, id];
    setElegidos(siguiente.length === 0 ? [NINGUNO] : siguiente);
    guardar(CLAVES.venues, siguiente.length === 0 ? [NINGUNO] : siguiente);
  }

  function todosLosVenues() {
    // Explicitos, no la lista vacia: vacio es "los de siempre", no "todos".
    const final = todos.map((v) => v.id);
    setElegidos(final);
    guardar(CLAVES.venues, final);
  }

  /**
   * Quitarlos todos deja la tabla vacia a proposito.
   *
   * Es lo que permite empezar de cero y marcar solo los dos que se estan
   * usando, que es como se mira esto de verdad. La lista vacia significa
   * "todos", asi que para decir "ninguno" hace falta un centinela.
   */
  function ningunVenue() {
    setElegidos([NINGUNO]);
    guardar(CLAVES.venues, [NINGUNO]);
  }

  function alternarFavorito(simbolo: string) {
    const siguiente = favoritos.includes(simbolo)
      ? favoritos.filter((s) => s !== simbolo)
      : [...favoritos, simbolo];
    setFavoritos(siguiente);
    guardar(CLAVES.favoritos, siguiente);
  }

  function cambiarUnidad(u: Unidad) {
    setUnidad(u);
    guardar(CLAVES.unidad, u);
  }

  function ordenarPor(clave: Orden['clave']) {
    setOrden((o) => (o.clave === clave ? { clave, desc: !o.desc } : { clave, desc: clave !== 'symbol' }));
  }

  const filas = useMemo(() => {
    const q = buscar.trim().toUpperCase();
    const lista = (data?.rows ?? []).filter((r) => q === '' || r.symbol.includes(q));

    const clave = (r: (typeof lista)[number]): number | string | null => {
      if (orden.clave === 'arb') return r.spreadHourly;
      if (orden.clave === 'symbol') return r.symbol;
      // Por nota, y dentro de la misma nota por el tiempo a favor. Asi
      // ordenar por esta columna no deja las letras desordenadas.
      if (orden.clave === 'sust') {
        const s = r.sustained;
        if (s?.grade == null) return null;
        return PESO_NOTA[s.grade] + (s.days7.uptime ?? 0);
      }
      return r.cells[orden.clave]?.hourlyRate ?? null;
    };

    const ordenada = [...lista].sort((a, b) => {
      const ka = clave(a);
      const kb = clave(b);
      // Lo que no tiene dato va siempre al final, sea cual sea el sentido.
      if (ka === null) return kb === null ? 0 : 1;
      if (kb === null) return -1;
      const c = typeof ka === 'string' ? ka.localeCompare(String(kb)) : ka - (kb as number);
      return orden.desc ? -c : c;
    });

    // Los favoritos arriba, conservando el orden elegido entre ellos.
    return [
      ...ordenada.filter((r) => favoritos.includes(r.symbol)),
      ...ordenada.filter((r) => !favoritos.includes(r.symbol)),
    ];
  }, [data, buscar, orden, favoritos]);

  if (error !== null) return <p className="light light-red">Could not load the screener: {error}</p>;

  // La cuenta atras a la hora en punto vale SOLO para los venues que liquidan
  // cada hora, que hoy es Hyperliquid. Aster cobra cada 8 h (4 en algunos
  // mercados), Perpl cada 43 min y Variational publica su tasa anualizada. Por
  // eso se nombran al lado del reloj: sin el nombre, el reloj parecia decir que
  // todas las columnas cobran a la vez.
  const horarios = activos.filter((v) => v.intervalHours === 1);
  const proximaHora = Math.ceil(ahora / 3_600_000) * 3_600_000;
  const proximoCiclo = data?.lastCycleAt == null ? null : data.lastCycleAt + data.collectIntervalMs;
  const progreso = proximoCiclo === null || data === null
    ? 0
    : Math.min(1, Math.max(0, 1 - (proximoCiclo - ahora) / data.collectIntervalMs));

  const flecha = (clave: Orden['clave']) => (orden.clave === clave ? (orden.desc ? ' ↓' : ' ↑') : '');

  return (
    <>
      <div className="controls">
        <label className="grow">
          <span className="label">Search</span>
          <input
            type="search"
            value={buscar}
            placeholder="BTC, SOL…"
            onChange={(e) => setBuscar(e.target.value)}
          />
        </label>

        <div className="control-group">
          <span className="label">Units</span>
          <div className="segmented">
            {(Object.keys(UNIDADES) as Unidad[]).map((u) => (
              <button key={u} className={u === unidad ? 'seg seg-active' : 'seg'} onClick={() => cambiarUnidad(u)}>
                {UNIDADES[u].label}
              </button>
            ))}
          </div>
        </div>

        {/* Con once venues la fila de botones ocupaba dos lineas y tapaba la
            tabla. En desplegable cabe todo y se ve de un vistazo cuantos hay
            elegidos, que es el dato que cambia lo que se esta comparando. */}
        <div className="control-group menu-anclaje" ref={menuRef}>
          <span className="label">Venues</span>
          <button className="seg seg-menu"
            onClick={() => { setMenuAbierto((v) => !v); setBuscarVenue(''); }}>
            {todos.length === 0 ? 'Loading…' : `${marcados.length} of ${todos.length}`} {menuAbierto ? '▴' : '▾'}
          </button>
          {menuAbierto && (
            <div className="menu">
              {/* El buscador filtra la LISTA, no la seleccion: escribir aqui
                  no marca ni desmarca nada, asi que se puede buscar sin miedo
                  a cambiar lo que se esta comparando. */}
              <input
                className="menu-buscar"
                type="search"
                value={buscarVenue}
                placeholder="Filter venues"
                autoFocus
                onChange={(e) => setBuscarVenue(e.target.value)}
              />
              <FiltroTipo tipo={tipo} onCambiar={setTipo} />
              <div className="menu-acciones">
                <button className="seg" onClick={todosLosVenues}>Select all</button>
                <button className="seg" onClick={ningunVenue}>Deselect all</button>
              </div>
              {venuesFiltrados.length === 0 && <div className="menu-vacio">No venue matches.</div>}
              {venuesFiltrados.map((v) => (
                <div key={v.id} className="menu-fila">
                  {/* Marcar un venue lo sube arriba de la lista. NO lo
                      selecciona: una cosa es tenerlo a mano y otra estar
                      comparandolo. */}
                  <Estrella marcado={favVenues.es(v.id)} que={v.label}
                    onClick={() => favVenues.alternar(v.id)} />
                  <button
                    className={marcados.includes(v.id) ? 'menu-item menu-item-on' : 'menu-item'}
                    title={`${v.symbols} symbols · ${v.status ?? 'no data'}`}
                    onClick={() => alternarVenue(v.id)}
                  >
                    <span className="menu-check">{marcados.includes(v.id) ? '×' : ''}</span>
                    <span className={`dot dot-${v.status ?? 'none'}`} />
                    <span className="menu-label">{v.label}</span>
                    <span className="menu-cifra">{v.symbols}</span>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="screener-meta">
        {horarios.length > 0 && (
          <span>
            <span className="label">Next funding</span>{' '}
            <strong>{cuentaAtras(proximaHora - ahora)}</strong>{' '}
            <span className="none">
              ({new Date(proximaHora).toISOString().slice(11, 16)} UTC ·{' '}
              {horarios.map((v) => v.label).join(', ')})
            </span>
          </span>
        )}
        {proximoCiclo !== null && (
          <span className="cycle">
            <span className="label">Update</span> <strong>{cuentaAtras(proximoCiclo - ahora)}</strong>
            <span className="cycle-bar"><span style={{ width: `${progreso * 100}%` }} /></span>
          </span>
        )}
        <span><strong>{filas.length}</strong> <span className="none">symbols</span></span>
        <span><strong>{marcados.length}/{todos.length}</strong> <span className="none">venues</span></span>
        {/* Anclado: cada fila es el mejor cruce que pasa por ese venue, no el
            mejor del mercado. Hay que decirlo o los numeros enganan. */}
        {data?.anchor != null && (
          <span className="none">one leg on <strong>{data.anchor}</strong></span>
        )}
      </div>

      {/* Symbol y Max arb estan SIEMPRE, aunque no haya ningun venue elegido.
          Antes la tabla entera desaparecia y la pantalla parecia rota en vez
          de vacia; el armazon quieto deja ver que lo unico que falta es elegir
          columnas. */}
      <div className="table-wrap screener-table">
          <table className="screener">
            <thead>
              <tr>
                <th className="star-col" />
                <th className="clickable" onClick={() => ordenarPor('symbol')}>Symbol{flecha('symbol')}</th>
                {/* La unidad NO se repite columna a columna: el control de
                    arriba ya dice en que estan todas, y repetirlo seis veces
                    en letra diminuta era ruido. Lo que si sigue es el aviso de
                    dydx, porque ahi la columna significa otra cosa. */}
                <th className="clickable arb-col" onClick={() => ordenarPor('arb')}>
                  Max arb{flecha('arb')}
                </th>
                {/* Columna fina: la nota de lo sostenido que ha sido ese
                    cruce. Al lado del arbitraje porque las dos se leen juntas:
                    cuanto paga y si aguanta. */}
                <th className="clickable sust-col" title={AYUDA_SOSTENIDO}
                  onClick={() => ordenarPor('sust')}>
                  Sust{flecha('sust')}
                </th>
                {columnas.map((v) => (
                  <th
                    key={v.id}
                    className={v.id === data?.anchor ? 'clickable anchor-col' : 'clickable'}
                    onClick={() => ordenarPor(v.id)}
                  >
                    {/* El nombre lleva a la web oficial; la cabecera ordena. */}
                    {v.url === null ? v.label : (
                      <a href={v.url} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()}>{v.label}</a>
                    )}{flecha(v.id)}
                    {/* dydx publica la tasa del PROXIMO periodo, no la del
                        actual: mezclarla sin decirlo falsearia la fila. */}
                    {v.kind === 'predicted' && <div className="sub">next period</div>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filas.length === 0 ? (
                <tr>
                  <td colSpan={4 + activos.length} className="none">
                    {activos.length < 2 ? 'Pick at least two venues to compare.' : 'No symbol matches.'}
                  </td>
                </tr>
              ) : filas.map((r) => {
                const fav = favoritos.includes(r.symbol);
                const desplegado = abierto === r.symbol;
                return (
                  <Fragment key={r.symbol}>
                  <tr>
                    <td className="star-col">
                      <button className={fav ? 'star star-on' : 'star'} title={fav ? 'Unpin' : 'Pin to top'}
                        onClick={() => alternarFavorito(r.symbol)}>{fav ? '★' : '☆'}</button>
                    </td>
                    {/* El simbolo abre su historico: la tabla dice cuanto paga
                        AHORA y eso no distingue una oportunidad de un pico. */}
                    <td className="asset symbol-cell clickable"
                      title="Funding history"
                      onClick={() => setAbierto(desplegado ? null : r.symbol)}>
                      {r.symbol} <span className="none">{desplegado ? '▾' : '▸'}</span>
                    </td>
                    <td className="arb-col">
                      {/* Sin el rotulo de que venue va largo y cual corto: las
                          etiquetas LONG y SHORT de las propias columnas ya lo
                          dicen, y repetirlo debajo de cada cifra era ruido. */}
                      <strong className="arb-value">
                        {r.spreadHourly === null ? '—' : valor(r.spreadHourly, unidad)}
                      </strong>
                    </td>
                    <td className="sust-col">
                      <Sostenido s={r.sustained} />
                    </td>
                    {columnas.map((v) => {
                      const c = r.cells[v.id];
                      // Un venue apartado por conflicto de ticker no es un
                      // hueco cualquiera: se marca, porque el usuario tiene que
                      // saber que ahi hay un dato y que NO se esta comparando.
                      const anclada = v.id === data?.anchor ? ' anchor-col' : '';
                      if (c === undefined) {
                        return r.conflicts.includes(v.id)
                          ? (
                            <td
                              key={v.id}
                              className={`none${anclada}`}
                              title="Different asset under the same ticker here"
                            >
                              ≠
                            </td>
                          )
                          : <td key={v.id} className={`none${anclada}`}>—</td>;
                      }
                      const lado = v.id === r.longVenue ? 'long' : v.id === r.shortVenue ? 'short' : null;
                      return (
                        <td key={v.id} className={(lado === null ? 'num' : `num cell-${lado}`) + anclada}>
                          {lado !== null && <span className={`side side-${lado}`}>{lado.toUpperCase()}</span>}
                          <span className={c.hourlyRate > 0 ? 'pos' : c.hourlyRate < 0 ? 'neg' : 'none'}>
                            {valor(c.hourlyRate, unidad)}
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                  {desplegado && (
                    <tr className="detail-row">
                      <td colSpan={4 + activos.length}>
                        <Historico
                          symbol={r.symbol}
                          unidad={unidad}
                          venuesCsv={idsActivos}
                          largoVenue={r.longVenue}
                          cortoVenue={r.shortVenue}
                        />
                      </td>
                    </tr>
                  )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
      </div>
    </>
  );
}

/**
 * Historico de funding de un simbolo, venue a venue.
 *
 * La pregunta que responde no es "cuanto paga ahora" sino **"cuanto tiempo
 * lleva pagando"**, que es lo unico que distingue una oportunidad de un pico de
 * un rato. Un diferencial del 80 % anual que existe desde hace veinte minutos
 * no es lo mismo que uno del 20 % que lleva tres dias, y en la tabla los dos se
 * ven igual.
 *
 * Por eso ademas de las lineas van los numeros: la media del periodo, el peor
 * momento y **que porcentaje del tiempo el diferencial se mantuvo a favor**.
 * Esa ultima cifra es la que sirve para lo de mas adelante, el backtesting.
 */
/** Segundos a algo que se lea: 45m, 6.5h, 3.2d. */
function duracion(s: number): string {
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86_400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86_400).toFixed(1)}d`;
}

/**
 * Historico del PAR, no del mercado.
 *
 * La version anterior dibujaba el maximo menos el minimo entre todos los
 * venues, y eso cambia de pareja solo: un dia el mejor cruce es A contra B y
 * al siguiente es C contra D. Una linea asi dice lo que habria dado
 * persiguiendo el mejor cruce cada rato, o sea cerrando y abriendo, que es
 * justo lo que hay que evitar porque cada vuelta se come comisiones y spread.
 *
 * Aqui la linea es la del par que la tabla senala AHORA, sostenido hacia atras
 * en el tiempo: una estimacion bruta del cruce mantenido, no pagos liquidados.
 */
function Historico({ symbol, unidad, venuesCsv, largoVenue: largoActual, cortoVenue: cortoActual }: {
  symbol: string;
  unidad: Unidad;
  /** Los venues elegidos, separados por comas. Ver `idsActivos` en el padre. */
  venuesCsv: string;
  /** La pata larga del cruce que senala la fila, o null si no hay cruce. */
  largoVenue: string | null;
  /** La pata corta. El diferencial es corto menos largo. */
  cortoVenue: string | null;
}) {
  // Preferencia local, igual que los favoritos: mantiene las patas guardadas.
  const clavePar = 'screener.pair.' + symbol;
  const [fijado, setFijado] = useState<{ long: string; short: string } | null>(() => {
    const p = leer<unknown>(clavePar, null);
    if (typeof p !== 'object' || p === null || !('long' in p) || !('short' in p)
      || typeof p.long !== 'string' || typeof p.short !== 'string' || p.long === p.short) return null;
    return { long: p.long, short: p.short };
  });
  const largoVenue = fijado?.long ?? largoActual;
  const cortoVenue = fijado?.short ?? cortoActual;
  const consultaVenues = fijado === null ? venuesCsv : [fijado.long, fijado.short].join(',');
  const [dias, setDias] = useState(7);
  const [data, setData] = useState<SeriesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const venues = useMemo(() => (consultaVenues === '' ? [] : consultaVenues.split(',')), [consultaVenues]);

  useEffect(() => {
    let vivo = true;
    const to = Date.now();
    const q = new URLSearchParams({ symbol, from: String(to - dias * 86_400_000), to: String(to) });
    if (consultaVenues !== '') q.set('venues', consultaVenues);
    getJson<SeriesResponse>(`/api/series?${q}`)
      .then((d) => { if (vivo) { setData(d); setError(null); } })
      .catch((e: unknown) => { if (vivo) setError(e instanceof Error ? e.message : String(e)); });
    return () => { vivo = false; };
    // No se vacia `data` al empezar: vaciarlo tiraba la grafica y la volvia a
    // montar en cada recarga, aunque los datos nuevos fuesen casi los mismos.
    // Se sustituye cuando llega la respuesta, y se ve quieta.
  }, [symbol, dias, consultaVenues]);

  const { series, resumen } = useMemo(() => {
    // Por dentro se trabaja con la tasa HORARIA en decimal, que es la unidad
    // en la que se puede acumular. La escala de pantalla se aplica al final.
    const factor = UNIDADES[unidad].factor;
    const porVenue = new Map<string, { time: number; hourly: number }[]>();
    for (const p of data?.points ?? []) {
      if (venues.length > 0 && !venues.includes(p.venue)) continue;
      const l = porVenue.get(p.venue) ?? [];
      l.push({ time: Math.floor(p.ts / 1000), hourly: p.fundingHourly });
      porVenue.set(p.venue, l);
    }
    for (const l of porVenue.values()) l.sort((a, b) => a.time - b.time);

    const ids = [...porVenue.keys()].sort();
    const series: Serie[] = ids.map((v, i) => ({
      id: v,
      label: `${v.toUpperCase()} (${v === largoVenue ? "Long Funding" : v === cortoVenue ? "Short Funding" : "Reference Funding"})`,
      width: 2,
      color: SERIE_COLORS[i % SERIE_COLORS.length] ?? '#4c9af8',
      points: (porVenue.get(v) ?? []).map((x) => ({ time: x.time, value: x.hourly * factor })),
    }));

    // El diferencial del PAR, cruzado por sello EXACTO. No se interpola: un
    // punto inventado en una pantalla que busca desajustes es peligroso.
    const puntosLargo = largoVenue === null ? [] : porVenue.get(largoVenue) ?? [];
    const puntosCorto = cortoVenue === null ? [] : porVenue.get(cortoVenue) ?? [];
    const mapaLargo = new Map(puntosLargo.map((x) => [x.time, x.hourly]));
    const spreads = puntosCorto
      .filter((x) => mapaLargo.has(x.time))
      .map((x) => ({ time: x.time, hourly: x.hourly - (mapaLargo.get(x.time) ?? 0) }))
      .sort((a, b) => a.time - b.time);

    if (spreads.length > 0) {
      // Mas gruesa y en blanco: es LA linea, y no puede compartir color con
      // ningun venue. Compartiendolo con el primero de la paleta, la del par y
      // la de Aster se dibujaban iguales y no habia forma de saber cual era
      // cual.
      series.push({
        id: '__spread',
        label: cortoVenue === null || largoVenue === null
          ? 'Pair Spread'
          : `Pair Spread (${cortoVenue.toUpperCase()} Short / ${largoVenue.toUpperCase()} Long)`,
        // El color del texto del tema, no blanco puro: #fff no esta en la
        // paleta y a 3 px de grosor se sale del contraste del resto.
        color: getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#e5e7eb',
        width: 3,
        points: spreads.map((x) => ({ time: x.time, value: x.hourly * factor })),
      });
    }

    const vals = spreads.map((s) => s.hourly * factor);
    const media = vals.length === 0 ? null : vals.reduce((a, b) => a + b, 0) / vals.length;
    const ordenados = [...vals].sort((a, b) => a - b);
    const p10 = ordenados.length === 0 ? null : ordenados[Math.floor(ordenados.length * 0.1)] ?? null;
    // Favorable significa tasa bruta positiva, sin descontar costes.
    const minimo = 0;

    /**
     * La racha mas larga que el diferencial aguanto por encima del umbral.
     *
     * Es la respuesta a "donde dura mas la oportunidad", y NO es lo mismo que
     * el porcentaje de tiempo a favor: un 80 % repartido en veinte ratos de
     * diez minutos no se puede operar, y un 60 % de una sola pieza si. Se mide
     * en tiempo de reloj y no en numero de muestras, porque el historico tiene
     * huecos donde el collector estuvo parado.
     *
     * Un hueco mayor que dos veces la cadencia normal CORTA la racha: no se
     * sabe que paso ahi, y dar por supuesto que aguanto seria inventarselo.
     */
    // La cadencia real, MEDIDA: la mediana de lo que separa dos muestras. De
    // ahi sale el corte que distingue "sigue habiendo dato" de "aqui hubo un
    // apagon", y lo usan tanto la racha como el tiempo cubierto.
    const saltos = spreads.slice(1)
      .map((s, i) => s.time - (spreads[i]?.time ?? s.time))
      .sort((a, b) => a - b);
    const cadencia = saltos[Math.floor(saltos.length / 2)] ?? 300;
    const corte = Math.min(cadencia * 2.5, 20 * 60);

    const rachaS = (() => {
      if (spreads.length < 2) return null;
      let mejor = 0;
      let desde: number | null = null;
      let previo: { time: number; hourly: number } | null = null;

      for (const punto of spreads) {
        const dentro = punto.hourly * factor > minimo;
        const hueco = previo !== null && punto.time - previo.time > corte;
        if (!dentro || hueco) {
          if (desde !== null && previo !== null) mejor = Math.max(mejor, previo.time - desde);
          desde = dentro ? punto.time : null;
        } else if (desde === null) {
          desde = punto.time;
        }
        previo = punto;
      }
      if (desde !== null && previo !== null) mejor = Math.max(mejor, previo.time - desde);
      return mejor;
    })();

    /**
     * Cuanto tiempo cubren DE VERDAD las muestras.
     *
     * No es del primer punto al ultimo: el collector ha estado parado a ratos
     * y algunos venues se activaron hoy, asi que en BTC habia un hueco de 3,8
     * dias en mitad de la semana. Midiendo de punta a punta salia "7.0d / 7d",
     * que es justo la mentira que hay que evitar: sin esto, un "100 % del
     * tiempo a favor" se lee como una semana entera cuando es una tarde.
     *
     * Se suman solo los tramos donde hubo muestras seguidas.
     */
    const cubiertoS = spreads.length < 2
      ? null
      : spreads.slice(1).reduce((acc, s, i) => {
        const dt = s.time - (spreads[i]?.time ?? s.time);
        return dt <= corte ? acc + dt : acc;
      }, 0);

    // Tiempo estimado entre muestras cercanas; los huecos no cuentan.
    const favorableS = spreads.slice(1).reduce((acc, s, i) => {
      const previo = spreads[i];
      if (previo === undefined) return acc;
      const dt = s.time - previo.time;
      if (dt <= 0 || dt > corte) return acc;
      const a = previo.hourly;
      const b = s.hourly;
      const fraccion = a > 0 && b > 0 ? 1 : a <= 0 && b <= 0 ? 0
        : Math.max(a, b) / Math.abs(b - a);
      return acc + dt * fraccion;
    }, 0);
    const aFavor = cubiertoS === null || cubiertoS <= 0 ? null : favorableS / cubiertoS;

    // Estimacion sobre el nocional de una pata, sin costes ni pagos liquidados.
    const acumuladoPct = cubiertoS === null || cubiertoS <= 0
      ? null
      : spreads.slice(1).reduce((acc, s, i) => {
        const previo = spreads[i];
        if (previo === undefined) return acc;
        const dt = s.time - previo.time;
        if (dt > corte) return acc;
        // Regla del trapecio: la tasa se mueve entre muestra y muestra.
        return acc + ((previo.hourly + s.hourly) / 2) * (dt / 3600);
      }, 0) * 100;

    return {
      series,
      resumen: { muestras: vals.length, media, p10, aFavor, rachaS, cubiertoS, acumuladoPct },
    };
  }, [data, unidad, venues, largoVenue, cortoVenue]);

  const fmtValor = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}${UNIDADES[unidad].sufijo}`;

  return (
    <div className="history">
      <div className="controls">
        <span className="label">LONG {largoVenue ?? '—'} / SHORT {cortoVenue ?? '—'}</span>
        <button type="button" disabled={largoVenue === null || cortoVenue === null}
          aria-pressed={fijado !== null}
          title="Save this pair in this browser to analyse the same legs across visits"
          onClick={() => {
            const next = fijado !== null || largoVenue === null || cortoVenue === null
              ? null : { long: largoVenue, short: cortoVenue };
            try {
              localStorage.setItem(clavePar, JSON.stringify(next));
              setFijado(next);
            } catch { setError('Could not save pair in this browser'); }
          }}>
          {fijado === null ? 'Save fixed pair' : 'Saved pair · Unpin'}
        </button>
      </div>
      <div className="controls">
        <div className="control-group">
          <span className="label">Range</span>
          <div className="segmented">
            {[1, 7, 30].map((d) => (
              <button key={d} className={d === dias ? 'seg seg-active' : 'seg'} onClick={() => setDias(d)}>
                {d === 1 ? '24h' : `${d}d`}
              </button>
            ))}
          </div>
        </div>
      </div>

      {error !== null && <p className="light light-red">Could not load history: {error}</p>}
      {error === null && data === null && <p className="none">Loading…</p>}

      {data !== null && resumen.muestras === 0 && (
        <p className="none">
          No overlapping history yet for {symbol} in this range.
        </p>
      )}

      {resumen.muestras > 0 && (
        <>
          <div className="stats">
            <div className="stat">
              <div className="label">History</div>
              <div className="stat-value">
                {resumen.cubiertoS === null ? '—' : `${duracion(resumen.cubiertoS)} / ${dias}d`}
              </div>
            </div>
            <div className="stat">
              <div className="label">Mean spread</div>
              <div className="stat-value">{resumen.media === null ? '—' : fmtValor(resumen.media)}</div>
            </div>
            <div className="stat">
              <div className="label">Worst tenth</div>
              <div className="stat-value">{resumen.p10 === null ? '—' : fmtValor(resumen.p10)}</div>
            </div>
            <div className="stat">
              <div className="label">Est. time positive</div>
              <div className="stat-value">
                {resumen.aFavor === null ? '—' : `${(resumen.aFavor * 100).toFixed(0)}%`}
              </div>
            </div>
            <div className="stat">
              <div className="label">Longest run</div>
              <div className="stat-value">
                {resumen.rachaS === null ? '—' : duracion(resumen.rachaS)}
              </div>
            </div>
            <div className="stat">
              <div className="label" title="Estimated on one leg's notional. Excludes fees, execution spread and price P&L. Not settled payments.">Est. gross funding</div>
              <div className="stat-value">
                {resumen.acumuladoPct === null
                  ? '—'
                  : `${resumen.acumuladoPct >= 0 ? '+' : ''}${resumen.acumuladoPct.toFixed(3)}%`}
              </div>
            </div>
          </div>

          <div className="chart-wrap">
            <div className="legend">{UNIDADES[unidad].label} · Venue rates: + shorts receive, − longs receive</div>
            <Chart series={series} height={320} formatValue={fmtValor} baseline={0} readableAxes />
            <div className="legend">Pair spread: + receives, − pays · Before costs · Estimated</div>
            <div className="legend">
              {series.map((s) => (
                <span key={s.id} className="legend-item">
                  <span className="legend-dot" style={{ background: s.color }} />
                  {s.label}
                </span>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

