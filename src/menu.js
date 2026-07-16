import { getPlayerName, setPlayerName, setNetIntent, watchLobby } from './net.js';
import {
  listMaps,
  getSavedMap,
  saveMapAs,
  renameMap,
  duplicateMap,
  deleteMap,
  exportMapFile,
  importMapFile,
} from './mapStore.js';

const nameInput = document.getElementById('menu-name');
const createBtn = document.getElementById('menu-create');
const loadBtn = document.getElementById('menu-load');
const hostBtn = document.getElementById('menu-host');
const autoJoinBtn = document.getElementById('menu-autojoin');
const sessionsEl = document.getElementById('menu-sessions');

// --- name ---------------------------------------------------------------

nameInput.value = getPlayerName();
nameInput.addEventListener('input', () => {
  nameInput.classList.remove('menu-name-missing');
  setPlayerName(nameInput.value);
});

// Multiplayer needs a name (it's shown over your head); solo modes don't.
function requireName() {
  const name = nameInput.value.trim();
  if (!name) {
    nameInput.classList.remove('menu-name-missing');
    // Reflow so the shake animation replays on repeated attempts.
    void nameInput.offsetWidth;
    nameInput.classList.add('menu-name-missing');
    nameInput.focus();
    return null;
  }
  setPlayerName(name);
  return name;
}

// --- navigation ---------------------------------------------------------

function openWorkshop(intent) {
  setNetIntent(intent);
  window.location.href = './workshop.html';
}

createBtn.addEventListener('click', () => openWorkshop({ mode: 'new' }));

loadBtn.title = 'Browse and manage the maps saved in this browser';
loadBtn.addEventListener('click', () => openLibrary('open'));

hostBtn.title = 'Pick a map to host — friends can join, edit with you, and explore together';
hostBtn.addEventListener('click', () => {
  if (!requireName()) return;
  openLibrary('host');
});

// --- map library ----------------------------------------------------------

const libraryEl = document.getElementById('library');
const libraryTitle = document.getElementById('library-title');
const libraryList = document.getElementById('library-list');
const libraryNewBtn = document.getElementById('library-new');
const libraryImportBtn = document.getElementById('library-import');
const libraryImportInput = document.getElementById('library-import-input');

let libraryMode = 'open';

function formatEdited(timestamp) {
  const minutes = Math.round((Date.now() - timestamp) / 60000);
  if (minutes < 1) return 'edited just now';
  if (minutes < 60) return `edited ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `edited ${hours} h ago`;
  return `edited ${Math.round(hours / 24)} d ago`;
}

function launchMap(entry) {
  openWorkshop(libraryMode === 'host'
    ? { mode: 'host', mapId: entry.id }
    : { mode: 'saved', mapId: entry.id });
}

function beginRename(entry, nameEl) {
  const input = document.createElement('input');
  input.className = 'library-rename-input';
  input.value = entry.name;
  input.maxLength = 48;
  let committed = false;
  const commit = () => {
    if (committed) return;
    committed = true;
    renameMap(entry.id, input.value);
    renderLibrary();
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') commit();
    if (event.key === 'Escape') {
      committed = true;
      renderLibrary();
    }
    event.stopPropagation();
  });
  input.addEventListener('blur', commit);
  input.addEventListener('click', (event) => event.stopPropagation());
  nameEl.replaceWith(input);
  input.focus();
  input.select();
}

function createLibraryCard(entry) {
  const card = document.createElement('div');
  card.className = 'library-card';

  const thumb = document.createElement('div');
  thumb.className = 'library-thumb';
  if (entry.thumb) {
    const img = document.createElement('img');
    img.src = entry.thumb;
    img.alt = '';
    thumb.appendChild(img);
  } else {
    thumb.classList.add('library-thumb-empty');
    thumb.textContent = '\u{1F5FA}';
  }
  card.appendChild(thumb);

  const info = document.createElement('div');
  info.className = 'library-info';
  const name = document.createElement('div');
  name.className = 'library-name';
  name.textContent = entry.name;
  name.title = entry.name;
  const meta = document.createElement('div');
  meta.className = 'library-meta';
  meta.textContent = `${entry.entityCount ?? '?'} pieces · ${entry.width}×${entry.depth} · ${formatEdited(entry.updatedAt)}`;
  info.append(name, meta);

  const actions = document.createElement('div');
  actions.className = 'library-actions';
  const addAction = (label, title, handler) => {
    const button = document.createElement('button');
    button.className = 'library-action';
    button.textContent = label;
    button.title = title;
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      handler();
    });
    actions.appendChild(button);
  };
  addAction('✎', 'Rename', () => beginRename(entry, name));
  addAction('⧉', 'Duplicate', () => {
    duplicateMap(entry.id);
    renderLibrary();
  });
  addAction('⤓', 'Export as file', () => {
    const map = getSavedMap(entry.id);
    if (map) exportMapFile(map, entry.name);
  });
  addAction('\u{1F5D1}', 'Delete', () => {
    if (!confirm(`Delete "${entry.name}"? This can't be undone.`)) return;
    deleteMap(entry.id);
    renderLibrary();
  });
  info.appendChild(actions);
  card.appendChild(info);

  const primary = document.createElement('button');
  primary.className = 'library-primary';
  primary.textContent = libraryMode === 'host' ? '\u{1F4E1} Host' : 'Open';
  primary.addEventListener('click', (event) => {
    event.stopPropagation();
    launchMap(entry);
  });
  card.appendChild(primary);

  card.addEventListener('click', () => launchMap(entry));
  return card;
}

