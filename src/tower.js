import { spawnModel } from './assets.js';
import { TILE_TOP } from './grid.js';

// Tower pieces (bottom/build segments) are 0.6 world units tall — see the
// POSITION bounds in the tower .glb files — so stacking steps by exactly
// that keeps the pieces flush. The whole stack starts on top of the tile
// slab rather than embedded in it.
export const TOWER_PIECE_HEIGHT = 0.6;

// Towers are assembled from stacked Kenney pieces: a base, a middle
// "build" segment, and a top/roof. Swapping the segment names lets us
// vary tower appearance without new geometry.
export async function buildTower(group, { x, z }, variant = 'round') {
  const pieces = [
    { name: `tower-${variant}-bottom-a`, y: TILE_TOP },
    { name: `tower-${variant}-build-a`, y: TILE_TOP + TOWER_PIECE_HEIGHT },
    { name: `tower-${variant}-top-a`, y: TILE_TOP + TOWER_PIECE_HEIGHT * 2 },
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
