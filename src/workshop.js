import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { spawnModel, getModelBounds, setMaxAnisotropy } from './assets.js';
import { buildCategories, getKitOptions, getModelMeta, isGroundModel } from './modelCategories.js';
import { cellToWorld, worldToCell } from './gridMath.js';
import { createEmptyMap, getSavedMap, saveMapAs, renameMap, listMaps, exportMapFile, importMapFile } from './mapStore.js';
import { createWalkController } from './walkController.js';
import { createWeaponController } from './weaponController.js';
import { TILE_SIZE } from './grid.js';
import { applySkybox, loadSkyboxSurface, SKYBOXES } from './skybox.js';
import { getNetIntent, getPlayerName, createGameSession, announceInLobby, selfId } from './net.js';
import { createRemotePlayers } from './remotePlayers.js';
import { createDeathmatch } from './deathmatch.js';

const ERASE = '__erase';

function cellKey(col, row) {
  return `${col},${row}`;
}

function getCellStackBase(col, row) {
  const props = (cellIndex.get(cellKey(col, row)) || []).filter((entity) => !entity.ground);
  if (props.length === 0) return 0;
  return Math.max(...props.map((entity) => entity.heightStep ?? 0)) + 1;
}

function getHorizontalBounds(bounds, rotationStep, mirrors, scale) {
  const angle = rotationStep * (Math.PI / 2);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const xs = [bounds.minX, bounds.maxX];
  const zs = [bounds.minZ, bounds.maxZ];
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;

  for (const sourceX of xs) {
    for (const sourceZ of zs) {
      const x = sourceX * scale * (mirrors.x ? -1 : 1);
      const z = sourceZ * scale * (mirrors.z ? -1 : 1);
      const rotatedX = x * cos + z * sin;
      const rotatedZ = -x * sin + z * cos;
      minX = Math.min(minX, rotatedX);
      maxX = Math.max(maxX, rotatedX);
      minZ = Math.min(minZ, rotatedZ);
      maxZ = Math.max(maxZ, rotatedZ);
    }
  }

  return { minX, maxX, minZ, maxZ };
}

const canvas = document.getElementById('scene');
const netStatusEl = document.getElementById('net-status');
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
const starredFilterBtn = document.getElementById('palette-starred-filter');
const paletteKitFilter = document.getElementById('palette-kit-filter');
const paletteTypeFilter = document.getElementById('palette-type-filter');
const quickbar = document.getElementById('quickbar');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
setMaxAnisotropy(renderer.capabilities.getMaxAnisotropy());

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1f2e);

// Scene.background paints the canvas behind the world, but the orthographic
// map editor needs a visible sky surface so the chosen skybox feels like it
// surrounds the map while orbiting and panning. Keep the dome just inside the
// editor camera's far plane and draw its inward-facing surface behind props.
const editorSkyDome = new THREE.Mesh(
  new THREE.SphereGeometry(90, 64, 32),
  new THREE.MeshBasicMaterial({ side: THREE.BackSide, depthWrite: false })
);
editorSkyDome.renderOrder = -1000;
scene.add(editorSkyDome);

let editorSkyboxRequest = 0;
async function setEditorSkybox(name) {
  const requestId = ++editorSkyboxRequest;
  const [, surfaceTexture] = await Promise.all([
    applySkybox(scene, name),
    loadSkyboxSurface(name),
  ]);
  if (requestId !== editorSkyboxRequest) return;
  editorSkyDome.material.map = surfaceTexture;
  editorSkyDome.material.needsUpdate = true;
}

for (const name of SKYBOXES) {
  const option = document.createElement('option');
  option.value = name;
  option.textContent = `Sky: ${name}`;
  skyboxSelect.appendChild(option);
}
skyboxSelect.value = 'day';
setEditorSkybox(skyboxSelect.value);
skyboxSelect.addEventListener('change', () => {
  setEditorSkybox(skyboxSelect.value);
  broadcastOp({ t: 'sky', name: skyboxSelect.value });
});

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
// Remote avatars join this list once multiplayer initializes, making other
// players shootable.
const weaponTargets = [mapGroup];
const weapons = createWeaponController({
  camera: exploreCamera,
  canvas,
  scene,
  targets: weaponTargets,
  onShot: (from, to, hit, hitPeerId) => {
    net?.sendShot({ f: [from.x, from.y, from.z], t: [to.x, to.y, to.z], hit });
    if (hitPeerId) dm?.reportHit(hitPeerId);
  },
});

// --- map data -----------------------------------------------------------

// The home menu records how this workshop session should start: a fresh map,
// the locally saved map, hosting the saved map for others, or joining a
// remote host (in which case the real map arrives over the wire).
const netIntent = getNetIntent() || { mode: 'saved' };
const isJoiner = netIntent.mode === 'join';
const isHost = netIntent.mode === 'host';
const netEnabled = isHost || isJoiner;

// Which library slot this session edits. New maps and joined sessions have
// no slot until the first save creates one.
let currentMapId = null;
let map = null;
if (netIntent.mode !== 'new' && !isJoiner) {
  const requestedId = netIntent.mapId
    ?? listMaps()[0]?.id; // legacy intents without a mapId open the latest map
  const saved = requestedId ? getSavedMap(requestedId) : null;
  if (saved) {
    map = saved;
    currentMapId = requestedId;
  }
}
if (!map) map = createEmptyMap(15, 15, TILE_SIZE);
// Cell spacing is dictated by the models (1x1 tiles), not the stored map —
// maps saved before the spacing fix carry a stale tileSize of 2.
map.tileSize = TILE_SIZE;
let cellIndex = new Map();
const objectsById = new Map();
const cellStackTops = new Map();
let renderGeneration = 0;
let mapEditQueue = Promise.resolve();

function enqueueMapEdit(operation) {
  mapEditQueue = mapEditQueue
    .then(operation)
    .catch((error) => console.error('Failed to edit map:', error));
  return mapEditQueue;
}

function rebuildIndex() {
  cellIndex.clear();
  for (const entity of map.entities) {
    const key = cellKey(entity.col, entity.row);
    if (!cellIndex.has(key)) cellIndex.set(key, []);
    cellIndex.get(key).push(entity);
  }
}

function getVerticalBounds(bounds, mirrorY = false, scale = 1) {
  const minY = (mirrorY ? -bounds.maxY : bounds.minY) * scale;
  const maxY = (mirrorY ? -bounds.minY : bounds.maxY) * scale;
  return { minY, maxY, height: bounds.height * scale };
}

async function layoutCellStack(col, row) {
  const key = cellKey(col, row);
  const props = (cellIndex.get(key) || []).filter((entity) => !entity.ground);
  const bounds = await Promise.all(props.map((entity) => getModelBounds(entity.name)));
  let top = 0;
  let legacyMaxStep = -1;
  props.forEach((entity, index) => {
    const verticalBounds = getVerticalBounds(bounds[index], entity.mirrorY, entity.scale ?? 1);
    const savedStep = entity.heightStep ?? legacyMaxStep + 1;
    if (entity.stackOffset === undefined) {
      entity.stackOffset = savedStep - (legacyMaxStep + 1);
    }
    legacyMaxStep = Math.max(legacyMaxStep, savedStep);
    const baseY = Number.isFinite(entity.attachedBaseY)
      ? entity.attachedBaseY
      : top + entity.stackOffset * verticalBounds.height;
    entity.stackOffset = (baseY - top) / verticalBounds.height;
    entity.stackY = baseY - verticalBounds.minY;
    top = Math.max(top, entity.stackY + verticalBounds.maxY);
    const object = objectsById.get(entity.id);
    if (object) object.position.y = entity.stackY;
  });
  cellStackTops.set(key, top);
}

async function layoutAllStacks() {
  cellStackTops.clear();
  await Promise.all([...cellIndex.keys()].map((key) => {
    const [col, row] = key.split(',').map(Number);
    return layoutCellStack(col, row);
  }));
}

function getPendingStackY(col, row, modelHeight) {
  return (cellStackTops.get(cellKey(col, row)) || 0) + pendingHeight * modelHeight;
}

