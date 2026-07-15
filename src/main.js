import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { spawnModel } from './assets.js';
import { GRID_WIDTH, GRID_DEPTH, tileWorldPosition, tileKindAt, buildPathWaypoints } from './grid.js';
import { buildTower } from './tower.js';

const TILE_MODEL = {
  grass: 'tile',
  path: 'tile-straight',
  spawn: 'tile-spawn',
  end: 'tile-end',
};

document.getElementById('hud-version').textContent = `v${__APP_VERSION__}`;

const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1f2e);

// Fixed isometric-style orthographic camera.
const ISO_ANGLE = Math.atan(1 / Math.sqrt(2));
const camera = new THREE.OrthographicCamera();
camera.near = -100;
camera.far = 100;
const cameraDistance = 20;
camera.position.set(cameraDistance, cameraDistance * Math.tan(ISO_ANGLE), cameraDistance);
camera.lookAt(0, 0, 0);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.minZoom = 0.5;
controls.maxZoom = 3;
controls.enablePan = false;
controls.minPolarAngle = Math.PI / 6;
controls.maxPolarAngle = Math.PI / 2.1;

const hemiLight = new THREE.HemisphereLight(0xbdd6ff, 0x2a2f3a, 1.1);
scene.add(hemiLight);

const sunLight = new THREE.DirectionalLight(0xfff2d9, 1.4);
sunLight.position.set(8, 12, 6);
sunLight.castShadow = true;
sunLight.shadow.camera.left = -12;
sunLight.shadow.camera.right = 12;
sunLight.shadow.camera.top = 12;
sunLight.shadow.camera.bottom = -12;
sunLight.shadow.mapSize.set(2048, 2048);
scene.add(sunLight);

const world = new THREE.Group();
scene.add(world);

async function buildLevel() {
  const tilePromises = [];
  for (let col = 0; col < GRID_WIDTH; col++) {
    for (let row = 0; row < GRID_DEPTH; row++) {
      const kind = tileKindAt(col, row);
      const { x, z } = tileWorldPosition(col, row);
      const rotationY = kind === 'path' ? Math.PI / 2 : 0;
      tilePromises.push(
        spawnModel(TILE_MODEL[kind], { position: { x, z }, rotationY }).then((tile) => world.add(tile))
      );
    }
  }
  await Promise.all(tilePromises);

  await buildTower(world, tileWorldPosition(2, 1), 'round');
  await buildTower(world, tileWorldPosition(4, 3), 'square');
  await buildTower(world, tileWorldPosition(6, 1), 'round');
}

async function spawnEnemy() {
  const waypoints = buildPathWaypoints();
  const enemy = await spawnModel('enemy-ufo-a', { position: waypoints[0], scale: 1.2 });
  world.add(enemy);
  return { mesh: enemy, waypoints, segment: 0, t: 0 };
}

function updateEnemy(enemy, deltaSeconds) {
  const speed = 1.5; // tiles per second
  const { waypoints } = enemy;
  const from = waypoints[enemy.segment];
  const to = waypoints[enemy.segment + 1];
  if (!to) return;

  const segmentLength = Math.hypot(to.x - from.x, to.z - from.z);
  enemy.t += (speed * deltaSeconds) / segmentLength;

  if (enemy.t >= 1) {
    enemy.t = 0;
    enemy.segment = Math.min(enemy.segment + 1, waypoints.length - 2);
  }

  const t = enemy.t;
  enemy.mesh.position.set(from.x + (to.x - from.x) * t, 0.4, from.z + (to.z - from.z) * t);
  enemy.mesh.rotation.y = Math.atan2(to.x - from.x, to.z - from.z);
}

function resize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const viewSize = 12;
  const aspect = width / height;
  camera.left = (-viewSize * aspect) / 2;
  camera.right = (viewSize * aspect) / 2;
  camera.top = viewSize / 2;
  camera.bottom = -viewSize / 2;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height);
}

window.addEventListener('resize', resize);
resize();

let enemyState = null;
buildLevel();
spawnEnemy().then((enemy) => {
  enemyState = enemy;
});

const clock = new THREE.Clock();
function animate() {
  const delta = clock.getDelta();
  if (enemyState) updateEnemy(enemyState, delta);
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}
animate();
