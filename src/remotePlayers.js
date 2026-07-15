import * as THREE from 'three';
import { spawnModel } from './assets.js';

// Renders the other players in a multiplayer session.
//
// Netcode model (the standard FPS recipe, adapted to a P2P mesh):
// - Your own movement is fully client-predicted — the walk controller already
//   simulates locally, so your input has zero added latency.
// - Peers broadcast small state snapshots at a fixed rate. We never display a
//   snapshot directly; instead each remote player is rendered ~120 ms in the
//   past, interpolating between the two snapshots that bracket that time
//   (Source-engine style snapshot interpolation). This turns a jittery
//   packet stream into perfectly smooth motion at the cost of a fixed,
//   imperceptible display delay.
// - If packets stall, we extrapolate along the last known velocity for up to
//   200 ms, then freeze rather than fling the avatar into the distance.
// - Fire events are replicated as one-shot tracer/impact effects.
const INTERP_DELAY_MS = 120;
const MAX_EXTRAPOLATION_MS = 200;
const STALE_HIDE_MS = 5000;
const BUFFER_KEEP_MS = 1500;

// Avatars are built at this reference eye height and squashed/stretched to
// the peer's live eye height, so crouch/prone read at a glance.
const REF_EYE = 0.5;

function peerColor(peerId) {
  let hash = 0;
  for (let i = 0; i < peerId.length; i++) hash = (hash * 31 + peerId.charCodeAt(i)) >>> 0;
  return new THREE.Color().setHSL((hash % 360) / 360, 0.72, 0.56);
}

function lerpAngle(a, b, t) {
  let diff = (b - a) % (Math.PI * 2);
  if (diff > Math.PI) diff -= Math.PI * 2;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}

function makeNameSprite(name, color) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.font = '600 34px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(10, 14, 24, 0.65)';
  const width = Math.min(ctx.measureText(name).width + 28, 252);
  ctx.beginPath();
  ctx.roundRect((256 - width) / 2, 8, width, 48, 12);
  ctx.fill();
  ctx.fillStyle = `#${color.getHexString()}`;
  ctx.fillText(name, 128, 34, 224);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true })
  );
  sprite.renderOrder = 20;
  sprite.scale.set(0.9, 0.225, 1);
  return sprite;
}

