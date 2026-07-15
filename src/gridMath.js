// Same centered-grid convention as src/grid.js, parameterized so the
// workshop can use arbitrary map dimensions instead of the fixed game level.
export function cellToWorld(col, row, width, depth, tileSize) {
  return {
    x: (col - (width - 1) / 2) * tileSize,
    z: (row - (depth - 1) / 2) * tileSize,
  };
}

export function worldToCell(x, z, width, depth, tileSize) {
  return {
    col: Math.round(x / tileSize + (width - 1) / 2),
    row: Math.round(z / tileSize + (depth - 1) / 2),
  };
}
