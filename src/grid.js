// Kenney's tiles are exactly 1x1 world units (see the POSITION bounds in
// any tile .glb), so cells must be spaced 1 apart for tiles to connect
// seamlessly. The tile slab itself is 0.2 high — props sit on TILE_TOP.
export const TILE_SIZE = 1;
export const TILE_TOP = 0.2;

// A single straight lane, 8 tiles long, running along +x.
// 'path' cells render the road tile set; everything else is grass.
export const GRID_WIDTH = 9;
export const GRID_DEPTH = 5;
export const PATH_ROW = 2;

export function tileWorldPosition(col, row) {
  return {
    x: (col - (GRID_WIDTH - 1) / 2) * TILE_SIZE,
    z: (row - (GRID_DEPTH - 1) / 2) * TILE_SIZE,
  };
}

export function tileKindAt(col, row) {
  if (row !== PATH_ROW) return 'grass';
  if (col === 0) return 'spawn';
  if (col === GRID_WIDTH - 1) return 'end';
  return 'path';
}

// World-space waypoints an enemy walks through, spawn -> end.
export function buildPathWaypoints() {
  const waypoints = [];
  for (let col = 0; col < GRID_WIDTH; col++) {
    const { x, z } = tileWorldPosition(col, PATH_ROW);
    waypoints.push({ x, z });
  }
  return waypoints;
}

// Grass tile slots adjacent to the lane where towers can be built.
export function buildTowerSlots() {
  const slots = [];
  for (const row of [PATH_ROW - 1, PATH_ROW + 1]) {
    for (let col = 1; col < GRID_WIDTH - 1; col += 2) {
      slots.push({ col, row, ...tileWorldPosition(col, row) });
    }
  }
  return slots;
}
