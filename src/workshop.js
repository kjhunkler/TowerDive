import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { spawnModel, getModelHeight, setMaxAnisotropy } from './assets.js';
import { buildCategories, isGroundModel } from './modelCategories.js';
import { cellToWorld, worldToCell } from './gridMath.js';
import { createEmptyMap, loadMap, saveMap, exportMapFile, importMapFile } from './mapStore.js';
import { createWalkController } from './walkController.js';
import { createWeaponController } from './weaponController.js';
import { TILE_SIZE } from './grid.js';
import { TOWER_PIECE_HEIGHT } from './tower.js';
import { applySkybox, SKYBOXES } from './skybox.js';

const ERASE = '__erase';
// Matches tower.js's stacking step, so nudging height lines up the
// separately-placed bottom/middle/top pieces of a tower correctly.
const HEIGHT_UNIT = TOWER_PIECE_HEIGHT;

// Props (anything that isn't a ground tile) stack on top of y=0, which is
// where every kit's ground tile top surface lands (see grid.js/assets.js).
function propY(heightStep) {
  return heightStep * HEIGHT_UNIT;
}

function cellKey(col, row) {
  return `${col},${row}`;
}

function getCellStackBase(col, row) {
  const props = (cellIndex.get(cellKey(col, row)) || []).filter((entity) => !entity.ground);
  if (props.length === 0) return 0;
  return Math.max(...props.map((entity) => entity.heightStep ?? 0)) + 1;
}

function getPendingStackHeight(col, row) {
  return getCellStackBase(col, row) + pendingHeight;
}

const canvas = document.getElementById('scene');
const paletteToolRow = document.getElementById('palette-tool-row');
const paletteCategories = document.getElementById('palette-categories');
const brushNameEl = document.getElementById('brush-status-name');
const brushDetailEl = document.getElementById('brush-status-detail');
const exploreHint = document.getElementById('explore-hint');
const exploreBtn = document.getElementById('action-explore');
const importInput = document.getElementById('action-import-input');
const skyboxSelect = document.getElementById('skybox-select');
const undoBtn = document.getElementById('action-undo');
const paletteSearch = document.getElementById('palette-search');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
setMaxAnisotropy(renderer.capabilities.getMaxAnisotropy());

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1f2e);

for (const name of SKYBOXES) {
  const option = document.createElement('option');
  option.value = name;
  option.textContent = `Sky: ${name}`;
  skyboxSelect.appendChild(option);
}
skyboxSelect.value = 'day';
applySkybox(scene, skyboxSelect.value);
skyboxSelect.addEventListener('change', () => applySkybox(scene, skyboxSelect.value));

const ISO_ANGLE = Math.atan(1 / Math.sqrt(2));
const camera = new THREE.OrthographicCamera();
camera.near = -100;
camera.far = 100;
const CAMERA_DISTANCE = 20;
camera.position.set(CAMERA_DISTANCE, CAMERA_DISTANCE * Math.tan(ISO_ANGLE), CAMERA_DISTANCE);
camera.lookAt(0, 0, 0);

// Explore mode needs a perspective projection: mouse-look through the
// orthographic build camera has no vanishing point, so turning your head
// reads as "the map spins" instead of first-person looking.
const exploreCamera = new THREE.PerspectiveCamera(70, 1, 0.01, 200);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
// Left button is reserved for placing/erasing; camera uses right-drag to
// orbit and middle-drag to pan, matching common 3D editor conventions.
controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
controls.minZoom = 0.3;
controls.maxZoom = 4;
controls.minPolarAngle = Math.PI / 8;
controls.maxPolarAngle = Math.PI / 2.1;

const hemiLight = new THREE.HemisphereLight(0xbdd6ff, 0x2a2f3a, 1.8);
scene.add(hemiLight);

const sunLight = new THREE.DirectionalLight(0xfff2d9, 0.6);
sunLight.position.set(8, 12, 6);
sunLight.castShadow = true;
scene.add(sunLight);

const mapGroup = new THREE.Group();
scene.add(mapGroup);

