/**
 * Familias de activos: simbolos DISTINTOS que siguen lo mismo.
 *
 * No es el ALIAS de `symbols.ts`. Alli se juntan nombres del MISMO contrato
 * (`XBR` y `BZ` son el Brent a 90,7 $ en los dos sitios). Aqui van productos
 * distintos con la misma exposicion: el S&P 500 a 7.326 $ y el ETF SPY a 732 $
 * no se pueden juntar en una fila (el precio es otro y la dispersion entre
 * venues saldria del 900 %), pero quien busca "SPY" quiere ver tambien el
 * indice, y quien busca "gold" quiere el oro, PAXG y XAUT.
 *
 * Sirve para BUSCAR y para decir que sigue cada fila. Nunca para sumar ni para
 * cruzar precios. Tabla explicita, como el ALIAS: `SPX` a secas es el memecoin
 * SPX6900, y por eso no esta en `simbolos` aunque si como palabra de busqueda.
 */
export interface FamiliaActivo {
  /** Lo que sigue, en ingles porque sale en la interfaz. */
  readonly label: string;
  /** Simbolos normalizados de la familia. */
  readonly simbolos: readonly string[];
  /** Otras formas de buscarla (nombre, ticker de futuros, de otros brokers). */
  readonly nombres: readonly string[];
}

export const FAMILIAS: readonly FamiliaActivo[] = [
  { label: 'S&P 500', simbolos: ['US500', 'SPY', 'VOO', 'SPXL', 'SPXS'], nombres: ['S&P', 'S&P500', 'SP500', 'SPX', 'SPX500', 'ES'] },
  { label: 'Nasdaq 100', simbolos: ['US100', 'QQQ', 'TQQQ', 'SQQQ'], nombres: ['NASDAQ', 'NAS100', 'NDX', 'NQ', 'XYZ100'] },
  { label: 'Dow Jones', simbolos: ['US30'], nombres: ['DOW', 'DJI', 'DJIA', 'YM'] },
  { label: 'Russell 2000', simbolos: ['US2000', 'IWM', 'TNA', 'TZA'], nombres: ['RUSSELL', 'RUT', 'RTY', 'US2K'] },
  { label: 'S&P MidCap 400', simbolos: ['US400'], nombres: ['MIDCAP'] },
  { label: 'Gold', simbolos: ['XAU', 'PAXG', 'XAUT', 'GLD'], nombres: ['GOLD', 'GC'] },
  { label: 'Silver', simbolos: ['XAG', 'SLV'], nombres: ['SILVER'] },
  { label: 'WTI crude', simbolos: ['WTI', 'USO'], nombres: ['OIL', 'CRUDE', 'CL', 'USOIL'] },
  { label: 'Brent crude', simbolos: ['BRENT'], nombres: ['OIL', 'CRUDE', 'BZ', 'UKOIL', 'XBR'] },
  { label: 'Natural gas', simbolos: ['NATGAS'], nombres: ['GAS', 'NG', 'XNG'] },
  { label: 'Copper', simbolos: ['COPPER', 'CPER'], nombres: ['HG'] },
  { label: 'Volatility', simbolos: ['VIX', 'UVXY'], nombres: ['VOLATILITY'] },
  { label: 'US dollar index', simbolos: ['DXY'], nombres: ['DOLLAR', 'USDX'] },
  { label: 'Anthropic', simbolos: ['ANTHROPIC', 'ANT'], nombres: ['CLAUDE'] },
  { label: 'OpenAI', simbolos: ['OPENAI'], nombres: ['OAI', 'CHATGPT'] },
  { label: 'SK Hynix', simbolos: ['SKHYNIX'], nombres: ['HYNIX', 'SKHX'] },
  { label: 'Bitcoin', simbolos: ['BTC', 'IBIT', 'BITU'], nombres: ['BITCOIN', 'XBT'] },
  { label: 'Ether', simbolos: ['ETH', 'ETHA'], nombres: ['ETHEREUM', 'ETHER'] },
];

const PORSIMBOLO = new Map<string, FamiliaActivo>(
  FAMILIAS.flatMap((f) => f.simbolos.map((s) => [s, f] as const)),
);

/** La familia de un simbolo normalizado, o null si no tiene. */
export function familiaDe(symbol: string): FamiliaActivo | null {
  return PORSIMBOLO.get(symbol) ?? null;
}

/**
 * Familias a las que apunta una busqueda. Exacta con cualquier simbolo o
 * nombre; por prefijo solo desde tres letras, para que "SI" no traiga la
 * plata ni "ES" el S&P.
 */
export function familiasDeBusqueda(q: string): FamiliaActivo[] {
  const t = q.trim().toUpperCase();
  if (t === '') return [];
  const largo = t.length >= 3;
  return FAMILIAS.filter((f) =>
    [...f.simbolos, ...f.nombres, f.label.toUpperCase()].some((n) => n === t || (largo && n.startsWith(t))),
  );
}
