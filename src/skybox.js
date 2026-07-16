import { TextureLoader, EquirectangularReflectionMapping, SRGBColorSpace, UVMapping } from 'three';

const loader = new TextureLoader();
const cache = new Map();
const surfaceCache = new Map();

export const SKYBOXES = ['day', 'morning', 'night', 'alien', 'space'];

export function loadSkybox(name) {
  if (cache.has(name)) return cache.get(name);
  const promise = new Promise((resolve, reject) => {
    loader.load(
      `${import.meta.env.BASE_URL}assets/skyboxes/skybox-${name}.png`,
      (texture) => {
        texture.mapping = EquirectangularReflectionMapping;
        texture.colorSpace = SRGBColorSpace;
        resolve(texture);
      },
      undefined,
      reject
    );
  });
  cache.set(name, promise);
  return promise;
}

// Only sets the visible background, not scene.environment — swapping in
// image-based lighting here would shift how every model's material looks,
// on top of lighting already tuned to avoid harsh facet shading.
export async function applySkybox(scene, name) {
  const texture = await loadSkybox(name);
  scene.background = texture;
  return texture;
}

export function loadSkyboxSurface(name) {
  if (surfaceCache.has(name)) return surfaceCache.get(name);
  const promise = loadSkybox(name).then((sourceTexture) => {
    const texture = sourceTexture.clone();
    texture.mapping = UVMapping;
    texture.needsUpdate = true;
    return texture;
  });
  surfaceCache.set(name, promise);
  return promise;
}
