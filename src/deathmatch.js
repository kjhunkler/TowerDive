// Deathmatch for multiplayer explore mode.
//
// Authority model (no server exists anywhere):
// - Hit detection is shooter-side: you hit what you see, against the
//   interpolated avatars on your screen — the P2P equivalent of server-side
//   lag compensation ("favor the shooter").
// - Health is victim-authoritative: only the player who got shot applies
//   damage to themselves and announces their own death, so nobody can
//   disagree about whether you died.
// - Match flow (countdown, round wins, restarts) is driven by one referee:
//   the connected peer with the lowest id. Everyone evaluates the same rule,
//   so the role deterministically survives players leaving. The referee
//   also broadcasts periodic score syncs, which lets late joiners and any
//   drifted peer converge.
//
// Match rules: starts (and restarts) when every player in the session is in
// explore mode; first to 10 kills wins a round; best of 3 rounds wins the
// match.
export const KILLS_TO_WIN = 10;
export const ROUNDS_TO_WIN = 2;
const MIN_PLAYERS = 2;
const COUNTDOWN_SECS = 5;
const NEXT_ROUND_COUNTDOWN_SECS = 3;
const INTERMISSION_MS = 6000;
const OVER_MS = 8000;
const RESPAWN_MS = 3000;
const MAX_HEALTH = 100;
const HIT_DAMAGE = 25;
const REFEREE_TICK_MS = 500;
const SYNC_INTERVAL_MS = 5000;

// --- tiny synth announcer sounds (no audio assets in the repo) --------------

let audioCtx = null;

function beep(freq, duration = 0.09, volume = 0.05, type = 'square') {
  try {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(volume, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + duration);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + duration);
  } catch {
    // No audio available — announcer stays visual-only.
  }
}

const SOUNDS = {
  tick: () => beep(620, 0.07),
  go: () => beep(980, 0.22, 0.06),
  kill: () => beep(300, 0.1, 0.05, 'sawtooth'),
  death: () => beep(140, 0.35, 0.06, 'sawtooth'),
  win: () => { beep(660, 0.12); setTimeout(() => beep(880, 0.12), 130); setTimeout(() => beep(1100, 0.2), 260); },
};

