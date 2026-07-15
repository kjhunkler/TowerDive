import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { loadModel, setMaxAnisotropy } from './assets.js';
import { MODEL_NAMES } from './modelList.js';
import { createWalkController } from './walkController.js';

const canvas = document.getElementById('scene');
const nameEl = document.getElementById('viewer-name');
const counterEl = document.getElementById('viewer-counter');
const prevBtn = document.getElementById('viewer-prev');
const nextBtn = document.getElementById('viewer-next');
const walkBtn = document.getElementById('viewer-walk');
const walkHint = document.getElementById('walk-hint');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
setMaxAnisotropy(renderer.capabilities.getMaxAnisotropy());

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1f2e);

const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 100);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.autoRotate = true;
controls.autoRotateSpeed = 1.6;

// These models are built from many small hard-edged facets; a strong
// single directional light makes each one catch the light differently,
// which reads as fine rib-like lines on curved shapes. Leaning on
// ambient/hemisphere light instead keeps some shape-defining shading
// without that harsh facet-to-facet contrast.
const hemiLight = new THREE.HemisphereLight(0xbdd6ff, 0x2a2f3a, 1.8);
scene.add(hemiLight);

const keyLight = new THREE.DirectionalLight(0xfff2d9, 0.6);
keyLight.position.set(4, 6, 5);
keyLight.castShadow = true;
scene.add(keyLight);

const fillLight = new THREE.DirectionalLight(0xaac8ff, 0.35);
fillLight.position.set(-5, 3, -4);
scene.add(fillLight);

const walker = createWalkController({ camera, canvas });

let currentObject = null;
let index = 0;

function resize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height);
}
window.addEventListener('resize', resize);
resize();

function frameObject(object) {
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.length() * 0.5, 0.1);

  object.position.sub(center);

  const distance = radius / Math.sin((camera.fov * Math.PI) / 360) * 1.35;
  camera.position.set(distance * 0.72, distance * 0.55, distance * 0.72);
  camera.near = Math.max(distance / 100, 0.01);
  camera.far = distance * 20;
  camera.updateProjectionMatrix();

  controls.target.set(0, 0, 0);
  controls.update();
}

async function showModel(newIndex) {
  index = ((newIndex % MODEL_NAMES.length) + MODEL_NAMES.length) % MODEL_NAMES.length;
  const name = MODEL_NAMES[index];

  nameEl.textContent = name;
  counterEl.textContent = `${index + 1} / ${MODEL_NAMES.length}`;
  history.replaceState(null, '', `#${name}`);

  const requestedIndex = index;
  const template = await loadModel(name);
  if (requestedIndex !== index) return; // a newer request superseded this one

  if (currentObject) {
    scene.remove(currentObject);
    currentObject.traverse((child) => {
      if (child.isMesh) {
        child.geometry.dispose();
      }
    });
  }

  const instance = template.clone(true);
  instance.traverse((child) => {
    if (child.isMesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });
  scene.add(instance);
  currentObject = instance;
  frameObject(instance);
}

function step(delta) {
  if (walker.active) return;
  showModel(index + delta);
}

prevBtn.addEventListener('click', () => step(-1));
nextBtn.addEventListener('click', () => step(1));

window.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowLeft') step(-1);
  if (event.key === 'ArrowRight') step(1);
});

let touchStartX = null;
canvas.addEventListener('touchstart', (event) => {
  touchStartX = event.changedTouches[0].clientX;
});
canvas.addEventListener('touchend', (event) => {
  if (touchStartX === null) return;
  const dx = event.changedTouches[0].clientX - touchStartX;
  if (Math.abs(dx) > 50) step(dx < 0 ? 1 : -1);
  touchStartX = null;
});

function setWalkUI(isWalking) {
  walkBtn.textContent = isWalking ? '\u{1F41C} exit walk' : '\u{1F41C} walk on model';
  walkBtn.classList.toggle('active', isWalking);
  walkHint.hidden = !isWalking;
  prevBtn.hidden = isWalking;
  nextBtn.hidden = isWalking;
}

function exitWalk() {
  controls.enabled = true;
  controls.autoRotate = true;
  frameObject(currentObject);
  setWalkUI(false);
}

walkBtn.addEventListener('click', () => {
  if (walker.active) {
    walker.exit();
    return;
  }
  if (!currentObject) return;
  controls.enabled = false;
  controls.autoRotate = false;
  walker.enter(currentObject, exitWalk);
  setWalkUI(true);
});

const initialName = decodeURIComponent(location.hash.slice(1));
const initialIndex = MODEL_NAMES.indexOf(initialName);
showModel(initialIndex >= 0 ? initialIndex : 0);

const clock = new THREE.Clock();
function animate() {
  const delta = clock.getDelta();
  if (walker.active) {
    walker.update(delta);
  } else {
    controls.update();
  }
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}
animate();
