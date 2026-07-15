import * as THREE from 'three';

// First-person controller with a Quake/Source-inspired movement model:
// acceleration, friction, air control, jump buffering, sprint, crouch, prone,
// and slide. It still uses inexpensive raycasts instead of a physics engine so
// the camera can walk directly on arbitrary GLTF geometry.
export function createWalkController({ camera, canvas }) {
  const DEFAULTS = {
    eyeHeight: null,
    crouchEyeHeight: null,
    proneEyeHeight: null,
    moveSpeed: null,
    sprintMultiplier: 1.45,
    crouchMultiplier: 0.55,
    proneMultiplier: 0.32,
    slideMultiplier: 1.85,
    acceleration: null,
    airAcceleration: null,
    friction: 9,
    airFriction: 0.18,
    gravity: null,
    jumpHeight: null,
    stepHeight: null,
    slopeLimit: 0.72,
    mouseSensitivity: 0.0025,
    coyoteTime: 0.09,
    jumpBufferTime: 0.12,
    slideMinSpeed: null,
    slideDuration: 0.85,
    slideCooldown: 0.2,
    stanceLerp: 14,
  };

  let active = false;
  let frozen = false;
  let target = null;
  let onExit = null;
  let config = { ...DEFAULTS };
  let eyeHeight = 0.05;
  let standEyeHeight = 0.05;
  let crouchEyeHeight = 0.032;
  let proneEyeHeight = 0.018;
  let yaw = 0;
  let pitch = 0;
  let groundY = null;
  let grounded = false;
  let coyoteTimer = 0;
  let jumpBufferTimer = 0;
  let slideTimer = 0;
  let slideCooldownTimer = 0;
  let stance = 'stand';
  let crouchWasHeld = false;

  const keys = new Set();
  const raycaster = new THREE.Raycaster();
  const down = new THREE.Vector3(0, -1, 0);
  const euler = new THREE.Euler(0, 0, 0, 'YXZ');
  const yawEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();
  const wishDir = new THREE.Vector3();
  const velocity = new THREE.Vector3();
  const probeOrigin = new THREE.Vector3();

  function onKeyDown(event) {
    event.preventDefault();
    if (event.code === 'Space') jumpBufferTimer = config.jumpBufferTime;
    keys.add(event.code);
  }

  function onKeyUp(event) {
    keys.delete(event.code);
  }

  function onWindowBlur() {
    keys.clear();
    crouchWasHeld = false;
  }

  function onMouseMove(event) {
    if (document.pointerLockElement !== canvas) return;
    yaw -= event.movementX * config.mouseSensitivity;
    pitch = Math.max(-1.48, Math.min(1.48, pitch - event.movementY * config.mouseSensitivity));
  }

  function onPointerLockChange() {
    if (document.pointerLockElement !== canvas && active) exit();
  }

  function findSurface(x, z, fromY, maxDistance) {
    probeOrigin.set(x, fromY, z);
    raycaster.set(probeOrigin, down);
    raycaster.far = maxDistance;
    const hits = raycaster.intersectObject(target, true);
    for (const hit of hits) {
      if (!hit.face) return hit;
      const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
      if (normal.y >= config.slopeLimit) return hit;
    }
    return null;
  }

  function getWishDirection() {
    yawEuler.set(0, yaw, 0);
    forward.set(0, 0, -1).applyEuler(yawEuler);
    right.set(1, 0, 0).applyEuler(yawEuler);
    wishDir.set(0, 0, 0);
    if (keys.has('KeyW') || keys.has('ArrowUp')) wishDir.add(forward);
    if (keys.has('KeyS') || keys.has('ArrowDown')) wishDir.sub(forward);
    if (keys.has('KeyD') || keys.has('ArrowRight')) wishDir.add(right);
    if (keys.has('KeyA') || keys.has('ArrowLeft')) wishDir.sub(right);
    if (wishDir.lengthSq() > 0) wishDir.normalize();
    return wishDir;
  }

  function applyFriction(delta, amount) {
    const horizontalSpeed = Math.hypot(velocity.x, velocity.z);
    if (horizontalSpeed <= 0.0001) return;
    const drop = horizontalSpeed * amount * delta;
    const scale = Math.max(horizontalSpeed - drop, 0) / horizontalSpeed;
    velocity.x *= scale;
    velocity.z *= scale;
  }

  function accelerate(direction, targetSpeed, accel, delta) {
    if (direction.lengthSq() === 0) return;
    const currentSpeed = velocity.x * direction.x + velocity.z * direction.z;
    const addSpeed = targetSpeed - currentSpeed;
    if (addSpeed <= 0) return;
    const accelSpeed = Math.min(accel * targetSpeed * delta, addSpeed);
    velocity.x += direction.x * accelSpeed;
    velocity.z += direction.z * accelSpeed;
  }

  function horizontalSpeed() {
    return Math.hypot(velocity.x, velocity.z);
  }

  function updateStance(delta) {
    const crouchHeld = keys.has('ControlLeft') || keys.has('ControlRight') || keys.has('KeyC');
    const crouchPressed = crouchHeld && !crouchWasHeld;
    const proneHeld = keys.has('KeyZ');
    const sprintHeld = keys.has('ShiftLeft') || keys.has('ShiftRight');

    if (slideTimer > 0) {
      slideTimer = Math.max(0, slideTimer - delta);
      stance = 'slide';
    } else if (proneHeld) {
      stance = 'prone';
    } else if (crouchHeld) {
      const canStartSlide = crouchPressed && grounded && sprintHeld && slideCooldownTimer <= 0 && horizontalSpeed() >= config.slideMinSpeed;
      if (canStartSlide) {
        slideTimer = config.slideDuration;
        slideCooldownTimer = config.slideCooldown;
        stance = 'slide';
        const dir = getWishDirection().lengthSq() > 0 ? getWishDirection() : forward;
        velocity.x += dir.x * config.moveSpeed * 0.45;
        velocity.z += dir.z * config.moveSpeed * 0.45;
      } else {
        stance = 'crouch';
      }
    } else {
      stance = 'stand';
    }

    slideCooldownTimer = Math.max(0, slideCooldownTimer - delta);
    const targetEyeHeight = stance === 'prone' ? proneEyeHeight : stance === 'crouch' || stance === 'slide' ? crouchEyeHeight : standEyeHeight;
    const blend = 1 - Math.exp(-config.stanceLerp * delta);
    eyeHeight = THREE.MathUtils.lerp(eyeHeight, targetEyeHeight, blend);
    crouchWasHeld = crouchHeld;
  }

  function enter(object, exitCallback, options = {}) {
    target = object;
    onExit = exitCallback;

    const box = new THREE.Box3().setFromObject(object);
    const scale = box.getSize(new THREE.Vector3()).length();
    standEyeHeight = options.eyeHeight ?? Math.max(scale * 0.012, 0.001);
    config = {
      ...DEFAULTS,
      ...options,
      moveSpeed: options.moveSpeed ?? standEyeHeight * 3.5,
      acceleration: options.acceleration ?? standEyeHeight * 36,
      airAcceleration: options.airAcceleration ?? standEyeHeight * 12,
      gravity: options.gravity ?? standEyeHeight * 28,
      jumpHeight: options.jumpHeight ?? standEyeHeight * 0.9,
      stepHeight: options.stepHeight ?? standEyeHeight * 0.45,
      slideMinSpeed: options.slideMinSpeed ?? (options.moveSpeed ?? standEyeHeight * 3.5) * 1.15,
    };
    crouchEyeHeight = options.crouchEyeHeight ?? standEyeHeight * 0.64;
    proneEyeHeight = options.proneEyeHeight ?? standEyeHeight * 0.34;
    eyeHeight = standEyeHeight;

    const startX = options.startPosition?.x ?? 0;
    const startZ = options.startPosition?.z ?? 0;
    const startY = box.max.y + scale;
    const hit = findSurface(startX, startZ, startY, startY + standEyeHeight * 200);
    groundY = hit?.point.y ?? box.max.y;
    camera.position.set(startX, groundY + eyeHeight, startZ);
    velocity.set(0, 0, 0);
    grounded = true;
    coyoteTimer = config.coyoteTime;
    jumpBufferTimer = 0;
    slideTimer = 0;
    slideCooldownTimer = 0;
    stance = 'stand';
    crouchWasHeld = false;
    frozen = false;
    yaw = options.yaw ?? 0;
    pitch = 0;
    camera.rotation.order = 'YXZ';

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('pointerlockchange', onPointerLockChange);
    window.addEventListener('blur', onWindowBlur);
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
    window.removeEventListener('blur', onWindowBlur);
    if (document.pointerLockElement === canvas) document.exitPointerLock();
    onExit?.();
  }

  // Teleport to a new spot (deathmatch respawns): same surface probe as
  // enter(), but without touching input listeners or look angles.
  function respawnAt(x, z) {
    if (!active || !target) return;
    const box = new THREE.Box3().setFromObject(target);
    const scale = box.getSize(new THREE.Vector3()).length();
    const startY = box.max.y + scale;
    const hit = findSurface(x, z, startY, startY + standEyeHeight * 200);
    groundY = hit?.point.y ?? box.max.y;
    camera.position.set(x, groundY + eyeHeight, z);
    velocity.set(0, 0, 0);
    grounded = true;
    coyoteTimer = config.coyoteTime;
    jumpBufferTimer = 0;
    slideTimer = 0;
  }

  function update(delta) {
    if (!active || frozen) return;
    delta = Math.min(delta, 0.05);
    euler.set(pitch, yaw, 0);
    camera.quaternion.setFromEuler(euler);

    jumpBufferTimer = Math.max(0, jumpBufferTimer - delta);
    updateStance(delta);

    const direction = getWishDirection();
    const sprinting = (keys.has('ShiftLeft') || keys.has('ShiftRight')) && stance === 'stand' && direction.lengthSq() > 0;
    const multiplier = stance === 'slide' ? config.slideMultiplier : stance === 'prone' ? config.proneMultiplier : stance === 'crouch' ? config.crouchMultiplier : sprinting ? config.sprintMultiplier : 1;
    const targetSpeed = config.moveSpeed * multiplier;

    if (grounded) {
      applyFriction(delta, stance === 'slide' ? config.friction * 0.18 : config.friction);
      accelerate(direction, targetSpeed, config.acceleration, delta);
    } else {
      applyFriction(delta, config.airFriction);
      accelerate(direction, targetSpeed, config.airAcceleration, delta);
      velocity.y -= config.gravity * delta;
    }

    if (jumpBufferTimer > 0 && (grounded || coyoteTimer > 0) && stance !== 'prone') {
      velocity.y = Math.sqrt(2 * config.gravity * config.jumpHeight);
      grounded = false;
      coyoteTimer = 0;
      jumpBufferTimer = 0;
      if (stance === 'slide') slideTimer = 0;
    }

    const nextX = camera.position.x + velocity.x * delta;
    const nextZ = camera.position.z + velocity.z * delta;
    const probeY = camera.position.y + config.stepHeight + Math.max(velocity.y, 0) * delta;
    const hit = findSurface(nextX, nextZ, probeY, config.stepHeight + eyeHeight * 4 + Math.max(-velocity.y * delta, 0));
    const nextFeetY = camera.position.y - eyeHeight + velocity.y * delta;

    if (hit && nextFeetY <= hit.point.y + config.stepHeight) {
      groundY = hit.point.y;
      grounded = true;
      coyoteTimer = config.coyoteTime;
      velocity.y = Math.max(0, velocity.y);
      camera.position.set(nextX, groundY + eyeHeight, nextZ);
    } else {
      grounded = false;
      coyoteTimer = Math.max(0, coyoteTimer - delta);
      camera.position.set(nextX, nextFeetY + eyeHeight, nextZ);
    }
  }

  return {
    enter,
    exit,
    update,
    respawnAt,
    setFrozen(value) {
      frozen = value;
      if (value) keys.clear();
    },
    get active() {
      return active;
    },
    get state() {
      return { grounded, stance, speed: horizontalSpeed() };
    },
    get eyeHeight() {
      return eyeHeight;
    },
  };
}
