/**
 * Sincronización con el repo.
 *
 * Asimétrica a propósito:
 *   - LEER no necesita nada. Los ficheros se publican en el propio sitio, así
 *     que basta un fetch relativo: quien abra la web ve las bibliotecas al
 *     instante, sin token, sin CORS y sin límites de peticiones.
 *   - ESCRIBIR necesita el token de quien publica, y cada persona toca
 *     únicamente su propio fichero. Por eso no hay conflictos que resolver.
 */

import * as db from './db.js';
import * as gh from './github.js';
import { paths, slug } from './config.js';

const OWNER_KEY = 'my-library:syncProfile';

/** Perfil que este navegador publica. Los demás son de solo lectura aquí. */
export function ownerProfile() {
  try { return localStorage.getItem(OWNER_KEY) || ''; } catch { return ''; }
}

export function setOwnerProfile(name) {
  try {
    if (name) localStorage.setItem(OWNER_KEY, name);
    else localStorage.removeItem(OWNER_KEY);
  } catch { /* sin localStorage no hay publicación */ }
}

export function canPublish() {
  return gh.hasToken() && Boolean(ownerProfile());
}

/* -------------------------------------------------------------------- pull */

/**
 * Descarga lo publicado y lo funde con lo local.
 *
 * Las bibliotecas ajenas se reemplazan enteras (su dueño manda). La propia se
 * funde por fecha de modificación, que es lo que permite editar desde el móvil
 * y el portátil sin pisarte, y recuperar todo si se limpia el navegador.
 */
export async function pull() {
  const index = await fetchJson(paths.index);
  if (!index) return { profiles: [], added: 0, updated: 0 };

  const mine = ownerProfile();
  const local = await db.listAllBooks();
  const localById = new Map(local.map((book) => [book.id, book]));

  const toStore = [];
  const toDelete = [];
  let added = 0;
  let updated = 0;

  for (const name of index.profiles || []) {
    const payload = await fetchJson(paths.profile(name));
    if (!payload) continue;

    const remote = (payload.books || []).map((book) => ({ ...book, profile: name }));
    const remoteIds = new Set(remote.map((book) => book.id));

    for (const book of remote) {
      const current = localById.get(book.id);
      if (!current) { toStore.push(book); added += 1; continue; }
      // En mi biblioteca gana la versión más reciente; en la ajena, siempre la suya.
      const remoteWins = name !== mine || (book.updatedAt || '') > (current.updatedAt || '');
      if (remoteWins) { toStore.push(book); updated += 1; }
    }

    if (name !== mine) {
      // Lo que su dueño ha borrado, aquí también desaparece.
      local.filter((book) => book.profile === name && !remoteIds.has(book.id))
        .forEach((book) => toDelete.push(book.id));
    }
  }

  if (toStore.length) await db.putBooks(toStore);
  for (const id of toDelete) await db.deleteBook(id);

  return { profiles: index.profiles || [], added, updated, deleted: toDelete.length };
}

/** Los ficheros publicados van al lado del index.html, de ahí la ruta relativa. */
async function fetchJson(path) {
  try {
    // El parámetro rompe la caché del CDN de Pages, que si no sirve copias viejas.
    const response = await fetch(`${path}?v=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null; // sin conexión: se sigue con lo que haya en local
  }
}

/* -------------------------------------------------------------------- push */

/**
 * Publica la biblioteca del perfil propietario en un único commit:
 * su JSON, las portadas que aún no estén subidas y el índice de perfiles.
 */
export async function push({ profiles } = {}) {
  const mine = ownerProfile();
  if (!mine) throw new Error('Elige primero qué perfil publica este dispositivo.');

  const books = await db.listBooks(mine);
  const existing = await gh.listPaths();
  const files = [];

  // 1. Portadas que faltan en el repo. Se suben una vez y ya se quedan.
  const wanted = new Set();
  for (const book of books) {
    if (!book.hasCover) continue;
    const blob = await db.getCover(book.id);
    if (!blob) continue;
    const path = paths.cover(book.id, blob.type);
    wanted.add(path);
    book.coverPath = path;
    if (!existing.has(path)) files.push({ path, blob });
  }

  // 2. Portadas de libros ya borrados: se quitan para no dejar basura.
  for (const path of existing) {
    if (path.startsWith(`${paths.coversDir}/`) && !wanted.has(path)) {
      files.push({ path, delete: true });
    }
  }

  // 3. La biblioteca en sí.
  const payload = {
    format: 'my-library',
    version: 1,
    profile: mine,
    updatedAt: new Date().toISOString(),
    books: books.map(stripLocalFields),
  };
  files.push({ path: paths.profile(mine), text: JSON.stringify(payload, null, 2) });

  // 4. Índice, para que la web sepa qué ficheros pedir sin adivinar nombres.
  const known = await fetchJson(paths.index);
  const merged = Array.from(new Set([...(known?.profiles || []), ...(profiles || []), mine]));
  files.push({ path: paths.index, text: JSON.stringify({ profiles: merged }, null, 2) });

  const sha = await gh.commitFiles(files, `Biblioteca de ${mine}: ${books.length} libros`);

  // Se guarda dónde quedó cada portada para poder pintarla desde el repo si
  // algún día este navegador pierde los blobs locales.
  await db.putBooks(books);
  await db.setSetting('lastPush', new Date().toISOString());

  return { sha, books: books.length, covers: files.filter((f) => f.blob).length, profiles: merged };
}

/** El estado local no viaja al repo: no le sirve a nadie más. */
function stripLocalFields(book) {
  const { hasCover, profile, ...rest } = book;
  void hasCover; void profile;
  return rest;
}

/* ------------------------------------------------------------------ estado */

export async function lastPush() {
  return db.getSetting('lastPush', null);
}

export { slug };
