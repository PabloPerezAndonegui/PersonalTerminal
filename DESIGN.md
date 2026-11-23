# Diseno de la interfaz

Toda la UI va **en ingles**. Este documento define que significa "minimalista"
aqui, en reglas comprobables, para que no dependa del gusto del dia.

## Que es "vibecode" y por que se evita

El aspecto tipico de una app generada sin criterio, y que aqui no queremos:

- Gradientes, sombras de colores y bordes brillantes que no comunican nada.
- Tarjetas con mucho aire para cuatro datos, que obligan a hacer scroll para
  ver lo que cabria en una tabla.
- Emojis e iconos decorativos mezclados con datos numericos.
- Badges de colores por todas partes, hasta que ninguno significa nada.
- Animaciones de entrada en cada elemento.
- Numeros grandes y llamativos sin unidad, sin fecha y sin fuente.

El criterio de fondo: **esto es una herramienta de trabajo con datos densos, no
una landing page.** Se parece mas a una terminal financiera que a una web de
producto. Cada pixel que no es dato, o guia hacia el dato, sobra.

## Reglas

### Prioritarias (mandan sobre las de abajo)

**Todo centrado respecto a la pagina.** El contenido, las tablas, las
cabeceras, las celdas y las cifras. Las columnas numericas tambien: siguen con
anchura tabular, que es lo que las hace comparables, pero centradas.

**Menu de arriba centrado, grande y en negrita.** Marca centrada encima y las
pestanas debajo, a 14 px y en negrita. Si no caben en una linea, parten en
varias centradas; nunca scroll horizontal.

**Sin textos explicativos.** Ni parrafos de introduccion ni notas largas. Lo
que la pantalla tenga que decir lo dicen las etiquetas, las cifras y el
semaforo. Los avisos de ESTADO (fuente caida, dato estimado, sin historico) se
quedan, porque callarlos haria parecer completa una tabla que no lo esta, pero
en una frase corta.

**Nunca guiones largos en mitad de una frase.** Nada de "esto — aquello". Se
usan punto, coma, dos puntos o parentesis. La UNICA excepcion es el "—" solo en
una celda, que marca un dato desconocido: no es texto, es un valor.

### Generales

**Densidad antes que aire.** La unidad por defecto es la tabla, no la tarjeta.
Una pantalla debe caber en un vistazo sin scroll siempre que sea posible. Las
tarjetas se reservan para lo que de verdad es una ficha independiente (una pool,
un bridge), nunca para una fila de datos.

**El color solo significa estado.** Verde, amarillo y rojo estan reservados
para el semaforo de salud y para el signo de un numero (positivo/negativo). Un
acento, y solo uno, para lo interactivo. Nada de colores decorativos: si algo es
verde, el usuario tiene que poder preguntar "por que es verde" y que haya
respuesta.

**Numeros monoespaciados, texto en sans.** Las CIFRAS van en monoespaciada,
que es lo que las mantiene alineadas columna a columna, y todo lo demas en la
sans del sistema, que se lee bastante mejor a tamano pequeno. Misma cantidad de
decimales en una columna, para que las cifras comparables midan lo mismo.
(Antes iban alineados a la derecha; ahora van centrados, ver arriba.)

**Una celda, un renglon.** Nada de segunda linea en letra pequena debajo de
un dato: el protocolo de un pool, el proveedor de una fuente. Duplicaba la
altura de cada fila y hacia bailar la columna entera. Si el dato merece estar,
va en su columna; si no, al titulo, donde se ve al pasar el cursor.

**La caja de un boton se ve.** Un boton sin borde visible se lee como texto
suelto y no se sabe que es pulsable.

**La flecha de un desplegable la dibujamos nosotros.** La del sistema la coloca
cada navegador donde quiere y se pega al texto. Va siempre a la misma distancia
del borde, con hueco reservado para que no lo pise.

**Nada baja de 12 px.** Los rotulos de 10 y 11 px no se leian, y una unidad que
no se lee es peor que no ponerla: se adivina. Si algo solo cabe en letra
diminuta, es que sobra o que va en otro sitio.

