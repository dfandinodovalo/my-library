# 📚 Mi biblioteca

Catálogo personal de libros leídos. Sueltas los `.epub` en la ventana y la web
saca de cada uno el título, el autor, la editorial, el ISBN, la saga y **la
portada**. A partir de ahí puntúas, escribes tu reseña y filtras.

Sitio estático puro: HTML, CSS y JavaScript. **Sin dependencias, sin build, sin
CDN y sin backend.** Lo que está en el repo es exactamente lo que se sirve.

## Cómo funciona

Un EPUB es un ZIP con un `.opf` dentro que describe el libro. La web:

1. Lee el índice del ZIP a mano y descomprime con `DecompressionStream`, que ya
   viene en el navegador (por eso no hace falta JSZip ni ninguna otra librería).
2. Sigue `META-INF/container.xml` → `.opf` para leer los metadatos.
3. Busca la portada probando cinco estrategias en orden, porque EPUB 2 y EPUB 3
   la declaran distinto y algunos generadores no la declaran: `properties="cover-image"`,
   `<meta name="cover">`, convención de nombre, la `<img>` de la página de cubierta
   del `<guide>` y, como último recurso, la primera imagen del manifiesto.
4. Reescala la portada a 600px de ancho antes de guardarla (de ~2 MB a ~50 KB).

## Dónde viven los datos

En dos sitios, y la distinción importa:

- **IndexedDB del navegador** es la copia de trabajo. Todo va rápido y funciona
  sin conexión.
- **El propio repo** es el almacén compartido, en `data/`: un JSON por persona
  y las portadas en `data/covers/`.

### Sincronización

Es asimétrica a propósito:

| | Necesita token | Por qué |
|---|---|---|
| **Leer** las bibliotecas | No | Los ficheros se publican en el mismo sitio, así que basta un `fetch` relativo. Quien abra la web ve las bibliotecas al instante, sin configurar nada. |
| **Publicar** la tuya | Sí | Escribe en el repo vía la API de GitHub. |

Cada persona publica **solo su propio fichero**, así que no hay conflictos que
resolver: nadie escribe donde escribe otro. Un lote de cambios se sube en un
único commit (Git Data API: blobs → tree → commit → ref), no uno por fichero.

Configúralo en `⋯ → Sincronización con GitHub`. El token es *fine-grained*,
limitado a este repo, con `Contents: Read and write` y nada más. Se guarda solo
en el `localStorage` de tu navegador: **nunca se sube al repo**.

Al mirar la biblioteca de otra persona, sus fichas son de **solo lectura** — si
las editaras, su dispositivo las sobrescribiría en la siguiente sincronización.

> Los cambios del otro tardan hasta unos minutos en verse: GitHub Pages tiene
> que redesplegar y su CDN cachea. Para un registro de libros leídos, irrelevante.

### Copias de seguridad

Aparte de la sincronización, `⋯ → Exportar copia de seguridad` baja un único
`.json` con los libros y las portadas incrustadas en base64. Restaurar es
idempotente: reimportar el mismo fichero actualiza, no duplica. Útil para migrar
entre navegadores sin pasar por el repo.

### Perfiles

Al entrar aparece un selector estilo Netflix con un avatar por persona y su
número de libros. Cada perfil tiene su estantería independiente, para que dos
personas compartan la misma web sin mezclar lecturas ni notas.

La elección se guarda en `localStorage`, así que **el selector solo sale la
primera vez** en cada dispositivo: después se entra directo. Para cambiar, pulsa
tu avatar en la barra superior (o `⋯ → Cambiar de perfil`).

En `⋯ → Gestionar perfiles` se añaden, se renombran (los libros se mueven con el
perfil) y se borran los que estén vacíos. Los avatares son de color e iniciales
generados a partir del nombre, así que no hay imágenes que mantener en el repo.

## Publicar en GitHub Pages

```bash
cd my-library
git init -b main
git add .
git commit -m "Mi biblioteca"
git remote add origin git@github.com:<tu-usuario>/my-library.git
git push -u origin main
```

Después, en GitHub: **Settings → Pages → Source: Deploy from a branch → `main` / `/ (root)`**.
En un minuto está en `https://<tu-usuario>.github.io/my-library/`.

No hace falta workflow de Actions ni `.nojekyll`: no hay build ni carpetas que
empiecen por guión bajo.

## Instalarla como app