const walker = createWalkController({ camera: exploreCamera, canvas });
const weapons = createWeaponController({ camera: exploreCamera, canvas, scene, targets: [mapGroup] });

// --- map data -----------------------------------------------------------

let map = loadMap() || createEmptyMap(15, 15, TILE_SIZE);
// Cell spacing is dictated by the models (1x1 tiles), not the stored map —
// maps saved before the spacing fix carry a stale tileSize of 2.
map.tileSize = TILE_SIZE;
let cellIndex = new Map();
const objectsById = new Map();
let renderGeneration = 0;

function rebuildIndex() {
  cellIndex.clear();
  for (const entity of map.entities) {
    const key = cellKey(entity.col, entity.row);
    if (!cellIndex.has(key)) cellIndex.set(key, []);
    cellIndex.get(key).push(entity);
  }
}

async function renderEntity(entity, generation = renderGeneration) {
  const { x, z } = cellToWorld(entity.col, entity.row, map.width, map.depth, TILE_SIZE);
  const y = entity.ground ? -(await getModelHeight(entity.name)) : propY(entity.heightStep);
  const object = await spawnModel(entity.name, {
    position: { x, y, z },
    rotationY: entity.rotationStep * (Math.PI / 2),
  });
  if (generation !== renderGeneration || !map.entities.includes(entity)) return;
  object.userData.entityId = entity.id;
  mapGroup.add(object);
  objectsById.set(entity.id, object);
}

function removeEntityObject(id) {
  const object = objectsById.get(id);
  if (object) {
    mapGroup.remove(object);
    objectsById.delete(id);
  }
}

async function loadEntireMap() {
  renderGeneration += 1;
  const generation = renderGeneration;
  mapGroup.clear();
  objectsById.clear();
  rebuildIndex();
  await Promise.all(map.entities.map((entity) => renderEntity(entity, generation)));
}

function addEntity(partial) {
  const entity = { id: map.nextId++, rotationStep: 0, heightStep: 0, ...partial };
  map.entities.push(entity);
  rebuildIndex();
  renderEntity(entity);
  return entity;
}

function removeEntity(id) {
  const idx = map.entities.findIndex((e) => e.id === id);
  if (idx === -1) return;
  map.entities.splice(idx, 1);
  rebuildIndex();
  removeEntityObject(id);
}

// --- edit history -----------------------------------------------------------

const undoStack = [];
const MAX_UNDO_STATES = 50;
let mapRevision = 0;
let importRequestId = 0;

function cloneMap(source) {
  return JSON.parse(JSON.stringify(source));
}

function updateUndoButton() {
  undoBtn.disabled = undoStack.length === 0;
}

function recordUndoState() {
  undoStack.push(cloneMap(map));
  if (undoStack.length > MAX_UNDO_STATES) undoStack.shift();
  updateUndoButton();
}

async function undoLastEdit() {
  const previous = undoStack.pop();
  if (!previous) return;
  map = previous;
  map.tileSize = TILE_SIZE;
  mapRevision += 1;
  updateUndoButton();
  await loadEntireMap();
}

// --- palette --------------------------------------------------------------

let currentBrush = null;
let pendingRotation = 0;
let pendingHeight = 0;

function updateBrushStatus() {
  if (!currentBrush) {
    brushNameEl.textContent = 'no tool selected';
    brushDetailEl.textContent = '';
  } else if (currentBrush === ERASE) {
    brushNameEl.textContent = 'erase';
    brushDetailEl.textContent = '';
  } else {
    brushNameEl.textContent = currentBrush;
    const offset = pendingHeight === 0 ? 'auto-stack' : `auto-stack ${pendingHeight > 0 ? '+' : ''}${pendingHeight}`;
    brushDetailEl.textContent = `rot ${pendingRotation * 90}° · ${offset}`;
  }
}

function selectBrush(name) {
  currentBrush = name;
  pendingRotation = 0;
  pendingHeight = 0;
  document.querySelectorAll('.palette-item.selected').forEach((el) => el.classList.remove('selected'));
  const el = document.querySelector(`.palette-item[data-name="${CSS.escape(name)}"]`);
  el?.classList.add('selected');
  updateGhost();
  updateBrushStatus();
}

