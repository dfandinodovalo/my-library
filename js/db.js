/**
 * Persistencia sobre IndexedDB.
 *
 * Se usa IndexedDB y no localStorage porque las portadas se guardan como Blob:
 * localStorage solo admite texto (habria que pasarlas a base64, +33% de tamano)
 * y tiene un tope de ~5MB, que con 50 libros ya se agota.
 *
 * Las portadas van en su propio store para poder listar la biblioteca entera
 * sin arrastrar megas de imagenes en cada consulta.
 */

const DB_NAME = 'my-library';
const DB_VERSION = 1;
const BOOKS = 'books';
const COVERS = 'covers';
const SETTINGS = 'settings';

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(BOOKS)) {
        const books = db.createObjectStore(BOOKS, { keyPath: 'id' });
        books.createIndex('profile', 'profile');
      }
      if (!db.objectStoreNames.contains(COVERS)) {
        db.createObjectStore(COVERS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(SETTINGS)) {
        db.createObjectStore(SETTINGS, { keyPath: 'key' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Hay otra pestana abierta con una version distinta. Cierrala y recarga.'));
  });

  return dbPromise;
}

/**
 * Ejecuta una escritura y resuelve cuando la transaccion se confirma de verdad,
 * no cuando la peticion individual responde: si no se espera al commit se puede
 * recargar la pagina con los datos aun sin escribir en disco.
 */
function write(storeNames, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaccion cancelada'));
    try {
      fn(tx);
    } catch (error) {
      tx.abort();
      reject(error);
    }
  }));
}

function await_(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/* ------------------------------------------------------------------ libros */

export async function listBooks(profile) {
  const db = await open();
  const tx = db.transaction(BOOKS, 'readonly');
  const index = tx.objectStore(BOOKS).index('profile');
  return await_(index.getAll(profile));
}

export async function listAllBooks() {
  const db = await open();
  return await_(db.transaction(BOOKS, 'readonly').objectStore(BOOKS).getAll());
}

export function putBook(book) {
  return write(BOOKS, (tx) => tx.objectStore(BOOKS).put(book));
}

export function putBooks(books) {
  return write(BOOKS, (tx) => {
    const store = tx.objectStore(BOOKS);
    books.forEach((book) => store.put(book));
  });
}

export function deleteBook(id) {
  return write([BOOKS, COVERS], (tx) => {
    tx.objectStore(BOOKS).delete(id);
    tx.objectStore(COVERS).delete(id);
  });
}

/* --------------------------------------------------------------- portadas */

export async function getCover(id) {
  const db = await open();
  const record = await await_(db.transaction(COVERS, 'readonly').objectStore(COVERS).get(id));
  return record?.blob || null;
}

export function putCover(id, blob) {
  return write(COVERS, (tx) => tx.objectStore(COVERS).put({ id, blob }));
}

/* ------------------------------------------------------------ preferencias */

export async function getSetting(key, fallback = null) {
  const db = await open();
  const record = await await_(db.transaction(SETTINGS, 'readonly').objectStore(SETTINGS).get(key));
  return record === undefined ? fallback : record.value;
}

export function setSetting(key, value) {
  return write(SETTINGS, (tx) => tx.objectStore(SETTINGS).put({ key, value }));
}

/* ------------------------------------------------------------------ cuota */

export async function storageEstimate() {
  if (!navigator.storage?.estimate) return null;
  const { usage, quota } = await navigator.storage.estimate();
  return { usage, quota };
}
