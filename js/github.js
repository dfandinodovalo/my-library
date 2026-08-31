/**
 * Cliente mínimo de la API de GitHub para usar el repo como almacén.
 *
 * Escribe con la "Git Data API" (blobs -> tree -> commit -> ref) en lugar del
 * endpoint sencillo de contenidos porque ese hace un commit por fichero: subir
 * 20 libros dejaría 21 commits en el historial. Así todo el lote entra en uno.
 *
 * El token se guarda en localStorage y nunca sale de este navegador: no está
 * en el repo ni viaja a ningún sitio que no sea api.github.com.
 */

import { REPO } from './config.js';

const API = 'https://api.github.com';
const TOKEN_KEY = 'my-library:token';

/* ------------------------------------------------------------------ token */

export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}

export function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token.trim());
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* sin localStorage no hay escritura posible, se avisa al usar */ }
}

export function hasToken() {
  return Boolean(getToken());
}

/** Comprueba que el token vale y que puede escribir en el repo. */
export async function checkToken() {
  const repo = await api(`/repos/${REPO.owner}/${REPO.repo}`);
  if (!repo.permissions?.push) {
    throw new Error('El token es válido pero no tiene permiso de escritura sobre el repo. Necesita "Contents: Read and write".');
  }
  return { repo: repo.full_name, private: repo.private };
}

/* -------------------------------------------------------------- peticiones */

async function api(path, options = {}) {
  const token = getToken();
  const response = await fetch(API + path, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });

  if (!response.ok) throw await describeError(response);
  return response.status === 204 ? null : response.json();
}

/** Convierte los errores de la API en algo que se pueda enseñar tal cual. */
async function describeError(response) {
  let detail = '';
  try { detail = (await response.json()).message || ''; } catch { /* cuerpo vacío */ }

  if (response.status === 401) return new Error('El token no es válido o ha caducado. Vuelve a introducirlo.');
  if (response.status === 403 && /rate limit/i.test(detail)) {
    return new Error('GitHub ha limitado las peticiones por ahora. Espera unos minutos.');
  }
  if (response.status === 403) return new Error(`GitHub ha denegado la operación: ${detail}`);
  if (response.status === 404) {
    return new Error(`No se encuentra ${REPO.owner}/${REPO.repo}. Revisa el nombre del repo o los permisos del token.`);
  }
  return new Error(`GitHub ha respondido ${response.status}: ${detail}`);
}

/* ------------------------------------------------------------- lectura ref */

const base = `/repos/${REPO.owner}/${REPO.repo}`;

async function headCommit() {
  const ref = await api(`${base}/git/ref/heads/${REPO.branch}`);
  const commit = await api(`${base}/git/commits/${ref.object.sha}`);
  return { commitSha: ref.object.sha, treeSha: commit.tree.sha };
}

/** Rutas que ya existen en el repo, para no volver a subir portadas guardadas. */
export async function listPaths() {
  try {
    const { treeSha } = await headCommit();
    const tree = await api(`${base}/git/trees/${treeSha}?recursive=1`);
    return new Set(tree.tree.filter((node) => node.type === 'blob').map((node) => node.path));
  } catch (error) {
    if (/No se encuentra/.test(error.message)) throw error;
    return new Set();
  }
}

/* ------------------------------------------------------------- escritura */

/**
 * Publica un lote de cambios en un único commit.
 *
 * `files`: [{ path, text }] | [{ path, blob }] | [{ path, delete: true }]
 *
 * Reintenta si alguien ha empujado entre medias: como cada persona solo toca
 * su propio fichero, rehacer el commit sobre la nueva punta nunca pisa nada.
 */
export async function commitFiles(files, message, attempt = 0) {
  if (!hasToken()) throw new Error('Configura primero tu token de GitHub para poder publicar.');
  if (!files.length) return null;

  const { commitSha, treeSha } = await headCommit();

  const entries = await Promise.all(files.map(async (file) => {
    if (file.delete) return { path: file.path, mode: '100644', type: 'blob', sha: null };
    const sha = await createBlob(file);
    return { path: file.path, mode: '100644', type: 'blob', sha };
  }));

  const tree = await api(`${base}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({ base_tree: treeSha, tree: entries }),
  });

  const commit = await api(`${base}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({ message, tree: tree.sha, parents: [commitSha] }),
  });

  try {
    await api(`${base}/git/refs/heads/${REPO.branch}`, {
      method: 'PATCH',
      body: JSON.stringify({ sha: commit.sha }),
    });
  } catch (error) {
    // 422 = la rama avanzó mientras preparábamos el commit. Se rehace sobre la punta nueva.
    if (attempt < 2 && /422|not a fast forward/i.test(error.message)) {
      return commitFiles(files, message, attempt + 1);
    }
    throw error;
  }

  return commit.sha;
}

async function createBlob(file) {
  const body = file.blob
    ? { content: await blobToBase64(file.blob), encoding: 'base64' }
    : { content: file.text, encoding: 'utf-8' };

  const blob = await api(`${base}/git/blobs`, { method: 'POST', body: JSON.stringify(body) });
  return blob.sha;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    // readAsDataURL da "data:<tipo>;base64,<datos>": nos quedamos con los datos.
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
