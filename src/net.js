import { joinRoom, selfId } from 'trystero';

// All P2P networking rides on trystero: WebRTC data channels between
// browsers, with public Nostr relays used only for signaling/room discovery.
// No game server exists anywhere — GitHub Pages stays the only host.
const APP_ID = 'kjhunkler-towerdive-mp-v1';
const LOBBY_ROOM = 'lobby-v1';

// How often hosts re-announce to the lobby, and how long the menu waits
// before treating a silent host as gone. Nostr relays occasionally drop
// peer-leave events, so presence is heartbeat-based rather than
// join/leave-based.
export const LOBBY_HEARTBEAT_MS = 5000;
export const LOBBY_STALE_MS = 14000;

export { selfId };

// --- identity ---------------------------------------------------------------

const NAME_KEY = 'towerdive-player-name-v1';

export function getPlayerName() {
  try {
    return localStorage.getItem(NAME_KEY) || '';
  } catch {
    return '';
  }
}

export function setPlayerName(name) {
  try {
    localStorage.setItem(NAME_KEY, name.trim().slice(0, 24));
  } catch (error) {
    console.error('Failed to save player name:', error);
  }
}

// --- menu → workshop handoff -------------------------------------------------

// The menu writes an "intent" describing how the workshop should start
// (fresh map, saved map, hosting, or joining someone). sessionStorage keeps
// it per-tab so two tabs can host and join simultaneously for testing.
const INTENT_KEY = 'towerdive-net-intent-v1';

export function setNetIntent(intent) {
  try {
    sessionStorage.setItem(INTENT_KEY, JSON.stringify(intent));
  } catch (error) {
    console.error('Failed to save net intent:', error);
  }
}

export function getNetIntent() {
  try {
    const raw = sessionStorage.getItem(INTENT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// --- lobby: global presence ---------------------------------------------------

// Everyone (menus browsing for games, workshops hosting them) joins one
// well-known lobby room. Hosts broadcast heartbeats describing their
// session; menus collect them into a live session list.

export function watchLobby(onSessionsChanged) {
  const room = joinRoom({ appId: APP_ID }, LOBBY_ROOM);
  const announce = room.makeAction('announce');
  const sessions = new Map(); // hostId -> { name, players, startedAt, seenAt }

  function emit() {
    onSessionsChanged([...sessions.entries()].map(([hostId, info]) => ({ hostId, ...info })));
  }

  function prune() {
    let changed = false;
    for (const [hostId, info] of sessions) {
      if (performance.now() - info.seenAt > LOBBY_STALE_MS) {
        sessions.delete(hostId);
        changed = true;
      }
    }
    if (changed) emit();
  }

  announce.onMessage = (data, { peerId }) => {
    if (!data || typeof data !== 'object') return;
    sessions.set(peerId, {
      name: String(data.name ?? 'player'),
      players: Number(data.players) || 1,
      startedAt: Number(data.startedAt) || Date.now(),
      seenAt: performance.now(),
    });
    emit();
  };

  room.onPeerLeave = (peerId) => {
    if (sessions.delete(peerId)) emit();
  };

  const pruneTimer = setInterval(prune, 2000);

  return {
    leave() {
      clearInterval(pruneTimer);
      room.leave();
    },
  };
}

export function announceInLobby(getInfo) {
  const room = joinRoom({ appId: APP_ID }, LOBBY_ROOM);
  const announce = room.makeAction('announce');

  const send = (target) => {
    announce.send(getInfo(), target ? { target } : undefined).catch(() => {});
  };

  // Broadcast on a heartbeat and directly to freshly-arrived browsers so a
  // menu that opens mid-session sees the host immediately.
  room.onPeerJoin = (peerId) => send(peerId);
  const heartbeat = setInterval(() => send(), LOBBY_HEARTBEAT_MS);
  setTimeout(() => send(), 1000);

  return {
    update: () => send(),
    leave() {
      clearInterval(heartbeat);
      room.leave();
    },
  };
}

// --- game session --------------------------------------------------------------

// One room per hosted game, keyed by the host's trystero peer id. The mesh
// is fully connected; the host is only "special" in that it answers full-map
// sync requests from newcomers and announces the session in the lobby.
//
// Channels:
//   map   — full map snapshot (host → new peer), trystero chunks big payloads
//   op    — collaborative edit operations, applied by every peer
//   state — player snapshots (position/look/stance) at ~20 Hz for netcode
//   shot  — fire events so everyone sees tracers/impacts
//   hello — name introduction, sent to each newly-connected peer
export function createGameSession({ hostId, isHost, playerName, handlers = {} }) {
  const room = joinRoom({ appId: APP_ID }, `game-${hostId}`);
  const mapAction = room.makeAction('map');
  const opAction = room.makeAction('op');
  const stateAction = room.makeAction('state');
  const shotAction = room.makeAction('shot');
  const helloAction = room.makeAction('hello');

  const peers = new Map(); // peerId -> { name }

  helloAction.onMessage = (data, { peerId }) => {
    peers.set(peerId, { name: String(data?.name ?? 'player').slice(0, 24) });
    handlers.onPeersChanged?.();
  };

  room.onPeerJoin = (peerId) => {
    if (!peers.has(peerId)) peers.set(peerId, { name: null });
    helloAction.send({ name: playerName }, { target: peerId }).catch(() => {});
    if (isHost) handlers.onPeerNeedsMap?.(peerId);
    handlers.onPeersChanged?.();
  };

  room.onPeerLeave = (peerId) => {
    peers.delete(peerId);
    handlers.onPeerLeft?.(peerId);
    handlers.onPeersChanged?.();
  };

  mapAction.onMessage = (map, { peerId }) => handlers.onMap?.(map, peerId);
  opAction.onMessage = (op, { peerId }) => handlers.onOp?.(op, peerId);
  stateAction.onMessage = (state, { peerId }) => handlers.onState?.(state, peerId);
  shotAction.onMessage = (shot, { peerId }) => handlers.onShot?.(shot, peerId);

  return {
    selfId,
    peers,
    peerName(peerId) {
      return peers.get(peerId)?.name || 'player';
    },
    sendMap: (map, target) => mapAction.send(map, target ? { target } : undefined).catch(() => {}),
    sendOp: (op) => opAction.send(op).catch(() => {}),
    sendState: (state) => stateAction.send(state).catch(() => {}),
    sendShot: (shot) => shotAction.send(shot).catch(() => {}),
    leave: () => room.leave(),
  };
}
