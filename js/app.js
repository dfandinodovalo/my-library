/**
 * Interfaz de Mi biblioteca.
 *
 * Vanilla JS sobre modulos ES: sin build, sin dependencias, sin CDN. Lo que
 * hay en el repo es exactamente lo que sirve GitHub Pages.
 */

import * as db from './db.js';
import {
  STATUSES, GROUP_ORDER, SORTS, emptyBook, readEpubs, commitBooks, applyFilters,
  readYears, computeStats, exportBackup, importBackup,
} from './library.js';
import { zipSupported } from './zip.js';
import * as sync from './sync.js';
import * as gh from './github.js';
import { REPO } from './config.js';

const DEFAULT_PROFILES = ['David', 'Iria'];

/**
 * El perfil elegido se recuerda en localStorage y no en IndexedDB a proposito:
 * es sincrono, asi que al recargar sabemos a quien mostrar sin esperar a que
 * abra la base de datos y sin que parpadee el selector.
 */
const REMEMBER_KEY = 'my-library:profile';

const state = {
  profiles: [...DEFAULT_PROFILES],
  profile: DEFAULT_PROFILES[0],   // quién eres
  scope: null,                    // qué biblioteca miras: un perfil, o 'all'
  books: [],
  view: 'grid',
  filters: { search: '', status: '', minRating: 0, year: '', sort: 'added' },
  syncState: 'off',               // off | synced | pending | working | error
  dirty: false,                   // hay cambios locales sin publicar
};

/** ¿Estoy mirando mi propia estantería? Fuera de ella todo es de solo lectura. */
const isOwnScope = () => state.scope === state.profile;

/** Cache de object URLs de portadas: crear uno por render acabaria filtrando memoria. */
const coverUrls = new Map();

const $ = (selector) => document.querySelector(selector);
const el = {
  gate: $('#gate'),
  gateProfiles: $('#gate-profiles'),
  gateCancel: $('#gate-cancel'),
  profileCurrent: $('#profile-current'),
  scopes: $('#scopes'),
  syncButton: $('#sync'),
  syncDialog: $('#sync-dialog'),
  stats: $('#stats'),
  library: $('#library'),
  empty: $('#empty'),
  search: $('#search'),
  status: $('#filter-status'),
  rating: $('#filter-rating'),
  year: $('#filter-year'),
  sort: $('#sort'),
  toasts: $('#toasts'),
  epubInput: $('#epub-input'),
  backupInput: $('#backup-input'),
  dropzone: $('#dropzone'),
  bookDialog: $('#book-dialog'),
  profilesDialog: $('#profiles-dialog'),
  menuPanel: $('#menu-panel'),
  menuToggle: $('#menu-toggle'),
  fab: $('#fab'),
  fabMain: $('#fab-main'),
  fabActions: $('#fab-actions'),
  filters: $('#filters'),
  filtersToggle: $('#filters-toggle'),
  filtersCount: $('#filters-count'),
  backdrop: $('#sheet-backdrop'),
};

/* ==================================================================== init */

init().catch((error) => {
  console.error(error);
  toast(`No se pudo arrancar la aplicación: ${error.message}`, { error: true });
});

async function init() {
  const [profiles, view, theme, sort] = await Promise.all([
    db.getSetting('profiles', DEFAULT_PROFILES),
    db.getSetting('view', 'grid'),
    db.getSetting('theme', 'dark'),
    db.getSetting('sort', 'added'),
  ]);

  state.profiles = Array.isArray(profiles) && profiles.length ? profiles : [...DEFAULT_PROFILES];
  state.profiles = await migrateLegacyProfile(state.profiles);
  state.view = view;
  state.filters.sort = sort;
  applyTheme(theme);

  buildSelects();
  wireEvents();

  // Si este dispositivo ya sabe quien lo usa, se entra directo; el selector
  // solo aparece la primera vez o cuando se pide cambiar.
  const remembered = readRemembered();
  if (remembered && state.profiles.includes(remembered)) {
    await enterAs(remembered);
  } else {
    openGate({ dismissible: false });
  }

  if (!zipSupported()) {
    toast('Tu navegador no puede descomprimir EPUB. Necesitas Chrome 103+, Firefox 113+ o Safari 16.4+.', { error: true, sticky: true });
  }

  // En segundo plano: la web ya es usable mientras llega lo publicado.
  initialSync();
  registrarServiceWorker();
}

/**
 * Registra el service worker que permite abrir la app sin conexión.
 *
 * `updateViaCache: 'none'` es importante: GitHub Pages sirve todo con
 * max-age=600, y sin esto el navegador podría darle al service worker una copia
 * guardada de sí mismo y retrasar diez minutos cada actualización.
 *
 * Va al final del arranque y sin await a propósito: si falla, o si el navegador
 * no lo soporta, la app funciona igual. Es una mejora, no un requisito.
 */
function registrarServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker
    .register('./sw.js', { scope: './', updateViaCache: 'none' })
    .catch((error) => console.warn('No se pudo registrar el service worker', error));
}

/**
 * Pide almacenamiento persistente, pero solo una vez y solo cuando ya hay algo
 * que perder: pedirlo nada más entrar, sin un libro guardado todavía, es un
 * aviso de permiso gratuito que además se concede peor.
 */
async function protegerDatos() {
  if (await db.getSetting('persistenceRequested', false)) return;
  await db.setSetting('persistenceRequested', true);

  const concedido = await db.requestPersistence();
  if (concedido) {
    toast('Tus libros quedan protegidos: el navegador ya no los borrará por su cuenta.');
  }
}

function buildSelects() {
  for (const [key, { label }] of Object.entries(STATUSES)) {
    el.status.append(new Option(label, key));
  }
  for (const [key, { label }] of Object.entries(SORTS)) {
    el.sort.append(new Option(label, key));
  }
  el.sort.value = state.filters.sort;

  document.querySelectorAll('.view-toggle button')
    .forEach((button) => button.classList.toggle('is-active', button.dataset.view === state.view));
}

/* ====================================================== selector de perfil */

/**
 * Antes de que existiera este selector el segundo perfil se llamaba
 * "Mi pareja". Se renombra al vuelo, arrastrando sus libros, para que los
 * dispositivos que ya tengan datos no se queden con el nombre viejo.
 */
async function migrateLegacyProfile(profiles) {
  const LEGACY = 'Mi pareja';
  const NEW = 'Iria';
  if (!profiles.includes(LEGACY) || profiles.includes(NEW)) return profiles;

  const books = await db.listBooks(LEGACY);
  if (books.length) await db.putBooks(books.map((book) => ({ ...book, profile: NEW })));

  const renamed = profiles.map((name) => (name === LEGACY ? NEW : name));
  await db.setSetting('profiles', renamed);
  if (readRemembered() === LEGACY) writeRemembered(NEW);
  return renamed;
}

/** localStorage puede lanzar en modo privado de Safari, de ahi los try/catch. */
function readRemembered() {
  try { return localStorage.getItem(REMEMBER_KEY); } catch { return null; }
}

function writeRemembered(name) {
  try { localStorage.setItem(REMEMBER_KEY, name); } catch { /* sin memoria, se pregunta cada vez */ }
}

function openGate({ dismissible = true } = {}) {
  el.gate.hidden = false;
  el.gateCancel.hidden = !dismissible;
  renderGate();
  el.gate.querySelector('.gate-profile')?.focus();
}