function deselectBrush() {
  currentBrush = null;
  document.querySelectorAll('.palette-item.selected').forEach((el) => el.classList.remove('selected'));
  updateGhost();
  updateBrushStatus();
}

const eraseBtn = paletteToolRow.querySelector('.palette-tool');
eraseBtn.addEventListener('click', () => selectBrush(ERASE));

for (const category of buildCategories()) {
  const section = document.createElement('div');
  section.className = 'palette-category';

  const label = document.createElement('div');
  label.className = 'palette-category-label';
  label.textContent = category.label;
  section.appendChild(label);

  const grid = document.createElement('div');
  grid.className = 'palette-grid';
  for (const name of category.items) {
    const btn = document.createElement('button');
    btn.className = 'palette-item';
    btn.dataset.name = name;
    btn.textContent = name.slice(name.indexOf('/') + 1);
    btn.title = name;
    btn.addEventListener('click', () => selectBrush(name));
    grid.appendChild(btn);
  }
  section.appendChild(grid);
  paletteCategories.appendChild(section);
}

paletteSearch.addEventListener('input', () => {
  const query = paletteSearch.value.trim().toLocaleLowerCase();
  paletteCategories.querySelectorAll('.palette-category').forEach((section) => {
    let visibleCount = 0;
    section.querySelectorAll('.palette-item').forEach((button) => {
      const visible = !query || button.dataset.name.toLocaleLowerCase().includes(query);
      button.hidden = !visible;
      if (visible) visibleCount += 1;
    });
    section.hidden = visibleCount === 0;
  });
});

// --- ghost / cell cursor ---------------------------------------------------

const cellCursor = new THREE.Mesh(
  new THREE.PlaneGeometry(TILE_SIZE * 0.92, TILE_SIZE * 0.92),
  new THREE.MeshBasicMaterial({ color: 0x88aaff, transparent: true, opacity: 0.35 })
);
cellCursor.rotation.x = -Math.PI / 2;
cellCursor.position.y = 0.02;
cellCursor.visible = false;
scene.add(cellCursor);

let ghostObject = null;
let ghostBrushName = null;
let ghostGroundY = 0;

// Keeps the ghost glued to the last known hover cell. Called both on
// pointer move and right after an async model load resolves — without the
// latter, a freshly-loaded ghost would sit at its default (0,0,0) origin
// until the next mouse movement instead of snapping straight to the cursor.
function syncGhostTransform() {
  if (!ghostObject || ghostBrushName !== currentBrush) return;
  if (!hoverCell) {
    ghostObject.visible = false;
    return;
  }
  const { x, z } = cellToWorld(hoverCell.col, hoverCell.row, map.width, map.depth, TILE_SIZE);
  ghostObject.visible = true;
  const y = isGroundModel(currentBrush) ? ghostGroundY : propY(getPendingStackHeight(hoverCell.col, hoverCell.row));
  ghostObject.position.set(x, y, z);
  ghostObject.rotation.y = pendingRotation * (Math.PI / 2);
}

async function ensureGhost(name) {
  if (ghostBrushName === name) return;
  if (ghostObject) {
    scene.remove(ghostObject);
    ghostObject = null;
  }
  ghostBrushName = name;
  const [object, groundHeight] = await Promise.all([
    spawnModel(name, {}),
    isGroundModel(name) ? getModelHeight(name) : Promise.resolve(0),
  ]);
  if (ghostBrushName !== name) return; // brush changed again while loading
  object.traverse((child) => {
    if (child.isMesh) {
      child.material = child.material.clone();
      child.material.transparent = true;
      child.material.opacity = 0.55;
      child.castShadow = false;
      child.receiveShadow = false;
    }
  });
  ghostGroundY = -groundHeight;
  ghostObject = object;
  ghostObject.visible = false;
  scene.add(object);
  syncGhostTransform();
}

