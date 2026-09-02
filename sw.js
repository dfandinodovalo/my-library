/**
 * Service worker de Mi biblioteca.
 *
 * Su trabajo es que la app abra sin conexión, no acelerar nada. Por eso el
 * criterio de diseño es conservador: ante la duda, red antes que caché. El
 * fallo que hay que evitar aquí no es que vaya lento, es que alguien se quede
 * mirando una versión vieja de la app o, peor, libros desactualizados.
 *
 * IMPORTANTE: al tocar cualquier fichero del "app shell" hay que subir VERSION,
 * o los dispositivos seguirán sirviendo la copia guardada. Es el precio de no
 * tener proceso de compilación que genere el hash automáticamente.
 */

const VERSION = 'v9';
const SHELL_CACHE = `biblioteca-shell-${VERSION}`;
// Las portadas sobreviven a los cambios de versión: su nombre es el id del
// libro y no cambian nunca, así que volver a bajarlas sería tirar datos.
const COVERS_CACHE = 'biblioteca-portadas';

/**
 * El shell son los ficheros que forman la aplicación. Rutas relativas porque
 * la app vive en un subdirectorio (/my-library/), no en la raíz del dominio.
 */
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  // Solo los dos iconos que carga la propia página: los maskable y el de iOS
  // los usa el sistema operativo, no el documento, y meterlos aquí solo daría
  // más ocasiones de que fallara la instalación.
  './icons/icon.svg',
  './icons/icon-192.png',
  './js/app.js',
  './js/library.js',
  './js/db.js',
  './js/sync.js',
  './js/config.js',
  './js/github.js',
  './js/epub.js',
  './js/zip.js',
];

/* ------------------------------------------------------------- instalación */

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);

    // `cache.addAll()` usaría la caché HTTP del navegador, y como Pages sirve
    // todo con max-age=600, un service worker recién instalado podría guardar
    // ficheros de hace diez minutos y congelar esa versión vieja durante toda
    // la vida de VERSION. Con cache:'reload' se piden siempre frescos.
    const respuestas = await Promise.all(
      SHELL.map((ruta) => fetch(new Request(ruta, { cache: 'reload' }))));

    // Si falta uno solo, se aborta: más vale seguir con la versión anterior,
    // que funciona, que activar una caché a medias y servir una app rota.
    if (respuestas.some((r) => !r.ok)) {
      throw new Error('Precarga incompleta: no se activa esta versión');
    }
    await Promise.all(respuestas.map((r, i) => cache.put(SHELL[i], r)));

    // Sin esto el service worker nuevo esperaría a que se cierren todas las
    // pestañas y una versión nueva podría tardar días en llegar. Es seguro
    // aquí porque los módulos ES se cargan todos al arrancar: la página abierta
    // no va a pedir código nuevo a mitad de sesión.
    await self.skipWaiting();
  })());
});

/* -------------------------------------------------------------- activación */

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Fuera los shells de versiones anteriores, o el almacenamiento crecería
    // sin límite a cada despliegue. Se filtra por el prefijo del shell, no por
    // "biblioteca-": la caché de portadas no lleva versión y debe sobrevivir.
    const nombres = await caches.keys();
    await Promise.all(nombres
      .filter((n) => n.startsWith('biblioteca-shell-') && n !== SHELL_CACHE)
      .map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

/* ----------------------------------------------------------------- fetch */

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Solo se toca lo propio y solo lecturas. Así api.github.com (las escrituras
  // de la sincronización) y las portadas de terceros quedan fuera sin necesidad
  // de una regla especial, que es justo lo que interesa: nada de cachear
  // llamadas a una API de escritura.
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  const ruta = url.pathname;

  /**
   * Las bibliotecas publicadas NO pasan por caché. Ni se leen, ni se guardan.
   *
   * Son los datos reales de las personas que usan esto, y servir una copia
   * vieja es el peor fallo que podría tener esta app. No hace falta cachearlas
   * para funcionar sin conexión: los libros ya están en IndexedDB, y fetchJson()
   * en sync.js devuelve null cuando falla la red, con lo que la app sigue con
   * lo local sin enterarse.
   *
   * Además sync.js les añade ?v=<timestamp> distinto en cada llamada para
   * saltarse el CDN de Pages. Al ser cada URL única, cachearlas iría creando
   * entradas nuevas sin reutilizar ninguna, hasta agotar la cuota y provocar
   * que el navegador desaloje el origen entero, IndexedDB incluida. O sea:
   * justo la pérdida de datos que esta PWA existe para evitar.
   */
  if (ruta.includes('/data/') && ruta.endsWith('.json')) return;

  if (ruta.includes('/data/covers/')) {
    event.respondWith(portada(event));
  } else {
    event.respondWith(shell(request));
  }
});

/**
 * Portadas: se sirven al instante de la caché y se refrescan por detrás. Pesan
 * y su nombre es el id del libro, así que rara vez cambian; pero si alguien
 * sustituye una, la siguiente visita ya la tendrá.
 *
 * El refresco va dentro de event.waitUntil() y no suelto: en cuanto se devuelve
 * la copia guardada, el navegador da por terminado el trabajo del service
 * worker y puede pararlo, abortando cualquier petición que siguiera en vuelo.
 * Eso aparecía en la pestaña de red como un reguero de net::ERR_FAILED y, lo
 * que es peor, dejaba portadas a medio guardar.
 */
async function portada(event) {
  const { request } = event;
  const cache = await caches.open(COVERS_CACHE);
  const guardada = await cache.match(request);

  if (guardada) {
    event.waitUntil(refrescar(cache, request));
    return guardada;
  }

  try {
    const respuesta = await fetch(request);
    if (respuesta.ok) event.waitUntil(cache.put(request, respuesta.clone()));
    return respuesta;
  } catch {
    // Sin red y sin copia guardada: la interfaz ya enseña el diseño de
    // repuesto con el título, así que basta con no reventar.
    return new Response('', { status: 504, statusText: 'Sin conexión' });
  }
}

async function refrescar(cache, request) {
  try {
    const respuesta = await fetch(request);
    if (respuesta.ok) await cache.put(request, respuesta);
  } catch { /* ya se sirvió la copia guardada; el refresco es opcional */ }
}

/** Shell: de la caché, que para eso se precargó; si no está, a la red. */
async function shell(request) {
  const guardada = await caches.match(request);
  if (guardada) return guardada;

  try {
    return await fetch(request);
  } catch {
    // Una navegación sin red y sin coincidencia exacta (por ejemplo con
    // parámetros en la URL) se resuelve con el index, que es la app entera.
    if (request.mode === 'navigate') {
      const inicio = await caches.match('./index.html');
      if (inicio) return inicio;
    }
    return new Response('', { status: 504, statusText: 'Sin conexión' });
  }
}