function closeGate() {
  el.gate.hidden = true;
}

async function renderGate() {
  // El recuento por perfil es lo que hace util el selector: de un vistazo
  // sabes cual es cual sin tener que entrar.
  const all = await db.listAllBooks();
  const counts = new Map();
  all.forEach((book) => counts.set(book.profile, (counts.get(book.profile) || 0) + 1));

  el.gateProfiles.innerHTML = state.profiles.map((name) => {
    const count = counts.get(name) || 0;
    return `
      <button type="button" class="gate-profile" data-profile="${esc(name)}">
        ${avatarHtml(name)}
        <span class="gate-profile-name">${esc(name)}</span>
        <span class="gate-profile-count">${count === 1 ? '1 libro' : `${count} libros`}</span>
      </button>`;
  }).join('');
}

/** Entra como `name`: lo recuerda, lo persiste y carga su estantería. */
async function enterAs(name) {
  state.profile = name;
  state.scope = name;
  writeRemembered(name);
  await db.setSetting('activeProfile', name);
  closeGate();
  await loadBooks();
}

/* --------------------------------------------------------------- avatares */

/**
 * Avatares generados a partir del nombre: nada de ficheros de imagen que
 * subir al repo, y un perfil nuevo tiene su color desde el primer segundo.
 */
function avatarHtml(name) {
  return `<span class="avatar" style="--h:${hueOf(name)}" aria-hidden="true">${esc(initialsOf(name))}</span>`;
}

function hueOf(name) {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)) % 360;
  return hash;
}

function initialsOf(name) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  return (words[0][0] + (words.length > 1 ? words[words.length - 1][0] : '')).toUpperCase();
}

/* ================================================================== datos */

async function loadBooks() {
  state.books = state.scope === 'all'
    ? await db.listAllBooks()
    : await db.listBooks(state.scope ?? state.profile);
  render();
}

async function saveBook(book) {
  book.updatedAt = new Date().toISOString();
  await db.putBook(book);
  const index = state.books.findIndex((b) => b.id === book.id);
  if (index >= 0) state.books[index] = book;
  else state.books.push(book);
  markDirty();
  render();
}

/** Marca que hay cambios propios pendientes de publicar. */
function markDirty() {
  if (!sync.canPublish()) return;
  state.dirty = true;
  setSyncState('pending');
}

/* ========================================================= sincronización */

const SYNC_LABELS = {
  off: 'Sin sincronizar',
  synced: 'Al día',
  pending: 'Sin publicar',
  working: 'Publicando…',
  error: 'Error al sincronizar',
};

function setSyncState(next) {
  state.syncState = next;
  el.syncButton.hidden = false;
  el.syncButton.dataset.state = next;
  el.syncButton.innerHTML = `<span class="dot"></span><span>${esc(SYNC_LABELS[next])}</span>`;
  el.syncButton.title = next === 'off'
    ? 'Configurar la sincronización con GitHub'
    : 'Publicar tus cambios y traer los de los demás';
}

/** Al arrancar se trae lo publicado; sin token también, porque leer es libre. */
async function initialSync() {
  setSyncState(sync.canPublish() ? 'synced' : 'off');
  try {
    const result = await sync.pull();
    if (result.profiles.length) await adoptProfiles(result.profiles);
    if (result.added || result.updated || result.deleted) await loadBooks();
  } catch (error) {
    console.warn('No se pudo leer lo publicado', error);
  }
}

/** Los perfiles publicados en el repo se añaden a los de este dispositivo. */
async function adoptProfiles(published) {
  const merged = Array.from(new Set([...state.profiles, ...published]));
  if (merged.length === state.profiles.length) return;
  state.profiles = merged;
  await db.setSetting('profiles', merged);
  renderScopes();
}

async function doSync() {
  if (!sync.canPublish()) return openSyncSettings();

  setSyncState('working');
  try {
    const pushed = await sync.push({ profiles: state.profiles });
    const pulled = await sync.pull();
    if (pulled.profiles.length) await adoptProfiles(pulled.profiles);

    state.dirty = false;
    setSyncState('synced');
    await loadBooks();

    const extras = [];
    if (pushed.covers) extras.push(`${pushed.covers} portadas nuevas`);
    if (pulled.added || pulled.updated) extras.push(`${pulled.added + pulled.updated} cambios recibidos`);
    toast(`Publicados ${pushed.books} libros${extras.length ? ` · ${extras.join(' · ')}` : ''}.`);
  } catch (error) {
    setSyncState('error');
    toast(error.message, { error: true });
  }
}

/* ---------------------------------------------------- ajustes de sincronía */

function openSyncSettings() {
  const owner = sync.ownerProfile() || state.profile;

  el.syncDialog.innerHTML = `
    <form method="dialog">
      <div class="dialog-body">
        <h2>Sincronización con GitHub</h2>
        <p class="detail-meta">
          Tu biblioteca se publica en <strong>${esc(REPO.owner)}/${esc(REPO.repo)}</strong>,
          un fichero por persona. <strong>Leer no necesita nada</strong>: quien abra la web
          ve las bibliotecas publicadas. El token solo hace falta para publicar la tuya, se
          guarda únicamente en este navegador y nunca se sube al repo.
        </p>

        <div class="field">
          <label for="sync-owner">Este dispositivo publica el perfil de</label>
          <select id="sync-owner" name="owner">
            ${state.profiles.map((name) =>
              `<option value="${esc(name)}" ${name === owner ? 'selected' : ''}>${esc(name)}</option>`).join('')}
          </select>
        </div>

        <div class="field">
          <label for="sync-token">Token de acceso personal</label>
          <input id="sync-token" name="token" type="password" autocomplete="off" spellcheck="false"
                 placeholder="${gh.hasToken() ? '•••••••• (ya guardado, escribe para cambiarlo)' : 'github_pat_…'}">
        </div>

        <details class="sync-help">
          <summary>Cómo sacar el token (1 minuto)</summary>
          <ol>
            <li>Entra en <strong>github.com → Settings → Developer settings →
                Personal access tokens → Fine-grained tokens → Generate new token</strong>.</li>
            <li>En <em>Repository access</em> elige <strong>Only select repositories</strong>
                y marca <strong>${esc(REPO.owner)}/${esc(REPO.repo)}</strong>.</li>
            <li>En <em>Permissions → Repository permissions</em>, pon
                <strong>Contents: Read and write</strong>. No hace falta nada más.</li>
            <li>Genera, copia y pega aquí. Solo se ve una vez.</li>
          </ol>
          <p>Al limitarlo a este repo, el token no puede tocar nada más de tu cuenta.</p>
        </details>
      </div>

      <div class="dialog-footer">
        ${gh.hasToken() ? '<button type="button" class="btn btn-danger" data-role="forget">Olvidar token</button>' : ''}
        <span class="spacer"></span>
        <button type="button" class="btn" data-role="cancel">Cancelar</button>
        <button type="submit" class="btn btn-primary">Guardar y comprobar</button>
      </div>
    </form>`;

  el.syncDialog.showModal();
  const form = el.syncDialog.querySelector('form');

  form.querySelector('[data-role="cancel"]').addEventListener('click', () => el.syncDialog.close());

  form.querySelector('[data-role="forget"]')?.addEventListener('click', () => {
    gh.setToken('');
    sync.setOwnerProfile('');
    setSyncState('off');
    el.syncDialog.close();
    toast('Token borrado de este navegador. Seguirás viendo lo publicado, pero no podrás publicar.');
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = form.querySelector('[type="submit"]');
    const typed = form.token.value.trim();

    if (typed) gh.setToken(typed);
    if (!gh.hasToken()) return toast('Hace falta un token para publicar.', { error: true });

    submit.disabled = true;
    submit.textContent = 'Comprobando…';
    try {
      // Se valida contra la API antes de dar por buena la configuración: mejor
      // fallar aquí que a la primera publicación, con cambios ya hechos.
      await gh.checkToken();
      sync.setOwnerProfile(form.owner.value);
      el.syncDialog.close();
      setSyncState('pending');
      state.dirty = true;
      toast('Token verificado. Publicando tu biblioteca…');
      await doSync();
    } catch (error) {
      toast(error.message, { error: true });
      submit.disabled = false;
      submit.textContent = 'Guardar y comprobar';
    }
  });

  el.syncDialog.addEventListener('close', () => { el.syncDialog.innerHTML = ''; }, { once: true });
}