async function renderEntity(entity, generation = renderGeneration) {
  const cellPosition = cellToWorld(entity.col, entity.row, map.width, map.depth, TILE_SIZE);
  const x = cellPosition.x + (entity.offsetX ?? 0);
  const z = cellPosition.z + (entity.offsetZ ?? 0);
  const bounds = entity.ground
    ? getVerticalBounds(await getModelBounds(entity.name), entity.mirrorY, entity.scale ?? 1)
    : null;
  const y = entity.ground ? -bounds.maxY : (entity.stackY ?? 0);
  const object = await spawnModel(entity.name, {
    position: { x, y, z },
    rotationY: entity.rotationStep * (Math.PI / 2),
    mirrorX: entity.mirrorX,
    mirrorY: entity.mirrorY,
    mirrorZ: entity.mirrorZ,
    scale: entity.scale ?? 1,
  });
  if (generation !== renderGeneration || !map.entities.includes(entity)) return;
  object.userData.entityId = entity.id;
  mapGroup.add(object);
  objectsById.set(entity.id, object);
  if (entity.id === selectedEntityId) updateSelectionOutline();
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
  syncQuickbar();
  await layoutAllStacks();
  if (generation !== renderGeneration) return;
  await Promise.all(map.entities.map((entity) => renderEntity(entity, generation)));
}

let mpIdCounter = 0;

// In multiplayer every peer mints entity ids under its own peer-id prefix,
// so simultaneous placements on different machines can never collide. Solo
// maps keep the compact numeric counter from the save format.
function nextEntityId() {
  return netEnabled ? `${selfId.slice(0, 8)}-${mpIdCounter++}` : map.nextId++;
}

function addEntity(partial) {
  const entity = { id: nextEntityId(), rotationStep: 0, heightStep: 0, ...partial };
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
  if (id === selectedEntityId) {
    selectedEntityId = null;
    moveEntityId = null;
    selectionOutline.visible = false;
  }
}

async function removeEntityPreservingStack(id, preservedSurvivors = null) {
  const target = map.entities.find((entity) => entity.id === id);
  if (!target) return null;

  const key = cellKey(target.col, target.row);
  const survivingProps = (cellIndex.get(key) || [])
    .filter((entity) => !entity.ground && entity.id !== id);
  const savedY = new Map(
    survivingProps.map((entity) => [
      entity.id,
      entity.stackY ?? objectsById.get(entity.id)?.position.y ?? 0,
    ])
  );

  removeEntity(id);
  if (target.ground || survivingProps.length === 0) {
    await layoutCellStack(target.col, target.row);
    return target;
  }

  if (Array.isArray(preservedSurvivors)) {
    const preservedById = new Map(
      preservedSurvivors.map((survivor) => [survivor.id, survivor])
    );
    for (const entity of survivingProps) {
      const preserved = preservedById.get(entity.id);
      if (!preserved || !Number.isFinite(preserved.stackOffset)) continue;
      entity.stackOffset = preserved.stackOffset;
      entity.stackY = Number.isFinite(preserved.stackY) ? preserved.stackY : entity.stackY;
    }
    await layoutCellStack(target.col, target.row);
    return {
      target,
      survivors: survivingProps.map(({ id, stackOffset, stackY }) => ({
        id,
        stackOffset,
        stackY,
      })),
    };
  }

  const bounds = await Promise.all(
    survivingProps.map((entity) => getModelBounds(entity.name))
  );
  let top = 0;
  survivingProps.forEach((entity, index) => {
    const verticalBounds = getVerticalBounds(
      bounds[index],
      entity.mirrorY,
      entity.scale ?? 1
    );
    const stackY = savedY.get(entity.id);
    const baseY = stackY + verticalBounds.minY;
    entity.stackOffset = (baseY - top) / verticalBounds.height;
    entity.stackY = stackY;
    top = Math.max(top, stackY + verticalBounds.maxY);
  });

  await layoutCellStack(target.col, target.row);
  return {
    target,
    survivors: survivingProps.map(({ id, stackOffset, stackY }) => ({
      id,
      stackOffset,
      stackY,
    })),
  };
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
  undoBtn.disabled = netEnabled || undoStack.length === 0;
  if (netEnabled) undoBtn.title = 'Undo is disabled in multiplayer sessions';
}

// Whole-map undo snapshots can't coexist with other players' live edits —
// restoring one would silently revert their work — so undo is a solo-only
// feature.
function recordUndoState() {
  if (netEnabled) return;
  undoStack.push(cloneMap(map));
  if (undoStack.length > MAX_UNDO_STATES) undoStack.shift();
  updateUndoButton();
}

async function undoLastEdit() {
  if (netEnabled) return;
  const previous = undoStack.pop();
  if (!previous) return;
  map = previous;
  map.tileSize = TILE_SIZE;
  mapRevision += 1;
  clearEntitySelection();
  updateUndoButton();
  await loadEntireMap();
}

// --- palette --------------------------------------------------------------

let currentBrush = null;
let pendingRotation = 0;
let pendingHeight = 0;
let pendingMirrors = { x: false, y: false, z: false };
let pendingScale = 1;
let selectedEntityId = null;
let moveEntityId = null;
let copyMode = false;
const STARRED_STORAGE_KEY = 'towerdive-workshop-starred-v1';
let starredOnly = false;

function loadStarredNames() {
  try {
    const stored = JSON.parse(localStorage.getItem(STARRED_STORAGE_KEY) || '[]');
    return new Set(Array.isArray(stored) ? stored.filter((name) => typeof name === 'string') : []);
  } catch (error) {
    console.error('Failed to load starred items:', error);
    return new Set();
  }
}

const starredNames = loadStarredNames();

for (const kit of getKitOptions()) {
  const option = document.createElement('option');
  option.value = kit.value;
  option.textContent = kit.label;
  paletteKitFilter.appendChild(option);
}

function saveStarredNames() {
  try {
    localStorage.setItem(STARRED_STORAGE_KEY, JSON.stringify([...starredNames]));
  } catch (error) {
    console.error('Failed to save starred items:', error);
  }
}

function updateBrushStatus() {
  const selectedEntity = map.entities.find((entity) => entity.id === selectedEntityId);
  const selectedMirrors = selectedEntity
    ? ['X', 'Y', 'Z'].filter((axis) => selectedEntity[`mirror${axis}`])
    : [];
  const brushMirrors = ['X', 'Y', 'Z'].filter((axis) => pendingMirrors[axis.toLocaleLowerCase()]);
  if (moveEntityId !== null && selectedEntity) {
    brushNameEl.textContent = `move: ${selectedEntity.name}`;
    brushDetailEl.textContent = 'click destination · Esc cancel';
  } else if (!currentBrush && selectedEntity) {
    brushNameEl.textContent = `selected: ${selectedEntity.name}`;
    brushDetailEl.textContent = `scale ${(selectedEntity.scale ?? 1).toFixed(2)}x · Del delete · C copy · M move · [ ] height${selectedMirrors.length ? ` · mirror ${selectedMirrors.join('/')}` : ''}`;
  } else if (!currentBrush) {
    brushNameEl.textContent = 'no tool selected';
    brushDetailEl.textContent = '';
  } else if (currentBrush === ERASE) {
    brushNameEl.textContent = 'erase';
    brushDetailEl.textContent = '';
  } else {
    brushNameEl.textContent = currentBrush;
    const offset = pendingHeight === 0 ? 'auto-stack' : `auto-stack ${pendingHeight > 0 ? '+' : ''}${pendingHeight}`;
    brushDetailEl.textContent = `${copyMode ? 'copy · ' : ''}scale ${pendingScale.toFixed(2)}x · rot ${pendingRotation * 90}° · ${offset}${brushMirrors.length ? ` · mirror ${brushMirrors.join('/')}` : ''}`;
  }
}

