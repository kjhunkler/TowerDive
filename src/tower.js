import { spawnModel } from './assets.js';

// Tower pieces (bottom/build segments) are 0.6 world units tall — see the
// POSITION bounds in the tower .glb files — so stacking steps by exactly
// that keeps the pieces flush. The stack starts at y=0, the height every
// kit's ground tiles are sunk to align their top surface to (see grid.js).
export const TOWER_PIECE_HEIGHT = 0.6;

// Towers are assembled from stacked Kenney pieces: a base, a middle
// "build" segment, and a top/roof. Swapping the segment names lets us
// vary tower appearance without new geometry.
export async function buildTower(group, { x, z }, variant = 'round') {
  const pieces = [
    { name: `tower-defense/tower-${variant}-bottom-a`, y: 0 },
    { name: `tower-defense/tower-${variant}-build-a`, y: TOWER_PIECE_HEIGHT },
    { name: `tower-defense/tower-${variant}-top-a`, y: TOWER_PIECE_HEIGHT * 2 },
  ];

  await Promise.all(
    pieces.map(async (piece) => {
      const model = await spawnModel(piece.name, {
        position: { x, y: piece.y, z },
      });
      group.add(model);
    })
  );
}