**La unidad no se repite columna a columna.** Si el control de arriba ya dice
en que estan todas las cifras, repetirlo en cada cabecera es ruido. Solo se
anota la columna que significa algo DISTINTO de las demas.

**La tabla tiene una L.** La fila de cabecera y la columna que identifica la
fila mandan, y se nota: fondo propio, letra mas grande y mas gruesa, y un corte
grueso que las separa del cuerpo. El borde exterior tambien es grueso. Con
todas las lineas del mismo peso, una tabla de cincuenta filas es una mancha.

**Toda cifra lleva unidad y contexto.** Nunca un numero suelto. Porcentaje de
que, en que ventana, medido o estimado, y de cuando es el dato.

**Lo estimado se etiqueta como estimado.** El volumen a 7d y 30d se calcula, no
se mide: va marcado. Un dato calculado que se presenta como medido es una
mentira aunque el calculo sea correcto.

**El dato ausente es "—".** Nunca 0, nunca una casilla vacia, nunca un guion
que se pueda confundir con un valor. Y si se sabe por que falta, se dice al
pasar el cursor.

**La degradacion se ve donde ocurre.** Si una tabla esta incompleta porque una
fuente esta amarilla, lo dice esa tabla, con enlace a Data Sources. Nunca una
pantalla que parece completa y no lo esta.

**Sin animaciones de entrada.** Las unicas transiciones aceptables son las que
dan continuidad a una accion del usuario (abrir un desplegable) y duran menos
de 150 ms. Los datos que se actualizan solos no parpadean ni saltan.

**Tipografia: tres tamanos y dos pesos.** Datos, etiquetas y cabeceras. Las
etiquetas en mayusculas y bajo contraste; los datos en alto contraste. La
jerarquia se hace con contraste y posicion, no con seis tamanos.

**Los mandos respiran.** Los grupos de control van dentro de su propia banda,
separados entre si, y cada control tiene cuerpo suficiente para acertarle. Una
barra de filtros apinada se lee como texto suelto encima de la tabla.

**La paleta viene de Variational.** Fondo negro azulado, superficies hacia el
azul pizarra y acento azul.

**Un solo nivel de superficie.** Fondo y, como mucho, un tono por encima para
agrupar. Nada de tarjetas dentro de tarjetas dentro de paneles.

## Accesibilidad y practica

- Contraste minimo AA sobre el fondo real, comprobado, no supuesto.
- El color nunca es el unico portador de informacion: el semaforo lleva ademas
  texto de estado, porque hay daltonismo rojo-verde.
- Todo lo interactivo se alcanza con teclado, y las tablas se pueden ordenar y
  filtrar sin raton.
- Responsive de verdad: las tablas anchas hacen scroll horizontal dentro de su
  contenedor, la pagina nunca.
- Tema oscuro por defecto, que es donde se va a usar.

## Implementacion

Vite + React, estatico, y **CSS plano con custom properties en vez de Tailwind**.

Son trece pantallas densas de tabla con un sistema de tokens estricto:
`<td className="num">` es mas legible y mas consistente que repetir
`text-right font-mono tabular-nums` por todas partes, y hace que anadir o
quitar una seccion sea tocar una capa semantica pequena en vez de perseguir
clases sueltas por trece pantallas. De paso evita PostCSS y una dependencia.

Sin libreria de estado: un store de cuarenta lineas cubre la suscripcion en
vivo y las cargas puntuales. lightweight-charts entrara cuando haya graficos
(secciones 9 y 11), no antes.

Los tokens de color, espaciado y tipografia se definen **una vez** en CSS y no
se repiten valores sueltos en los componentes. Si un componente necesita un
color que no esta en los tokens, casi siempre es que el diseno esta mal, no que
falte un token.

### Paneles de Traders

Traders y Assets a todo el ancho; el resto en dos columnas en escritorio.
Separacion generosa entre paneles (32 px). Cada panel es un solo recuadro:
sin tablas, cabeceras tabulares ni bandas de controles con caja dentro.
Titulo, acciones y contenido comparten la misma superficie. Esta preferencia
es especifica de Traders y prevalece sobre la preferencia general por tablas.
