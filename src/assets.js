import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const loader = new GLTFLoader();
const cache = new Map();

export function loadModel(name) {
  if (cache.has(name)) return cache.get(name);
  const promise = loader.loadAsync(`/assets/models/${name}.glb`).then((gltf) => gltf.scene);
  cache.set(name, promise);
  return promise;
}

export async function spawnModel(name, { position, rotationY = 0, scale = 1 } = {}) {
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
  instance.scale.setScalar(scale);
  return instance;
}
