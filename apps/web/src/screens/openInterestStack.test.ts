import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apilar } from './openInterestStack.ts';

const OPC = { colores: ['#111111', '#222222'], etiqueta: (v: string) => v };
const HORA = 3_600_000;

/** El acumulado de arriba del todo en el ultimo sello: el total que se lee. */
function totalFinal(bandas: ReturnType<typeof apilar>): number | undefined {
  // `apilar` devuelve en orden de dibujo: la primera es la de acumulado mayor.
  return bandas[0]?.points.at(-1)?.value;
}

test('un venue que deja de reportar NO sigue sumando hasta el final', () => {
  // El caso de la auditoria del 25 de septiembre de 2026: A da un punto y
  // calla; B sigue un dia despues. Antes el total final era 130, con los 100
  // de A arrastrados veinticuatro horas. A ya no se sabe cuanto tiene.
  //
  // La pantalla pasa el limite a partir de la resolucion que da el servidor,
  // y asi se prueba aqui: con solo dos sellos no hay cadencia que deducir.
  const bandas = apilar([
    { venue: 'A', points: [{ t: 0, v: 100 }] },
    { venue: 'B', points: [{ t: 0, v: 20 }, { t: 24 * HORA, v: 30 }] },
  ], { ...OPC, maxArrastreMs: 3 * HORA });
  assert.equal(totalFinal(bandas), 30);
  assert.equal(bandas.find((b) => b.venue === 'A')?.ultimoUsd, null, 'la cifra de A ya no vale como actual');
});

test('sin limite explicito, lo deduce de la cadencia de las que siguen vivas', () => {
  // A calla tras su primer punto y B sigue cada hora durante un dia. El paso
  // tipico es una hora, asi que a las tres horas A deja de contar.
  const bandas = apilar([
    { venue: 'A', points: [{ t: 0, v: 100 }] },
    { venue: 'B', points: Array.from({ length: 25 }, (_v, i) => ({ t: i * HORA, v: 20 })) },
  ], OPC);
  assert.equal(totalFinal(bandas), 20);
});

test('un hueco corto si se arrastra: cada fuente guarda a su ritmo', () => {
  // A y B no sellan en el mismo instante. Entre un punto de A y el siguiente,
  // su ultimo valor sigue valiendo: eso no es un venue muerto, es cadencia.
  const paso = 15 * 60_000;
  const bandas = apilar([
    { venue: 'A', points: [{ t: 0, v: 100 }, { t: 2 * paso, v: 110 }, { t: 4 * paso, v: 120 }] },
    { venue: 'B', points: [{ t: paso, v: 20 }, { t: 3 * paso, v: 30 }, { t: 5 * paso, v: 40 }] },
  ], OPC);
  // En el ultimo sello (5 pasos) A no tiene punto, pero el suyo es de hace uno.
  assert.equal(totalFinal(bandas), 160);
});

test('el limite sale del paso de la propia serie, no de un numero fijo', () => {
  // En la vista de treinta dias los cubos son de tres horas. Con un limite
  // fijo de minutos, todo venue pareceria muerto entre un cubo y el siguiente.
  const cubo = 3 * HORA;
  const bandas = apilar([
    { venue: 'A', points: [0, 1, 2, 3, 4].map((i) => ({ t: i * cubo, v: 100 })) },
    { venue: 'B', points: [0, 1, 2, 3, 4, 5].map((i) => ({ t: i * cubo, v: 10 })) },
  ], OPC);
  // A falta en el ultimo cubo, pero su lectura es de hace UN paso: se arrastra.
  assert.equal(totalFinal(bandas), 110);
});

test('antes de su primer punto un venue no existe: no suma cero', () => {
  const bandas = apilar([
    { venue: 'A', points: [{ t: 0, v: 100 }, { t: HORA, v: 100 }] },
    { venue: 'B', points: [{ t: HORA, v: 50 }] },
  ], OPC);
  // Las bandas son ACUMULADOS: la de B es el borde de A mas B. Antes de que B
  // exista, ese borde coincide con el de A, o sea que B tiene grosor cero
  // porque no esta, no porque se le haya puesto un valor.
  const a = bandas.find((x) => x.venue === 'A');
  const b = bandas.find((x) => x.venue === 'B');
  assert.equal((b?.points[0]?.value ?? 0) - (a?.points[0]?.value ?? 0), 0);
  assert.equal((b?.points[1]?.value ?? 0) - (a?.points[1]?.value ?? 0), 50);
});

test('se puede fijar el limite a mano', () => {
  const bandas = apilar([
    { venue: 'A', points: [{ t: 0, v: 100 }] },
    { venue: 'B', points: [{ t: 0, v: 20 }, { t: 24 * HORA, v: 30 }] },
  ], { ...OPC, maxArrastreMs: 48 * HORA });
  assert.equal(totalFinal(bandas), 130, 'con dos dias de margen, A sigue contando');
});