/* ================================================================ pintado */

function render() {
  renderProfiles();
  renderScopes();
  renderStats();
  renderYearFilter();
  renderLibrary();
}

/**
 * Pestañas para saltar entre bibliotecas. Solo se muestran si de verdad hay
 * más de una que mirar: con una sola persona sobran.
 */
async function renderScopes() {
  const all = await db.listAllBooks();
  const withBooks = state.profiles.filter((name) => all.some((book) => book.profile === name));
  const others = withBooks.filter((name) => name !== state.profile);

  el.scopes.hidden = others.length === 0;
  if (el.scopes.hidden) {
    if (state.scope === 'all' || !state.profiles.includes(state.scope)) state.scope = state.profile;
    return;
  }

  const tabs = [
    { key: state.profile, label: 'Mis libros', avatar: true },
    ...others.map((name) => ({ key: name, label: name, avatar: true })),
    { key: 'all', label: 'Todos', avatar: false },
  ];

  el.scopes.innerHTML = tabs.map(({ key, label, avatar }) => `
    <button type="button" class="scope-tab${avatar ? '' : ' scope-all'}" data-scope="${esc(key)}"
            aria-current="${key === state.scope}">
      ${avatar ? avatarHtml(key) : ''}<span>${esc(label)}</span>
    </button>`).join('');
}

function renderProfiles() {
  el.profileCurrent.innerHTML = `
    ${avatarHtml(state.profile)}
    <span class="profile-current-name">${esc(state.profile)}</span>`;
  el.profileCurrent.setAttribute('aria-label', `Perfil de ${state.profile}. Cambiar de perfil`);
}

function renderStats() {
  const stats = computeStats(state.books);
  const cards = [
    ['En la estantería', stats.total],
    ['Leídos', stats.read],
    [`Leídos en ${new Date().getFullYear()}`, stats.thisYear],
    ['Leyendo ahora', stats.reading],
    ['Nota media', stats.average ? stats.average.toFixed(1) : '—'],
  ];
  el.stats.innerHTML = cards.map(([label, value]) => `
    <div class="stat">
      <span class="stat-value">${esc(String(value))}</span>
      <span class="stat-label">${esc(label)}</span>
    </div>
  `).join('');
}

function renderYearFilter() {
  const current = el.year.value;
  const years = readYears(state.books);
  el.year.innerHTML = '<option value="">Cualquier año</option>'
    + years.map((year) => `<option value="${year}">Leído en ${year}</option>`).join('');
  if (years.map(String).includes(current)) el.year.value = current;
  else state.filters.year = '';
}

function renderLibrary() {
  renderFiltersCount();
  const books = applyFilters(state.books, state.filters);

  el.library.className = `library view-${state.view}`;
  el.library.innerHTML = state.view === 'groups'
    ? groupsHtml(books)
    : books.map(cardHtml).join('');
  observeCovers();

  const hasFilters = Boolean(state.filters.search || state.filters.status
    || state.filters.minRating || state.filters.year);

  el.empty.hidden = books.length > 0;
  if (books.length === 0) {
    el.empty.innerHTML = hasFilters
      ? `<h2>Nada por aquí</h2><p>Ningún libro de <strong>${esc(state.profile)}</strong> encaja con estos filtros.</p>
         <button type="button" class="btn" data-action="clear-filters">Quitar filtros</button>`
      : `<h2>La estantería de ${esc(state.profile)} está vacía</h2>
         <p>Toca el botón <strong>＋</strong> de abajo para subir un <strong>.epub</strong> —
         saco el título, el autor y la portada— o para añadir un libro a mano.</p>
         <button type="button" class="btn btn-primary" data-action="add">Subir un EPUB</button>`;
  }
}

/**
 * Vista por estado: una sección por cada uno, en el orden de GROUP_ORDER.
 *
 * Los grupos vacíos no se pintan. Si estás filtrando por "Leído", ver cuatro
 * cabeceras con tres a cero solo sería ruido; y con la biblioteca recién
 * empezada la pantalla se llenaría de secciones huecas.
 *
 * Dentro de cada grupo se reutiliza la rejilla de portadas tal cual: las reglas
 * de .view-grid cuelgan de un ancestro, así que basta con ponerle la clase.
 */
function groupsHtml(books) {
  return GROUP_ORDER.map((estado) => {
    const grupo = books.filter((book) => book.status === estado);
    if (!grupo.length) return '';

    const { plural, icon } = STATUSES[estado];
    return `
      <section class="group">
        <h2 class="group-head" data-status="${esc(estado)}">
          <span class="group-icon" aria-hidden="true">${esc(icon)}</span>
          <span class="group-title">${esc(plural)}</span>
          <span class="group-count">${grupo.length}</span>
        </h2>
        <div class="group-items view-grid">${grupo.map(cardHtml).join('')}</div>
      </section>`;
  }).join('');
}

function cardHtml(book) {
  const author = book.authors[0] || 'Autor desconocido';
  const status = STATUSES[book.status];

  return `
    <button type="button" class="card" data-id="${book.id}">
      <div class="card-cover" data-cover="${book.id}">
        ${coverMarkup(book)}
        ${book.rating ? `<div class="card-rating">${stars(book.rating)}</div>` : ''}
      </div>
      <!-- Fuera de .card-cover para poder recolocarlo: en la rejilla va encima
           de la portada y en la lista, como una columna más de la fila. -->
      <div class="card-badges">
        <span class="badge" data-status="${esc(book.status)}">${esc(status.icon)} ${esc(status.label)}</span>
        ${book.favorite ? '<span class="badge badge-fav">★</span>' : ''}
      </div>
      <div class="card-main">
        <div class="card-title">${esc(book.title)}</div>
        <div class="card-author">${esc(author)}</div>
      </div>
      <div class="card-side">
        <span class="list-stars">${book.rating ? stars(book.rating) : ''}</span>
        <span class="list-date">${book.finishedAt ? esc(book.finishedAt) : ''}</span>
      </div>
    </button>
  `;
}

/**
 * Qué va dentro del hueco de la portada.
 *
 * Si la portada está publicada en el repo es una URL normal y corriente: se
 * pone el <img> directamente con loading="lazy" y que la difiera el navegador.
 * Solo las que están en IndexedDB necesitan el observer, porque hay que leer
 * el blob y montar un object URL.
 */
function coverMarkup(book) {
  if (book.hasCover) return '';                       // la pinta paintCover()
  if (book.coverPath) return `<img src="${esc(book.coverPath)}" alt="" loading="lazy">`;
  return fallbackCover(book);
}