function selectBrush(name) {
  currentBrush = name;
  moveEntityId = null;
  copyMode = false;
  selectedEntityId = null;
  selectionOutline.visible = false;
  pendingRotation = 0;
  pendingHeight = 0;
  pendingMirrors = { x: false, y: false, z: false };
  pendingScale = 1;
  document.querySelectorAll('.palette-item.selected').forEach((el) => el.classList.remove('selected'));
  document.querySelectorAll('.quickbar-item.selected').forEach((el) => el.classList.remove('selected'));
  document.querySelectorAll(`[data-name="${CSS.escape(name)}"]`).forEach((el) => el.classList.add('selected'));
  updateGhost();
  updateBrushStatus();
}

function deselectBrush() {
  currentBrush = null;
  moveEntityId = null;
  copyMode = false;
  document.querySelectorAll('.palette-item.selected').forEach((el) => el.classList.remove('selected'));
  document.querySelectorAll('.quickbar-item.selected').forEach((el) => el.classList.remove('selected'));
  updateGhost();
  updateBrushStatus();
}

function selectEntity(id) {
  selectedEntityId = map.entities.some((entity) => entity.id === id) ? id : null;
  updateSelectionOutline();
  updateBrushStatus();
}

function clearEntitySelection() {
  selectedEntityId = null;
  moveEntityId = null;
  selectionOutline.visible = false;
  updateBrushStatus();
}

function copySelectedEntity() {
  const entity = map.entities.find((candidate) => candidate.id === selectedEntityId);
  if (!entity) return;
  selectBrush(entity.name);
  pendingRotation = entity.rotationStep ?? 0;
  pendingMirrors = {
    x: Boolean(entity.mirrorX),
    y: Boolean(entity.mirrorY),
    z: Boolean(entity.mirrorZ),
  };
  pendingScale = entity.scale ?? 1;
  copyMode = true;
  syncGhostTransform();
  updateBrushStatus();
}

function beginMoveSelectedEntity() {
  if (!map.entities.some((entity) => entity.id === selectedEntityId)) return;
  currentBrush = null;
  copyMode = false;
  moveEntityId = selectedEntityId;
  document.querySelectorAll('.palette-item.selected, .quickbar-item.selected')
    .forEach((element) => element.classList.remove('selected'));
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
    const entry = document.createElement('div');
    entry.className = 'palette-entry';

    const btn = document.createElement('button');
    btn.className = 'palette-item';
    btn.dataset.name = name;
    const preview = document.createElement('img');
    preview.className = 'palette-preview';
    preview.alt = '';
    preview.dataset.previewName = name;
    btn.appendChild(preview);

    const label = document.createElement('span');
    label.className = 'palette-item-label';
    label.textContent = name.slice(name.indexOf('/') + 1);
    btn.appendChild(label);
    btn.title = name;
    btn.addEventListener('click', () => selectBrush(name));
    entry.appendChild(btn);

    const starBtn = document.createElement('button');
    starBtn.className = 'palette-star';
    starBtn.type = 'button';
    starBtn.dataset.starName = name;
    starBtn.addEventListener('click', () => toggleStar(name));
    entry.appendChild(starBtn);
    grid.appendChild(entry);
  }
  section.appendChild(grid);
  paletteCategories.appendChild(section);
}

function applyPaletteFilters() {
  const query = paletteSearch.value.trim().toLocaleLowerCase();
  paletteCategories.querySelectorAll('.palette-category').forEach((section) => {
    let visibleCount = 0;
    section.querySelectorAll('.palette-entry').forEach((entry) => {
      const item = entry.querySelector('.palette-item');
      const name = item.dataset.name;
      const meta = getModelMeta(name);
      const selectedKit = paletteKitFilter.value;
      const selectedType = paletteTypeFilter.value;
      const searchable = `${name} ${meta.kitLabel} ${meta.type}`.toLocaleLowerCase();
      const visible = (!query || searchable.includes(query))
        && (selectedKit === 'all' || meta.kit === selectedKit)
        && (selectedType === 'all' || meta.type === selectedType)
        && (!starredOnly || starredNames.has(name));
      entry.hidden = !visible;
      if (visible) visibleCount += 1;
    });
    section.hidden = visibleCount === 0;
  });
}

function updateStarControls() {
  paletteCategories.querySelectorAll('.palette-star').forEach((button) => {
    const starred = starredNames.has(button.dataset.starName);
    button.classList.toggle('starred', starred);
    button.textContent = starred ? '\u2605' : '\u2606';
    button.title = starred ? 'Remove star' : 'Star item';
    button.setAttribute('aria-label', `${starred ? 'Unstar' : 'Star'} ${button.dataset.starName}`);
    button.setAttribute('aria-pressed', String(starred));
  });
  starredFilterBtn.textContent = `${starredOnly ? '\u2605' : '\u2606'} Starred`;
  starredFilterBtn.setAttribute('aria-pressed', String(starredOnly));
}

function toggleStar(name) {
  if (starredNames.has(name)) starredNames.delete(name);
  else starredNames.add(name);
  saveStarredNames();
  updateStarControls();
  applyPaletteFilters();
  syncQuickbar();
}

paletteSearch.addEventListener('input', applyPaletteFilters);
paletteKitFilter.addEventListener('change', applyPaletteFilters);
paletteTypeFilter.addEventListener('change', applyPaletteFilters);
starredFilterBtn.addEventListener('click', () => {
  starredOnly = !starredOnly;
  updateStarControls();
  applyPaletteFilters();
});
updateStarControls();

// --- quickbar ---------------------------------------------------------------

const QUICKBAR_STORAGE_KEY = 'towerdive-workshop-quickbar-v1';
const previewRequests = new Map();
let previewQueue = Promise.resolve();
const previewRenderer = new THREE.WebGLRenderer({
  alpha: true,
  antialias: true,
  preserveDrawingBuffer: true,
});
previewRenderer.setPixelRatio(1);
previewRenderer.setSize(136, 80, false);

function loadQuickbarOrder() {
  try {
    const stored = JSON.parse(localStorage.getItem(QUICKBAR_STORAGE_KEY) || '[]');
    return Array.isArray(stored) ? stored.filter((name) => typeof name === 'string') : [];
  } catch (error) {
    console.error('Failed to load quickbar:', error);
    return [];
  }
}

let quickbarOrder = loadQuickbarOrder();

function saveQuickbarOrder() {
  try {
    localStorage.setItem(QUICKBAR_STORAGE_KEY, JSON.stringify(quickbarOrder));
  } catch (error) {
    console.error('Failed to save quickbar:', error);
  }
}

async function renderModelPreview(name) {
  const previewScene = new THREE.Scene();
  previewScene.add(new THREE.HemisphereLight(0xdde8ff, 0x303744, 2.5));
  const previewSun = new THREE.DirectionalLight(0xfff2d9, 2);
  previewSun.position.set(3, 5, 4);
  previewScene.add(previewSun);

  const model = await spawnModel(name, {});
  const box = new THREE.Box3().setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  model.position.sub(center);
  previewScene.add(model);

  const radius = Math.max(size.length() / 2, 0.1);
  const previewCamera = new THREE.PerspectiveCamera(32, 136 / 80, 0.01, radius * 10);
  previewCamera.position.set(radius * 2.5, radius * 2, radius * 2.5);
  previewCamera.lookAt(0, 0, 0);
  previewRenderer.render(previewScene, previewCamera);
  return previewRenderer.domElement.toDataURL('image/png');
}

function getModelPreview(name) {
  if (previewRequests.has(name)) return previewRequests.get(name);
  const request = previewQueue.then(() => renderModelPreview(name));
  previewQueue = request.catch(() => {});
  const cachedRequest = request.catch((error) => {
    previewRequests.delete(name);
    throw error;
  });
  previewRequests.set(name, cachedRequest);
  return cachedRequest;
}

function createQuickbarItem(name) {
  const button = document.createElement('button');
  button.className = 'quickbar-item';
  button.dataset.name = name;
  button.title = name;
  button.setAttribute('aria-label', `Select ${name}`);
  button.addEventListener('click', () => selectBrush(name));
  button.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    toggleStar(name);
  });

  const preview = document.createElement('img');
  preview.className = 'quickbar-preview';
  preview.alt = '';
  getModelPreview(name)
    .then((url) => {
      if (preview.isConnected) preview.src = url;
    })
    .catch((error) => console.error(`Failed to render preview for ${name}:`, error));
  button.appendChild(preview);

  const label = document.createElement('span');
  label.className = 'quickbar-label';
  label.textContent = name.slice(name.indexOf('/') + 1);
  button.appendChild(label);
  if (starredNames.has(name)) {
    const star = document.createElement('span');
    star.className = 'quickbar-star';
    star.textContent = '\u2605';
    button.appendChild(star);
  }
  if (name === currentBrush) button.classList.add('selected');
  return button;
}

