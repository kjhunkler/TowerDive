import * as THREE from 'three';
import { spawnModel } from './assets.js';

const WEAPONS = [
  {
    id: 'carbine', name: 'Pulse Carbine', slot: '1', model: 'blaster/blaster-a', magazineSize: 24, reserveAmmo: 96,
    roundsPerMinute: 560, reloadTime: 1.28, damage: 25, range: 85, spreadHip: 0.012, spreadAds: 0.003,
    hipPosition: new THREE.Vector3(0.25, -0.23, -0.5), adsPosition: new THREE.Vector3(0, -0.16, -0.34),
    hipRotation: new THREE.Euler(-0.08, 0.2, 0.02), adsRotation: new THREE.Euler(-0.035, 0, 0), tracerColor: 0x82f6ff,
    kick: 0.025, kickReturn: 18, shotPitch: 260,
  },
  {
    id: 'scatter', name: 'Scatter Blaster', slot: '2', model: 'blaster/blaster-f', magazineSize: 8, reserveAmmo: 40,
    roundsPerMinute: 92, reloadTime: 1.55, damage: 14, pellets: 7, range: 48, spreadHip: 0.06, spreadAds: 0.035,
    hipPosition: new THREE.Vector3(0.28, -0.25, -0.56), adsPosition: new THREE.Vector3(0.02, -0.17, -0.38),
    hipRotation: new THREE.Euler(-0.1, 0.22, 0.025), adsRotation: new THREE.Euler(-0.05, 0.02, 0), tracerColor: 0xffb15f,
    kick: 0.065, kickReturn: 14, shotPitch: 145,
  },
  {
    id: 'lancer', name: 'Rail Lancer', slot: '3', model: 'blaster/blaster-r', magazineSize: 5, reserveAmmo: 20,
    roundsPerMinute: 54, reloadTime: 1.85, damage: 80, range: 130, spreadHip: 0.025, spreadAds: 0.0008,
    hipPosition: new THREE.Vector3(0.3, -0.24, -0.62), adsPosition: new THREE.Vector3(0, -0.15, -0.42),
    hipRotation: new THREE.Euler(-0.07, 0.24, 0.015), adsRotation: new THREE.Euler(-0.025, 0, 0), tracerColor: 0xd987ff,
    kick: 0.09, kickReturn: 11, shotPitch: 95,
  },
];

