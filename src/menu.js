import { getPlayerName, setPlayerName, setNetIntent, watchLobby } from './net.js';
import { loadMap } from './mapStore.js';

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

const hasSavedMap = Boolean(loadMap());
loadBtn.disabled = !hasSavedMap;
loadBtn.title = hasSavedMap ? 'Open the map saved in this browser' : 'No map saved in this browser yet';
loadBtn.addEventListener('click', () => openWorkshop({ mode: 'saved' }));

hostBtn.title = 'Host your saved map — friends can join, edit with you, and explore together';
hostBtn.addEventListener('click', () => {
  if (!requireName()) return;
  openWorkshop({ mode: 'host' });
});

function joinSession(session) {
  if (!requireName()) return;
  openWorkshop({ mode: 'join', hostId: session.hostId, hostName: session.name });
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
    name.textContent = `${session.name}'s map`;
    const meta = document.createElement('div');
    meta.className = 'menu-session-meta';
    meta.textContent = `${session.players} player${session.players === 1 ? '' : 's'} · ${formatElapsed(session.startedAt)}`;
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