function hydratePalettePreviews() {
  paletteCategories.querySelectorAll('.palette-preview[data-preview-name]').forEach((preview) => {
    const name = preview.dataset.previewName;
    delete preview.dataset.previewName;
    getModelPreview(name)
      .then((url) => {
        if (preview.isConnected) preview.src = url;
      })
      .catch((error) => console.error(`Failed to render preview for ${name}:`, error));
  });
}

hydratePalettePreviews();
applyPaletteFilters();

function syncQuickbar() {
  const availableNames = new Set(map.entities.map((entity) => entity.name));
  for (const entity of map.entities) {
    if (!quickbarOrder.includes(entity.name)) quickbarOrder.push(entity.name);
  }
  saveQuickbarOrder();
  const visibleNames = quickbarOrder.filter((name) => availableNames.has(name));
  quickbar.replaceChildren(...visibleNames.map(createQuickbarItem));
}

quickbar.addEventListener('wheel', (event) => {
  const items = [...quickbar.querySelectorAll('.quickbar-item')];
  if (items.length === 0) return;
  event.preventDefault();
  const selectedEntity = map.entities.find((entity) => entity.id === selectedEntityId);
  const activeName = currentBrush || selectedEntity?.name;
  const activeIndex = items.findIndex((item) => item.dataset.name === activeName);
  const direction = (event.deltaY || event.deltaX) > 0 ? 1 : -1;
  const nextIndex = activeIndex === -1
    ? (direction > 0 ? 0 : items.length - 1)
    : (activeIndex + direction + items.length) % items.length;
  const nextItem = items[nextIndex];
  selectBrush(nextItem.dataset.name);
  nextItem.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}, { passive: false });

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
let ghostMinY = 0;
let ghostMaxY = 0;
let ghostHeight = 0;
let ghostBounds = null;
let ghostBoundsName = null;
let hoverSidePlacement = null;

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
  const cellPosition = cellToWorld(hoverCell.col, hoverCell.row, map.width, map.depth, TILE_SIZE);
  const x = hoverSidePlacement?.x ?? cellPosition.x;
  const z = hoverSidePlacement?.z ?? cellPosition.z;
  ghostObject.visible = true;
  const verticalBounds = getVerticalBounds(
    { minY: ghostMinY, maxY: ghostMaxY, height: ghostHeight },
    pendingMirrors.y,
    pendingScale
  );
  const y = isGroundModel(currentBrush)
    ? -verticalBounds.maxY
    : hoverSidePlacement?.y
      ?? getPendingStackY(hoverCell.col, hoverCell.row, verticalBounds.height) - verticalBounds.minY;
  ghostObject.position.set(x, y, z);
  ghostObject.rotation.y = pendingRotation * (Math.PI / 2);
  ghostObject.scale.set(
    pendingScale * (pendingMirrors.x ? -1 : 1),
    pendingScale * (pendingMirrors.y ? -1 : 1),
    pendingScale * (pendingMirrors.z ? -1 : 1)
  );
}

