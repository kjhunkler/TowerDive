const STORAGE_KEY = 'towerdive-workshop-map-v1';

export function createEmptyMap(width = 15, depth = 15, tileSize = 1) {
  const entities = [];
  let id = 0;
  for (let col = 0; col < width; col++) {
    for (let row = 0; row < depth; row++) {
      entities.push({ id: id++, name: 'tower-defense/tile', ground: true, col, row, rotationStep: 0, heightStep: 0 });
    }
  }
  return { version: 1, width, depth, tileSize, nextId: id, entities };
}

// Maps saved before models were split into per-kit folders store bare names
// (e.g. "tile" instead of "tower-defense/tile") — the only kit that existed
// then, so an unprefixed name always means tower-defense.
function migrateEntityNames(map) {
  for (const entity of map.entities) {
    if (!entity.name.includes('/')) entity.name = `tower-defense/${entity.name}`;
  }
  return map;
}

export function loadMap() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const map = JSON.parse(raw);
    if (map?.version !== 1) return null;
    return migrateEntityNames(map);
  } catch {
    return null;
  }
}

export function saveMap(map) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
}

export function exportMapFile(map) {
  const blob = new Blob([JSON.stringify(map, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'towerdive-map.json';
  a.click();
  URL.revokeObjectURL(url);
}

export async function importMapFile(file) {
  const map = JSON.parse(await file.text());
  if (map?.version !== 1) throw new Error('Unrecognized map file');
  return migrateEntityNames(map);
}
