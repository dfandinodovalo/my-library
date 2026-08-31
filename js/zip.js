/**
 * Lector de ZIP minimalista para el navegador, sin dependencias.
 *
 * Un EPUB no es mas que un ZIP con una estructura concreta, asi que en vez de
 * cargar una libreria entera (JSZip pesa ~100KB) leemos el directorio central
 * a mano y delegamos la descompresion en DecompressionStream('deflate-raw'),
 * que ya viene en todos los navegadores modernos.
 *
 * Soporta los dos metodos que usan los EPUB reales: 0 (stored) y 8 (deflate).
 */

const EOCD_SIG = 0x06054b50;
const EOCD64_LOCATOR_SIG = 0x07064b50;
const EOCD64_SIG = 0x06064b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

const utf8 = new TextDecoder('utf-8');

export function zipSupported() {
  return typeof DecompressionStream === 'function';
}

/**
 * Abre un Blob/File como ZIP y devuelve un objeto con las entradas indexadas
 * por nombre y metodos para extraerlas.
 */
export async function openZip(blob) {
  if (!zipSupported()) {
    throw new Error('Tu navegador no soporta DecompressionStream. Actualiza a una version reciente de Chrome, Firefox o Safari.');
  }

  const { offset: cdOffset, size: cdSize } = await locateCentralDirectory(blob);
  const cd = new DataView(await blob.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
  const entries = new Map();

  let p = 0;
  while (p + 46 <= cd.byteLength && cd.getUint32(p, true) === CENTRAL_SIG) {
    const method = cd.getUint16(p + 10, true);
    const nameLen = cd.getUint16(p + 28, true);
    const extraLen = cd.getUint16(p + 30, true);
    const commentLen = cd.getUint16(p + 32, true);

    let compressedSize = cd.getUint32(p + 20, true);
    let uncompressedSize = cd.getUint32(p + 24, true);
    let localOffset = cd.getUint32(p + 42, true);

    const name = utf8.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen));

    // ZIP64: los campos a 0xffffffff viven en el extra field 0x0001.
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      const zip64 = readZip64Extra(cd, p + 46 + nameLen, extraLen, {
        uncompressedSize, compressedSize, localOffset,
      });
      ({ compressedSize, uncompressedSize, localOffset } = zip64);
    }

    // Las carpetas se ignoran: solo nos interesan ficheros.
    if (!name.endsWith('/')) {
      entries.set(name, { name, method, compressedSize, uncompressedSize, localOffset });
    }

    p += 46 + nameLen + extraLen + commentLen;
  }

  const zip = {
    entries,
    has: (name) => entries.has(name),
    names: () => Array.from(entries.keys()),
    /** Devuelve un ArrayBuffer con el contenido descomprimido de la entrada. */
    async buffer(name) {
      const entry = entries.get(name);
      if (!entry) throw new Error(`El EPUB no contiene "${name}"`);
      return readEntry(blob, entry);
    },
    /** Devuelve la entrada decodificada como texto UTF-8. */
    async text(name) {
      return utf8.decode(await zip.buffer(name));
    },
    /** Devuelve la entrada como Blob, con el tipo MIME que le indiquemos. */
    async blob(name, type = 'application/octet-stream') {
      return new Blob([await zip.buffer(name)], { type });
    },
  };

  return zip;
}

/**
 * El End Of Central Directory esta al final del fichero, pero puede llevar
 * detras hasta 64KB de comentario, asi que lo buscamos hacia atras en la cola.
 */
async function locateCentralDirectory(blob) {
  const tailLen = Math.min(blob.size, 0xffff + 22);
  const tailStart = blob.size - tailLen;
  const tail = new DataView(await blob.slice(tailStart).arrayBuffer());

  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('El fichero no parece un EPUB valido (no se encuentra el indice del ZIP).');

  let size = tail.getUint32(eocd + 12, true);
  let offset = tail.getUint32(eocd + 16, true);

  if (offset === 0xffffffff || size === 0xffffffff) {
    const locator = eocd - 20;
    if (locator < 0 || tail.getUint32(locator, true) !== EOCD64_LOCATOR_SIG) {
      throw new Error('ZIP64 mal formado en el EPUB.');
    }
    const eocd64Offset = Number(tail.getBigUint64(locator + 8, true));
    const rec = new DataView(await blob.slice(eocd64Offset, eocd64Offset + 56).arrayBuffer());
    if (rec.getUint32(0, true) !== EOCD64_SIG) throw new Error('ZIP64 mal formado en el EPUB.');
    size = Number(rec.getBigUint64(40, true));
    offset = Number(rec.getBigUint64(48, true));
  }

  return { offset, size };
}

function readZip64Extra(view, start, extraLen, current) {
  const out = { ...current };
  let p = start;
  const end = start + extraLen;

  while (p + 4 <= end) {
    const id = view.getUint16(p, true);
    const len = view.getUint16(p + 2, true);
    if (id === 0x0001) {
      let q = p + 4;
      // Los campos aparecen en orden, pero solo los que valian 0xffffffff.
      if (out.uncompressedSize === 0xffffffff) { out.uncompressedSize = Number(view.getBigUint64(q, true)); q += 8; }
      if (out.compressedSize === 0xffffffff) { out.compressedSize = Number(view.getBigUint64(q, true)); q += 8; }
      if (out.localOffset === 0xffffffff) { out.localOffset = Number(view.getBigUint64(q, true)); q += 8; }
      break;
    }
    p += 4 + len;
  }
  return out;
}

async function readEntry(blob, entry) {
  // El directorio central apunta a la cabecera local, cuya longitud varia:
  // hay que leerla para saber donde empiezan los datos de verdad.
  const header = new DataView(await blob.slice(entry.localOffset, entry.localOffset + 30).arrayBuffer());
  if (header.getUint32(0, true) !== LOCAL_SIG) {
    throw new Error(`Cabecera corrupta en "${entry.name}"`);
  }
  const nameLen = header.getUint16(26, true);
  const extraLen = header.getUint16(28, true);
  const dataStart = entry.localOffset + 30 + nameLen + extraLen;
  const raw = blob.slice(dataStart, dataStart + entry.compressedSize);

  if (entry.method === 0) return raw.arrayBuffer();
  if (entry.method !== 8) {
    throw new Error(`Metodo de compresion ${entry.method} no soportado en "${entry.name}"`);
  }

  const stream = raw.stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).arrayBuffer();
}
