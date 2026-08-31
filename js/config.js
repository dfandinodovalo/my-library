/**
 * Dónde vive el repo que hace de almacén compartido.
 *
 * Se declara explícito en vez de deducirlo de location.hostname para que la
 * sincronización funcione igual servida desde GitHub Pages que desde
 * localhost mientras desarrollas.
 */
export const REPO = {
  owner: 'dfandinodovalo',
  repo: 'my-library',
  branch: 'main',
};

/** Carpeta del repo donde se publican las bibliotecas. */
export const DATA_DIR = 'data';

export const paths = {
  index: `${DATA_DIR}/profiles.json`,
  coversDir: `${DATA_DIR}/covers`,
  profile: (name) => `${DATA_DIR}/${slug(name)}.json`,
  // La extensión se saca del tipo real: servir un PNG como .jpg funciona por
  // el sniffing del navegador, pero es basura que acaba dando problemas.
  cover: (bookId, type = 'image/jpeg') => `${DATA_DIR}/covers/${bookId}.${extensionOf(type)}`,
};

function extensionOf(mime) {
  return {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
    'image/gif': 'gif', 'image/svg+xml': 'svg', 'image/avif': 'avif',
  }[mime] || 'jpg';
}

/** Nombre de fichero seguro a partir de un nombre de perfil ("Iria" -> "iria"). */
export function slug(name) {
  return String(name)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'perfil';
}
