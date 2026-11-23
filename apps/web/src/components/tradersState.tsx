import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { BASE, getJson, type AlertsResponse, type TradersResponse } from '../api.ts';

/**
 * Estado compartido de los traders seguidos.
 *
 * Vive aqui y no dentro de cada panel para que Traders y Terminal ensenen
 * exactamente lo mismo: una sola descarga, una sola lista, y pausar desde
 * cualquiera de las dos pantallas se ve al instante en la otra. Los paneles
 * son tontos a proposito.
 *
 * La lista de verdad esta en SQLite, en el servidor. Aqui no se guarda nada
 * que sobreviva a la pestana: lo unico que se recuerda en el navegador es la
 * disposicion visual, que es preferencia y no dato.
 */
interface TradersState {
  readonly data: TradersResponse | null;
  readonly error: string | null;
  /** true mientras no ha llegado la primera respuesta. */
  readonly loading: boolean;
  readonly asset: string;
  readonly traderId: string;
  readonly group: string;
  setAsset(value: string): void;
  setTraderId(value: string): void;
  setGroup(value: string): void;
  /** Cambios de posicion detectados y estado del bot de Telegram. */
  readonly alerts: AlertsResponse | null;
  /** Mensaje de prueba. Solo sale cuando el usuario pulsa el boton. */
  testTelegram(): Promise<void>;
  refresh(): Promise<void>;
  add(input: { address: string; alias?: string; color?: string; group?: string; notes?: string }): Promise<void>;
  patch(id: string, cambios: Record<string, unknown>): Promise<void>;
  remove(id: string): Promise<void>;
}

const Ctx = createContext<TradersState | null>(null);

/** Cada cuanto se relee la lista. Es local, asi que sale barato. */
const REFRESCO_MS = 5_000;

async function enviar(ruta: string, metodo: string, cuerpo?: unknown): Promise<void> {
  // Con BASE. Sin el, en desarrollo esto iba al 5173, Vite devolvia su propia
  // pagina con un 200 y aqui parecia que habia salido bien: anadir y quitar no
  // hacian nada y no se veia ni un error.
  const r = await fetch(`${BASE}${ruta}`, {
    method: metodo,
    headers: cuerpo === undefined ? {} : { 'content-type': 'application/json' },
    ...(cuerpo === undefined ? {} : { body: JSON.stringify(cuerpo) }),
  });
  if (!r.ok) {
    // El mensaje del servidor es el util ("already on the list", "not a
    // Hyperliquid address"): se propaga tal cual en vez de un "error 400".
    const d = (await r.json().catch(() => null)) as { error?: string } | null;
    throw new Error(d?.error ?? `${r.status}`);
  }
  // Un 200 que no sea JSON no lo ha contestado la API. Callarselo es lo que
  // hacia que el boton no diese ni error ni resultado.
  if (!(r.headers.get('content-type') ?? '').includes('json')) {
    throw new Error('the API did not answer this request');
  }
}

export function TradersProvider({ children }: { children: ReactNode }) {
  const [asset, setAsset] = useState('');
  const [traderId, setTraderId] = useState('');
  const [group, setGroup] = useState('');
  const [data, setData] = useState<TradersResponse | null>(null);
  const [alerts, setAlerts] = useState<AlertsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      // Las dos juntas: la lista y lo que ha cambiado en ella se miran a la
      // vez, y separarlas dejaria un aviso de una posicion que la tabla de al
      // lado todavia no tiene.
      const [t, a] = await Promise.all([
        getJson<TradersResponse>('/api/traders'),
        getJson<AlertsResponse>('/api/alerts?limit=60'),
      ]);
      setData(t);
      setAlerts(a);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    let vivo = true;
    const tick = async () => {
      if (!vivo) return;
      await refresh();
    };
    void tick();
    const t = setInterval(() => void tick(), REFRESCO_MS);
    return () => { vivo = false; clearInterval(t); };
  }, [refresh]);

  // Tras cambiar algo se relee: la fuente de verdad es el servidor, no un
  // estado local que se pueda desincronizar del seguimiento real.
  const add: TradersState['add'] = async (input) => {
    await enviar('/api/traders', 'POST', input);
    await refresh();
  };
  const patch: TradersState['patch'] = async (id, cambios) => {
    await enviar(`/api/traders/${encodeURIComponent(id)}`, 'PATCH', cambios);
    await refresh();
  };
  const remove: TradersState['remove'] = async (id) => {
    await enviar(`/api/traders/${encodeURIComponent(id)}`, 'DELETE');
    await refresh();
  };
  // Manda un mensaje de verdad al chat del usuario, asi que no se lanza solo:
  // sale unicamente del boton de la pantalla.
  const testTelegram: TradersState['testTelegram'] = async () => {
    await enviar('/api/alerts/test', 'POST');
    await refresh();
  };

  return (
    <Ctx.Provider value={{ asset, setAsset, traderId, setTraderId, group, setGroup, data, alerts, error, loading: data === null && error === null, refresh, add, patch, remove, testTelegram }}>
      {children}
    </Ctx.Provider>
  );
}

/** Los paneles lo usan. Fuera del proveedor es un error de montaje. */
export function useTraders(): TradersState {
  const v = useContext(Ctx);
  if (v === null) throw new Error('TradersProvider is missing above this panel');
  return v;
}
