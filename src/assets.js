import { Box3, LinearFilter, LinearMipmapLinearFilter, Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const loader = new GLTFLoader();
const cache = new Map();

// Kenney's models bake curved shapes (round towers, domes) out of many
// small flat faces with hard per-face normals, so each facet catches
// directional light at a slightly different angle — visible as fine
// rib-like lines. Re-derive smooth normals, but only average together
// faces whose original normals are already close (within ANGLE_THRESHOLD):
// that smooths genuinely curved surfaces (facets a few degrees apart)
// while leaving real hard edges — crenellations, corners — untouched. A
// naive "average everything at this position" pass would also blend
// unrelated, opposite-facing faces that happen to share a vertex position
// (e.g. inner/outer walls meeting at a corner) into a cancelled-out zero
// vector, which renders solid black.
const ANGLE_THRESHOLD = Math.cos((40 * Math.PI) / 180);

function smoothFacetedNormals(geometry) {
  const position = geometry.attributes.position;
  const normal = geometry.attributes.normal;
  if (!position || !normal) return;

  const groups = new Map();
  const keyFor = (i) =>
    `${position.getX(i).toFixed(4)}_${position.getY(i).toFixed(4)}_${position.getZ(i).toFixed(4)}`;
  for (let i = 0; i < position.count; i++) {
    const key = keyFor(i);
    let group = groups.get(key);
    if (!group) groups.set(key, (group = []));
    group.push(i);
  }

  const ni = new Vector3();
  const nj = new Vector3();
  const accum = new Vector3();
  const smoothed = new Float32Array(position.count * 3);

  for (const indices of groups.values()) {
    for (const i of indices) {
      ni.set(normal.getX(i), normal.getY(i), normal.getZ(i));
      accum.set(0, 0, 0);
      for (const j of indices) {
        nj.set(normal.getX(j), normal.getY(j), normal.getZ(j));
        if (ni.dot(nj) >= ANGLE_THRESHOLD) accum.add(nj);
      }
      accum.normalize();
      smoothed[i * 3] = accum.x;
      smoothed[i * 3 + 1] = accum.y;
      smoothed[i * 3 + 2] = accum.z;
    }
  }
  normal.array.set(smoothed);
  normal.needsUpdate = true;
}

let maxAnisotropy = 1;
export function setMaxAnisotropy(value) {
  maxAnisotropy = value;
}

export function loadModel(name) {
  if (cache.has(name)) return cache.get(name);
  const promise = loader
    .loadAsync(`${import.meta.env.BASE_URL}assets/models/${name}.glb`)
    .then((gltf) => {
      gltf.scene.traverse((child) => {
        if (!child.isMesh) return;
        smoothFacetedNormals(child.geometry);
        if (!child.material?.map) return;
        const map = child.material.map;
        map.magFilter = LinearFilter;
        map.minFilter = LinearMipmapLinearFilter;
        map.anisotropy = maxAnisotropy;
        map.needsUpdate = true;
      });
      return gltf.scene;
    });
  cache.set(name, promise);
  return promise;
}

const boundsCache = new Map();

export async function getModelBounds(name) {
  if (boundsCache.has(name)) return boundsCache.get(name);
  const template = await loadModel(name);
  const box = new Box3().setFromObject(template);
  const bounds = {
    minX: box.min.x,
    minY: box.min.y,
    minZ: box.min.z,
    maxX: box.max.x,
    maxY: box.max.y,
    maxZ: box.max.z,
    height: box.max.y - box.min.y,
  };
  boundsCache.set(name, bounds);
  return bounds;
}

// Kits ship ground tiles at different slab thicknesses (e.g. a tower-defense
// grass tile is 0.2 units thick, a fantasy-town road is 0.025) — measuring
// each model's own bounding box lets callers sink a ground tile so its top
// surface lands at a consistent world height regardless of source kit.
export async function getModelHeight(name) {
  return (await getModelBounds(name)).height;
}

export async function spawnModel(
  name,
  { position, rotationY = 0, scale = 1, mirrorX = false, mirrorY = false, mirrorZ = false } = {}
) {
  const template = await loadModel(name);
  const instance = template.clone(true);
  instance.traverse((child) => {
    if (child.isMesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });
  if (position) instance.position.set(position.x, position.y ?? 0, position.z);
  instance.rotation.y = rotationY;
  instance.scale.set(
    scale * (mirrorX ? -1 : 1),
    scale * (mirrorY ? -1 : 1),
    scale * (mirrorZ ? -1 : 1)
  );
  return instance;
}