async function ensureGhost(name) {
  if (ghostBrushName === name) {
    refreshPointerHover();
    return;
  }
  if (ghostObject) {
    scene.remove(ghostObject);
    ghostObject = null;
  }
  ghostBrushName = name;
  ghostBounds = null;
  ghostBoundsName = null;
  hoverSidePlacement = null;
  const [object, bounds] = await Promise.all([
    spawnModel(name, {}),
    getModelBounds(name),
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
  ghostMinY = bounds.minY;
  ghostMaxY = bounds.maxY;
  ghostHeight = bounds.height;
  ghostBounds = bounds;
  ghostBoundsName = name;
  ghostObject = object;
  ghostObject.visible = false;
  scene.add(object);
  refreshPointerHover();
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
const selectionOutline = new THREE.BoxHelper(undefined, 0x66ff99);
selectionOutline.material.depthTest = false;
selectionOutline.material.transparent = true;
selectionOutline.material.opacity = 1;
selectionOutline.renderOrder = 11;
selectionOutline.visible = false;
scene.add(selectionOutline);
let hoverCell = null;
let hoverEntityId = null;
const faceNormal = new THREE.Vector3();
const targetBounds = new THREE.Box3();
const targetCenter = new THREE.Vector3();

function getSidePlacement(intersection, targetObject) {
  if (
    !intersection?.face
    || !targetObject
    || !ghostBounds
    || ghostBoundsName !== currentBrush
    || !currentBrush
    || currentBrush === ERASE
    || isGroundModel(currentBrush)
  ) return null;

  faceNormal.copy(intersection.face.normal).transformDirection(intersection.object.matrixWorld);
  const horizontalStrength = Math.max(Math.abs(faceNormal.x), Math.abs(faceNormal.z));
  if (Math.abs(faceNormal.y) > 0.45 || horizontalStrength < 0.75) return null;

  targetBounds.setFromObject(targetObject);
  targetBounds.getCenter(targetCenter);
  const horizontalBounds = getHorizontalBounds(
    ghostBounds,
    pendingRotation,
    pendingMirrors,
    pendingScale
  );
  const verticalBounds = getVerticalBounds(ghostBounds, pendingMirrors.y, pendingScale);

  let x;
  let z;
  if (Math.abs(faceNormal.x) >= Math.abs(faceNormal.z)) {
    const positive = faceNormal.x > 0;
    x = intersection.point.x
      - (positive ? horizontalBounds.minX : horizontalBounds.maxX);
    z = targetCenter.z - (horizontalBounds.minZ + horizontalBounds.maxZ) / 2;
  } else {
    const positive = faceNormal.z > 0;
    z = intersection.point.z
      - (positive ? horizontalBounds.minZ : horizontalBounds.maxZ);
    x = targetCenter.x - (horizontalBounds.minX + horizontalBounds.maxX) / 2;
  }

  const destination = worldToCell(x, z, map.width, map.depth, TILE_SIZE);
  const col = THREE.MathUtils.clamp(destination.col, 0, map.width - 1);
  const row = THREE.MathUtils.clamp(destination.row, 0, map.depth - 1);
  const cellPosition = cellToWorld(col, row, map.width, map.depth, TILE_SIZE);
  const baseY = targetBounds.min.y + pendingHeight * verticalBounds.height;
  return {
    col,
    row,
    x,
    y: baseY - verticalBounds.minY,
    z,
    offsetX: x - cellPosition.x,
    offsetZ: z - cellPosition.z,
  };
}

function updateSelectionOutline() {
  const object = objectsById.get(selectedEntityId);
  selectionOutline.visible = Boolean(object);
  if (object) selectionOutline.setFromObject(object);
}

function getEntityIdFromIntersection(intersection) {
  let object = intersection?.object;
  while (object && object !== mapGroup) {
    if (object.userData.entityId !== undefined) return object.userData.entityId;
    object = object.parent;
  }
  return null;
}

function updateHover(clientX, clientY, ignoredEntityId = null) {
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1
  );
  raycaster.setFromCamera(ndc, camera);
  const entityHit = raycaster.intersectObject(mapGroup, true)
    .find((hit) => getEntityIdFromIntersection(hit) !== ignoredEntityId);
  hoverEntityId = getEntityIdFromIntersection(entityHit);
  const hoverEntity = map.entities.find((entity) => entity.id === hoverEntityId);
  const hoverObject = objectsById.get(hoverEntityId);
  hoverSidePlacement = getSidePlacement(entityHit, hoverObject);
  hoverOutline.visible = Boolean(hoverObject);
  if (hoverObject) hoverOutline.setFromObject(hoverObject);

  if (hoverSidePlacement) {
    hoverCell = { col: hoverSidePlacement.col, row: hoverSidePlacement.row };
  } else if (hoverEntity) {
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

  const { col, row } = hoverSidePlacement
    ? hoverSidePlacement
    : hoverEntity
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

async function placeEntity({ cell, brush, rotation, heightOffset, mirrors, scale, sidePlacement }) {
  if (!cell || !brush || brush === ERASE) return;
  recordUndoState();
  const { col, row } = cell;
  const ground = isGroundModel(brush);
  let placed;
  if (ground) {
    const existingGround = (cellIndex.get(cellKey(col, row)) || []).find((e) => e.ground);
    if (existingGround) removeEntity(existingGround.id);
    placed = addEntity({
      name: brush,
      ground: true,
      col,
      row,
      rotationStep: rotation,
      heightStep: 0,
      mirrorX: mirrors.x,
      mirrorY: mirrors.y,
      mirrorZ: mirrors.z,
      scale,
    });
  } else {
    const bounds = await getModelBounds(brush);
    const verticalBounds = getVerticalBounds(bounds, mirrors.y, scale);
    const currentStackTop = cellStackTops.get(cellKey(col, row)) || 0;
    const baseY = sidePlacement
      ? sidePlacement.y + verticalBounds.minY
      : currentStackTop + heightOffset * verticalBounds.height;
    const stackOffset = sidePlacement
      ? (baseY - currentStackTop) / verticalBounds.height
      : heightOffset;
    placed = addEntity({
      name: brush,
      ground: false,
      col,
      row,
      rotationStep: rotation,
      heightStep: getCellStackBase(col, row) + heightOffset,
      stackOffset,
      stackY: baseY - verticalBounds.minY,
      offsetX: sidePlacement?.offsetX ?? 0,
      offsetZ: sidePlacement?.offsetZ ?? 0,
      attachedBaseY: sidePlacement ? baseY : null,
      mirrorX: mirrors.x,
      mirrorY: mirrors.y,
      mirrorZ: mirrors.z,
      scale,
    });
    await layoutCellStack(col, row);
  }
  broadcastOp({ t: 'add', e: placed });
  mapRevision += 1;
  syncQuickbar();
}

async function eraseEntity({ cell, entityId }) {
  if (!cell) return;
  const entities = cellIndex.get(cellKey(cell.col, cell.row)) || [];
  if (entities.length === 0) return;
  const props = entities.filter((e) => !e.ground);
  const selectedTarget = entities.find((entity) => entity.id === entityId);
  if (entityId !== null && !selectedTarget) return;
  const target = selectedTarget || (props.length ? props[props.length - 1] : entities[entities.length - 1]);
  recordUndoState();
  const deletion = await removeEntityPreservingStack(target.id);
  broadcastOp({ t: 'del', id: target.id, survivors: deletion?.survivors });
  mapRevision += 1;
  syncQuickbar();
  hoverEntityId = null;
  hoverOutline.visible = false;
}

async function deleteSelectedEntity(entityId) {
  const entity = map.entities.find((candidate) => candidate.id === entityId);
  if (!entity) return;
  recordUndoState();
  const deletion = await removeEntityPreservingStack(entity.id);
  broadcastOp({ t: 'del', id: entity.id, survivors: deletion?.survivors });
  mapRevision += 1;
  syncQuickbar();
  clearEntitySelection();
}

// Shared between the local UI handlers and remote-op application, so both
// paths stay behaviorally identical.
async function moveEntityCore(entity, cell) {
  const oldCell = { col: entity.col, row: entity.row };
  map.entities.splice(map.entities.indexOf(entity), 1);
  rebuildIndex();

  if (entity.ground) {
    const destinationGround = (cellIndex.get(cellKey(cell.col, cell.row)) || [])
      .find((candidate) => candidate.ground);
    if (destinationGround) removeEntity(destinationGround.id);
  }

  entity.col = cell.col;
  entity.row = cell.row;
  entity.heightStep = entity.ground ? 0 : getCellStackBase(cell.col, cell.row);
  entity.stackOffset = 0;
  entity.offsetX = 0;
  entity.offsetZ = 0;
  entity.attachedBaseY = null;
  map.entities.push(entity);
  rebuildIndex();

  const { x, z } = cellToWorld(cell.col, cell.row, map.width, map.depth, TILE_SIZE);
  const object = objectsById.get(entity.id);
  if (object) object.position.set(x, object.position.y, z);
  await Promise.all([
    layoutCellStack(oldCell.col, oldCell.row),
    layoutCellStack(cell.col, cell.row),
  ]);
  mapRevision += 1;
  syncQuickbar();
}

async function adjustHeightCore(entity, delta) {
  if (Number.isFinite(entity.attachedBaseY)) {
    const bounds = await getModelBounds(entity.name);
    entity.attachedBaseY += bounds.height * (entity.scale ?? 1) * delta;
  }
  entity.stackOffset = (entity.stackOffset ?? 0) + delta;
  entity.heightStep = (entity.heightStep ?? 0) + delta;
  await layoutCellStack(entity.col, entity.row);
  mapRevision += 1;
}

async function toggleMirrorCore(entity, axis) {
  const property = `mirror${axis.toLocaleUpperCase()}`;
  entity[property] = !entity[property];

  const object = objectsById.get(entity.id);
  if (object) object.scale[axis] *= -1;
  if (entity.ground) {
    const bounds = getVerticalBounds(
      await getModelBounds(entity.name),
      entity.mirrorY,
      entity.scale ?? 1
    );
    if (object) object.position.y = -bounds.maxY;
  } else {
    await layoutCellStack(entity.col, entity.row);
  }
  mapRevision += 1;
}

async function setEntityScaleCore(entity, scale) {
  entity.scale = THREE.MathUtils.clamp(scale, 0.25, 4);
  const object = objectsById.get(entity.id);
  if (object) {
    object.scale.set(
      entity.scale * (entity.mirrorX ? -1 : 1),
      entity.scale * (entity.mirrorY ? -1 : 1),
      entity.scale * (entity.mirrorZ ? -1 : 1)
    );
  }
  if (entity.ground) {
    const bounds = getVerticalBounds(await getModelBounds(entity.name), entity.mirrorY, entity.scale);
    if (object) object.position.y = -bounds.maxY;
  } else {
    await layoutCellStack(entity.col, entity.row);
  }
  mapRevision += 1;
}

async function adjustEntityScaleCore(entity, delta) {
  entity.scaleValue = (entity.scaleValue ?? entity.scale ?? 1) + delta;
  await setEntityScaleCore(entity, entity.scaleValue);
  return true;
}

async function moveSelectedEntity({ entityId, cell }) {
  const entity = map.entities.find((candidate) => candidate.id === entityId);
  if (!entity || !cell) return;
  if (
    entity.col === cell.col
    && entity.row === cell.row
    && Math.abs(entity.offsetX ?? 0) < 1e-6
    && Math.abs(entity.offsetZ ?? 0) < 1e-6
  ) {
    moveEntityId = null;
    updateBrushStatus();
    return;
  }

  recordUndoState();
  await moveEntityCore(entity, cell);
  broadcastOp({ t: 'move', id: entity.id, col: cell.col, row: cell.row });
  moveEntityId = null;
  updateSelectionOutline();
  updateBrushStatus();
}

async function adjustSelectedHeight(entityId, delta) {
  const entity = map.entities.find((candidate) => candidate.id === entityId);
  if (!entity || entity.ground) return;
  recordUndoState();
  await adjustHeightCore(entity, delta);
  broadcastOp({ t: 'height', id: entity.id, delta });
  updateSelectionOutline();
  updateBrushStatus();
}

async function toggleSelectedMirror(entityId, axis) {
  const entity = map.entities.find((candidate) => candidate.id === entityId);
  if (!entity) return;
  recordUndoState();
  await toggleMirrorCore(entity, axis);
  broadcastOp({ t: 'mirror', id: entity.id, axis });
  updateSelectionOutline();
  updateBrushStatus();
}

async function scaleSelectedEntity(entityId, delta) {
  const entity = map.entities.find((candidate) => candidate.id === entityId);
  if (!entity) return;
  const nextScale = THREE.MathUtils.clamp((entity.scale ?? 1) + delta, 0.25, 4);
  if (nextScale === (entity.scale ?? 1)) return;
  recordUndoState();
  await adjustEntityScaleCore(entity, delta);
  broadcastOp({ t: 'scale', id: entity.id, delta });
  updateSelectionOutline();
  updateBrushStatus();
}

function scaleBrush(delta) {
  pendingScale = THREE.MathUtils.clamp(pendingScale + delta, 0.25, 4);
  refreshPointerHover();
  updateBrushStatus();
}

function toggleBrushMirror(axis) {
  pendingMirrors[axis] = !pendingMirrors[axis];
  refreshPointerHover();
  updateBrushStatus();
}

let dragCandidate = null;
let suppressNextClick = false;
let lastPointerPosition = null;

function refreshPointerHover() {
  if (lastPointerPosition) {
    updateHover(lastPointerPosition.x, lastPointerPosition.y);
  } else {
    syncGhostTransform();
  }
}

function restoreDraggedObject(candidate) {
  const object = objectsById.get(candidate?.entityId);
  if (object) {
    object.position.x = candidate.originX;
    object.position.y = candidate.originY;
    object.position.z = candidate.originZ;
  }
  updateSelectionOutline();
}

canvas.addEventListener('pointerdown', (event) => {
  if (walker.active || event.button !== 0 || currentBrush || moveEntityId !== null) return;
  updateHover(event.clientX, event.clientY);
  if (hoverEntityId === null || hoverEntityId !== selectedEntityId) return;
  const object = objectsById.get(selectedEntityId);
  const entity = map.entities.find((candidate) => candidate.id === selectedEntityId);
  if (!object || !entity) return;
  dragCandidate = {
    pointerId: event.pointerId,
    entityId: selectedEntityId,
    startX: event.clientX,
    startY: event.clientY,
    originX: object.position.x,
    originY: object.position.y,
    originZ: object.position.z,
    sourceCol: entity.col,
    sourceRow: entity.row,
    ground: entity.ground,
    bounds: getModelBounds(entity.name).then((modelBounds) =>
      getVerticalBounds(modelBounds, entity.mirrorY, entity.scale ?? 1)
    ),
    dragging: false,
  };
  canvas.setPointerCapture(event.pointerId);
});

canvas.addEventListener('pointermove', (event) => {
  if (walker.active) return;
  lastPointerPosition = { x: event.clientX, y: event.clientY };
  if (dragCandidate?.pointerId === event.pointerId) {
    if (!dragCandidate.dragging) {
      const distance = Math.hypot(
        event.clientX - dragCandidate.startX,
        event.clientY - dragCandidate.startY
      );
      if (distance >= 5) {
        dragCandidate.dragging = true;
        canvas.setPointerCapture(event.pointerId);
        controls.enabled = false;
      }
    }
    if (dragCandidate.dragging) {
      updateHover(event.clientX, event.clientY, dragCandidate.entityId);
      const object = objectsById.get(dragCandidate.entityId);
      if (object && hoverCell) {
        const activeDrag = dragCandidate;
        const previewCell = { ...hoverCell };
        const { x, z } = cellToWorld(previewCell.col, previewCell.row, map.width, map.depth, TILE_SIZE);
        object.position.x = x;
        object.position.z = z;
        updateSelectionOutline();
        activeDrag.bounds.then((bounds) => {
          if (dragCandidate !== activeDrag) return;
          if (hoverCell?.col !== previewCell.col || hoverCell?.row !== previewCell.row) return;
          if (previewCell.col === activeDrag.sourceCol && previewCell.row === activeDrag.sourceRow) {
            object.position.y = activeDrag.originY;
          } else {
            const stackTop = cellStackTops.get(cellKey(previewCell.col, previewCell.row)) || 0;
            object.position.y = activeDrag.ground ? -bounds.maxY : stackTop - bounds.minY;
          }
          updateSelectionOutline();
        });
      }
      return;
    }
  }
  updateHover(event.clientX, event.clientY);
});

canvas.addEventListener('pointerup', (event) => {
  if (dragCandidate?.pointerId !== event.pointerId) return;
  const candidate = dragCandidate;
  dragCandidate = null;
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  if (!candidate.dragging) return;
  suppressNextClick = true;
  setTimeout(() => {
    suppressNextClick = false;
  }, 0);
  controls.enabled = true;
  const cell = hoverCell ? { ...hoverCell } : null;
  if (!cell) {
    restoreDraggedObject(candidate);
    return;
  }
  enqueueMapEdit(() => moveSelectedEntity({ entityId: candidate.entityId, cell }));
});

canvas.addEventListener('pointercancel', (event) => {
  if (dragCandidate?.pointerId !== event.pointerId) return;
  const candidate = dragCandidate;
  dragCandidate = null;
  controls.enabled = true;
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  restoreDraggedObject(candidate);
});

canvas.addEventListener('click', (event) => {
  if (walker.active) return;
  if (suppressNextClick) {
    suppressNextClick = false;
    return;
  }
  updateHover(event.clientX, event.clientY);
  const cell = hoverCell ? { ...hoverCell } : null;
  if (moveEntityId !== null) {
    const request = { cell, entityId: moveEntityId };
    enqueueMapEdit(() => moveSelectedEntity(request));
  } else if (!currentBrush) {
    selectEntity(hoverEntityId);
  } else if (currentBrush === ERASE) {
    const request = { cell, entityId: hoverEntityId };
    enqueueMapEdit(() => eraseEntity(request));
  } else {
    const request = {
      cell,
      brush: currentBrush,
      rotation: pendingRotation,
      heightOffset: pendingHeight,
      mirrors: { ...pendingMirrors },
      scale: pendingScale,
      sidePlacement: hoverSidePlacement ? { ...hoverSidePlacement } : null,
    };
    enqueueMapEdit(() => placeEntity(request));
  }
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
    enqueueMapEdit(undoLastEdit);
    return;
  }
  const mirrorAxis = event.shiftKey && ['x', 'y', 'z'].includes(event.key.toLocaleLowerCase())
    ? event.key.toLocaleLowerCase()
    : null;
  if (mirrorAxis) {
    event.preventDefault();
    if (selectedEntityId !== null && !currentBrush) {
      const entityId = selectedEntityId;
      enqueueMapEdit(() => toggleSelectedMirror(entityId, mirrorAxis));
    } else if (currentBrush && currentBrush !== ERASE) {
      toggleBrushMirror(mirrorAxis);
    }
    return;
  }
  const scaleDelta = ['+', '='].includes(event.key)
    ? 0.25
    : ['-', '_'].includes(event.key) ? -0.25 : 0;
  if (scaleDelta !== 0) {
    if (selectedEntityId !== null && !currentBrush) {
      event.preventDefault();
      const entityId = selectedEntityId;
      enqueueMapEdit(() => scaleSelectedEntity(entityId, scaleDelta));
    } else if (currentBrush && currentBrush !== ERASE) {
      event.preventDefault();
      scaleBrush(scaleDelta);
    }
    return;
  }
  if ((event.key === 'Delete' || event.key === 'Backspace') && selectedEntityId !== null) {
    event.preventDefault();
    const entityId = selectedEntityId;
    enqueueMapEdit(() => deleteSelectedEntity(entityId));
    return;
  }
  if (event.key.toLocaleLowerCase() === 'c' && selectedEntityId !== null) {
    event.preventDefault();
    copySelectedEntity();
    return;
  }
  if (event.key.toLocaleLowerCase() === 'm' && selectedEntityId !== null) {
    event.preventDefault();
    beginMoveSelectedEntity();
    return;
  }
  if (event.key === 'r' || event.key === 'R') {
    pendingRotation = (pendingRotation + 1) % 4;
    updateBrushStatus();
    refreshPointerHover();
  } else if (event.key === '[') {
    if (selectedEntityId !== null && !currentBrush) {
      const entityId = selectedEntityId;
      enqueueMapEdit(() => adjustSelectedHeight(entityId, -1));
    } else {
      pendingHeight -= 1;
      updateBrushStatus();
      refreshPointerHover();
    }
  } else if (event.key === ']') {
    if (selectedEntityId !== null && !currentBrush) {
      const entityId = selectedEntityId;
      enqueueMapEdit(() => adjustSelectedHeight(entityId, 1));
    } else {
      pendingHeight += 1;
      updateBrushStatus();
      refreshPointerHover();
    }
  } else if (event.key === 'Escape') {
    if (currentBrush || moveEntityId !== null) deselectBrush();
    else clearEntitySelection();
  }
});

// --- top bar actions --------------------------------------------------------

const mapNameInput = document.getElementById('map-name');
const saveBtn = document.getElementById('action-save');
{
  const savedEntry = currentMapId ? listMaps().find((entry) => entry.id === currentMapId) : null;
  mapNameInput.value = savedEntry?.name
    || (isJoiner ? `${netIntent.hostName || 'host'}'s map` : '');
}
mapNameInput.addEventListener('change', () => {
  if (!currentMapId) return;
  const entry = renameMap(currentMapId, mapNameInput.value);
  if (entry) mapNameInput.value = entry.name;
});

// Small screenshot of the current view, stored with the library entry so
// the menu can show what each map looks like.
function captureThumbnail() {
  renderer.render(scene, walker.active ? exploreCamera : camera);
  const source = renderer.domElement;
  const thumbCanvas = document.createElement('canvas');
  thumbCanvas.width = 240;
  thumbCanvas.height = 135;
  const ctx = thumbCanvas.getContext('2d');
  const scale = Math.max(thumbCanvas.width / source.width, thumbCanvas.height / source.height);
  const width = source.width * scale;
  const height = source.height * scale;
  ctx.drawImage(source, (thumbCanvas.width - width) / 2, (thumbCanvas.height - height) / 2, width, height);
  return thumbCanvas.toDataURL('image/jpeg', 0.7);
}

let saveFlashTimer = 0;
saveBtn.addEventListener('click', () => {
  try {
    const entry = saveMapAs({
      id: currentMapId,
      name: mapNameInput.value.trim() || 'Untitled map',
      map,
      thumb: captureThumbnail(),
    });
    currentMapId = entry.id;
    mapNameInput.value = entry.name;
    saveBtn.textContent = '✓ Saved';
    clearTimeout(saveFlashTimer);
    saveFlashTimer = setTimeout(() => {
      saveBtn.textContent = 'Save';
    }, 1200);
  } catch (error) {
    console.error('Failed to save map:', error);
  }
});

undoBtn.addEventListener('click', () => enqueueMapEdit(undoLastEdit));

document.getElementById('action-export').addEventListener('click', () => {
  exportMapFile(map, mapNameInput.value.trim() || 'towerdive-map');
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
    await enqueueMapEdit(async () => {
      if (requestId !== importRequestId || startingRevision !== mapRevision) {
        throw new Error('Map changed before import completed');
      }
      recordUndoState();
      map = importedMap;
      map.tileSize = TILE_SIZE;
      mapRevision += 1;
      clearEntitySelection();
      broadcastOp({ t: 'replace', map: cloneMap(map) });
      await loadEntireMap();
    });
  } catch (err) {
    console.error('Failed to import map:', err);
  }
});

document.getElementById('action-clear').addEventListener('click', () => {
  if (!confirm('Clear the entire map?')) return;
  enqueueMapEdit(async () => {
    recordUndoState();
    map = createEmptyMap(map.width, map.depth, TILE_SIZE);
    mapRevision += 1;
    clearEntitySelection();
    broadcastOp({ t: 'clear', width: map.width, depth: map.depth });
    await loadEntireMap();
  });
});

// The walker drives its own perspective camera, so the orthographic build
// camera (and its orbit controls) are untouched — exiting just switches
// which camera renders.
function exitExplore() {
  weapons.exit();
  weapons.setFiringLocked(false);
  controls.enabled = true;
  exploreHint.hidden = true;
  exploreBtn.classList.remove('active');
  exploreBtn.textContent = '\u{1F6F8} Explore';
  document.body.classList.remove('explore-mode');
  dm?.refreshHud();
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
  document.body.classList.add('explore-mode');
  exploreHint.hidden = false;
  exploreBtn.classList.add('active');
  exploreBtn.textContent = '\u{1F6F8} exit explore';
  dm?.refreshHud();
});

// --- multiplayer --------------------------------------------------------------

let net = null;
let lobby = null;
let remotePlayers = null;
let dm = null;
let mapSynced = !isJoiner; // joiners wait for the host's map before edits count
let mapSyncSourceId = null;
let pendingSyncOps = [];
let mapSyncToken = 0;
let localOpSequence = 0;
let opClock = {};
const sessionStartedAt = Number(netIntent.startedAt) || Date.now();

function broadcastOp(op) {
  if (!net || !mapSynced) return;
  localOpSequence += 1;
  opClock[selfId] = localOpSequence;
  net.sendOp({ origin: selfId, sequence: localOpSequence, op });
}

function findEntity(id) {
  return map.entities.find((entity) => entity.id === id);
}

// Remote edits reuse the same cores as local edits and run through the same
// serialization queue, so a burst of concurrent edits can't interleave
// mid-async-operation.
async function applyRemoteOp(op) {
  switch (op?.t) {
    case 'add': {
      const entity = op.e;
      if (!entity || findEntity(entity.id)) return;
      if (entity.ground) {
        const existing = (cellIndex.get(cellKey(entity.col, entity.row)) || []).find((e) => e.ground);
        if (existing) removeEntity(existing.id);
      }
      map.entities.push(entity);
      rebuildIndex();
      if (!entity.ground) await layoutCellStack(entity.col, entity.row);
      renderEntity(entity);
      mapRevision += 1;
      syncQuickbar();
      return;
    }
    case 'del': {
      const entity = findEntity(op.id);
      if (!entity) return;
      await removeEntityPreservingStack(entity.id, op.survivors);
      mapRevision += 1;
      syncQuickbar();
      return;
    }
    case 'move': {
      const entity = findEntity(op.id);
      if (!entity) return;
      await moveEntityCore(entity, { col: op.col, row: op.row });
      updateSelectionOutline();
      return;
    }
    case 'height': {
      const entity = findEntity(op.id);
      if (!entity || entity.ground) return;
      await adjustHeightCore(entity, op.delta);
      updateSelectionOutline();
      return;
    }
    case 'mirror': {
      const entity = findEntity(op.id);
      if (!entity || !['x', 'y', 'z'].includes(op.axis)) return;
      await toggleMirrorCore(entity, op.axis);
      updateSelectionOutline();
      return;
    }
    case 'scale': {
      const entity = findEntity(op.id);
      if (!entity || !Number.isFinite(op.delta) || Math.abs(op.delta) > 1) return;
      await adjustEntityScaleCore(entity, op.delta);
      updateSelectionOutline();
      updateBrushStatus();
      return;
    }
    case 'clear': {
      map = createEmptyMap(op.width || map.width, op.depth || map.depth, TILE_SIZE);
      mapRevision += 1;
      clearEntitySelection();
      await loadEntireMap();
      return;
    }
    case 'replace': {
      if (op.map?.version !== 1) return;
      map = op.map;
      map.tileSize = TILE_SIZE;
      mapRevision += 1;
      clearEntitySelection();
      await loadEntireMap();
      return;
    }
    case 'sky': {
      if (SKYBOXES.includes(op.name)) {
        skyboxSelect.value = op.name;
        setEditorSkybox(op.name);
      }
      return;
    }
  }
}

async function applyNetworkOp(message) {
  if (
    message
    && typeof message === 'object'
    && typeof message.origin === 'string'
    && Number.isSafeInteger(message.sequence)
    && message.sequence > 0
    && message.op
  ) {
    if (message.sequence <= (opClock[message.origin] || 0)) return;
    await applyRemoteOp(message.op);
    opClock[message.origin] = message.sequence;
    return;
  }
  // Compatibility with peers that connected during a rolling deployment.
  await applyRemoteOp(message);
}

function updateNetStatus() {
  if (!netEnabled) return;
  netStatusEl.hidden = false;
  netStatusEl.classList.toggle('net-status-syncing', !mapSynced);
  if (!mapSynced) {
    netStatusEl.textContent = `⏳ joining ${netIntent.hostName || 'host'}…`;
    return;
  }
  const count = net ? net.peers.size + 1 : 1;
  const names = net
    ? [...net.peers.values()].map((peer) => peer.name).filter(Boolean).join(', ')
    : '';
  const currentHostName = net?.isHost
    ? getPlayerName() || 'player'
    : net?.peerName(net?.currentHostId) || netIntent.hostName || 'host';
  netStatusEl.textContent = net?.isHost
    ? `\u{1F4E1} Hosting · ${count} player${count === 1 ? '' : 's'}`
    : `\u{1F517} ${currentHostName}'s session · ${count} player${count === 1 ? '' : 's'}`;
  netStatusEl.title = names ? `Also here: ${names}` : 'No one else here yet';
}

if (netEnabled) {
  const playerName = getPlayerName() || 'player';
  const hostId = isHost ? selfId : netIntent.hostId;

  function syncHostRole() {
    if (!net) return;
    if (net.isHost && !lobby) {
      lobby = announceInLobby(hostId, () => ({
        name: playerName,
        mapName: mapNameInput.value.trim() || `${playerName}'s map`,
        players: net.peers.size + 1,
        startedAt: sessionStartedAt,
        generation: net.hostGeneration,
      }));
      if (mapSynced) {
        enqueueMapEdit(() => net.sendMap({
          map: cloneMap(map),
          sky: skyboxSelect.value,
          opClock: { ...opClock },
        }));
      }
    } else if (!net.isHost && lobby) {
      lobby.leave();
      lobby = null;
    }
    updateNetStatus();
  }

  remotePlayers = createRemotePlayers({
    scene,
    tileSize: TILE_SIZE,
    cellToWorld: (col, row) => cellToWorld(col, row, map.width, map.depth, TILE_SIZE),
  });

  net = createGameSession({
    hostId,
    playerName,
    ready: !isJoiner,
    handlers: {
      // Host answers each newcomer with a consistent snapshot; taking it
      // through the edit queue guarantees no half-applied operation is
      // captured mid-flight.
      onPeerNeedsMap(peerId) {
        enqueueMapEdit(() => {
          net.sendMap({
            map: cloneMap(map),
            sky: skyboxSelect.value,
            opClock: { ...opClock },
          }, peerId);
        });
      },
      onMap(data, peerId) {
        if (!isJoiner || mapSynced || peerId !== net.currentHostId) return;
        if (data?.map?.version !== 1) return;
        const syncToken = ++mapSyncToken;
        const hostGeneration = net.hostGeneration;
        mapSyncSourceId = peerId;
        enqueueMapEdit(async () => {
          if (
            mapSynced
            || peerId !== net.currentHostId
            || mapSyncSourceId !== peerId
            || hostGeneration !== net.hostGeneration
            || syncToken !== mapSyncToken
          ) return;
          map = data.map;
          map.tileSize = TILE_SIZE;
          opClock = data.opClock && typeof data.opClock === 'object' ? { ...data.opClock } : {};
          localOpSequence = Math.max(localOpSequence, opClock[selfId] || 0);
          mapRevision += 1;
          clearEntitySelection();
          if (SKYBOXES.includes(data.sky)) {
            skyboxSelect.value = data.sky;
            setEditorSkybox(data.sky);
          }
          await loadEntireMap();
          if (
            peerId !== net.currentHostId
            || mapSyncSourceId !== peerId
            || hostGeneration !== net.hostGeneration
            || syncToken !== mapSyncToken
          ) return;
          while (pendingSyncOps.length > 0) {
            const ops = pendingSyncOps.splice(0);
            for (const op of ops) await applyNetworkOp(op);
          }
          mapSynced = true;
          mapSyncSourceId = null;
          net.setReady(true);
          updateNetStatus();
        });
      },
      // Ops arriving before the initial snapshot are dropped: everything the
      // host did up to the snapshot is already inside it.
      onOp(op) {
        if (!mapSynced) {
          pendingSyncOps.push(op);
          return;
        }
        enqueueMapEdit(() => applyNetworkOp(op));
      },
      onState(state, peerId) {
        remotePlayers.pushState(peerId, state);
        dm?.setPeerMode(peerId, state.m === 'x' ? 'x' : 'e');
      },
      onShot(shot) {
        remotePlayers.showShot(shot);
      },
      onDm(event, peerId) {
        dm?.handleRemote(event, peerId);
      },
      onPeerLeft(peerId) {
        remotePlayers.removePeer(peerId);
        dm?.peerLeft(peerId);
      },
      onPeersChanged() {
        for (const [peerId, info] of net.peers) {
          if (info.name) remotePlayers.setPeerName(peerId, info.name);
        }
        updateNetStatus();
        lobby?.update();
      },
      onHostChanged() {
        if (!mapSynced) {
          mapSyncToken += 1;
          mapSyncSourceId = null;
        }
        syncHostRole();
      },
    },
  });

  dm = createDeathmatch({
    selfId,
    send: (event) => net.sendDm(event),
    getSelfName: () => playerName,
    getPeerName: (id) => net.peerName(id),
    getPeerIds: () => [...net.peers.keys()],
    isExploring: () => walker.active,
    setDead(dead) {
      walker.setFrozen(dead);
      weapons.setFiringLocked(dead);
    },
    respawn() {
      const col = Math.floor(Math.random() * map.width);
      const row = Math.floor(Math.random() * map.depth);
      const { x, z } = cellToWorld(col, row, map.width, map.depth, TILE_SIZE);
      walker.respawnAt(x, z);
    },
  });
  weaponTargets.push(remotePlayers.avatarsGroup);

  syncHostRole();

  updateNetStatus();
  updateUndoButton();

  let networkClosed = false;
  function closeNetworkSession() {
    if (networkClosed) return;
    networkClosed = true;
    lobby?.leave();
    net.leave();
  }
  window.addEventListener('pagehide', closeNetworkSession);
  window.addEventListener('beforeunload', closeNetworkSession);
  window.addEventListener('pageshow', (event) => {
    if (event.persisted && networkClosed) window.location.reload();
  });
}

// Fixed-rate state broadcast: 20 Hz snapshots of where we are and what we're
// doing. Our own movement stays fully client-predicted (the walk controller
// simulates locally), remote players are drawn via snapshot interpolation in
// remotePlayers.js — the classic FPS split of prediction + interpolation.
const STATE_SEND_INTERVAL = 1 / 20;
let stateSendTimer = 0;

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function buildLocalState() {
  if (walker.active) {
    return {
      m: 'x',
      p: [round3(exploreCamera.position.x), round3(exploreCamera.position.y), round3(exploreCamera.position.z)],
      y: round3(exploreCamera.rotation.y),
      pt: round3(exploreCamera.rotation.x),
      eh: round3(walker.eyeHeight),
    };
  }
  return {
    m: 'e',
    p: [0, 0, 0],
    c: hoverCell ? [hoverCell.col, hoverCell.row] : null,
  };
}

function netTick(delta) {
  if (!net) return;
  remotePlayers.update();
  dm.update();
  stateSendTimer += delta;
  if (stateSendTimer < STATE_SEND_INTERVAL) return;
  stateSendTimer = stateSendTimer > STATE_SEND_INTERVAL * 2 ? 0 : stateSendTimer - STATE_SEND_INTERVAL;
  net.sendState(buildLocalState());
}

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

// Dev-only handle for automated movement/physics tests; stripped from
// production builds.
if (import.meta.env.DEV) {
  window.__towerdive = { walker, exploreCamera, scene, mapGroup, THREE };
}

// Joiners start from the host's synced map, not the local placeholder.
if (!isJoiner) enqueueMapEdit(loadEntireMap);

const clock = new THREE.Clock();
function animate() {
  const delta = clock.getDelta();
  if (walker.active) {
    walker.update(delta);
    weapons.update(delta);
  } else {
    controls.update();
  }
  netTick(delta);
  renderer.render(scene, walker.active ? exploreCamera : camera);
  requestAnimationFrame(animate);
}
animate();