/**
 * Si una portada publicada no llega (sin conexión, o el fichero ya no está),
 * se cae al diseño de repuesto con el título. Sin esto quedaba un recuadro
 * vacío y el libro se volvía irreconocible.
 *
 * El evento `error` de una imagen no burbujea, así que hay que escucharlo en
 * fase de captura; a cambio, un único listener cubre toda la rejilla.
 */
function wireCoverFallback(contenedor) {
  contenedor.addEventListener('error', (event) => {
    const img = event.target;
    if (img.tagName !== 'IMG') return;
    const hueco = img.closest('.card-cover, .detail-cover');
    const id = hueco?.dataset.cover ?? img.closest('[data-id]')?.dataset.id;
    const book = state.books.find((b) => b.id === id);
    if (!hueco || !book) return;
    img.remove();
    hueco.insertAdjacentHTML('afterbegin', fallbackCover(book));
  }, true);
}

function fallbackCover(book) {
  return `<div class="cover-fallback">
    <div class="cf-title">${esc(book.title)}</div>
    <div class="cf-author">${esc(book.authors[0] || '')}</div>
  </div>`;
}

/**
 * Las portadas se cargan solo cuando se acercan al viewport. Con 300 libros,
 * leer los 300 blobs de IndexedDB al pintar bloquearia la pagina un segundo largo.
 */
let coverObserver = null;

function observeCovers() {
  coverObserver?.disconnect();
  coverObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      coverObserver.unobserve(entry.target);
      void paintCover(entry.target);
    }
  }, { rootMargin: '400px' });

  el.library.querySelectorAll('[data-cover]').forEach((node) => {
    const book = state.books.find((b) => b.id === node.dataset.cover);
    if (book?.hasCover) coverObserver.observe(node);
  });
}

/** Puede haberla en local (blob) o publicada en el repo (los libros de otros). */
function hasAnyCover(book) {
  return Boolean(book?.hasCover || book?.coverPath);
}

async function paintCover(node) {
  const id = node.dataset.cover;
  try {
    const book = state.books.find((b) => b.id === id);
    // El blob local es preferible: va sin red y sin esperar al CDN de Pages.
    const url = (await coverUrl(id)) || book?.coverPath || null;
    if (!url || !node.isConnected || node.querySelector('img')) return;
    const img = new Image();
    img.src = url;
    img.alt = '';
    img.loading = 'lazy';
    node.prepend(img);
  } catch (error) {
    console.warn('No se pudo cargar la portada', id, error);
  }
}

async function coverUrl(id) {
  if (coverUrls.has(id)) return coverUrls.get(id);
  const blob = await db.getCover(id);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  coverUrls.set(id, url);
  return url;
}

function stars(rating) {
  const full = Math.floor(rating);
  const half = rating % 1 >= 0.5;
  return '★'.repeat(full) + (half ? '½' : '');
}

/* ================================================================ eventos */

function wireEvents() {
  // --- filtros
  el.search.addEventListener('input', debounce(() => {
    state.filters.search = el.search.value;
    renderLibrary();
  }, 150));

  el.status.addEventListener('change', () => { state.filters.status = el.status.value; renderLibrary(); });
  el.rating.addEventListener('change', () => { state.filters.minRating = Number(el.rating.value); renderLibrary(); });
  el.year.addEventListener('change', () => { state.filters.year = el.year.value; renderLibrary(); });
  el.sort.addEventListener('change', () => {
    state.filters.sort = el.sort.value;
    db.setSetting('sort', el.sort.value);
    renderLibrary();
  });

  document.querySelector('.view-toggle').addEventListener('click', (event) => {
    const button = event.target.closest('[data-view]');
    if (!button) return;
    state.view = button.dataset.view;
    db.setSetting('view', state.view);
    document.querySelectorAll('.view-toggle button')
      .forEach((b) => b.classList.toggle('is-active', b === button));
    renderLibrary();
  });

  // --- perfiles
  el.profileCurrent.addEventListener('click', () => openGate());
  el.gateCancel.addEventListener('click', () => closeGate());

  el.gate.addEventListener('click', async (event) => {
    if (event.target.closest('[data-action="profiles"]')) return openProfiles();
    const tile = event.target.closest('[data-profile]');
    if (tile) await enterAs(tile.dataset.profile);
  });

  el.gate.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !el.gateCancel.hidden) closeGate();
  });

  // --- ámbito y sincronización
  el.scopes.addEventListener('click', async (event) => {
    const tab = event.target.closest('[data-scope]');
    if (!tab || tab.dataset.scope === state.scope) return;
    state.scope = tab.dataset.scope;
    await loadBooks();
  });

  el.syncButton.addEventListener('click', () => doSync());

  wireCoverFallback(el.library);
  wireCoverFallback(el.bookDialog);

  // La ficha alterna entre detalle y edición sin cerrarse, así que el vaciado
  // va aquí una sola vez y no atado a una apertura concreta.
  el.bookDialog.addEventListener('close', () => { el.bookDialog.innerHTML = ''; });


  // --- libros
  el.library.addEventListener('click', (event) => {
    const card = event.target.closest('.card');
    if (card) openBook(state.books.find((b) => b.id === card.dataset.id));
  });

  el.empty.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'add') el.epubInput.click();
    if (action === 'clear-filters') clearFilters();
  });

  // --- menu
  el.menuToggle.addEventListener('click', () => toggleMenu());
  $('#menu-close').addEventListener('click', () => toggleMenu(false));
  document.addEventListener('click', (event) => {
    // El panel ya no cuelga del botón, así que hay que excluir ambos.
    if (!event.target.closest('#menu-panel, #menu-toggle')) toggleMenu(false);
  });
  el.menuPanel.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    toggleMenu(false);
    menuAction(action);
  });

  // --- botón flotante de añadir
  el.fabMain.addEventListener('click', () => toggleFab());
  el.fabActions.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    toggleFab(false);
    if (action === 'add-epub') el.epubInput.click();
    if (action === 'add-manual') openBook(emptyBook(state.profile), { isNew: true });
  });

  // --- hoja de filtros
  el.filtersToggle.addEventListener('click', () => toggleFilters());
  $('#filters-close').addEventListener('click', () => toggleFilters(false));
  $('#filters-apply').addEventListener('click', () => toggleFilters(false));
  el.filters.querySelector('[data-action="clear-filters"]').addEventListener('click', clearFilters);

  el.backdrop.addEventListener('click', () => {
    toggleFab(false);
    toggleFilters(false);
    toggleMenu(false);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!el.fabActions.hidden) toggleFab(false);
    else if (!el.menuPanel.hidden) toggleMenu(false);
    else if (el.filters.classList.contains('is-open')) toggleFilters(false);
  });

  // --- entradas de fichero
  el.epubInput.addEventListener('change', () => {
    handleFiles(Array.from(el.epubInput.files));
    el.epubInput.value = '';
  });
  el.backupInput.addEventListener('change', () => {
    handleBackupFile(el.backupInput.files[0]);
    el.backupInput.value = '';
  });

  wireDragAndDrop();

  // --- atajos
  document.addEventListener('keydown', (event) => {
    if (event.key === '/' && !isTyping(event.target)) {
      event.preventDefault();
      el.search.focus();
    }
  });
}