function updateGhost() {
  if (!currentBrush || currentBrush === ERASE) {
    if (ghostObject) ghostObject.visible = false;
    return;
  }
  ensureGhost(currentBrush);
}

const raycaster = new THREE.Raycaster();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const hoverOutline = new THREE.BoxHelper(undefined, 0xffd166);
hoverOutline.material.depthTest = false;
hoverOutline.material.transparent = true;
hoverOutline.material.opacity = 0.9;
hoverOutline.renderOrder = 10;
hoverOutline.visible = false;
scene.add(hoverOutline);
let hoverCell = null;
let hoverEntityId = null;

function getEntityIdFromIntersection(intersection) {
  let object = intersection?.object;
  while (object && object !== mapGroup) {
    if (object.userData.entityId !== undefined) return object.userData.entityId;
    object = object.parent;
  }
  return null;
}

function updateHover(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1
  );
  raycaster.setFromCamera(ndc, camera);
  const entityHit = raycaster.intersectObject(mapGroup, true)[0];
  hoverEntityId = getEntityIdFromIntersection(entityHit);
  const hoverEntity = map.entities.find((entity) => entity.id === hoverEntityId);
  const hoverObject = objectsById.get(hoverEntityId);
  hoverOutline.visible = Boolean(hoverObject);
  if (hoverObject) hoverOutline.setFromObject(hoverObject);

  if (hoverEntity) {
    hoverCell = { col: hoverEntity.col, row: hoverEntity.row };
  } else {
    hoverEntityId = null;
  }

  const point = new THREE.Vector3();
  if (!hoverEntity && !raycaster.ray.intersectPlane(groundPlane, point)) {
    hoverCell = null;
    cellCursor.visible = false;
    syncGhostTransform();
    return;
  }

  const { col, row } = hoverEntity
    ? hoverCell
    : worldToCell(point.x, point.z, map.width, map.depth, TILE_SIZE);
  if (col < 0 || col >= map.width || row < 0 || row >= map.depth) {
    hoverCell = null;
    cellCursor.visible = false;
    syncGhostTransform();
    return;
  }

  hoverCell = { col, row };
  const { x, z } = cellToWorld(col, row, map.width, map.depth, TILE_SIZE);
  cellCursor.position.set(x, 0.02, z);
  cellCursor.material.color.set(currentBrush === ERASE ? 0xff6666 : 0x88aaff);
  cellCursor.visible = true;
  syncGhostTransform();
}

// --- placing / erasing ------------------------------------------------------

function placeAtHover() {
  if (!hoverCell || !currentBrush || currentBrush === ERASE) return;
  recordUndoState();
  const { col, row } = hoverCell;
  const ground = isGroundModel(currentBrush);
  if (ground) {
    const existingGround = (cellIndex.get(cellKey(col, row)) || []).find((e) => e.ground);
    if (existingGround) removeEntity(existingGround.id);
    addEntity({ name: currentBrush, ground: true, col, row, rotationStep: pendingRotation, heightStep: 0 });
  } else {
    addEntity({
      name: currentBrush,
      ground: false,
      col,
      row,
      rotationStep: pendingRotation,
      heightStep: getPendingStackHeight(col, row),
    });
  }
  mapRevision += 1;
}

function eraseAtHover() {
  if (!hoverCell) return;
  const entities = cellIndex.get(cellKey(hoverCell.col, hoverCell.row)) || [];
  if (entities.length === 0) return;
  const props = entities.filter((e) => !e.ground);
  const target = entities.find((entity) => entity.id === hoverEntityId)
    || (props.length ? props[props.length - 1] : entities[entities.length - 1]);
  recordUndoState();
  removeEntity(target.id);
  mapRevision += 1;
  hoverEntityId = null;
  hoverOutline.visible = false;
}

canvas.addEventListener('pointermove', (event) => {
  if (walker.active) return;
  updateHover(event.clientX, event.clientY);
});

canvas.addEventListener('click', (event) => {
  if (walker.active) return;
  updateHover(event.clientX, event.clientY);
  if (currentBrush === ERASE) eraseAtHover();
  else placeAtHover();
});

