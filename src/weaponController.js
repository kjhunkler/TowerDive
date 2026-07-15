import * as THREE from 'three';
import { spawnModel } from './assets.js';

const WEAPON_DEFAULTS = {
  model: 'blaster/blaster-a',
  magazineSize: 24,
  reserveAmmo: 96,
  roundsPerMinute: 520,
  reloadTime: 1.35,
  damage: 25,
  range: 80,
  hipPosition: new THREE.Vector3(0.24, -0.22, -0.48),
  adsPosition: new THREE.Vector3(0, -0.16, -0.34),
  hipRotation: new THREE.Euler(-0.08, 0.18, 0.02),
  adsRotation: new THREE.Euler(-0.04, 0, 0),
  hipFov: 70,
  adsFov: 48,
  adsLerp: 18,
  recoilKick: 0.018,
};

export function createWeaponController({ camera, canvas, scene, targets = [], onShot = null }) {
  const config = { ...WEAPON_DEFAULTS };
  let active = false;
  let firingLocked = false;
  let model = null;
  let hud = null;
  let ammo = config.magazineSize;
  let reserve = config.reserveAmmo;
  let fireCooldown = 0;
  let reloadTimer = 0;
  let aiming = false;
  let firing = false;
  let adsAmount = 0;
  let baseFov = camera.fov ?? config.hipFov;

  const raycaster = new THREE.Raycaster();
  const center = new THREE.Vector2(0, 0);
  const tempPos = new THREE.Vector3();
  const tempQuat = new THREE.Quaternion();
  const hipQuat = new THREE.Quaternion().setFromEuler(config.hipRotation);
  const adsQuat = new THREE.Quaternion().setFromEuler(config.adsRotation);
  const tracerMaterial = new THREE.LineBasicMaterial({ color: 0x82f6ff, transparent: true, opacity: 0.75 });
  const impactMaterial = new THREE.MeshBasicMaterial({ color: 0xfff2a8 });

  function ensureHud() {
    if (hud) return;
    hud = document.createElement('div');
    hud.id = 'weapon-hud';
    hud.innerHTML = '<div id="weapon-reticle"></div><div id="weapon-ammo"></div>';
    document.getElementById('app')?.appendChild(hud);
    updateHud();
  }

  async function ensureModel() {
    if (model) return;
    model = await spawnModel(config.model, { scale: 0.18 });
    model.traverse((child) => {
      if (child.isMesh) {
        child.castShadow = false;
        child.receiveShadow = false;
        child.frustumCulled = false;
      }
    });
    model.position.copy(config.hipPosition);
    model.quaternion.copy(hipQuat);
    camera.add(model);
    if (!camera.parent) scene.add(camera);
  }

  function updateHud() {
    if (!hud) return;
    const ammoEl = hud.querySelector('#weapon-ammo');
    const reticleEl = hud.querySelector('#weapon-reticle');
    ammoEl.textContent = reloadTimer > 0 ? `Reloading · ${ammo}/${reserve}` : `${ammo}/${reserve}`;
    reticleEl.classList.toggle('ads', aiming);
  }

  function enter() {
    active = true;
    aiming = false;
    firing = false;
    ensureHud();
    ensureModel();
    hud.hidden = false;
    baseFov = camera.fov ?? config.hipFov;
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('contextmenu', onContextMenu);
    updateHud();
  }

  function exit() {
    active = false;
    aiming = false;
    firing = false;
    if (hud) hud.hidden = true;
    window.removeEventListener('mousedown', onMouseDown);
    window.removeEventListener('mouseup', onMouseUp);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('contextmenu', onContextMenu);
    if (camera.isPerspectiveCamera) {
      camera.fov = baseFov;
      camera.updateProjectionMatrix();
    }
  }

  function onContextMenu(event) {
    if (!active || document.pointerLockElement !== canvas) return;
    event.preventDefault();
  }

  function onMouseDown(event) {
    if (!active || document.pointerLockElement !== canvas) return;
    if (event.button === 0) {
      firing = true;
      fire();
    }
    if (event.button === 2) aiming = true;
  }

  function onMouseUp(event) {
    if (event.button === 0) firing = false;
    if (event.button === 2) aiming = false;
  }

  function onKeyDown(event) {
    if (!active || document.pointerLockElement !== canvas) return;
    if (event.code === 'KeyR') startReload();
  }

  function startReload() {
    if (reloadTimer > 0 || ammo === config.magazineSize || reserve <= 0) return;
    reloadTimer = config.reloadTime;
    firing = false;
    updateHud();
  }

  function finishReload() {
    const needed = config.magazineSize - ammo;
    const loaded = Math.min(needed, reserve);
    ammo += loaded;
    reserve -= loaded;
    reloadTimer = 0;
    updateHud();
  }

  function spawnTracer(from, to) {
    const geometry = new THREE.BufferGeometry().setFromPoints([from, to]);
    const line = new THREE.Line(geometry, tracerMaterial.clone());
    scene.add(line);
    setTimeout(() => {
      scene.remove(line);
      line.geometry.dispose();
      line.material.dispose();
    }, 55);
  }

  function spawnImpact(point) {
    const marker = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 8), impactMaterial.clone());
    marker.position.copy(point);
    scene.add(marker);
    setTimeout(() => {
      scene.remove(marker);
      marker.geometry.dispose();
      marker.material.dispose();
    }, 140);
  }

  // The hit object may be any mesh inside a remote player's avatar group;
  // the peer id lives on the group root.
  function findHitPeerId(intersection) {
    let object = intersection?.object;
    while (object) {
      if (object.userData.peerId) return object.userData.peerId;
      object = object.parent;
    }
    return null;
  }

  function fire() {
    if (!active || firingLocked || fireCooldown > 0 || reloadTimer > 0) return;
    if (ammo <= 0) {
      startReload();
      return;
    }

    ammo -= 1;
    fireCooldown = 60 / config.roundsPerMinute;
    raycaster.setFromCamera(center, camera);
    raycaster.far = config.range;
    const hits = raycaster.intersectObjects(targets, true);
    const from = camera.getWorldPosition(new THREE.Vector3());
    const to = hits[0]?.point ?? raycaster.ray.at(config.range, new THREE.Vector3());
    spawnTracer(from, to);
    if (hits[0]) spawnImpact(hits[0].point);
    onShot?.(from, to, Boolean(hits[0]), findHitPeerId(hits[0]));

    camera.rotation.x -= config.recoilKick;
    if (model) model.position.z += 0.035;
    updateHud();
  }

  function update(delta) {
    if (!active) return;
    fireCooldown = Math.max(0, fireCooldown - delta);
    if (reloadTimer > 0) {
      reloadTimer -= delta;
      if (reloadTimer <= 0) finishReload();
    }
    if (firing && fireCooldown <= 0) fire();

    adsAmount = THREE.MathUtils.damp(adsAmount, aiming ? 1 : 0, config.adsLerp, delta);
    if (model) {
      tempPos.copy(config.hipPosition).lerp(config.adsPosition, adsAmount);
      tempQuat.copy(hipQuat).slerp(adsQuat, adsAmount);
      model.position.lerp(tempPos, 1 - Math.exp(-config.adsLerp * delta));
      model.quaternion.slerp(tempQuat, 1 - Math.exp(-config.adsLerp * delta));
    }
    if (camera.isPerspectiveCamera) {
      camera.fov = THREE.MathUtils.lerp(baseFov, config.adsFov, adsAmount);
      camera.updateProjectionMatrix();
    }
  }

  return {
    enter,
    exit,
    update,
    setFiringLocked(value) {
      firingLocked = value;
      if (value) firing = false;
    },
    get active() { return active; },
  };
}
