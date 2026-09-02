/**
 * Logica de biblioteca: modelo de libro, importacion de EPUBs, filtrado,
 * estadisticas y copias de seguridad. Todo lo que no es pintar la interfaz.
 */

import { parseEpub } from './epub.js';
import * as db from './db.js';

export const STATUSES = {
  read: { label: 'Leído', plural: 'Leídos', icon: '✓' },
  reading: { label: 'Leyendo', plural: 'Leyendo ahora', icon: '▶' },
  pending: { label: 'Pendiente', plural: 'Pendientes', icon: '◷' },
  abandoned: { label: 'Abandonado', plural: 'Abandonados', icon: '✕' },
};

/**
 * Orden de los grupos en la vista por estado: primero lo que se está leyendo,
 * que es lo que se consulta a diario, y al final lo abandonado.
 */
export const GROUP_ORDER = ['reading', 'read', 'pending', 'abandoned'];

export function newId() {
  return (crypto.randomUUID?.() ?? `b-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

export function emptyBook(profile) {
  const now = new Date().toISOString();
  return {
    id: newId(),
    profile,
    title: '',
    authors: [],
    series: '',
    seriesIndex: null,
    publisher: '',
    language: '',
    description: '',
    subjects: [],
    isbn: '',
    year: null,
    fileName: '',
    fileSize: 0,
    hasCover: false,
    // Pendiente, no leído: subir el EPUB solo dice que tienes el libro, no que
    // te lo hayas terminado. Darlo por leído obligaría a corregir a mano cada
    // importación, y falsearía las estadísticas mientras no lo hicieras.
    status: 'pending',
    rating: 0,
    review: '',
    startedAt: '',
    finishedAt: '',
    favorite: false,
    addedAt: now,
    updatedAt: now,
  };
}

/* -------------------------------------------------------------- importacion */

/**
 * Importa una lista de ficheros EPUB al perfil indicado.
 * `onProgress(done, total, label)` se llama tras cada fichero para que la UI
 * pueda ir informando; los fallos no abortan el lote, se acumulan y se devuelven.
 */
export async function importEpubs(files, profile, existingBooks, onProgress) {
  const seen = new Set(existingBooks.map(fingerprint));
  const added = [];
  const skipped = [];
  const failed = [];

  let done = 0;
  for (const file of files) {
    try {
      const meta = await parseEpub(file);
      const book = {
        ...emptyBook(profile),
        title: meta.title,
        authors: meta.authors,
        series: meta.series,
        seriesIndex: meta.seriesIndex,
        publisher: meta.publisher,
        language: meta.language,
        description: meta.description,
        subjects: meta.subjects,
        isbn: meta.isbn,
        year: meta.year,
        fileName: meta.fileName,
        fileSize: meta.fileSize,
        hasCover: Boolean(meta.cover),
      };

      const key = fingerprint(book);
      if (seen.has(key)) {
        skipped.push(book.title);
      } else {
        seen.add(key);
        if (meta.cover) await db.putCover(book.id, meta.cover);
        await db.putBook(book);
        added.push(book);
      }
    } catch (error) {
      failed.push({ name: file.name, message: error.message });
    }
    onProgress?.(++done, files.length, file.name);
  }

  return { added, skipped, failed };
}

/**
 * Identidad "logica" de un libro para no importar dos veces el mismo EPUB.
 * El ISBN manda cuando existe; si no, titulo + primer autor normalizados.
 */
function fingerprint(book) {
  if (book.isbn) return `isbn:${book.isbn}`;
  return `ta:${normalize(book.title)}|${normalize(book.authors[0] || '')}`;
}

function normalize(text) {
  return (text || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // busca "cronica" y encuentra "Crónica"
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/* ----------------------------------------------------------------- filtrado */

export const SORTS = {
  added: { label: 'Añadido recientemente', compare: (a, b) => b.addedAt.localeCompare(a.addedAt) },
  finished: { label: 'Terminado recientemente', compare: (a, b) => (b.finishedAt || '').localeCompare(a.finishedAt || '') },
  rating: { label: 'Mejor puntuados', compare: (a, b) => b.rating - a.rating || a.title.localeCompare(b.title) },
  title: { label: 'Título (A-Z)', compare: (a, b) => a.title.localeCompare(b.title, 'es') },
  author: { label: 'Autor (A-Z)', compare: (a, b) => (a.authors[0] || 'zzz').localeCompare(b.authors[0] || 'zzz', 'es') },
  year: { label: 'Año de publicación', compare: (a, b) => (b.year || 0) - (a.year || 0) },
};

export function applyFilters(books, { search = '', status = '', minRating = 0, year = '', sort = 'added' } = {}) {
  const needle = normalize(search);

  const filtered = books.filter((book) => {
    if (status && book.status !== status) return false;
    if (minRating && book.rating < minRating) return false;
    if (year && String(readYear(book)) !== String(year)) return false;
    if (!needle) return true;
    const haystack = normalize([
      book.title, book.series, book.publisher, book.review,
      ...book.authors, ...book.subjects,
    ].join(' '));
    return needle.split(' ').every((word) => haystack.includes(word));
  });

  return filtered.sort(SORTS[sort]?.compare ?? SORTS.added.compare);
}

/** Año en que se termino el libro, que es el que interesa para "leidos en 2026". */
export function readYear(book) {
  return book.finishedAt ? Number(book.finishedAt.slice(0, 4)) : null;
}

export function readYears(books) {
  const years = new Set(books.map(readYear).filter(Boolean));
  return Array.from(years).sort((a, b) => b - a);
}

/* ------------------------------------------------------------ estadisticas */

export function computeStats(books) {
  const read = books.filter((book) => book.status === 'read');
  const rated = books.filter((book) => book.rating > 0);
  const thisYear = new Date().getFullYear();

  return {
    total: books.length,
    read: read.length,
    reading: books.filter((book) => book.status === 'reading').length,
    pending: books.filter((book) => book.status === 'pending').length,
    thisYear: read.filter((book) => readYear(book) === thisYear).length,
    average: rated.length ? rated.reduce((sum, book) => sum + book.rating, 0) / rated.length : 0,
    favorites: books.filter((book) => book.favorite).length,
  };
}

/* ------------------------------------------------------------------ backup */

/**
 * Exporta libros + portadas a un unico JSON autocontenido.
 * Las portadas van en base64: infla el fichero un 33% pero permite restaurar
 * la biblioteca entera con un solo fichero, sin ZIP ni carpetas sueltas.
 */
export async function exportBackup(books) {
  const covers = {};
  for (const book of books.filter((b) => b.hasCover)) {
    const blob = await db.getCover(book.id);
    if (blob) covers[book.id] = await blobToDataUrl(blob);
  }

  return {
    format: 'my-library',
    version: 1,
    exportedAt: new Date().toISOString(),
    books,
    covers,
  };
}

/**
 * Restaura un backup. Los libros que ya existen (mismo id) se sobrescriben,
 * asi que reimportar el mismo fichero es idempotente en vez de duplicar todo.
 */
export async function importBackup(payload, targetProfile) {
  if (payload?.format !== 'my-library' || !Array.isArray(payload.books)) {
    throw new Error('El fichero no es una copia de seguridad de Mi biblioteca.');
  }

  const books = payload.books.map((book) => ({
    ...emptyBook(targetProfile || book.profile),
    ...book,
    profile: targetProfile || book.profile,
  }));

  await db.putBooks(books);

  for (const book of books) {
    const dataUrl = payload.covers?.[book.id];
    if (dataUrl) await db.putCover(book.id, await dataUrlToBlob(dataUrl));
  }

  return books.length;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function dataUrlToBlob(dataUrl) {
  return (await fetch(dataUrl)).blob();
}