export function createRemotePlayers({ scene, cellToWorld, tileSize = 1 }) {
  const peers = new Map(); // peerId -> peer record
  const effects = [];

  function buildAvatar(color) {
    const group = new THREE.Group();

    const bodyMaterial = new THREE.MeshStandardMaterial({ color, roughness: 0.55 });
    const radius = REF_EYE * 0.28;
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(radius, REF_EYE * 0.72, 6, 14), bodyMaterial);
    body.position.y = REF_EYE * 0.64;
    body.castShadow = true;
    group.add(body);

    // Head pivots for pitch; the group itself carries yaw.
    const head = new THREE.Group();
    head.position.y = REF_EYE;
    group.add(head);

    const visor = new THREE.Mesh(
      new THREE.BoxGeometry(radius * 1.3, REF_EYE * 0.13, REF_EYE * 0.1),
      new THREE.MeshStandardMaterial({ color: 0x101822, roughness: 0.2, metalness: 0.4 })
    );
    visor.position.set(0, 0.02, -radius * 0.95);
    head.add(visor);

    spawnModel('blaster/blaster-a', { scale: 0.14 })
      .then((weapon) => {
        weapon.traverse((child) => {
          if (child.isMesh) child.castShadow = false;
        });
        weapon.position.set(radius * 0.9, -REF_EYE * 0.18, -radius * 0.9);
        head.add(weapon);
      })
      .catch(() => {});

    return { group, head };
  }

  function ensurePeer(peerId) {
    let peer = peers.get(peerId);
    if (peer) return peer;
    const color = peerColor(peerId);
    peer = {
      color,
      name: 'player',
      buffer: [], // snapshots: { t, x, y, z, yaw, pitch, eye, mode, cell }
      avatar: null,
      head: null,
      nameSprite: null,
      cursor: null,
      cursorSprite: null,
    };
    peers.set(peerId, peer);
    return peer;
  }

  function ensureAvatar(peer) {
    if (peer.avatar) return;
    const { group, head } = buildAvatar(peer.color);
    peer.avatar = group;
    peer.head = head;
    peer.nameSprite = makeNameSprite(peer.name, peer.color);
    peer.nameSprite.position.y = REF_EYE * 1.55;
    group.add(peer.nameSprite);
    group.visible = false;
    scene.add(group);
  }

  function ensureCursor(peer) {
    if (peer.cursor) return;
    const cursor = new THREE.Group();
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(tileSize * 0.96, tileSize * 0.96),
      new THREE.MeshBasicMaterial({ color: peer.color, transparent: true, opacity: 0.32, depthWrite: false })
    );
    plane.rotation.x = -Math.PI / 2;
    plane.position.y = 0.03;
    cursor.add(plane);
    const sprite = makeNameSprite(peer.name, peer.color);
    sprite.position.y = 0.45;
    cursor.add(sprite);
    peer.cursor = cursor;
    peer.cursorSprite = sprite;
    cursor.visible = false;
    scene.add(cursor);
  }

  function refreshName(peer) {
    for (const key of ['nameSprite', 'cursorSprite']) {
      const old = peer[key];
      if (!old) continue;
      const fresh = makeNameSprite(peer.name, peer.color);
      fresh.position.copy(old.position);
      old.parent.add(fresh);
      old.parent.remove(old);
      old.material.map.dispose();
      old.material.dispose();
      peer[key] = fresh;
    }
  }

  function setPeerName(peerId, name) {
    const peer = ensurePeer(peerId);
    if (peer.name === name) return;
    peer.name = name;
    refreshName(peer);
  }

  function pushState(peerId, state) {
    if (!state || !Array.isArray(state.p)) return;
    const peer = ensurePeer(peerId);
    peer.buffer.push({
      t: performance.now(),
      x: state.p[0],
      y: state.p[1],
      z: state.p[2],
      yaw: Number(state.y) || 0,
      pitch: Number(state.pt) || 0,
      eye: Number(state.eh) || REF_EYE,
      mode: state.m === 'x' ? 'explore' : 'edit',
      cell: Array.isArray(state.c) ? state.c : null,
    });
    const cutoff = performance.now() - INTERP_DELAY_MS - BUFFER_KEEP_MS;
    while (peer.buffer.length > 2 && peer.buffer[0].t < cutoff) peer.buffer.shift();
  }

  function removePeer(peerId) {
    const peer = peers.get(peerId);
    if (!peer) return;
    if (peer.avatar) scene.remove(peer.avatar);
    if (peer.cursor) scene.remove(peer.cursor);
    peers.delete(peerId);
  }

  // Sampled remote pose at (now - interpolation delay).
  function samplePose(buffer, now) {
    const renderTime = now - INTERP_DELAY_MS;
    const latest = buffer[buffer.length - 1];
    if (latest.t <= renderTime) {
      // Ran out of fresh snapshots: extrapolate briefly along last velocity.
      const prev = buffer.length > 1 ? buffer[buffer.length - 2] : null;
      const overshoot = Math.min(renderTime - latest.t, MAX_EXTRAPOLATION_MS);
      if (!prev || overshoot <= 0 || latest.t === prev.t) return { ...latest };
      const step = overshoot / (latest.t - prev.t);
      return {
        ...latest,
        x: latest.x + (latest.x - prev.x) * step,
        y: latest.y + (latest.y - prev.y) * step,
        z: latest.z + (latest.z - prev.z) * step,
      };
    }
    let older = buffer[0];
    let newer = latest;
    for (let i = buffer.length - 1; i > 0; i--) {
      if (buffer[i - 1].t <= renderTime) {
        older = buffer[i - 1];
        newer = buffer[i];
        break;
      }
    }
    const span = newer.t - older.t;
    const t = span > 0 ? THREE.MathUtils.clamp((renderTime - older.t) / span, 0, 1) : 1;
    return {
      x: THREE.MathUtils.lerp(older.x, newer.x, t),
      y: THREE.MathUtils.lerp(older.y, newer.y, t),
      z: THREE.MathUtils.lerp(older.z, newer.z, t),
      yaw: lerpAngle(older.yaw, newer.yaw, t),
      pitch: THREE.MathUtils.lerp(older.pitch, newer.pitch, t),
      eye: THREE.MathUtils.lerp(older.eye, newer.eye, t),
      mode: newer.mode,
      cell: newer.cell,
    };
  }

  function update() {
    const now = performance.now();
    for (const peer of peers.values()) {
      const latest = peer.buffer[peer.buffer.length - 1];
      const stale = !latest || now - latest.t > STALE_HIDE_MS;
      if (stale) {
        if (peer.avatar) peer.avatar.visible = false;
        if (peer.cursor) peer.cursor.visible = false;
        continue;
      }
      const pose = samplePose(peer.buffer, now);

      if (pose.mode === 'explore') {
        ensureAvatar(peer);
        if (peer.cursor) peer.cursor.visible = false;
        peer.avatar.visible = true;
        // State carries the eye position; the avatar's origin is the feet.
        // Camera convention: forward is -Z rotated by yaw, positive pitch
        // looks up — the visor sits on the avatar's local -Z, so both angles
        // transfer directly.
        peer.avatar.position.set(pose.x, pose.y - pose.eye, pose.z);
        peer.avatar.rotation.y = pose.yaw;
        const squash = THREE.MathUtils.clamp(pose.eye / REF_EYE, 0.25, 1.4);
        peer.avatar.scale.set(1, squash, 1);
        peer.head.rotation.x = pose.pitch;
      } else {
        if (peer.avatar) peer.avatar.visible = false;
        if (pose.cell) {
          ensureCursor(peer);
          const { x, z } = cellToWorld(pose.cell[0], pose.cell[1]);
          peer.cursor.position.set(x, 0, z);
          peer.cursor.visible = true;
        } else if (peer.cursor) {
          peer.cursor.visible = false;
        }
      }
    }

    for (let i = effects.length - 1; i >= 0; i--) {
      const effect = effects[i];
      if (now >= effect.until) {
        scene.remove(effect.object);
        effect.object.geometry.dispose();
        effect.object.material.dispose();
        effects.splice(i, 1);
      }
    }
  }

  function showShot(shot) {
    if (!Array.isArray(shot?.f) || !Array.isArray(shot?.t)) return;
    const from = new THREE.Vector3(...shot.f);
    const to = new THREE.Vector3(...shot.t);
    const tracer = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([from, to]),
      new THREE.LineBasicMaterial({ color: 0xffb27d, transparent: true, opacity: 0.8 })
    );
    scene.add(tracer);
    effects.push({ object: tracer, until: performance.now() + 60 });
    if (shot.hit) {
      const impact = new THREE.Mesh(
        new THREE.SphereGeometry(0.035, 8, 8),
        new THREE.MeshBasicMaterial({ color: 0xfff2a8 })
      );
      impact.position.copy(to);
      scene.add(impact);
      effects.push({ object: impact, until: performance.now() + 140 });
    }
  }

  function dispose() {
    for (const peerId of [...peers.keys()]) removePeer(peerId);
    for (const effect of effects) scene.remove(effect.object);
    effects.length = 0;
  }

  return { setPeerName, pushState, removePeer, showShot, update, dispose };
}
