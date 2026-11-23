import type { DatabaseSync } from 'node:sqlite';

/**
 * Wallets del usuario.
 *
 * Dato del usuario: irreemplazable, no se purga nunca y entra en la copia de
 * seguridad. Aqui **solo** hay direcciones publicas. Una clave privada o una
 * seed phrase no entra en esta base de datos bajo ningun concepto: la
 * aplicacion es de solo lectura y no necesita ninguna.
 */
export interface Wallet {
  readonly id: string;
  readonly address: string;
  readonly chain: string;
  readonly label: string | null;
  readonly notes: string | null;
  readonly createdAt: number;
}

export interface NewWallet {
  readonly address: string;
  readonly chain: string;
  readonly label?: string | null;
  readonly notes?: string | null;
}

/** Longitud a partir de la cual algo deja de parecer una direccion publica. */
const MAX_ADDRESS = 128;

/**
 * Rechaza lo que no parece una direccion publica.
 *
 * No valida el formato de cada cadena a proposito (son demasiadas y cambian),
 * pero si corta el caso peligroso: una seed phrase pegada por error en el campo
 * de direccion. Doce palabras separadas por espacios no son una direccion, y
 * guardarlas en claro seria el peor fallo posible de esta aplicacion.
 */
export function validateAddress(address: string): string {
  const limpia = address.trim();
  if (limpia === '') throw new Error('the address is empty');
  if (limpia.length > MAX_ADDRESS) throw new Error('the address is too long');
  if (/\s/.test(limpia)) {
    throw new Error(
      'the address contains spaces: if you pasted a seed phrase, delete it from here immediately',
    );
  }
  return limpia;
}

export function addWallet(db: DatabaseSync, wallet: NewWallet, now: number = Date.now()): Wallet {
  const address = validateAddress(wallet.address);
  const chain = wallet.chain.trim().toLowerCase();
  if (chain === '') throw new Error('the chain is required');

  const id = `${chain}:${address.toLowerCase()}`;
  const row: Wallet = {
    id,
    address,
    chain,
    label: wallet.label ?? null,
    notes: wallet.notes ?? null,
    createdAt: now,
  };

  db.prepare(
    `INSERT INTO wallet (id, address, chain, label, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(address, chain) DO UPDATE SET
       label = excluded.label,
       notes = excluded.notes`,
  ).run(row.id, row.address, row.chain, row.label, row.notes, row.createdAt);

  const guardada = getWallet(db, id);
  // El upsert por (address, chain) puede haber actualizado una fila existente
  // con otro id, asi que se devuelve lo que hay en la base, no lo que se creia.
  return guardada ?? row;
}

export function getWallet(db: DatabaseSync, id: string): Wallet | null {
  const row = db.prepare('SELECT * FROM wallet WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row === undefined ? null : toWallet(row);
}

export function listWallets(db: DatabaseSync): Wallet[] {
  const rows = db
    .prepare('SELECT * FROM wallet ORDER BY created_at ASC')
    .all() as Record<string, unknown>[];
  return rows.map(toWallet);
}

export function removeWallet(db: DatabaseSync, id: string): boolean {
  return Number(db.prepare('DELETE FROM wallet WHERE id = ?').run(id).changes) > 0;
}

function toWallet(row: Record<string, unknown>): Wallet {
  return {
    id: String(row['id']),
    address: String(row['address']),
    chain: String(row['chain']),
    label: row['label'] === null ? null : String(row['label']),
    notes: row['notes'] === null ? null : String(row['notes']),
    createdAt: Number(row['created_at']),
  };
}