export function createWeaponController({ camera, canvas, scene, targets = [], onShot = null }) {
  let active = false, firingLocked = false, hud = null, model = null, muzzle = null;
  let index = 0, config = WEAPONS[0], ammo = {}, reserve = {}, fireCooldown = 0, reloadTimer = 0, aiming = false, firing = false;
  let adsAmount = 0, recoil = 0, swapTimer = 0, bobTime = 0, baseFov = camera.fov ?? 70;
  const raycaster = new THREE.Raycaster();
  const tempPos = new THREE.Vector3(), tempQuat = new THREE.Quaternion(), tempDir = new THREE.Vector3(), right = new THREE.Vector3();
  const center = new THREE.Vector2(0, 0);
  const hipQuat = new THREE.Quaternion(), adsQuat = new THREE.Quaternion();
  const flashMaterial = new THREE.MeshBasicMaterial({ color: 0xfff0a0, transparent: true, opacity: 0.9, depthWrite: false });
  const impactMaterial = new THREE.MeshBasicMaterial({ color: 0xfff2a8 });
  const casingMaterial = new THREE.MeshStandardMaterial({ color: 0xe2b45b, roughness: 0.45, metalness: 0.35 });
  const casings = [];
  const rnd = () => Math.random() - 0.5;

  WEAPONS.forEach((w) => { ammo[w.id] = w.magazineSize; reserve[w.id] = w.reserveAmmo; });

  let audioCtx = null;
  function tone(freq, duration = 0.045, volume = 0.035, type = 'square') {
    try {
      audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioCtx.createOscillator(); const gain = audioCtx.createGain();
      osc.type = type; osc.frequency.value = freq;
      gain.gain.setValueAtTime(volume, audioCtx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq * 0.45), audioCtx.currentTime + duration);
      gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + duration);
      osc.connect(gain).connect(audioCtx.destination); osc.start(); osc.stop(audioCtx.currentTime + duration);
    } catch { /* audio is optional */ }
  }

  function ensureHud() {
    if (hud) return;
    hud = document.createElement('div');
    hud.id = 'weapon-hud';
    hud.innerHTML = `
      <div id="weapon-reticle"><i></i><b></b><em></em><strong></strong></div>
      <div id="weapon-hitmarker">×</div>
      <div id="weapon-card"><div id="weapon-name"></div><div id="weapon-ammo"></div><div id="weapon-slots"></div></div>`;
    document.getElementById('app')?.appendChild(hud);
    updateHud();
  }

  async function loadModel() {
    const old = model;
    model = await spawnModel(config.model, { scale: 0.18 });
    model.traverse((child) => { if (child.isMesh) { child.castShadow = false; child.receiveShadow = false; child.frustumCulled = false; } });
    model.position.copy(config.hipPosition); model.quaternion.copy(hipQuat.setFromEuler(config.hipRotation));
    camera.add(model); if (!camera.parent) scene.add(camera);
    if (old) camera.remove(old);
  }

  function switchWeapon(next) {
    if (next === index || reloadTimer > 0) return;
    index = next; config = WEAPONS[index]; swapTimer = 0.2; firing = false; recoil = 0;
    hipQuat.setFromEuler(config.hipRotation); adsQuat.setFromEuler(config.adsRotation);
    loadModel(); updateHud(); tone(420, 0.035, 0.02, 'triangle');
  }

  function updateHud() {
    if (!hud) return;
    hud.querySelector('#weapon-name').textContent = config.name;
    hud.querySelector('#weapon-ammo').textContent = reloadTimer > 0 ? `RELOAD · ${ammo[config.id]}/${reserve[config.id]}` : `${ammo[config.id]}/${reserve[config.id]}`;
    hud.querySelector('#weapon-slots').textContent = WEAPONS.map((w, i) => i === index ? `[${w.slot}] ${w.name}` : `${w.slot} ${w.name}`).join('  ');
    hud.querySelector('#weapon-reticle').classList.toggle('ads', aiming);
    hud.querySelector('#weapon-card').classList.toggle('weapon-low-ammo', ammo[config.id] <= Math.ceil(config.magazineSize * 0.25));
  }

  function enter() { active = true; aiming = false; firing = false; ensureHud(); hipQuat.setFromEuler(config.hipRotation); adsQuat.setFromEuler(config.adsRotation); loadModel(); hud.hidden = false; baseFov = camera.fov ?? 70; window.addEventListener('mousedown', onMouseDown); window.addEventListener('mouseup', onMouseUp); window.addEventListener('keydown', onKeyDown); window.addEventListener('contextmenu', onContextMenu); updateHud(); }
  function exit() { active = false; aiming = false; firing = false; if (hud) hud.hidden = true; window.removeEventListener('mousedown', onMouseDown); window.removeEventListener('mouseup', onMouseUp); window.removeEventListener('keydown', onKeyDown); window.removeEventListener('contextmenu', onContextMenu); if (camera.isPerspectiveCamera) { camera.fov = baseFov; camera.updateProjectionMatrix(); } }
  function onContextMenu(e) { if (active && document.pointerLockElement === canvas) e.preventDefault(); }
  function onMouseDown(e) { if (!active || document.pointerLockElement !== canvas) return; if (e.button === 0) { firing = true; fire(); } if (e.button === 2) aiming = true; }
  function onMouseUp(e) { if (e.button === 0) firing = false; if (e.button === 2) aiming = false; }
  function onKeyDown(e) { if (!active || document.pointerLockElement !== canvas) return; if (e.code === 'KeyR') startReload(); if (/^Digit[123]$/.test(e.code)) switchWeapon(Number(e.code.slice(-1)) - 1); }
  function startReload() { if (reloadTimer > 0 || ammo[config.id] === config.magazineSize || reserve[config.id] <= 0) return; reloadTimer = config.reloadTime; firing = false; tone(180, 0.08, 0.025, 'sawtooth'); updateHud(); }
  function finishReload() { const needed = config.magazineSize - ammo[config.id]; const loaded = Math.min(needed, reserve[config.id]); ammo[config.id] += loaded; reserve[config.id] -= loaded; reloadTimer = 0; tone(520, 0.05, 0.025, 'triangle'); updateHud(); }

  function showHitmarker() { const el = hud?.querySelector('#weapon-hitmarker'); if (!el) return; el.classList.remove('weapon-hitmarker-pop'); void el.offsetWidth; el.classList.add('weapon-hitmarker-pop'); }
  function spawnTracer(from, to, strong = false) { const mat = new THREE.LineBasicMaterial({ color: config.tracerColor, transparent: true, opacity: strong ? 0.95 : 0.65 }); const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([from, to]), mat); scene.add(line); setTimeout(() => { scene.remove(line); line.geometry.dispose(); line.material.dispose(); }, strong ? 95 : 55); }
  function spawnImpact(point) { const marker = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 8), impactMaterial.clone()); marker.position.copy(point); scene.add(marker); setTimeout(() => { scene.remove(marker); marker.geometry.dispose(); marker.material.dispose(); }, 140); }
  function spawnMuzzle() { if (!model) return; if (muzzle) model.remove(muzzle); muzzle = new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.18, 7), flashMaterial.clone()); muzzle.rotation.x = Math.PI / 2; muzzle.position.set(0, 0.035, -0.42); model.add(muzzle); setTimeout(() => { if (muzzle) { model?.remove(muzzle); muzzle.geometry.dispose(); muzzle.material.dispose(); muzzle = null; } }, 35); }
  function ejectCasing() { const casing = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.055, 8), casingMaterial); camera.getWorldPosition(tempPos); camera.getWorldDirection(tempDir); right.set(1, 0, 0).applyQuaternion(camera.quaternion); casing.position.copy(tempPos).add(right.multiplyScalar(0.18)).add(tempDir.multiplyScalar(0.08)); casing.rotation.set(rnd(), rnd(), rnd()); scene.add(casing); casings.push({ mesh: casing, life: 0.8, vel: new THREE.Vector3(0.5 + Math.random() * 0.35, 0.35, rnd() * 0.4).applyQuaternion(camera.quaternion) }); }
  function findHitPeerId(intersection) { let object = intersection?.object; while (object) { if (object.userData.peerId) return object.userData.peerId; object = object.parent; } return null; }
  function shotDirection(spread) { raycaster.setFromCamera(center, camera); tempDir.copy(raycaster.ray.direction); right.set(1, 0, 0).applyQuaternion(camera.quaternion); const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion); tempDir.addScaledVector(right, rnd() * spread).addScaledVector(up, rnd() * spread).normalize(); return tempDir.clone(); }

  function fire() {
    if (!active || firingLocked || fireCooldown > 0 || reloadTimer > 0) return;
    if (ammo[config.id] <= 0) { tone(90, 0.04, 0.018, 'square'); startReload(); return; }
    ammo[config.id] -= 1; fireCooldown = 60 / config.roundsPerMinute; recoil += config.kick; spawnMuzzle(); ejectCasing(); tone(config.shotPitch, 0.055, 0.04, 'sawtooth');
    const pellets = config.pellets ?? 1; let bestPeer = null; let anyHit = false;
    camera.getWorldPosition(tempPos); const from = tempPos.clone();
    for (let i = 0; i < pellets; i++) {
      const dir = shotDirection(THREE.MathUtils.lerp(config.spreadHip, config.spreadAds, adsAmount));
      raycaster.set(from, dir); raycaster.far = config.range;
      const hits = raycaster.intersectObjects(targets, true); const to = hits[0]?.point ?? raycaster.ray.at(config.range, new THREE.Vector3());
      spawnTracer(from, to, config.id === 'lancer'); if (hits[0]) { anyHit = true; bestPeer ??= findHitPeerId(hits[0]); spawnImpact(hits[0].point); }
    }
    if (anyHit) showHitmarker(); onShot?.(from, raycaster.ray.at(config.range, new THREE.Vector3()), anyHit, bestPeer, config.damage);
    camera.rotation.x -= config.kick * 0.35; updateHud();
  }

  function updateCasings(delta) { for (let i = casings.length - 1; i >= 0; i--) { const c = casings[i]; c.life -= delta; c.vel.y -= 1.8 * delta; c.mesh.position.addScaledVector(c.vel, delta); c.mesh.rotation.x += delta * 8; c.mesh.rotation.z += delta * 5; if (c.life <= 0) { scene.remove(c.mesh); c.mesh.geometry.dispose(); casings.splice(i, 1); } } }

  function update(delta) {
    if (!active) return; fireCooldown = Math.max(0, fireCooldown - delta); swapTimer = Math.max(0, swapTimer - delta); updateCasings(delta);
    if (reloadTimer > 0) { reloadTimer -= delta; if (reloadTimer <= 0) finishReload(); }
    if (firing && fireCooldown <= 0) fire();
    adsAmount = THREE.MathUtils.damp(adsAmount, aiming ? 1 : 0, 18, delta); recoil = THREE.MathUtils.damp(recoil, 0, config.kickReturn, delta); bobTime += delta * (firing ? 13 : 6);
    if (model) {
      const bob = aiming ? 0.002 : 0.01; tempPos.copy(config.hipPosition).lerp(config.adsPosition, adsAmount);
      tempPos.x += Math.sin(bobTime) * bob; tempPos.y += Math.abs(Math.cos(bobTime)) * bob * 0.7 - recoil - (reloadTimer > 0 ? Math.sin((1 - reloadTimer / config.reloadTime) * Math.PI) * 0.08 : 0) - swapTimer * 0.6;
      tempPos.z += recoil * 1.35; tempQuat.copy(hipQuat).slerp(adsQuat, adsAmount);
      model.position.lerp(tempPos, 1 - Math.exp(-20 * delta)); model.quaternion.slerp(tempQuat, 1 - Math.exp(-18 * delta));
    }
    if (camera.isPerspectiveCamera) { camera.fov = THREE.MathUtils.lerp(baseFov, config.id === 'lancer' ? 38 : 48, adsAmount); camera.updateProjectionMatrix(); }
  }

  return { enter, exit, update, setFiringLocked(value) { firingLocked = value; if (value) firing = false; }, get active() { return active; } };
}