Al abrirla en el móvil puedes añadirla a la pantalla de inicio y se comporta como
una app: icono propio, sin barra de navegador y **abre sin conexión**.

- **iPhone (Safari)**: Compartir → *Añadir a pantalla de inicio*.
- **Android (Chrome)**: menú del navegador → *Instalar aplicación*.

En iOS esto no es un capricho estético: Safari **borra el almacenamiento de una web
tras 7 días sin visitarla**, y ahí es donde viven tus libros. Instalada en la pantalla
de inicio queda exenta de ese borrado. Si usas la app en el móvil, instálala.

La app pide además almacenamiento persistente por su cuenta después de que añadas
tu primer libro. Puedes comprobar el estado en `⋯ → Espacio usado`.

### Al publicar una versión nueva

`sw.js` guarda una copia de la app para poder abrirla sin conexión, y esa copia se
identifica por una constante:

```js
const VERSION = 'v1';
```

**Si tocas `index.html`, el CSS o cualquier módulo de `js/`, sube ese número** (`v2`,
`v3`…) antes de hacer push. Si no lo haces, los dispositivos que ya tengan la app
seguirán sirviendo la copia guardada y no verán tus cambios. No hay proceso de
compilación que lo automatice, así que toca acordarse.

Los ficheros de `data/` no se cachean nunca, así que publicar libros desde la app
no requiere tocar nada de esto.

## Desarrollo local

Los módulos ES no funcionan abriendo `index.html` con doble clic (`file://` los
bloquea por CORS). Necesitas un servidor:

```bash
python3 -m http.server 4173
# http://localhost:4173
```

## Atajos y detalles

- `/` enfoca el buscador.
- La búsqueda ignora tildes: `cronica` encuentra `Crónica`.
- Media estrella: pulsa en la mitad izquierda de una estrella. Pulsar la misma
  nota otra vez la borra.
- Al marcar un libro como *Leído* se propone la fecha de hoy.
- Al importar, se detectan duplicados por ISBN (o por título + autor si no hay).
- Se puede añadir un libro a mano y ponerle una portada desde un fichero de
  imagen, para lo que no tengas en EPUB.

## Estructura

```
index.html
css/styles.css
js/zip.js       Lector de ZIP sobre DecompressionStream
js/epub.js      Metadatos y portada del EPUB
js/db.js        IndexedDB (libros, portadas, preferencias)
js/library.js   Modelo, importación, filtros, estadísticas, backup
js/config.js    Dónde está el repo que hace de almacén
js/github.js    Cliente de la API de GitHub (commits atómicos)
js/sync.js      Publicar la propia biblioteca y traer las demás
js/app.js       Interfaz
sw.js           Service worker: abre sin conexión
manifest.webmanifest  Metadatos para instalarla como app
icons/          Logo (icon.svg) y los PNG derivados
tools/          generar-iconos.sh, solo si cambia el logo
data/           Lo publicado: un JSON por persona + portadas
```

Los iconos se generan del SVG con `./tools/generar-iconos.sh`, que usa Chrome en
modo headless como rasterizador para no arrastrar dependencias. Solo hay que
volver a lanzarlo si cambia `icons/icon.svg`.

## Marca

Sigue la guía gráfica. Los colores no son decorativos: cada uno tiene un cometido
y no se usa fuera de él.

| Color | | Para qué |
|---|---|---|
| Tinta | `#123A33` | Fondos y texto |
| Coral | `#D85A30` | Acción (el botón de añadir) y estado *leyendo* |
| Ámbar | `#EF9F27` | Reseñas y puntuaciones, y estado *pendiente* |
| Verde | `#0F6E56` | Confirmar (guardar) y estado *leído* |
| Crema | `#F5EFE3` | Fondo de la app en tema claro |

Tipografía: SF Pro, con Inter como alternativa y la del sistema como respaldo.
No se carga ninguna webfont, así que se resuelve con la pila del sistema.
Títulos a peso 500, cuerpo a 400, y **siempre en frase, nunca en Mayúsculas
Iniciales ni versalitas**.

Los cinco colores están en `css/styles.css` como `--tinta`, `--coral`, `--ambar`,
`--verde` y `--crema`; el resto de variables derivan de ellos, así que un cambio
de marca se hace en un solo sitio.

## Compatibilidad

Necesita `DecompressionStream`: Chrome 103+, Firefox 113+, Safari 16.4+. Si el
navegador no lo soporta, la web avisa en lugar de fallar en silencio.
