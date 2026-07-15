import { spawnModel } from './assets.js';

const HEIGHT_STEP = 0.9;

// Towers are assembled from stacked Kenney pieces: a base, a middle
// "build" segment, and a top/roof. Swapping the segment names lets us
// vary tower appearance without new geometry.
export async function buildTower(group, { x, z }, variant = 'round') {
  const pieces = [
    { name: `tower-${variant}-bottom-a`, y: 0 },
    { name: `tower-${variant}-build-a`, y: HEIGHT_STEP },
    { name: `tower-${variant}-top-a`, y: HEIGHT_STEP * 2 },
  ];

  for (const piece of pieces) {
    const model = await spawnModel(piece.name, {
      position: { x, y: piece.y, z },
    });
    group.add(model);
  }
}
