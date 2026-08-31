/**
 * Extraccion de metadatos y portada de un fichero EPUB.
 *
 * Ruta que sigue el estandar:
 *   META-INF/container.xml  ->  ruta del .opf
 *   .opf                    ->  <metadata> (titulo, autor...) y <manifest> (ficheros)
 *
 * La portada es la parte tramposa: EPUB 2 y EPUB 3 la declaran de formas
 * distintas y hay generadores que no la declaran en absoluto, asi que probamos
 * cinco estrategias en orden de fiabilidad.
 */

import { openZip } from './zip.js';

const IMAGE_TYPES = /^image\//;

export async function parseEpub(file) {
  const zip = await openZip(file);

  const containerXml = await zip.text('META-INF/container.xml');
  const container = parseXml(containerXml);
  const rootfile = tags(container, 'rootfile')[0];
  const opfPath = rootfile?.getAttribute('full-path');
  if (!opfPath) throw new Error('El EPUB no declara su fichero OPF.');

  const opf = parseXml(await zip.text(opfPath));
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';

  const metadata = readMetadata(opf);
  const manifest = readManifest(opf, opfDir);
  const cover = await extractCover(zip, opf, manifest, opfDir);

  return { ...metadata, cover, fileName: file.name, fileSize: file.size };
}

/* ---------------------------------------------------------------- metadatos */

function readMetadata(opf) {
  const text = (name) => tags(opf, name)[0]?.textContent?.trim() || '';

  const authors = tags(opf, 'creator')
    .map((el) => el.textContent.trim())
    .filter(Boolean);

  const identifiers = tags(opf, 'identifier').map((el) => el.textContent.trim());
  const isbn = identifiers
    .map((id) => id.replace(/^urn:isbn:/i, '').replace(/[\s-]/g, ''))
    .find((id) => /^\d{9}[\dxX]$|^\d{13}$/.test(id)) || '';

  const metas = tags(opf, 'meta');
  const legacyMeta = (name) =>
    metas.find((m) => m.getAttribute('name') === name)?.getAttribute('content')?.trim() || '';
  const propMeta = (property) =>
    metas.find((m) => m.getAttribute('property') === property)?.textContent?.trim() || '';

  const series = legacyMeta('calibre:series') || propMeta('belongs-to-collection');
  const seriesIndexRaw = legacyMeta('calibre:series_index') || propMeta('group-position');

  const published = text('date') || propMeta('dcterms:modified');

  return {
    title: text('title') || '(sin titulo)',
    authors: dedupe(authors),
    publisher: text('publisher'),
    language: text('language'),
    description: stripHtml(text('description')),
    subjects: dedupe(tags(opf, 'subject').map((el) => el.textContent.trim()).filter(Boolean)),
    isbn,
    series,
    seriesIndex: seriesIndexRaw ? Number(seriesIndexRaw) || null : null,
    year: published ? Number(published.slice(0, 4)) || null : null,
  };
}

function readManifest(opf, opfDir) {
  const items = new Map();
  for (const item of tags(opf, 'item')) {
    const id = item.getAttribute('id');
    const href = item.getAttribute('href');
    if (!id || !href) continue;
    items.set(id, {
      id,
      path: resolvePath(opfDir, href),
      type: item.getAttribute('media-type') || '',
      properties: item.getAttribute('properties') || '',
    });
  }
  return items;
}

/* ----------------------------------------------------------------- portada */