function renderLibrary() {
  const entries = listMaps();
  libraryTitle.textContent = libraryMode === 'host' ? 'Choose a map to host' : 'Your maps';
  libraryNewBtn.hidden = libraryMode !== 'host';

  if (entries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'menu-empty';
    empty.textContent = libraryMode === 'host'
      ? 'No saved maps yet — host a new empty map, or import one.'
      : 'No saved maps yet — create a new map, or import one.';
    libraryList.replaceChildren(empty);
    return;
  }
  libraryList.replaceChildren(...entries.map(createLibraryCard));
}

function openLibrary(mode) {
  libraryMode = mode;
  renderLibrary();
  libraryEl.hidden = false;
}

function closeLibrary() {
  libraryEl.hidden = true;
}

document.getElementById('library-close').addEventListener('click', closeLibrary);
libraryEl.addEventListener('click', (event) => {
  if (event.target === libraryEl) closeLibrary();
});
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !libraryEl.hidden) closeLibrary();
});

libraryNewBtn.addEventListener('click', () => openWorkshop({ mode: 'host' }));

libraryImportBtn.addEventListener('click', () => libraryImportInput.click());
libraryImportInput.addEventListener('change', async () => {
  const file = libraryImportInput.files?.[0];
  libraryImportInput.value = '';
  if (!file) return;
  try {
    const map = await importMapFile(file);
    saveMapAs({ name: file.name.replace(/\.json$/i, '') || 'Imported map', map });
    renderLibrary();
  } catch (error) {
    console.error('Failed to import map:', error);
    alert('That file is not a TowerDive map.');
  }
});

function joinSession(session) {
  if (!requireName()) return;
  openWorkshop({
    mode: 'join',
    hostId: session.hostId,
    hostName: session.name,
    startedAt: session.startedAt,
  });
}

// --- global presence ----------------------------------------------------

let liveSessions = [];

function formatElapsed(startedAt) {
  const minutes = Math.max(0, Math.round((Date.now() - startedAt) / 60000));
  if (minutes < 1) return 'just started';
  if (minutes === 1) return 'started 1 min ago';
  if (minutes < 60) return `started ${minutes} min ago`;
  return `started ${Math.round(minutes / 60)} h ago`;
}

function renderSessions(sessions) {
  liveSessions = [...sessions].sort((a, b) => a.startedAt - b.startedAt);
  autoJoinBtn.disabled = liveSessions.length === 0;

  if (liveSessions.length === 0) {
    sessionsEl.replaceChildren();
    const empty = document.createElement('div');
    empty.className = 'menu-empty';
    empty.textContent = 'No one is hosting right now.';
    sessionsEl.appendChild(empty);
    return;
  }

  sessionsEl.replaceChildren(...liveSessions.map((session) => {
    const row = document.createElement('div');
    row.className = 'menu-session';

    const dot = document.createElement('span');
    dot.className = 'menu-session-dot';
    row.appendChild(dot);

    const info = document.createElement('div');
    info.className = 'menu-session-info';
    const name = document.createElement('div');
    name.className = 'menu-session-name';
    name.textContent = session.mapName || `${session.name}'s map`;
    const meta = document.createElement('div');
    meta.className = 'menu-session-meta';
    meta.textContent = `hosted by ${session.name} · ${session.players} player${session.players === 1 ? '' : 's'} · ${formatElapsed(session.startedAt)}`;
    info.append(name, meta);
    row.appendChild(info);

    const join = document.createElement('button');
    join.className = 'menu-session-join';
    join.textContent = 'Join';
    join.addEventListener('click', () => joinSession(session));
    row.appendChild(join);

    return row;
  }));
}

autoJoinBtn.addEventListener('click', () => {
  if (liveSessions.length > 0) joinSession(liveSessions[0]);
});

const lobby = watchLobby(renderSessions);
window.addEventListener('pagehide', () => lobby.leave());