export function createDeathmatch({
  selfId,
  send, // broadcast a dm event to all peers
  getSelfName,
  getPeerName,
  getPeerIds, // all connected peer ids (game room membership)
  isExploring, // is the local player in explore mode
  setDead, // (dead) => freeze walker / lock weapons
  respawn, // teleport local player to a fresh spawn point
}) {
  let phase = 'idle'; // idle | countdown | active | intermission | over
  let round = 1;
  let phaseEndsAt = 0;
  let kills = {}; // peerId -> kills this round
  let wins = {}; // peerId -> rounds won this match
  let health = MAX_HEALTH;
  let alive = true;
  let respawnDueAt = 0;
  let lastShownCount = null;
  let lastRefereeTick = 0;
  let lastSyncSentAt = 0;
  const peerModes = new Map(); // peerId -> 'x' | 'e'

  // --- HUD --------------------------------------------------------------------

  const app = document.getElementById('app');

  function el(id, className) {
    const node = document.createElement('div');
    node.id = id;
    if (className) node.className = className;
    node.hidden = true;
    app.appendChild(node);
    return node;
  }

  const announcerEl = el('dm-announcer');
  const feedEl = el('dm-feed');
  const scoreboardEl = el('dm-scoreboard');
  const healthEl = el('dm-health');
  const deathEl = el('dm-death');
  const vignetteEl = el('dm-vignette');

  let announceTimer = null;

  function announce(text, { ms = 2200, big = false } = {}) {
    announcerEl.hidden = false;
    announcerEl.textContent = text;
    announcerEl.classList.toggle('dm-announcer-big', big);
    announcerEl.classList.remove('dm-announcer-pop');
    void announcerEl.offsetWidth; // restart the pop animation
    announcerEl.classList.add('dm-announcer-pop');
    clearTimeout(announceTimer);
    announceTimer = setTimeout(() => { announcerEl.hidden = true; }, ms);
  }

  function feed(text) {
    const line = document.createElement('div');
    line.className = 'dm-feed-line';
    line.textContent = text;
    feedEl.hidden = false;
    feedEl.appendChild(line);
    while (feedEl.children.length > 4) feedEl.firstChild.remove();
    setTimeout(() => {
      line.remove();
      if (feedEl.children.length === 0) feedEl.hidden = true;
    }, 4500);
  }

  function nameOf(id) {
    return id === selfId ? getSelfName() : getPeerName(id);
  }

  function playerIds() {
    return [selfId, ...getPeerIds()];
  }

  function renderScoreboard() {
    if (phase === 'idle') {
      scoreboardEl.hidden = true;
      return;
    }
    scoreboardEl.hidden = false;
    const rows = playerIds()
      .map((id) => ({ id, kills: kills[id] || 0, wins: wins[id] || 0 }))
      .sort((a, b) => b.kills - a.kills || b.wins - a.wins);
    const header = document.createElement('div');
    header.className = 'dm-scoreboard-header';
    header.textContent = `Round ${round} · first to ${KILLS_TO_WIN} · best of 3`;
    scoreboardEl.replaceChildren(header, ...rows.map((row) => {
      const line = document.createElement('div');
      line.className = 'dm-scoreboard-row' + (row.id === selfId ? ' dm-scoreboard-self' : '');
      const name = document.createElement('span');
      name.textContent = `${'★'.repeat(row.wins)} ${nameOf(row.id)}`;
      const score = document.createElement('span');
      score.textContent = String(row.kills);
      line.append(name, score);
      return line;
    }));
  }

  function renderHealth() {
    const show = phase === 'active' && isExploring();
    healthEl.hidden = !show;
    if (!show) return;
    healthEl.innerHTML = `<div id="dm-health-fill" style="width:${Math.max(0, health)}%"></div><span>${Math.max(0, health)}</span>`;
    healthEl.classList.toggle('dm-health-low', health <= 25);
  }

  function flashDamage() {
    vignetteEl.hidden = false;
    vignetteEl.classList.remove('dm-vignette-flash');
    void vignetteEl.offsetWidth;
    vignetteEl.classList.add('dm-vignette-flash');
  }

  // --- local life cycle ---------------------------------------------------

  function resetLife() {
    health = MAX_HEALTH;
    alive = true;
    deathEl.hidden = true;
    setDead(false);
    renderHealth();
  }

  function die(killerId) {
    alive = false;
    health = 0;
    respawnDueAt = performance.now() + RESPAWN_MS;
    setDead(true);
    deathEl.hidden = false;
    SOUNDS.death();
    recordKill(killerId, selfId);
    send({ k: 'death', killer: killerId });
    renderHealth();
  }

  function applyDamage(dmg, fromId) {
    if (phase !== 'active' || !alive || !isExploring()) return;
    health -= dmg;
    flashDamage();
    if (health <= 0) die(fromId);
    renderHealth();
  }

  // --- scoring --------------------------------------------------------------

  function recordKill(killerId, victimId) {
    if (phase !== 'active') return;
    if (killerId && killerId !== victimId) {
      kills[killerId] = (kills[killerId] || 0) + 1;
      if (killerId === selfId) {
        announce(`You eliminated ${nameOf(victimId)}`, { ms: 1600 });
        SOUNDS.kill();
      }
    }
    feed(`${nameOf(killerId) ?? '?'} ⚡ ${nameOf(victimId)}`);
    renderScoreboard();
    if (isReferee() && killerId && (kills[killerId] || 0) >= KILLS_TO_WIN) {
      const nextWins = { ...wins, [killerId]: (wins[killerId] || 0) + 1 };
      if (nextWins[killerId] >= ROUNDS_TO_WIN) {
        broadcastCtl({ ev: 'mend', winner: killerId, wins: nextWins, kills });
      } else {
        broadcastCtl({ ev: 'rend', winner: killerId, wins: nextWins, kills, round });
      }
    }
  }

  // --- match control (referee + everyone applying ctl events) ---------------

  // Lowest peer id runs the match. No player-count minimum here: if everyone
  // else leaves mid-match, the lone survivor must still referee (and abort)
  // their own game. Match starts are gated separately on MIN_PLAYERS.
  function isReferee() {
    return playerIds().sort()[0] === selfId;
  }

  function broadcastCtl(ctl) {
    send({ k: 'ctl', ...ctl });
    applyCtl(ctl);
  }

  function applyCtl(ctl) {
    switch (ctl.ev) {
      case 'count':
        phase = 'countdown';
        round = ctl.round;
        phaseEndsAt = performance.now() + ctl.secs * 1000;
        lastShownCount = null;
        if (ctl.round === 1) {
          wins = {};
          kills = {};
        }
        resetLife();
        renderScoreboard();
        break;
      case 'go':
        phase = 'active';
        round = ctl.round;
        kills = {};
        resetLife();
        if (isExploring()) respawn();
        announce('GO!', { ms: 1200, big: true });
        SOUNDS.go();
        renderScoreboard();
        renderHealth();
        break;
      case 'rend':
        phase = 'intermission';
        phaseEndsAt = performance.now() + INTERMISSION_MS;
        kills = ctl.kills || kills;
        wins = ctl.wins || wins;
        resetLife();
        announce(`${nameOf(ctl.winner)} wins round ${ctl.round}!`, { ms: 3500, big: true });
        SOUNDS.win();
        renderScoreboard();
        renderHealth();
        break;
      case 'mend':
        phase = 'over';
        phaseEndsAt = performance.now() + OVER_MS;
        wins = ctl.wins || wins;
        resetLife();
        announce(`🏆 ${nameOf(ctl.winner)} wins the match!`, { ms: 5000, big: true });
        SOUNDS.win();
        renderScoreboard();
        renderHealth();
        break;
      case 'abort':
        phase = 'idle';
        resetLife();
        announce('Deathmatch cancelled', { ms: 2000 });
        renderScoreboard();
        renderHealth();
        break;
      case 'sync':
        // Authoritative snapshot from the referee: adopt it wholesale so
        // late joiners and drifted peers converge.
        if (ctl.phase !== phase) {
          phase = ctl.phase;
          lastShownCount = null;
          if (phase === 'active' || phase === 'idle') resetLife();
        }
        if (typeof ctl.endsIn === 'number') phaseEndsAt = performance.now() + ctl.endsIn;
        round = ctl.round;
        kills = ctl.kills || kills;
        wins = ctl.wins || wins;
        renderScoreboard();
        renderHealth();
        break;
    }
  }

  function refereeTick(now) {
    if (!isReferee()) return;
    const ids = playerIds();
    const total = ids.length;
    const exploring = (isExploring() ? 1 : 0)
      + getPeerIds().filter((id) => peerModes.get(id) === 'x').length;
    const everyoneExploring = total >= MIN_PLAYERS && exploring === total;

    if (phase === 'idle') {
      if (everyoneExploring) {
        broadcastCtl({ ev: 'count', round: 1, secs: COUNTDOWN_SECS });
      }
      return;
    }
    if (!everyoneExploring && phase !== 'over') {
      broadcastCtl({ ev: 'abort' });
      return;
    }
    if (phase === 'countdown' && now >= phaseEndsAt) {
      broadcastCtl({ ev: 'go', round });
    } else if (phase === 'intermission' && now >= phaseEndsAt) {
      broadcastCtl({ ev: 'count', round: round + 1, secs: NEXT_ROUND_COUNTDOWN_SECS });
    }

    if (phase !== 'idle' && now - lastSyncSentAt >= SYNC_INTERVAL_MS) {
      lastSyncSentAt = now;
      send({
        k: 'ctl',
        ev: 'sync',
        phase,
        round,
        kills,
        wins,
        endsIn: Math.max(0, Math.round(phaseEndsAt - now)),
      });
    }
  }

  // --- public API -------------------------------------------------------------

  function handleRemote(event, peerId) {
    if (!event || typeof event !== 'object') return;
    if (event.k === 'hit') {
      if (event.target === selfId) applyDamage(Number(event.dmg) || HIT_DAMAGE, peerId);
    } else if (event.k === 'death') {
      recordKill(event.killer, peerId);
    } else if (event.k === 'ctl') {
      applyCtl(event);
    }
  }

  // Called by the shooter when a fired ray hits a remote avatar.
  function reportHit(peerId) {
    if (phase !== 'active' || !alive || !isExploring()) return;
    if (peerModes.get(peerId) !== 'x') return;
    send({ k: 'hit', target: peerId, dmg: HIT_DAMAGE });
  }

  function setPeerMode(peerId, mode) {
    peerModes.set(peerId, mode);
  }

  function peerLeft(peerId) {
    peerModes.delete(peerId);
    renderScoreboard();
  }

  function update() {
    const now = performance.now();

    // Countdown ticker (visual + beep), driven locally from the shared
    // deadline so every screen counts in step.
    if (phase === 'countdown') {
      const remaining = Math.max(1, Math.ceil((phaseEndsAt - now) / 1000));
      if (remaining !== lastShownCount) {
        lastShownCount = remaining;
        announce(String(remaining), { ms: 1100, big: true });
        SOUNDS.tick();
      }
    }

    if (phase === 'over' && now >= phaseEndsAt) {
      phase = 'idle';
      renderScoreboard();
      renderHealth();
    }

    if (!alive && phase === 'active') {
      const left = Math.max(0, respawnDueAt - now);
      deathEl.textContent = `☠ Respawning in ${Math.ceil(left / 1000)}…`;
      if (left <= 0) {
        resetLife();
        if (isExploring()) respawn();
      }
    }

    if (now - lastRefereeTick >= REFEREE_TICK_MS) {
      lastRefereeTick = now;
      refereeTick(now);
    }
  }

  // Re-check the health HUD when the local player enters/leaves explore mode.
  function refreshHud() {
    renderHealth();
    renderScoreboard();
  }

  return { handleRemote, reportHit, setPeerMode, peerLeft, update, refreshHud };
}
