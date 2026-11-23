import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agruparPrecios, precioDeReferencia } from './precios.ts';

/**
 * El caso que motivo esto, con las cifras REALES medidas el 5 de octubre de
 * 2026: QNT lo listan cuatro venues en dos grupos y la mediana caia en el
 * hueco, a 149,41, donde no cotiza ninguno.
 */
const QNT = [252.3231808206989, 252.84518185, 46.438962508629, 46.5];

test('dos grupos empatados NO tienen referencia', () => {
  // La mediana de los cuatro daba 149,41 y marcaba a los cuatro como malos.
  assert.equal(precioDeReferencia(QNT, 1.1), null);
  const grupos = agruparPrecios(QNT, 1.1);
  assert.equal(grupos.length, 2);
  assert.deepEqual(grupos.map((g) => g.length), [2, 2]);
});

test('con mayoria manda el grupo grande, no la mediana de todo', () => {
  // Tres venues de acuerdo y uno que se va: la referencia son los tres.
  const r = precioDeReferencia([100, 101, 102, 4000], 1.1);
  assert.equal(r?.precio, 101);
  assert.equal(r?.enElGrupo, 3);
  assert.equal(r?.total, 4);
});

test('todos de acuerdo: la referencia es la mediana de siempre', () => {
  const r = precioDeReferencia([99, 100, 101], 1.1);
  assert.equal(r?.precio, 100);
  assert.equal(r?.enElGrupo, 3);
});

test('dos grupos con uno mayor: gana el mayor aunque sea el de precio bajo', () => {
  // Importa que gane por TAMANO y no por quedar arriba en el array ordenado,
  // que era justo el fallo de `precios[n/2]` en la matriz.
  const r = precioDeReferencia([46.4, 46.5, 46.6, 252.3, 252.8], 1.1);
  assert.equal(r?.precio, 46.5);
  assert.equal(r?.enElGrupo, 3);
});

test('un solo precio es mayoria de uno, y quien llama ya lo ha filtrado', () => {
  // Que devuelva el propio precio no es un descuido: comparar uno con nada no
  // llega hasta aqui. La matriz exige dos venues y la validacion tres, asi que
  // este caso lo cortan ellos antes. Se fija por escrito para que nadie anada
  // esa comprobacion dos veces ni la quite de donde si hace falta.
  assert.equal(precioDeReferencia([100], 1.1)?.precio, 100);
});

test('los precios invalidos no entran ni cuentan para la mayoria', () => {
  const r = precioDeReferencia([100, 101, 102, 0, -5, Number.NaN], 1.1);
  assert.equal(r?.precio, 101);
  assert.equal(r?.total, 3, 'los tres validos, no los seis');
});

test('una pareja a cada lado y uno suelto: el suelto no desempata', () => {
  // Tres grupos de 1, 2 y 2. El mayor empata, asi que sigue sin haber mayoria.
  assert.equal(precioDeReferencia([10, 100, 101, 1000, 1010], 1.1), null);
});