function clearFilters() {
  state.filters = { ...state.filters, search: '', status: '', minRating: 0, year: '' };
  el.search.value = '';
  el.status.value = '';
  el.rating.value = '0';
  el.year.value = '';
  renderLibrary();
}

/* ------------------------------------------------- hojas y botón flotante */

/**
 * Menú, filtros y botón de añadir comparten el fondo oscuro y se estorban
 * entre sí, así que el estado de las capas se recalcula en un único sitio en
 * vez de encadenar condiciones en cada toggle.
 */
function syncOverlays() {
  const menuOpen = !el.menuPanel.hidden;
  const fabOpen = !el.fabActions.hidden;
  const filtersOpen = el.filters.classList.contains('is-open');

  // Menú y filtros solo son hojas a pantalla completa en móvil. En escritorio
  // son paneles pequeños que no tapan nada, así que ni ocultan el botón de
  // añadir ni deben congelar el scroll de la página.
  const asSheet = window.matchMedia('(max-width: 760px)').matches;
  const sheetOpen = asSheet && (menuOpen || filtersOpen);

  el.backdrop.hidden = !(menuOpen || fabOpen || filtersOpen);
  el.fab.hidden = sheetOpen;
  document.body.style.overflow = sheetOpen ? 'hidden' : '';
}

function toggleFab(force) {
  const show = force ?? el.fabActions.hidden;
  el.fabActions.hidden = !show;
  el.fabMain.setAttribute('aria-expanded', String(show));
  syncOverlays();
  if (show) el.fabActions.querySelector('button').focus();
}

function toggleFilters(force) {
  const show = force ?? !el.filters.classList.contains('is-open');
  el.filters.classList.toggle('is-open', show);
  el.filtersToggle.setAttribute('aria-expanded', String(show));
  syncOverlays();
}

/** Cuántos filtros hay puestos, para avisarlo en el botón cuando está plegado. */
function renderFiltersCount() {
  const { status, minRating, year } = state.filters;
  const active = [status, minRating, year].filter(Boolean).length;
  el.filtersCount.hidden = active === 0;
  el.filtersCount.textContent = String(active);
}

function toggleMenu(force) {
  const show = force ?? el.menuPanel.hidden;

  if (show) {
    // El panel cuelga del <body>, así que se ancla al botón a mano. En móvil
    // la hoja inferior ignora estas variables y se pega abajo.
    const anchor = el.menuToggle.getBoundingClientRect();
    el.menuPanel.style.setProperty('--menu-top', `${Math.round(anchor.bottom + 8)}px`);
    el.menuPanel.style.setProperty('--menu-right', `${Math.round(window.innerWidth - anchor.right)}px`);
  }

  el.menuPanel.hidden = !show;
  el.menuToggle.setAttribute('aria-expanded', String(show));
  syncOverlays();
}

async function menuAction(action) {
  switch (action) {
    case 'switch': openGate(); break;
    case 'profiles': openProfiles(); break;
    case 'sync-settings': openSyncSettings(); break;
    case 'export': await doExport(); break;
    case 'import': el.backupInput.click(); break;
    case 'theme': await toggleTheme(); break;
    case 'storage': await showStorage(); break;
  }
}

/* ------------------------------------------------------- arrastrar y soltar */

function wireDragAndDrop() {
  // Los eventos dragenter/dragleave se disparan tambien al pasar sobre hijos,
  // asi que se lleva un contador en vez de un booleano.
  let depth = 0;

  window.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth += 1;
    el.dropzone.hidden = false;
  });

  window.addEventListener('dragover', (event) => {
    if (hasFiles(event)) event.preventDefault();
  });

  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) el.dropzone.hidden = true;
  });

  window.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth = 0;
    el.dropzone.hidden = true;
    handleFiles(Array.from(event.dataTransfer.files));
  });
}

function hasFiles(event) {
  return Array.from(event.dataTransfer?.types || []).includes('Files');
}

/* --------------------------------------------------------------- importar */

async function handleFiles(files) {
  const epubs = files.filter((file) => /\.epub$/i.test(file.name) || file.type === 'application/epub+zip');
  const backups = files.filter((file) => /\.json$/i.test(file.name));

  if (backups.length) return handleBackupFile(backups[0]);

  if (!epubs.length) {
    toast('Solo entiendo ficheros .epub (o una copia de seguridad .json).', { error: true });
    return;
  }

  // Los libros nuevos son siempre tuyos, aunque estés mirando otra estantería,
  // y los duplicados se buscan solo contra la tuya.
  const mine = await db.listBooks(state.profile);
  state.scope = state.profile;

  const notice = progressToast(epubs.length);
  // Leer no guarda nada: los libros salen de aquí en memoria, y a la biblioteca
  // solo entran cuando se confirman.
  const { ready, skipped, failed } = await readEpubs(epubs, state.profile, mine,
    (done, total, name) => notice.update(done, total, name));
  notice.close();

  // Lo que no se ha llegado a preparar sí se cuenta ya: son avisos, no cambios.
  if (skipped.length) {
    toast(`${skipped.length} ya estaba${skipped.length > 1 ? 'n' : ''} en la estantería.`);
  }
  for (const failure of failed) {
    toast(`No pude leer «${failure.name}»: ${failure.message}`, { error: true });
  }
  if (!ready.length) return;

  // Con un solo libro se abre el formulario para revisarlo antes de añadirlo.
  // Cancelar no deja rastro porque todavía no se ha escrito nada.
  if (ready.length === 1) {
    const { book, cover } = ready[0];
    openBookEditor(book, {
      isNew: true,
      pendingCover: cover,
      onSaved: () => confirmarAlta(1),
    });
    return;
  }

  // Con varios no hay revisión posible una a una: se añaden y listo.
  await commitBooks(ready);
  await loadBooks();
  confirmarAlta(ready.length);
}

/** Cierra el alta de libros: avisa, marca para publicar y protege los datos. */
function confirmarAlta(cuantos) {
  markDirty();
  protegerDatos();   // ya hay libros que merece la pena no perder
  toast(`${cuantos} libro${cuantos > 1 ? 's' : ''} añadido${cuantos > 1 ? 's' : ''}.`);
}

async function handleBackupFile(file) {
  if (!file) return;
  try {
    const payload = JSON.parse(await file.text());
    const count = await importBackup(payload, null);
    // Un backup puede traer perfiles que aun no existen en este dispositivo.
    const incoming = new Set(payload.books.map((book) => book.profile).filter(Boolean));
    const merged = Array.from(new Set([...state.profiles, ...incoming]));
    if (merged.length !== state.profiles.length) {
      state.profiles = merged;
      await db.setSetting('profiles', merged);
    }
    await loadBooks();
    toast(`Copia restaurada: ${count} libros.`);
  } catch (error) {
    toast(`No pude leer la copia de seguridad: ${error.message}`, { error: true });
  }
}

