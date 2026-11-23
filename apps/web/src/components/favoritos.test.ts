import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * El orden de los favoritos.
 *
 * La logica de marcado vive en un hook de React y se comprueba en el
 * navegador; lo que si se puede probar aqui, y es donde esta el error facil,
 * es el orden: subir los marcados SIN reordenar el resto. Si el orden de cada
 * grupo cambiase, la lista bailaria cada vez que se marca algo.
 */
function ordenar<T>(lista: readonly string[], items: readonly T[], id: (x: T) => string): T[] {
  return [
    ...items.filter((x) => lista.includes(id(x))),
    ...items.filter((x) => !lista.includes(id(x))),
  ];
}

const items = ['a', 'b', 'c', 'd'];
const mismo = (x: string) => x;

test('los marcados suben y el resto conserva su orden', () => {
  assert.deepEqual(ordenar(['c'], items, mismo), ['c', 'a', 'b', 'd']);
});

test('entre marcados tambien se conserva el orden original', () => {
  // NO el orden en que se marcaron: si no, la lista bailaria sola.
  assert.deepEqual(ordenar(['d', 'b'], items, mismo), ['b', 'd', 'a', 'c']);
});

test('sin favoritos no se toca nada', () => {
  assert.deepEqual(ordenar([], items, mismo), items);
});

test('un favorito que ya no esta en la lista no rompe nada', () => {
  // Pasa al quitar un venue del registro con la estrella puesta.
  assert.deepEqual(ordenar(['zz'], items, mismo), items);
});