window.addEventListener('keydown', (event) => {
  if (walker.active) return;
  if (
    event.target instanceof HTMLInputElement
    || event.target instanceof HTMLTextAreaElement
    || event.target instanceof HTMLSelectElement
    || event.target?.isContentEditable
  ) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'z') {
    event.preventDefault();
    undoLastEdit();
    return;
  }
  if (event.key === 'r' || event.key === 'R') {
    pendingRotation = (pendingRotation + 1) % 4;
    updateBrushStatus();
    syncGhostTransform();
  } else if (event.key === '[') {
    pendingHeight -= 1;
    updateBrushStatus();
    syncGhostTransform();
  } else if (event.key === ']') {
    pendingHeight += 1;
    updateBrushStatus();
    syncGhostTransform();
  } else if (event.key === 'Escape') {
    deselectBrush();
  }
});

// --- top bar actions --------------------------------------------------------

document.getElementById('action-save').addEventListener('click', () => {
  saveMap(map);
});

undoBtn.addEventListener('click', undoLastEdit);

document.getElementById('action-export').addEventListener('click', () => {
  exportMapFile(map);
});

document.getElementById('action-import').addEventListener('click', () => importInput.click());
importInput.addEventListener('change', async () => {
  const file = importInput.files?.[0];
  importInput.value = '';
  if (!file) return;
  const requestId = ++importRequestId;
  const startingRevision = mapRevision;
  try {
    const importedMap = await importMapFile(file);
    if (requestId !== importRequestId || startingRevision !== mapRevision) {
      throw new Error('Map changed before import completed');
    }
    recordUndoState();
    map = importedMap;
    map.tileSize = TILE_SIZE;
    mapRevision += 1;
    await loadEntireMap();
  } catch (err) {
    console.error('Failed to import map:', err);
  }
});

document.getElementById('action-clear').addEventListener('click', () => {
  if (!confirm('Clear the entire map?')) return;
  recordUndoState();
  map = createEmptyMap(map.width, map.depth, TILE_SIZE);
  mapRevision += 1;
  loadEntireMap();
});

// The walker drives its own perspective camera, so the orthographic build
// camera (and its orbit controls) are untouched — exiting just switches
// which camera renders.
function exitExplore() {
  weapons.exit();
  controls.enabled = true;
  exploreHint.hidden = true;
  exploreBtn.classList.remove('active');
  exploreBtn.textContent = '\u{1F6F8} Explore';
}

exploreBtn.addEventListener('click', () => {
  if (walker.active) {
    walker.exit();
    return;
  }
  controls.enabled = false;
  cellCursor.visible = false;
  hoverOutline.visible = false;
  if (ghostObject) ghostObject.visible = false;
  // Roughly human-scale for 1-unit tiles: eyes ~0.5 units up, brisk walk.
  walker.enter(mapGroup, exitExplore, {
    eyeHeight: TILE_SIZE * 0.5,
    moveSpeed: TILE_SIZE * 2.5,
    startPosition: { x: 0, z: 0 },
  });
  weapons.enter();
  exploreHint.hidden = false;
  exploreBtn.classList.add('active');
  exploreBtn.textContent = '\u{1F6F8} exit explore';
});

// --- boot / loop -------------------------------------------------------------

function resize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const viewSize = 13;
  const aspect = width / height;
  camera.left = (-viewSize * aspect) / 2;
  camera.right = (viewSize * aspect) / 2;
  camera.top = viewSize / 2;
  camera.bottom = -viewSize / 2;
  camera.updateProjectionMatrix();
  exploreCamera.aspect = aspect;
  exploreCamera.updateProjectionMatrix();
  renderer.setSize(width, height);
}
window.addEventListener('resize', resize);
resize();

loadEntireMap();

const clock = new THREE.Clock();
function animate() {
  const delta = clock.getDelta();
  if (walker.active) {
    walker.update(delta);
    weapons.update(delta);
  } else {
    controls.update();
  }
  renderer.render(scene, walker.active ? exploreCamera : camera);
  requestAnimationFrame(animate);
}
animate();