async function doExport() {
  const books = await db.listAllBooks();
  if (!books.length) return toast('No hay nada que exportar todavía.', { error: true });

  const payload = await exportBackup(books);
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `mi-biblioteca-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
  toast(`Exportados ${books.length} libros (todos los perfiles).`);
}

async function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  applyTheme(next);
  await db.setSetting('theme', next);
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
}

async function showStorage() {
  const estimate = await db.storageEstimate();
  if (!estimate) return toast('Tu navegador no informa del espacio usado.');
  const used = (estimate.usage / 1024 / 1024).toFixed(1);
  const quota = (estimate.quota / 1024 / 1024 / 1024).toFixed(1);
  toast(`Ocupas ${used} MB de los ~${quota} GB disponibles en este navegador.`);
}

/* =========================================================== ficha de libro */

/**
 * Al tocar un libro se abre su ficha en modo lectura, no el formulario.
 *
 * Puntuar es lo que se hace a diario y se resuelve con un toque, así que las
 * estrellas y el favorito sí son pulsables aquí y guardan al instante. Para
 * cualquier otra cosa hay que entrar en «Editar» a propósito: abrir siempre el
 * formulario invitaba a cambiar un campo sin querer.
 */
function openBook(book, { isNew = false } = {}) {
  if (!book) return;
  const draft = structuredClone(book);

  // Un libro que se añade a mano no tiene nada que mirar: al formulario.
  if (isNew) return openBookEditor(draft, { isNew: true, readOnly: false });

  openBookDetail(draft, { readOnly: draft.profile !== state.profile });
}

function openBookDetail(book, { readOnly }) {
  el.bookDialog.innerHTML = bookDetailHtml(book, readOnly);
  if (!el.bookDialog.open) el.bookDialog.showModal();
  paintDialogCover(book);

  const root = el.bookDialog;
  root.querySelector('[data-role="close"]').addEventListener('click', () => root.close());
  root.querySelector('[data-role="edit"]')
    ?.addEventListener('click', () => openBookEditor(book, { isNew: false, readOnly }));

  if (readOnly) return;

  // Estrellas y favorito guardan solos: no hay botón de guardar en el detalle.
  const starsBox = root.querySelector('.stars');
  paintStars(starsBox, book.rating);
  starsBox.addEventListener('click', async (event) => {
    const value = ratingFromClick(event);
    if (value === null) return;
    book.rating = book.rating === value ? 0 : value;   // repetir la nota la quita
    paintStars(starsBox, book.rating);
    await saveBook({ ...book });
  });

  const favButton = root.querySelector('[data-role="favorite"]');
  paintFavorite(favButton, book.favorite);
  favButton.addEventListener('click', async () => {
    book.favorite = !book.favorite;
    paintFavorite(favButton, book.favorite);
    await saveBook({ ...book });
  });
}

/** Media estrella si se pulsa en la mitad izquierda, entera en la derecha. */
function ratingFromClick(event) {
  const button = event.target.closest('button');
  if (!button) return null;
  const index = Number(button.dataset.index);
  const rect = button.getBoundingClientRect();
  return event.clientX - rect.left < rect.width / 2 ? index - 0.5 : index;
}

function paintDialogCover(book) {
  const hueco = el.bookDialog.querySelector('.detail-cover');
  if (!hueco || !hasAnyCover(book)) return;
  coverUrl(book.id).then((url) => {
    const src = url || book.coverPath;
    if (src && hueco.isConnected) {
      hueco.insertAdjacentHTML('afterbegin', `<img src="${esc(src)}" alt="">`);
    }
  });
}

/* ------------------------------------------------------- ficha: edición */

/**
 * `pendingCover` es la portada de un libro que todavía no existe en la base de
 * datos: viene de un EPUB recién leído y se guarda solo si se confirma el alta.
 * `onSaved` avisa a quien abrió el formulario de que el libro ya es real.
 */
function openBookEditor(draft, { isNew = false, readOnly = false,
                                 pendingCover = null, onSaved = null } = {}) {
  el.bookDialog.innerHTML = bookDialogHtml(draft, isNew, readOnly);
  if (!el.bookDialog.open) el.bookDialog.showModal();

  const form = el.bookDialog.querySelector('form');

  // Cancelar en un libro que ya existía devuelve a su detalle, no cierra del
  // todo: se venía de ahí y cerrar la ficha entera sería perder el sitio. En
  // uno nuevo simplemente se cierra, y como no se ha escrito nada, no hay nada
  // que deshacer.
  form.querySelector('[data-role="cancel"]').addEventListener('click', () => {
    if (isNew) el.bookDialog.close();
    else openBookDetail(draft, { readOnly });
  });

  const coverBox = el.bookDialog.querySelector('.detail-cover');
  let coverBlob = pendingCover;   // se escribe en el submit, no antes

  if (pendingCover) {
    // Aún no está en IndexedDB, así que se pinta directamente del blob.
    coverBox.querySelector('.cover-fallback')?.remove();
    coverBox.insertAdjacentHTML('afterbegin',
      `<img src="${URL.createObjectURL(pendingCover)}" alt="">`);
  } else {
    paintDialogCover(draft);
  }

  // La biblioteca de otra persona se mira, no se toca: cualquier cambio aquí
  // lo sobrescribiría su propietario en la siguiente sincronización.
  if (readOnly) {
    form.querySelectorAll('input, textarea, select').forEach((field) => { field.disabled = true; });
    form.querySelectorAll('[data-role="pick-cover"], [data-role="favorite"]')
      .forEach((button) => { button.disabled = true; });
    return;
  }

  // --- estrellas
  const starsBox = form.querySelector('.stars');
  paintStars(starsBox, draft.rating);
  starsBox.addEventListener('click', (event) => {
    const value = ratingFromClick(event);
    if (value === null) return;
    draft.rating = draft.rating === value ? 0 : value; // volver a pulsar quita la nota
    paintStars(starsBox, draft.rating);
  });

  // --- favorito
  const favButton = form.querySelector('[data-role="favorite"]');
  paintFavorite(favButton, draft.favorite);
  favButton.addEventListener('click', () => {
    draft.favorite = !draft.favorite;
    paintFavorite(favButton, draft.favorite);
  });

  // --- al marcar como leído, proponer la fecha de hoy
  form.status.addEventListener('change', () => {
    if (form.status.value === 'read' && !form.finishedAt.value) {
      form.finishedAt.value = new Date().toISOString().slice(0, 10);
    }
  });

  // --- portada manual
  form.querySelector('[data-role="pick-cover"]').addEventListener('click', async () => {
    const file = await pickImage();
    if (!file) return;
    coverBlob = file;
    const url = URL.createObjectURL(file);
    coverBox.querySelector('img')?.remove();
    coverBox.querySelector('.cover-fallback')?.remove();
    coverBox.insertAdjacentHTML('afterbegin', `<img src="${url}" alt="">`);
  });

  // --- borrar
  form.querySelector('[data-role="delete"]')?.addEventListener('click', async () => {
    if (!confirm(`¿Quitar «${draft.title}» de la estantería de ${state.profile}?`)) return;
    await db.deleteBook(draft.id);
    releaseCover(draft.id);
    state.books = state.books.filter((b) => b.id !== draft.id);
    el.bookDialog.close();
    markDirty();
    render();
    toast('Libro eliminado.');
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(form);

    Object.assign(draft, {
      title: (data.get('title') || '').trim() || '(sin título)',
      authors: splitList(data.get('authors')),
      series: (data.get('series') || '').trim(),
      seriesIndex: data.get('seriesIndex') ? Number(data.get('seriesIndex')) : null,
      status: data.get('status'),
      startedAt: data.get('startedAt') || '',
      finishedAt: data.get('finishedAt') || '',
      review: (data.get('review') || '').trim(),
    });

    if (coverBlob) {
      await db.putCover(draft.id, coverBlob);
      releaseCover(draft.id);
      draft.hasCover = true;
    }

    await saveBook(draft);
    onSaved?.(draft);
    // Al guardar se vuelve al detalle para ver el resultado; un libro recién
    // creado no tenía detalle previo, así que ahí sí se cierra.
    if (isNew) el.bookDialog.close();
    else openBookDetail(draft, { readOnly });
  });

  form.querySelector('[name="title"]').focus();
}

/** Datos de la cabecera del EPUB, comunes al detalle y al formulario. */
function bookMetaRows(book) {
  return [
    ['Editorial', book.publisher],
    ['Publicado', book.year],
    ['Idioma', book.language],
    ['ISBN', book.isbn],
    ['Fichero', book.fileName],
  ].filter(([, value]) => value);
}

/**
 * Longitud del libro en texto legible.
 *
 * Se marca cuándo es una estimación: un EPUB no tiene páginas —el texto se
 * reflowa— así que salvo que el fichero traiga el mapa de la edición impresa,
 * la cifra sale de dividir las palabras contadas. Darla por exacta sería
 * mentir, y con "≈" queda claro de un vistazo.
 */
function bookLength(book) {
  if (!book.words && !book.pages) return null;

  const partes = [];
  if (book.pages) {
    partes.push(book.pagesSource === 'epub'
      ? `${book.pages} páginas`
      : `≈ ${book.pages} páginas`);
  }
  if (book.words) partes.push(`${book.words.toLocaleString('es-ES')} palabras`);

  return {
    texto: partes.join(' · '),
    estimado: book.pagesSource === 'estimado',
  };
}

function bookDetailHtml(book, readOnly) {
  const meta = bookMetaRows(book);
  const largo = bookLength(book);
  const status = STATUSES[book.status];
  const autores = book.authors.length ? book.authors.join(', ') : 'Autor desconocido';

  const fechas = [
    book.startedAt && `empezado el ${book.startedAt}`,
    book.finishedAt && `terminado el ${book.finishedAt}`,
  ].filter(Boolean).join(' · ');

  return `
  <div class="dialog-body detail-read">
    ${readOnly ? `<div class="readonly-note" style="grid-column:1/-1">
      <span aria-hidden="true">👀</span>
      <span>Estás viendo la biblioteca de <strong>${esc(book.profile)}</strong>. Solo lectura:
      cualquier cambio lo sobrescribiría su dispositivo al sincronizar.</span>
    </div>` : ''}

    <div class="detail-side">
      <div class="detail-cover">${coverMarkup(book)}</div>
      ${meta.length ? `<div class="detail-meta">${meta
        .map(([k, v]) => `<div><strong>${esc(k)}:</strong> ${esc(String(v))}</div>`).join('')}</div>` : ''}
      ${book.subjects?.length ? `<div class="chips">${book.subjects.slice(0, 6)
        .map((s) => `<span class="chip">${esc(s)}</span>`).join('')}</div>` : ''}
    </div>

    <div class="detail-main">
      <div class="dialog-head">
        <div class="grow">
          <h2 class="detail-title">${esc(book.title)}</h2>
          <p class="detail-author">${esc(autores)}</p>
          ${book.series ? `<p class="detail-series">${esc(book.series)}${
            book.seriesIndex ? ` · nº ${esc(String(book.seriesIndex))}` : ''}</p>` : ''}
        </div>
        <button type="button" class="btn btn-icon" data-role="favorite"
                aria-pressed="${book.favorite}" title="Marcar como favorito"
                ${readOnly ? 'disabled' : ''}>${book.favorite ? '★' : '☆'}</button>
      </div>

      <div class="detail-rating">
        <div class="stars" role="group" aria-label="Puntuación de 0 a 5">
          ${[1, 2, 3, 4, 5].map((i) => `
            <button type="button" data-index="${i}" aria-label="${i} estrellas"
                    ${readOnly ? 'disabled' : ''}>
              <span class="star-glyph">★</span>
            </button>`).join('')}
        </div>
        <span class="rating-value"></span>
      </div>

      <div class="detail-status">
        <span class="badge" data-status="${esc(book.status)}">${esc(status.icon)} ${esc(status.label)}</span>
        ${fechas ? `<span class="detail-dates">${esc(fechas)}</span>` : ''}
      </div>

      ${largo ? `<p class="detail-length"${largo.estimado
        ? ' title="El EPUB no trae paginación: es una estimación a partir de las palabras del libro"'
        : ' title="Paginación declarada por el propio EPUB"'}>
        <span aria-hidden="true">📖</span> ${esc(largo.texto)}
      </p>` : ''}

      <div class="detail-block">
        <h3>Tu reseña</h3>
        ${book.review
          ? `<p class="detail-review">${esc(book.review)}</p>`
          : `<p class="detail-empty">Todavía no has escrito nada.</p>`}
      </div>

      ${book.description ? `<div class="detail-block">
        <h3>Sinopsis</h3>
        <div class="description">${esc(book.description)}</div>
      </div>` : ''}
    </div>
  </div>

  <div class="dialog-footer">
    <span class="spacer"></span>
    <button type="button" class="btn" data-role="close">Cerrar</button>
    ${readOnly ? '' : '<button type="button" class="btn btn-primary" data-role="edit">Editar</button>'}
  </div>`;
}

function bookDialogHtml(book, isNew, readOnly = false) {
  const meta = bookMetaRows(book);

  return `
  <form method="dialog">
    <div class="dialog-body">
      ${readOnly ? `<div class="readonly-note" style="grid-column:1/-1">
        <span aria-hidden="true">👀</span>
        <span>Estás viendo la biblioteca de <strong>${esc(book.profile)}</strong>. Su ficha es
        de solo lectura: cualquier cambio lo sobrescribiría su dispositivo al sincronizar.</span>
      </div>` : ''}
      <div class="detail-side">
        <div class="detail-cover">${coverMarkup(book)}</div>
        <button type="button" class="btn btn-ghost" data-role="pick-cover">Cambiar portada</button>
        ${meta.length ? `<div class="detail-meta">${meta.map(([k, v]) => `<div><strong>${esc(k)}:</strong> ${esc(String(v))}</div>`).join('')}</div>` : ''}
        ${book.subjects?.length ? `<div class="chips">${book.subjects.slice(0, 6).map((s) => `<span class="chip">${esc(s)}</span>`).join('')}</div>` : ''}
      </div>

      <div class="detail-main">
        <div class="dialog-head">
          <div class="grow field field-title">
            <label for="bd-title">Título</label>
            <input id="bd-title" name="title" value="${esc(book.title)}" placeholder="Título del libro" required>
          </div>
          <button type="button" class="btn btn-icon" data-role="favorite"
                  aria-pressed="${book.favorite}" title="Marcar como favorito">${book.favorite ? '★' : '☆'}</button>
        </div>

        <div class="field">
          <label for="bd-authors">Autores <span style="text-transform:none">(separados por comas)</span></label>
          <input id="bd-authors" name="authors" value="${esc(book.authors.join(', '))}">
        </div>

        <div class="field-row">
          <div class="field">
            <label for="bd-series">Saga</label>
            <input id="bd-series" name="series" value="${esc(book.series || '')}">
          </div>
          <div class="field">
            <label for="bd-series-index">Nº en la saga</label>
            <input id="bd-series-index" name="seriesIndex" type="number" step="0.5" value="${book.seriesIndex ?? ''}">
          </div>
        </div>

        <div class="field">
          <label>Puntuación</label>
          <div class="rating-row">
            <div class="stars" role="group" aria-label="Puntuación de 0 a 5">
              ${[1, 2, 3, 4, 5].map((i) => `
                <button type="button" data-index="${i}" aria-label="${i} estrellas">
                  <span class="star-glyph">★</span>
                </button>`).join('')}
            </div>
            <span class="rating-value"></span>
          </div>
        </div>

        <div class="field-row">
          <div class="field">
            <label for="bd-status">Estado</label>
            <select id="bd-status" name="status">
              ${Object.entries(STATUSES).map(([key, { label }]) =>
                `<option value="${key}" ${book.status === key ? 'selected' : ''}>${esc(label)}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label for="bd-finished">Terminado el</label>
            <input id="bd-finished" name="finishedAt" type="date" value="${esc(book.finishedAt || '')}">
          </div>
        </div>

        <div class="field">
          <label for="bd-started">Empezado el</label>
          <input id="bd-started" name="startedAt" type="date" value="${esc(book.startedAt || '')}">
        </div>

        <div class="field">
          <label for="bd-review">Tu reseña</label>
          <textarea id="bd-review" name="review" placeholder="¿Qué te ha parecido?">${esc(book.review || '')}</textarea>
        </div>

        ${book.description ? `<div class="field">
          <label>Sinopsis del EPUB</label>
          <div class="description">${esc(book.description)}</div>
        </div>` : ''}
      </div>
    </div>

    <div class="dialog-footer">
      ${isNew || readOnly ? '' : '<button type="button" class="btn btn-danger" data-role="delete">Eliminar</button>'}
      <span class="spacer"></span>
      <button type="button" class="btn" data-role="cancel">${readOnly ? 'Cerrar' : 'Cancelar'}</button>
      ${readOnly ? '' : '<button type="submit" class="btn btn-primary">Guardar</button>'}
    </div>
  </form>`;
}

function paintStars(box, rating) {
  box.querySelectorAll('button').forEach((button) => {
    const index = Number(button.dataset.index);
    const fill = rating >= index ? 'full' : rating >= index - 0.5 ? 'half' : 'none';
    button.dataset.fill = fill;
  });
  box.parentElement.querySelector('.rating-value').textContent = rating ? `${rating}/5` : 'Sin nota';
}

function paintFavorite(button, favorite) {
  button.textContent = favorite ? '★' : '☆';
  button.setAttribute('aria-pressed', String(favorite));
  button.style.color = favorite ? 'var(--star)' : '';
}

async function pickImage() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.addEventListener('change', () => resolve(input.files[0] || null), { once: true });
    input.addEventListener('cancel', () => resolve(null), { once: true });
    input.click();
  });
}

