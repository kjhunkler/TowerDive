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
export const LOBBY_STALE_MS = 20000;

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
  const sessions = new Map(); // sessionId -> { hostPeerId, name, players, startedAt, seenAt }

  function emit() {
    onSessionsChanged([...sessions.entries()].map(([hostId, info]) => ({ hostId, ...info })));
  }

  function prune() {
    let changed = false;
    for (const [sessionId, info] of sessions) {
      if (performance.now() - info.seenAt > LOBBY_STALE_MS) {
        sessions.delete(sessionId);
        changed = true;
      }
    }
    if (changed) emit();
  }

  announce.onMessage = (data, { peerId }) => {
    if (!data || typeof data !== 'object') return;
    const sessionId = String(data.sessionId || peerId);
    const current = sessions.get(sessionId);
    if (data.active === false) {
      if (
        current?.hostPeerId === peerId
        && Number(data.generation || 0) >= current.generation
        && sessions.delete(sessionId)
      ) emit();
      return;
    }
    const generation = Number(data.generation) || 0;
    if (current && generation < current.generation) return;
    if (current && generation === current.generation && current.hostPeerId < peerId) return;
    sessions.set(sessionId, {
      hostPeerId: peerId,
      generation,
      name: String(data.name ?? 'player'),
      mapName: String(data.mapName ?? ''),
      players: Number(data.players) || 1,
      startedAt: Number(data.startedAt) || Date.now(),
      seenAt: performance.now(),
    });
    emit();
  };

  room.onPeerLeave = (peerId) => {
    let changed = false;
    for (const [sessionId, info] of sessions) {
      if (info.hostPeerId === peerId) {
        sessions.delete(sessionId);
        changed = true;
      }
    }
    if (changed) emit();
  };

  const pruneTimer = setInterval(prune, 2000);

  return {
    leave() {
      clearInterval(pruneTimer);
      room.leave();
    },
  };
}