async function extractCover(zip, opf, manifest, opfDir) {
  const candidates = [];
  const items = Array.from(manifest.values());

  // 1. EPUB 3: el item lleva properties="cover-image". Es la via canonica.
  candidates.push(items.find((i) => i.properties.split(/\s+/).includes('cover-image')));

  // 2. EPUB 2: <meta name="cover" content="id-del-item">.
  const coverId = tags(opf, 'meta')
    .find((m) => m.getAttribute('name')?.toLowerCase() === 'cover')
    ?.getAttribute('content');
  if (coverId) candidates.push(manifest.get(coverId));

  // 3. Convencion de nombres: id o ruta que contenga "cover"/"portada".
  candidates.push(items.find((i) =>
    IMAGE_TYPES.test(i.type) && /cover|portada/i.test(i.id + ' ' + i.path)));

  // 4. <guide><reference type="cover" href="cover.xhtml"> -> la <img> de dentro.
  const guideHref = tags(opf, 'reference')
    .find((r) => /cover/i.test(r.getAttribute('type') || ''))
    ?.getAttribute('href');
  if (guideHref) {
    const page = resolvePath(opfDir, guideHref);
    const imgPath = await imageInsidePage(zip, page);
    if (imgPath) candidates.push(items.find((i) => i.path === imgPath) || { path: imgPath, type: guessType(imgPath) });
  }

  // 5. Ultimo recurso: la primera imagen de la spine, que suele ser la cubierta.
  candidates.push(items.find((i) => IMAGE_TYPES.test(i.type)));

  for (const candidate of candidates) {
    if (!candidate || !zip.has(candidate.path)) continue;
    const type = IMAGE_TYPES.test(candidate.type) ? candidate.type : guessType(candidate.path);
    if (!IMAGE_TYPES.test(type)) continue;
    try {
      const raw = await zip.blob(candidate.path, type);
      return await downscale(raw);
    } catch {
      // Imagen corrupta o formato que el navegador no decodifica: siguiente.
    }
  }
  return null;
}

/** Busca la primera imagen referenciada dentro de una pagina XHTML de cubierta. */
async function imageInsidePage(zip, pagePath) {
  if (!zip.has(pagePath)) return null;
  try {
    const doc = parseXml(await zip.text(pagePath), 'text/html');
    const src = doc.querySelector('img')?.getAttribute('src')
      || doc.querySelector('image')?.getAttribute('xlink:href')
      || doc.querySelector('image')?.getAttribute('href');
    if (!src) return null;
    const dir = pagePath.includes('/') ? pagePath.slice(0, pagePath.lastIndexOf('/')) : '';
    return resolvePath(dir, src);
  } catch {
    return null;
  }
}

/**
 * Las portadas de los EPUB vienen a menudo a 1600px y pesan varios MB. Como en
 * la rejilla se ven a ~200px, las reescalamos antes de guardarlas: pasamos de
 * ~2MB a ~50KB por libro, que es la diferencia entre que IndexedDB vuele o se
 * arrastre cuando tengas 300 libros.
 */
const COVER_MAX_WIDTH = 600;

async function downscale(blob) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    return blob; // SVG u otro formato no decodificable: lo guardamos tal cual.
  }

  const scale = Math.min(1, COVER_MAX_WIDTH / bitmap.width);
  if (scale === 1 && blob.size < 120_000) {
    bitmap.close();
    return blob;
  }

  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const resized = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
  return resized && resized.size < blob.size ? resized : blob;
}

/* ----------------------------------------------------------------- helpers */

function parseXml(source, type = 'application/xml') {
  const doc = new DOMParser().parseFromString(source, type);
  if (doc.querySelector('parsererror')) throw new Error('XML del EPUB mal formado.');
  return doc;
}

/**
 * Busca por nombre local ignorando el prefijo de namespace: los OPF mezclan
 * `dc:title`, `title` y `opf:meta` segun quien los haya generado.
 */
function tags(root, localName) {
  return Array.from(root.getElementsByTagName('*')).filter((el) => el.localName === localName);
}

function resolvePath(base, href) {
  const clean = decodeURIComponent(href.split('#')[0].split('?')[0]);
  const parts = [...(base ? base.split('/') : []), ...clean.split('/')];
  const out = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

function guessType(path) {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif',
  }[ext] || '';
}

function stripHtml(text) {
  if (!text || !/[<&]/.test(text)) return text;
  const doc = new DOMParser().parseFromString(text, 'text/html');
  return doc.body.textContent.replace(/\s+/g, ' ').trim();
}

function dedupe(list) {
  return Array.from(new Set(list));
}