function releaseCover(id) {
  const url = coverUrls.get(id);
  if (url) {
    URL.revokeObjectURL(url);
    coverUrls.delete(id);
  }
}

/* ============================================================ perfiles UI */

async function openProfiles() {
  const all = await db.listAllBooks();
  const counts = new Map();
  all.forEach((book) => counts.set(book.profile, (counts.get(book.profile) || 0) + 1));

  el.profilesDialog.innerHTML = `
    <form method="dialog">
      <div class="dialog-body">
        <h2>Perfiles</h2>
        <p class="detail-meta">Cada perfil tiene su propia estantería. Renombra uno y sus libros se
        renombran con él; para borrarlo, primero tiene que quedarse vacío.</p>
        <div id="profile-rows">
          ${state.profiles.map((name, i) => `
            <div class="profile-row" data-original="${esc(name)}">
              <input name="p${i}" value="${esc(name)}" aria-label="Nombre del perfil">
              <span class="count">${counts.get(name) || 0} libros</span>
              <button type="button" class="btn btn-danger" data-remove="${esc(name)}"
                      ${counts.get(name) ? 'disabled title="Tiene libros dentro"' : ''}>Borrar</button>
            </div>`).join('')}
        </div>
        <button type="button" class="btn" data-role="add-profile" style="margin-top:1rem">＋ Nuevo perfil</button>
      </div>
      <div class="dialog-footer">
        <span class="spacer"></span>
        <button type="button" class="btn" data-role="cancel">Cancelar</button>
        <button type="submit" class="btn btn-primary">Guardar</button>
      </div>
    </form>`;

  el.profilesDialog.showModal();
  const dialog = el.profilesDialog;
  const rows = dialog.querySelector('#profile-rows');

  dialog.querySelector('[data-role="add-profile"]').addEventListener('click', () => {
    const index = rows.children.length;
    rows.insertAdjacentHTML('beforeend', `
      <div class="profile-row" data-original="">
        <input name="p${index}" value="" placeholder="Nombre" aria-label="Nombre del perfil">
        <span class="count">0 libros</span>
        <button type="button" class="btn btn-danger" data-remove="">Borrar</button>
      </div>`);
    rows.lastElementChild.querySelector('input').focus();
  });

  rows.addEventListener('click', (event) => {
    const button = event.target.closest('[data-remove]');
    if (button && !button.disabled) button.closest('.profile-row').remove();
  });

  dialog.querySelector('[data-role="cancel"]').addEventListener('click', () => dialog.close());

  dialog.querySelector('form').addEventListener('submit', async (event) => {
    event.preventDefault();

    const renames = [];
    const names = [];
    for (const row of rows.querySelectorAll('.profile-row')) {
      const name = row.querySelector('input').value.trim();
      if (!name || names.includes(name)) continue;
      names.push(name);
      const original = row.dataset.original;
      if (original && original !== name) renames.push([original, name]);
    }

    if (!names.length) return toast('Necesitas al menos un perfil.', { error: true });

    // Renombrar un perfil implica reetiquetar sus libros, o quedarian huerfanos.
    for (const [from, to] of renames) {
      const books = await db.listBooks(from);
      if (books.length) await db.putBooks(books.map((book) => ({ ...book, profile: to })));
      if (state.profile === from) state.profile = to;
    }

    state.profiles = names;
    if (!names.includes(state.profile)) state.profile = names[0];
    await db.setSetting('profiles', names);
    await db.setSetting('activeProfile', state.profile);
    // Si este dispositivo ya recordaba a alguien, se actualiza por si le han
    // cambiado el nombre. Si aun no habia elegido nadie, no se decide por el.
    if (readRemembered()) writeRemembered(state.profile);

    dialog.close();
    await loadBooks();
    if (!el.gate.hidden) renderGate();
    toast('Perfiles actualizados.');
  });

  dialog.addEventListener('close', () => { dialog.innerHTML = ''; }, { once: true });
}

/* ================================================================= avisos */

function toast(message, { error = false, sticky = false } = {}) {
  const node = document.createElement('div');
  node.className = `toast${error ? ' is-error' : ''}`;
  node.textContent = message;
  el.toasts.append(node);
  if (!sticky) setTimeout(() => node.remove(), 5200);
  return node;
}

function progressToast(total) {
  const node = toast(`Leyendo ${total} EPUB…`, { sticky: true });
  const bar = document.createElement('progress');
  bar.max = total;
  bar.value = 0;
  node.append(bar);

  return {
    update(done, max, name) {
      node.firstChild.textContent = `Leyendo ${done}/${max} — ${name}`;
      bar.value = done;
    },
    close() { node.remove(); },
  };
}

/* ================================================================ helpers */

function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

function splitList(value) {
  return String(value || '').split(',').map((part) => part.trim()).filter(Boolean);
}

function debounce(fn, wait) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

function isTyping(node) {
  return /^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName) || node.isContentEditable;
}