export function announceInLobby(sessionId, getInfo) {
  const room = joinRoom({ appId: APP_ID }, LOBBY_ROOM);
  const announce = room.makeAction('announce');

  const send = (target) => {
    announce.send(
      { ...getInfo(), sessionId, active: true },
      target ? { target } : undefined
    ).catch(() => {});
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
      const info = getInfo();
      announce.send({
        sessionId,
        active: false,
        generation: Number(info.generation) || 0,
      }).catch(() => {});
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
//   dm    — deathmatch events: hits, deaths, and referee match control
export function createGameSession({ hostId, playerName, ready = true, handlers = {} }) {
  const room = joinRoom({ appId: APP_ID }, `game-${hostId}`);
  const mapAction = room.makeAction('map');
  const opAction = room.makeAction('op');
  const stateAction = room.makeAction('state');
  const shotAction = room.makeAction('shot');
  const helloAction = room.makeAction('hello');
  const dmAction = room.makeAction('dm');
  const authorityAction = room.makeAction('authority');
  const presenceAction = room.makeAction('presence');

  const peers = new Map(); // peerId -> { name, seenAt }
  let currentHostId = hostId;
  let hostGeneration = 0;
  let selfReady = ready;

  function notifyHostChanged() {
    handlers.onHostChanged?.(currentHostId);
  }

  function setCurrentHost(nextHostId, generation = hostGeneration) {
    if (currentHostId === nextHostId && hostGeneration === generation) return;
    currentHostId = nextHostId;
    hostGeneration = generation;
    notifyHostChanged();
    if (currentHostId === selfId) {
      authorityAction.send({ hostId: selfId, generation: hostGeneration }).catch(() => {});
    }
  }

  function readyCandidates() {
    const candidates = [];
    if (selfReady) candidates.push(selfId);
    for (const [peerId, peer] of peers) {
      if (peer.ready) candidates.push(peerId);
    }
    return candidates.sort();
  }

  function reconcileHost() {
    const currentIsReady = currentHostId === selfId
      ? selfReady
      : peers.get(currentHostId)?.ready;
    if (currentIsReady) return;
    // A newcomer without a map must learn the established migrated authority;
    // it cannot safely invent the next generation from partial peer knowledge.
    if (!selfReady && hostGeneration === 0 && currentHostId === hostId) return;

    const candidates = readyCandidates();
    if (hostGeneration === 0 && peers.get(hostId)?.ready) {
      setCurrentHost(hostId, 0);
      return;
    }
    const nextGeneration = currentHostId ? hostGeneration + 1 : hostGeneration;
    setCurrentHost(candidates[0] || null, nextGeneration);
  }

  function touchPeer(peerId, name, peerReady) {
    const existing = peers.get(peerId);
    peers.set(peerId, {
      name: name ?? existing?.name ?? null,
      ready: peerReady ?? existing?.ready ?? false,
      seenAt: performance.now(),
    });
  }

  helloAction.onMessage = (data, { peerId }) => {
    touchPeer(peerId, String(data?.name ?? 'player').slice(0, 24), data?.ready === true);
    reconcileHost();
    handlers.onPeersChanged?.();
  };

  room.onPeerJoin = (peerId) => {
    touchPeer(peerId);
    helloAction.send({ name: playerName, ready: selfReady }, { target: peerId }).catch(() => {});
    authorityAction.send(
      { hostId: currentHostId, generation: hostGeneration },
      { target: peerId }
    ).catch(() => {});
    if (currentHostId === selfId) handlers.onPeerNeedsMap?.(peerId);
    handlers.onPeersChanged?.();
  };

  function removePeer(peerId) {
    if (!peers.delete(peerId)) return;
    handlers.onPeerLeft?.(peerId);
    if (peerId === currentHostId) reconcileHost();
    handlers.onPeersChanged?.();
  }

  room.onPeerLeave = removePeer;

  authorityAction.onMessage = (data, { peerId }) => {
    touchPeer(peerId);
    const proposedHostId = String(data?.hostId || '');
    const proposedGeneration = Number(data?.generation) || 0;
    const proposedReady = proposedHostId === selfId
      ? selfReady
      : peers.get(proposedHostId)?.ready;
    if (!proposedHostId || !proposedReady) return;
    if (
      proposedGeneration > hostGeneration
      || (proposedGeneration === hostGeneration && (!currentHostId || proposedHostId < currentHostId))
    ) {
      setCurrentHost(proposedHostId, proposedGeneration);
    }
    reconcileHost();
  };

  presenceAction.onMessage = (data, { peerId }) => {
    const isNew = !peers.has(peerId);
    touchPeer(peerId, undefined, data?.ready === true);
    reconcileHost();
    if (isNew) handlers.onPeersChanged?.();
  };

  const presenceTimer = setInterval(() => {
    presenceAction.send({ at: Date.now(), ready: selfReady }).catch(() => {});
    if (currentHostId === selfId) {
      authorityAction.send({ hostId: selfId, generation: hostGeneration }).catch(() => {});
    }
    for (const [peerId, peer] of peers) {
      if (performance.now() - peer.seenAt > LOBBY_STALE_MS * 2) removePeer(peerId);
    }
    reconcileHost();
  }, LOBBY_HEARTBEAT_MS);

  mapAction.onMessage = (map, { peerId }) => handlers.onMap?.(map, peerId);
  opAction.onMessage = (op, { peerId }) => handlers.onOp?.(op, peerId);
  stateAction.onMessage = (state, { peerId }) => handlers.onState?.(state, peerId);
  shotAction.onMessage = (shot, { peerId }) => handlers.onShot?.(shot, peerId);
  dmAction.onMessage = (event, { peerId }) => handlers.onDm?.(event, peerId);

  return {
    selfId,
    peers,
    get currentHostId() {
      return currentHostId;
    },
    get isHost() {
      return currentHostId === selfId;
    },
    get hostGeneration() {
      return hostGeneration;
    },
    setReady(value) {
      selfReady = Boolean(value);
      presenceAction.send({ at: Date.now(), ready: selfReady }).catch(() => {});
      reconcileHost();
    },
    peerName(peerId) {
      return peers.get(peerId)?.name || 'player';
    },
    sendMap: (map, target) => mapAction.send(map, target ? { target } : undefined).catch(() => {}),
    sendOp: (op) => opAction.send(op).catch(() => {}),
    sendState: (state) => stateAction.send(state).catch(() => {}),
    sendShot: (shot) => shotAction.send(shot).catch(() => {}),
    sendDm: (event) => dmAction.send(event).catch(() => {}),
    leave() {
      clearInterval(presenceTimer);
      room.leave();
    },
  };
}
