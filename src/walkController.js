import * as THREE from 'three';

// Basic first-person "walk on the model" controller: WASD + mouse look via
// pointer lock, with the camera glued to the model's surface by raycasting
// straight down each frame (no physics engine — just enough to feel like
// you're standing on the object rather than floating through it).
export function createWalkController({ camera, canvas }) {
  let active = false;
  let target = null;
  let eyeHeight = 0.05;
  let moveSpeed = 0.2;
  let yaw = 0;
  let pitch = 0;
  let onExit = null;

  const keys = new Set();
  const raycaster = new THREE.Raycaster();
  const down = new THREE.Vector3(0, -1, 0);
  const euler = new THREE.Euler(0, 0, 0, 'YXZ');
  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();
  const move = new THREE.Vector3();

  function onKeyDown(event) {
    keys.add(event.code);
  }
  function onKeyUp(event) {
    keys.delete(event.code);
  }
  function onMouseMove(event) {
    if (document.pointerLockElement !== canvas) return;
    yaw -= event.movementX * 0.0025;
    pitch = Math.max(-1.4, Math.min(1.4, pitch - event.movementY * 0.0025));
  }
  function onPointerLockChange() {
    if (document.pointerLockElement !== canvas && active) exit();
  }

  function findSurfaceY(x, z, fromY) {
    raycaster.set(new THREE.Vector3(x, fromY, z), down);
    raycaster.far = fromY + eyeHeight * 200;
    const hits = raycaster.intersectObject(target, true);
    return hits.length ? hits[0].point.y : null;
  }

  function enter(object, exitCallback) {
    target = object;
    onExit = exitCallback;

    const box = new THREE.Box3().setFromObject(object);
    const scale = box.getSize(new THREE.Vector3()).length();
    eyeHeight = Math.max(scale * 0.012, 0.001);
    moveSpeed = eyeHeight * 3.5;

    const startY = box.max.y + scale;
    const groundY = findSurfaceY(0, 0, startY) ?? box.max.y;
    camera.position.set(0, groundY + eyeHeight, 0);
    yaw = 0;
    pitch = 0;
    camera.rotation.order = 'YXZ';

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('pointerlockchange', onPointerLockChange);
    canvas.requestPointerLock?.();

    active = true;
  }

  function exit() {
    if (!active) return;
    active = false;
    keys.clear();
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('keyup', onKeyUp);
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('pointerlockchange', onPointerLockChange);
    if (document.pointerLockElement === canvas) document.exitPointerLock();
    onExit?.();
  }

  function update(delta) {
    if (!active) return;

    euler.set(pitch, yaw, 0);
    camera.quaternion.setFromEuler(euler);

    forward.set(0, 0, -1).applyEuler(euler.clone().set(0, yaw, 0));
    right.set(1, 0, 0).applyEuler(euler.clone().set(0, yaw, 0));
    move.set(0, 0, 0);
    if (keys.has('KeyW') || keys.has('ArrowUp')) move.add(forward);
    if (keys.has('KeyS') || keys.has('ArrowDown')) move.sub(forward);
    if (keys.has('KeyD') || keys.has('ArrowRight')) move.add(right);
    if (keys.has('KeyA') || keys.has('ArrowLeft')) move.sub(right);
    if (move.lengthSq() === 0) return;
    move.normalize().multiplyScalar(moveSpeed * delta);

    const newX = camera.position.x + move.x;
    const newZ = camera.position.z + move.z;
    const groundY = findSurfaceY(newX, newZ, camera.position.y + eyeHeight * 10);
    if (groundY !== null) {
      camera.position.set(newX, groundY + eyeHeight, newZ);
    }
  }

  return {
    enter,
    exit,
    update,
    get active() {
      return active;
    },
  };
}
